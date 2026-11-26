import { workspaces } from './workspace.js'

/**
 * 前置参考资料：agent 模式下的会话资料（研究结果 zip 解压出的 markdown、
 * 个人经历/习惯 md 等），统一放在工作区 references/ 目录，并注入 system prompt
 * 让模型自动参考（小文件内联全文，大文件提示用 read_file 读取）。
 */

export const REFERENCES_DIR = 'references'

export type ReferenceItem = {
  path: string
  size: number
  preview: string
}

const MAX_FILES = 50
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const INLINE_LIMIT = 1500 // 单个文件内联全文的字符上限
const PREVIEW_CHARS = 200
const PROMPT_BUDGET = 6000 // 注入 system prompt 的总字符预算

/** 相对路径清洗：拒绝越界与绝对路径 */
const sanitizePath = (path: string): string => {
  const cleaned = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
  return cleaned || 'unnamed.md'
}

/** 写入一批参考资料（前端已解压好 zip；后端只做校验与落盘） */
export const saveReferences = async (
  sessionId: string,
  files: Array<{ path: string; content: string }>
): Promise<{ count: number }> => {
  await workspaces.ensure(sessionId)
  const entries = files.slice(0, MAX_FILES)
  let total = 0
  let count = 0
  for (const file of entries) {
    const size = Buffer.byteLength(file.content, 'utf8')
    if (size > 2 * 1024 * 1024 || total + size > MAX_TOTAL_BYTES) {
      continue
    }
    total += size
    await workspaces.writeFile(sessionId, `${REFERENCES_DIR}/${sanitizePath(file.path)}`, file.content)
    count += 1
  }
  return { count }
}

/** 列出现有资料（含预览） */
export const listReferences = async (sessionId: string): Promise<ReferenceItem[]> => {
  const entries = await workspaces
    .listDir(sessionId, REFERENCES_DIR)
    .catch(() => [] as Array<{ name: string; type: 'file' | 'dir'; size?: number }>)
  const items: ReferenceItem[] = []
  for (const entry of entries) {
    if (entry.type !== 'file') {
      continue
    }
    const path = `${REFERENCES_DIR}/${entry.name}`
    const preview = await workspaces
      .readFile(sessionId, path)
      .then(({ content }) => content.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS))
      .catch(() => '')
    items.push({ path, size: entry.size ?? 0, preview })
  }
  return items
}

export const deleteReference = async (sessionId: string, relativePath: string): Promise<void> => {
  if (!relativePath.startsWith(`${REFERENCES_DIR}/`) || relativePath.includes('..')) {
    throw new Error('非法路径')
  }
  await workspaces.deleteFile(sessionId, relativePath)
}

/** 生成注入 system prompt 的资料块（小文件内联，大文件给摘录 + read_file 提示） */
export const buildReferencesPrompt = async (sessionId: string): Promise<string> => {
  const items = await listReferences(sessionId)
  if (items.length === 0) {
    return ''
  }
  const sections: string[] = []
  let budget = 0
  for (const item of items) {
    if (budget >= PROMPT_BUDGET) {
      break
    }
    const { content } = await workspaces.readFile(sessionId, item.path).catch(() => ({ content: '' }))
    if (!content) {
      continue
    }
    const text = content.trim()
    let body: string
    let hint = ''
    if (text.length <= INLINE_LIMIT) {
      body = text
    } else {
      body = `${text.slice(0, 300).trim()} …`
      hint = `（内容较长，需用 read_file 工具读取 ${item.path} 全文）`
    }
    const section = `### ${item.path}\n${body}\n${hint}`
    sections.push(section)
    budget += section.length
  }
  if (sections.length === 0) {
    return ''
  }
  return (
    `[前置参考资料] 工作区内提供了以下资料（references/ 目录，可用 read_file 工具读取全文）。` +
    `这些是用户提供的可信背景材料，回答任务时优先参考：\n\n${sections.join('\n\n')}`
  )
}
