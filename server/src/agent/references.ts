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

const MAX_FILES = 200
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
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

/** 与前端一致：修复未声明 UTF-8 的 Mac zip 文件名（Latin-1 → UTF-8） */
export const repairReferenceName = (name: string): string => {
  if (!name) {
    return name
  }
  const bytes = Buffer.alloc(name.length)
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index)
    if (code > 0xff) {
      return name.normalize('NFC')
    }
    bytes[index] = code
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  } catch {
    return name.normalize('NFC')
  }
}

const isMetadataPath = (value: string): boolean =>
  value
    .replace(/\\/g, '/')
    .split('/')
    .some(
      (segment) =>
        segment === '__MACOSX' ||
        segment === '.DS_Store' ||
        segment === 'Thumbs.db' ||
        segment === 'desktop.ini' ||
        segment.startsWith('._')
    )

/**
 * 历史 Mac zip 可能已经以乱码目录落盘；打开资料时顺手修复。
 * 同时清掉 __MACOSX / ._ 资源分叉，避免模型把这些二进制元数据当正文。
 */
export const repairReferenceStorage = async (sessionId: string): Promise<{
  renamed: number
  removed: number
}> => {
  const entries = await workspaces
    .listFilesRecursive(sessionId, REFERENCES_DIR)
    .catch(() => [] as Array<{ path: string; size: number; mtimeMs: number }>)
  let renamed = 0
  let removed = 0
  for (const entry of entries) {
    const relative = entry.path.startsWith(`${REFERENCES_DIR}/`)
      ? entry.path.slice(REFERENCES_DIR.length + 1)
      : entry.path
    if (isMetadataPath(relative)) {
      await workspaces.deleteFile(sessionId, entry.path).catch(() => undefined)
      removed += 1
      continue
    }
    const fixed = relative
      .split('/')
      .map((segment) => repairReferenceName(segment))
      .join('/')
    if (fixed === relative) {
      continue
    }
    try {
      await workspaces.moveFile(
        sessionId,
        entry.path,
        `${REFERENCES_DIR}/${fixed}`
      )
      renamed += 1
    } catch {
      // 目标已存在或文件被占用：保留原名，避免覆盖用户资料
    }
  }
  await workspaces.pruneEmptyDirs(sessionId, REFERENCES_DIR).catch(() => undefined)
  return { renamed, removed }
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
    const relative = sanitizePath(file.path)
    if (isMetadataPath(relative)) {
      continue
    }
    const size = Buffer.byteLength(file.content, 'utf8')
    if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) {
      continue
    }
    total += size
    await workspaces.writeFile(
      sessionId,
      `${REFERENCES_DIR}/${relative}`,
      file.content,
      MAX_FILE_BYTES
    )
    count += 1
  }
  return { count }
}

/** 列出现有资料（含预览）；递归包含 zip 内的子目录 */
export const listReferences = async (sessionId: string): Promise<ReferenceItem[]> => {
  await repairReferenceStorage(sessionId).catch(() => undefined)
  const entries = await workspaces
    .listFilesRecursive(sessionId, REFERENCES_DIR)
    .catch(() => [] as Array<{ path: string; size: number; mtimeMs: number }>)
  const items: ReferenceItem[] = []
  for (const entry of entries) {
    if (isMetadataPath(entry.path)) {
      continue
    }
    const preview = await workspaces
      .readFileRange(sessionId, entry.path, 1, 20, PREVIEW_CHARS)
      .then(({ content }) => content.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS))
      .catch(() => '')
    items.push({ path: entry.path, size: entry.size, preview })
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
    // 大文件不再整份载入 prompt：只读取开头一小段，完整内容通过 read_file 分块读取
    const { content } = await workspaces
      .readFileRange(sessionId, item.path, 1, 80, INLINE_LIMIT + 1)
      .catch(() => ({ content: '' }))
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
      hint = `（内容较长，先用 read_file 的 offset/limit 分块读取 ${item.path}，或开启资料索引后直接检索）`
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
