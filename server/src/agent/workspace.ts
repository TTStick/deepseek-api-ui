import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env.js'

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

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 单文件读写上限 2MB

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
    if (info.size > MAX_FILE_SIZE) {
      throw new WorkspaceError(`文件过大（${Math.round(info.size / 1024)}KB > 2MB），无法读取`)
    }
    const content = await readFile(target, 'utf8')
    return { content, size: info.size }
  }

  /** 按原始字节读取（图片预览用） */
  async readRaw(sessionId: string, relativePath: string): Promise<Buffer> {
    const target = this.resolve(sessionId, relativePath)
    const info = await stat(target).catch(() => {
      throw new WorkspaceError(`文件不存在：${relativePath}`)
    })
    if (!info.isFile() || info.size > MAX_FILE_SIZE) {
      throw new WorkspaceError('文件不存在或过大')
    }
    return readFile(target)
  }

  async writeFile(sessionId: string, relativePath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
      throw new WorkspaceError('内容超过 2MB 上限')
    }
    const target = this.resolve(sessionId, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  async deleteFile(sessionId: string, relativePath: string): Promise<void> {
    const target = this.resolve(sessionId, relativePath)
    await rm(target, { recursive: true, force: true })
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
