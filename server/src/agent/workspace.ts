import { createHash } from 'node:crypto'
import { chmod, chown, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env.js'
import { isEncrypted, readSecure, writeSecure } from '../storage/crypto.js'

/**
 * 每会话工作区（移植 claude-code 的 session-scoped cwd 概念）：
 * - 一个会话一个目录：{workspaceRoot}/<sessionId slug>/
 * - 所有文件操作严格限制在该目录内（路径归一化 + 前缀校验，防 ../ 逃逸）
 * - 关闭 agent / 删除会话时由 cleanup 整体删除
 */

export type FileNode = {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

export type WorkspaceInfo = {
  root: string
  exists: boolean
  fileCount: number
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/** sessionId 转目录名：slug 化 + 8 位哈希后缀防碰撞 */
const sessionDirName = (sessionId: string): string => {
  const slug = sessionId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64)
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}

/**
 * 工作区文件的 AAD 使用目录名而不是原始 sessionId：
 * 迁移历史明文文件时只能从目录名反推，不需要建立额外映射。
 */
const workspaceAad = (dirName: string, relativePath: string): string =>
  `workspace:${dirName}:${relativePath.replace(/\\/g, '/')}`

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 普通工具读写上限；资料与大文件走分块/专用接口
const MAX_FULL_READ_SIZE = 256 * 1024 * 1024

export class WorkspaceManager {
  constructor(private readonly root: string = env.workspaceRoot) {}

  private dir(sessionId: string): string {
    return path.join(this.root, sessionDirName(sessionId))
  }

  /** 把相对路径解析到工作区内的绝对路径；越界或含空字节抛错 */
  private resolve(sessionId: string, relativePath: string): string {
    const root = this.dir(sessionId)
    if (relativePath.includes('\0')) {
      throw new WorkspaceError('路径包含非法字符')
    }
    const resolved = path.resolve(root, relativePath)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new WorkspaceError(`路径越出工作区：${relativePath}`)
    }
    return resolved
  }

  private relative(sessionId: string, target: string): string {
    return path.relative(this.dir(sessionId), target).split(path.sep).join('/')
  }

  private aad(sessionId: string, target: string): string {
    return workspaceAad(sessionDirName(sessionId), this.relative(sessionId, target))
  }

  /** 确保工作区目录存在并返回根路径 */
  async ensure(sessionId: string): Promise<string> {
    const root = this.dir(sessionId)
    await mkdir(root, { recursive: true })
    return root
  }

  /** 删除整个工作区（幂等） */
  async cleanup(sessionId: string): Promise<void> {
    await rm(this.dir(sessionId), { recursive: true, force: true })
  }

  async info(sessionId: string): Promise<WorkspaceInfo> {
    const root = this.dir(sessionId)
    const exists = await stat(root)
      .then((s) => s.isDirectory())
      .catch(() => false)
    let fileCount = 0
    if (exists) {
      fileCount = await this.countFiles(root)
    }
    return { root, exists, fileCount }
  }

  private async countFiles(dir: string): Promise<number> {
    let count = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += await this.countFiles(path.join(dir, entry.name))
      } else {
        count += 1
      }
    }
    return count
  }

  /** 文件树（目录优先排序，单层最多 500 项） */
  async tree(sessionId: string): Promise<FileNode[]> {
    const root = this.dir(sessionId)
    const build = async (dir: string, relative: string): Promise<FileNode[]> => {
      const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
        .slice(0, 500)
      const nodes: FileNode[] = []
      for (const entry of entries) {
        const childRel = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: childRel,
            type: 'dir',
            children: await build(path.join(dir, entry.name), childRel),
          })
        } else {
          const size = await stat(path.join(dir, entry.name))
            .then((s) => s.size)
            .catch(() => 0)
          nodes.push({ name: entry.name, path: childRel, type: 'file', size })
        }
      }
      return nodes
    }
    return build(root, '')
  }

  async readFile(sessionId: string, relativePath: string): Promise<{ content: string; size: number }> {
    const target = this.resolve(sessionId, relativePath)
    const info = await stat(target).catch(() => {
      throw new WorkspaceError(`文件不存在：${relativePath}`)
    })
    if (!info.isFile()) {
      throw new WorkspaceError(`不是文件：${relativePath}`)
    }
    const buffer = await readSecure(target, this.aad(sessionId, target))
    if (buffer.length > MAX_FILE_SIZE) {
      throw new WorkspaceError(`文件过大（${Math.round(buffer.length / 1024)}KB > 2MB），无法读取`)
    }
    return { content: buffer.toString('utf8'), size: buffer.length }
  }

  /** 读取完整文本（资料索引等内部用途）；普通 read_file 走分块接口 */
  async readFileFull(
    sessionId: string,
    relativePath: string,
    maxBytes = MAX_FULL_READ_SIZE
  ): Promise<{ content: string; size: number }> {
    const target = this.resolve(sessionId, relativePath)
    const info = await stat(target).catch(() => {
      throw new WorkspaceError(`文件不存在：${relativePath}`)
    })
    if (!info.isFile()) {
      throw new WorkspaceError(`不是文件：${relativePath}`)
    }
    if (info.size > maxBytes + 1024) {
      // 加密文件比明文多 33 字节头；先做粗筛，解密后再精确校验
      throw new WorkspaceError(`文件过大（${Math.round(info.size / 1024 / 1024)}MB）`)
    }
    const buffer = await readSecure(target, this.aad(sessionId, target))
    if (buffer.length > maxBytes) {
      throw new WorkspaceError(`文件过大（${Math.round(buffer.length / 1024 / 1024)}MB）`)
    }
    return { content: buffer.toString('utf8'), size: buffer.length }
  }

  /**
   * 按行分块读取（移植编程 Agent 的 read_file offset/limit 语义）：
   * 加密文件需要整体解密后切窗口；默认 500 行、最多 100KB 字符，返回 nextOffset。
   */
  async readFileRange(
    sessionId: string,
    relativePath: string,
    offset = 1,
    limit = 500,
    maxChars = 100_000,
    charOffset = 0
  ): Promise<{
    content: string
    startLine: number
    endLine: number
    hasMore: boolean
    nextOffset: number
    /** >0 表示起始行是超长行，下一次应从该字符位置继续 */
    nextCharOffset: number
  }> {
    const target = this.resolve(sessionId, relativePath)
    const info = await stat(target).catch(() => {
      throw new WorkspaceError(`文件不存在：${relativePath}`)
    })
    if (!info.isFile()) {
      throw new WorkspaceError(`不是文件：${relativePath}`)
    }
    const buffer = await readSecure(target, this.aad(sessionId, target))
    const startLine = Math.max(1, Math.floor(offset))
    const lineLimit = Math.max(1, Math.min(5000, Math.floor(limit)))
    const lines = buffer.toString('utf8').split('\n')
    const collected: string[] = []
    let chars = 0
    let hasMore = false
    let nextCharOffset = 0
    const initialCharOffset = Math.max(0, Math.floor(charOffset))
    for (let index = startLine - 1; index < lines.length; index += 1) {
      const lineNo = index + 1
      if (collected.length >= lineLimit) {
        hasMore = true
        break
      }
      const rawLine = lines[index] ?? ''
      const visible =
        lineNo === startLine && initialCharOffset > 0
          ? rawLine.slice(Math.min(initialCharOffset, rawLine.length))
          : rawLine
      // 超长单行不能整行塞进上下文；返回当前字符窗口，并给出 char_offset 续读位置
      if (collected.length === 0 && visible.length + 1 > maxChars) {
        const take = Math.max(1, maxChars - 1)
        collected.push(visible.slice(0, take))
        chars = take
        hasMore = true
        nextCharOffset = initialCharOffset + take
        break
      }
      if (chars + visible.length + 1 > maxChars) {
        hasMore = true
        break
      }
      collected.push(visible)
      chars += visible.length + 1
    }
    return {
      content: collected.join('\n'),
      startLine,
      endLine: collected.length > 0 ? startLine + collected.length - 1 : startLine - 1,
      hasMore,
      nextOffset: nextCharOffset > 0 ? startLine : startLine + collected.length,
      nextCharOffset,
    }
  }

  /** 按原始字节读取（图片预览用） */
  async readRaw(sessionId: string, relativePath: string): Promise<Buffer> {
    const target = this.resolve(sessionId, relativePath)
    const info = await stat(target).catch(() => {
      throw new WorkspaceError(`文件不存在：${relativePath}`)
    })
    if (!info.isFile()) {
      throw new WorkspaceError('文件不存在')
    }
    const buffer = await readSecure(target, this.aad(sessionId, target))
    if (buffer.length > MAX_FILE_SIZE) {
      throw new WorkspaceError('文件过大')
    }
    return buffer
  }

  async writeFile(
    sessionId: string,
    relativePath: string,
    content: string,
    maxBytes = MAX_FILE_SIZE
  ): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new WorkspaceError(`内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`)
    }
    const target = this.resolve(sessionId, relativePath)
    await writeSecure(target, Buffer.from(content, 'utf8'), this.aad(sessionId, target))
  }

  /** 写入原始字节（图片、PDF 等交付物）；同样加密落盘 */
  async writeRaw(
    sessionId: string,
    relativePath: string,
    content: Buffer,
    maxBytes = MAX_FULL_READ_SIZE
  ): Promise<void> {
    if (content.length > maxBytes) {
      throw new WorkspaceError(`内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`)
    }
    const target = this.resolve(sessionId, relativePath)
    await writeSecure(target, content, this.aad(sessionId, target))
  }

  async deleteFile(sessionId: string, relativePath: string): Promise<void> {
    const target = this.resolve(sessionId, relativePath)
    await rm(target, { recursive: true, force: true })
  }

  /** 递归列出目录下的文件（资料索引/前置资料清单用；忽略符号链接，最多 5000 个） */
  async listFilesRecursive(
    sessionId: string,
    relativeDir = ''
  ): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const root = this.resolve(sessionId, relativeDir)
    const base = relativeDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const result: Array<{ path: string; size: number; mtimeMs: number }> = []
    const walk = async (dir: string, prefix: string) => {
      if (result.length >= 5000) {
        return
      }
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (result.length >= 5000) {
          return
        }
        if (entry.isSymbolicLink()) {
          continue
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const target = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(target, relative)
        } else if (entry.isFile()) {
          const info = await stat(target).catch(() => undefined)
          if (info) {
            result.push({
              path: base ? `${base}/${relative}` : relative,
              size: info.size,
              mtimeMs: info.mtimeMs,
            })
          }
        }
      }
    }
    await walk(root, '')
    return result
  }

  /**
   * Python 执行的工作区视图：
   * 工作区里的文件默认都是密文，脚本无法直接读取；执行前把明文复制到 tmpfs，
   * 执行完再把生成/修改的文件写回加密工作区。明文只存在于内存盘和进程内存。
   */
  async withExecutionWorkspace<T>(
    sessionId: string,
    task: (workspaceDir: string) => Promise<T>
  ): Promise<T> {
    const workspaceDir = await this.ensure(sessionId)
    const dirName = sessionDirName(sessionId)
    let execRoot: string
    try {
      await mkdir(env.execTmpRoot, { recursive: true })
      // 父目录需要 x 权限，降权后的 Python 才能进入自己的临时子目录；
      // 0711 允许穿过但不允许列出其他会话目录。
      await chmod(env.execTmpRoot, 0o711).catch(() => undefined)
      execRoot = await mkdtemp(path.join(env.execTmpRoot, 'myagent-exec-'))
    } catch {
      throw new WorkspaceError(
        `执行临时目录不可用（${env.execTmpRoot}）。请把 EXEC_TMP_ROOT 指向可写的 tmpfs，例如 /dev/shm。`
      )
    }
    await chmod(execRoot, 0o700).catch(() => undefined)
    // Python 以无特权 UID 运行时，临时目录和文件必须归它所有
    const chownExec = (target: string) =>
      chown(target, env.agentExecUid, env.agentExecGid).catch(() => undefined)
    await chownExec(execRoot)

    const copyIn = async (dir: string, prefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const source = path.join(dir, entry.name)
        const target = path.join(execRoot, ...relative.split('/'))
        if (entry.isDirectory()) {
          await mkdir(target, { recursive: true })
          await chownExec(target)
          await copyIn(source, relative)
        } else if (entry.isFile()) {
          const buffer = await readSecure(source, workspaceAad(dirName, relative))
          await writeFile(target, buffer, { mode: 0o600 })
          await chownExec(target)
        }
      }
    }

    const copyOut = async (dir: string, prefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const source = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__pycache__' || entry.name === '.git') {
            continue
          }
          await copyOut(source, relative)
        } else if (entry.isFile()) {
          if (entry.name.endsWith('.pyc')) {
            continue
          }
          const buffer = await readFile(source)
          await this.writeRaw(sessionId, relative, buffer)
        }
      }
    }

    let result!: T
    try {
      await copyIn(workspaceDir, '')
      result = await task(execRoot)
    } finally {
      await copyOut(execRoot, '').catch(() => undefined)
      await rm(execRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    return result
  }

  /** 列出目录内容（agent 工具的 list_files） */
  async listDir(sessionId: string, relativePath: string): Promise<Array<{ name: string; type: 'file' | 'dir'; size?: number }>> {
    const target = this.resolve(sessionId, relativePath)
    const entries = (await readdir(target, { withFileTypes: true }).catch(() => []))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200)
    const result = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        result.push({ name: entry.name, type: 'dir' as const })
      } else {
        const size = await stat(path.join(target, entry.name))
          .then((s) => s.size)
          .catch(() => 0)
        result.push({ name: entry.name, type: 'file' as const, size })
      }
    }
    return result
  }
}

export const workspaces = new WorkspaceManager()

/** 清理异常退出遗留的执行临时目录（正常路径在 finally 中已删除）。 */
export const cleanupExecutionTmp = async (): Promise<number> => {
  const entries = await readdir(env.execTmpRoot, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('myagent-exec-')) {
      await rm(path.join(env.execTmpRoot, entry.name), { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

/**
 * 启动迁移：把历史工作区（references、生成物、脚本）原地加密。
 * 目录名包含 sessionId 的哈希，AAD 只依赖目录名 + 相对路径，迁移无需反查会话。
 */
export const migrateWorkspaceStorage = async (): Promise<number> => {
  const walk = async (dir: string, dirName: string, prefix: string): Promise<number> => {
    let count = 0
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        count += await walk(target, dirName, relative)
      } else if (entry.isFile()) {
        const raw = await readFile(target)
        if (raw.length > 0 && !isEncrypted(raw)) {
          await writeSecure(target, raw, workspaceAad(dirName, relative))
          count += 1
        }
      }
    }
    return count
  }

  const dirs = await readdir(env.workspaceRoot, { withFileTypes: true }).catch(() => [])
  let count = 0
  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue
    }
    count += await walk(path.join(env.workspaceRoot, dir.name), dir.name, '')
  }
  return count
}
