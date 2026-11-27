import { unzipSync } from 'fflate'
import { getAgentApiOrigin } from '../../services/api/client.js'
import { showToast } from '../../components/base/toastState.js'

/**
 * 前置参考资料：上传 zip（解压出 markdown/txt）或单个 md 文件，
 * 存入会话工作区 references/ 目录；agent 每轮会自动在 system prompt 中参考。
 */

export type ReferenceItem = {
  path: string
  size: number
  preview: string
}

const MAX_ZIP_BYTES = 256 * 1024 * 1024
const MAX_FILES = 200
// 单个资料文件不再按 2MB 拒绝；64MB 是浏览器/JSON 传输的工程安全上限，
// 阅读侧通过 read_file offset/limit 分块，不会整份塞进上下文。
const MAX_FILE_BYTES = 64 * 1024 * 1024

const isTextFile = (name: string): boolean => /\.(md|markdown|txt)$/i.test(name)

/**
 * 修复 Mac 压缩包的文件名：
 * 部分 zip 用 UTF-8 存中文名但没有设置 UTF-8 标志，fflate 会按 Latin-1 解码，
 * 得到“æ§å«…”这类乱码。这里把 Latin-1 码点还原成字节，再按 UTF-8 解码；
 * 真正的 Latin-1 文件名会解码失败并保留原样。
 */
export const repairZipEntryName = (name: string): string => {
  if (!name) {
    return name
  }
  const bytes = new Uint8Array(name.length)
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

/** macOS 压缩包里的资源分叉/目录元数据，不是用户资料 */
const isMetadataPath = (path: string): boolean =>
  path
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

/** 保留 zip 内相对路径并清洗（去掉 . 与 .. 段） */
const sanitizeEntryPath = (raw: string): string => {
  const cleaned = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
  return cleaned || 'unnamed.md'
}

/** 从上传文件里收集文本条目（zip 解压 / 直接读 md） */
const collectTextFiles = async (file: File): Promise<Array<{ path: string; content: string }>> => {
  if (/\.zip$/i.test(file.name)) {
    if (file.size > MAX_ZIP_BYTES) {
      showToast({ key: 'referencesTooLarge', type: 'error' })
      return []
    }
    const archive = unzipSync(new Uint8Array(await file.arrayBuffer()))
    const entries: Array<{ path: string; content: string }> = []
    let count = 0
    for (const [rawName, bytes] of Object.entries(archive)) {
      const name = repairZipEntryName(rawName)
      if (isMetadataPath(name) || !isTextFile(name) || bytes.length > MAX_FILE_BYTES) {
        continue
      }
      if (count >= MAX_FILES) {
        break
      }
      count += 1
      entries.push({
        path: sanitizeEntryPath(name),
        content: new TextDecoder('utf-8').decode(bytes),
      })
    }
    if (entries.length === 0) {
      showToast({ key: 'referencesZipEmpty', type: 'error' })
    }
    return entries
  }
  const fileName = repairZipEntryName(file.name)
  if (isTextFile(fileName) && !isMetadataPath(fileName)) {
    if (file.size > MAX_FILE_BYTES) {
      showToast({ key: 'referencesTooLarge', type: 'error' })
      return []
    }
    return [{ path: sanitizeEntryPath(fileName), content: await file.text() }]
  }
  showToast({ key: 'referencesUnsupported', type: 'error' })
  return []
}

/** 上传并写入会话参考资料，返回成功写入的数量 */
export const uploadReferenceFiles = async (sessionId: string, files: File[]): Promise<number> => {
  const collected: Array<{ path: string; content: string }> = []
  for (const file of files) {
    collected.push(...(await collectTextFiles(file)))
  }
  if (collected.length === 0) {
    return 0
  }
  const response = await fetch(`${getAgentApiOrigin()}/api/agent/references`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, files: collected }),
  })
  if (!response.ok) {
    showToast({ key: 'referencesUploadFailed', type: 'error' })
    return 0
  }
  const result = (await response.json()) as { count: number }
  return result.count
}

export const listReferences = async (sessionId: string): Promise<ReferenceItem[]> => {
  const response = await fetch(
    `${getAgentApiOrigin()}/api/agent/references?sessionId=${encodeURIComponent(sessionId)}`
  )
  if (!response.ok) {
    return []
  }
  return (await response.json()) as ReferenceItem[]
}

export const deleteReference = async (sessionId: string, path: string): Promise<boolean> => {
  const response = await fetch(`${getAgentApiOrigin()}/api/agent/references`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, path }),
  })
  return response.ok
}
