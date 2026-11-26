import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { env } from './env.js'
import { hasExcessiveDepth } from './validation.js'

/**
 * 服务端会话库：手机端与网页端共享同一份对话。
 * - 每个会话一个 JSON 文件（内容为客户端完整 Session 对象，服务端不解析消息结构）
 * - 每个会话一个 .meta.json 摘要文件，列表查询不必读取大文件
 * - 删除写入墓碑，客户端拉取后同步删除本地副本
 * 单用户场景；所有写入串行执行，文件先写临时文件再原子重命名。
 */

const SESSIONS_DIR = path.join(env.dataRoot, 'sessions')
const TOMBSTONES_FILE = path.join(env.dataRoot, 'session-tombstones.json')
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type SessionSummary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  group?: string
  archived?: boolean
  pinned?: boolean
  compressedRounds: number
  messageCount: number
}

export type SessionTombstone = { id: string; deletedAt: number }

export const isValidSessionId = (id: string): boolean => ID_PATTERN.test(id)

const sessionFile = (id: string) => path.join(SESSIONS_DIR, `${id}.json`)
const metaFile = (id: string) => path.join(SESSIONS_DIR, `${id}.meta.json`)

const ensureDir = () => mkdir(SESSIONS_DIR, { recursive: true })

const writeAtomic = async (target: string, content: string) => {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, target)
}

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** SSH 凭据属于本机浏览器，不写入服务端会话库，也不下发给手机端 */
const withoutSecrets = (session: Record<string, unknown>): Record<string, unknown> => {
  if (!('ssh' in session)) {
    return session
  }
  const sanitized = { ...session }
  delete sanitized.ssh
  return sanitized
}

/**
 * 会话结构校验：客户端可自由扩展字段，但核心字段类型必须正确，
 * 否则列表/时间戳排序会被静默污染。返回错误文案，合法时返回 null。
 */
const validateSessionShape = (session: Record<string, unknown>): string | null => {
  if (!Array.isArray(session.messages)) {
    return 'messages 必须是数组'
  }
  if (session.messages.length > 20000) {
    return '消息数量超过 20000 条上限'
  }
  if (hasExcessiveDepth(session.messages)) {
    return 'messages 嵌套层级过深'
  }
  if (session.title !== undefined && typeof session.title !== 'string') {
    return 'title 必须是字符串'
  }
  if (typeof session.title === 'string' && session.title.length > 2000) {
    return 'title 长度超过 2000 字符上限'
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (
      session[key] !== undefined &&
      (typeof session[key] !== 'number' ||
        !Number.isFinite(session[key]) ||
        session[key] < 0 ||
        session[key] > 8.64e15)
    ) {
      return `${key} 必须是合法时间戳`
    }
  }
  for (const key of ['archived', 'pinned'] as const) {
    if (session[key] !== undefined && typeof session[key] !== 'boolean') {
      return `${key} 必须是布尔值`
    }
  }
  if (session.group !== undefined && typeof session.group !== 'string') {
    return 'group 必须是字符串'
  }
  if (
    session.compression !== undefined &&
    (typeof session.compression !== 'object' ||
      session.compression === null ||
      Array.isArray(session.compression))
  ) {
    return 'compression 必须是对象'
  }
  if (
    session.messages.some(
      (message) => typeof message !== 'object' || message === null || Array.isArray(message)
    )
  ) {
    return 'messages 中存在非对象条目'
  }
  return null
}

const summarize = (session: Record<string, unknown>): SessionSummary | null => {  const id = typeof session.id === 'string' ? session.id : ''
  if (!isValidSessionId(id)) {
    return null
  }
  const messages = Array.isArray(session.messages) ? session.messages : []
  const compression = session.compression as { archivedRounds?: unknown } | undefined
  const compressed =
    typeof compression?.archivedRounds === 'number'
      ? compression.archivedRounds
      : typeof session.compressedRounds === 'number'
        ? session.compressedRounds
        : 0
  return {
    id,
    title: typeof session.title === 'string' ? session.title : '',
    createdAt: typeof session.createdAt === 'number' ? session.createdAt : 0,
    updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : 0,
    group: typeof session.group === 'string' ? session.group : undefined,
    archived: session.archived === true ? true : undefined,
    pinned: session.pinned === true ? true : undefined,
    compressedRounds: compressed,
    messageCount: messages.length,
  }
}

// 写入会话、墓碑与索引共用一条队列，避免并发覆盖。
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const result = queue.then(task)
  queue = result.catch(() => {})
  return result
}

export const listSessions = async (): Promise<SessionSummary[]> => {
  await ensureDir()
  const names = await readdir(SESSIONS_DIR).catch(() => [] as string[])
  const sessions: SessionSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.meta.json')) {
      continue
    }
    const meta = await readJson<SessionSummary>(path.join(SESSIONS_DIR, name))
    if (meta && isValidSessionId(meta.id)) {
      sessions.push(meta)
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

export const readSession = async (id: string): Promise<Record<string, unknown> | undefined> => {
  if (!isValidSessionId(id)) {
    return undefined
  }
  return readJson<Record<string, unknown>>(sessionFile(id))
}

export type ApplyResult = {
  applied: boolean
  summary: SessionSummary
}

export const writeSession = (id: string, rawSession: Record<string, unknown>): Promise<ApplyResult> =>
  serial(async () => {
    const session = withoutSecrets({ ...rawSession, id })
    const shapeError = validateSessionShape(session)
    if (shapeError) {
      throw new Error(shapeError)
    }
    const summary = summarize(session)
    if (!summary) {
      throw new Error('会话结构不合法')
    }
    await ensureDir()
    const existing = await readJson<SessionSummary>(metaFile(id))
    if (existing && existing.updatedAt > summary.updatedAt) {
      return { applied: false, summary: existing }
    }
    await writeAtomic(sessionFile(id), JSON.stringify(session))
    await writeAtomic(metaFile(id), JSON.stringify(summary))
    // 重新创建同名会话时清掉旧墓碑，避免客户端下次拉取又删掉它。
    const tombstones = await readTombstones()
    if (tombstones.some((item) => item.id === id)) {
      await writeTombstones(tombstones.filter((item) => item.id !== id))
    }
    return { applied: true, summary }
  })

export const deleteSession = (id: string): Promise<SessionTombstone> =>
  serial(async () => {
    if (!isValidSessionId(id)) {
      throw new Error('会话 id 不合法')
    }
    await ensureDir()
    await Promise.all([
      rm(sessionFile(id), { force: true }),
      rm(metaFile(id), { force: true }),
    ])
    const tombstones = await readTombstones()
    const deletedAt = Date.now()
    const next = [
      ...tombstones.filter((item) => item.id !== id),
      { id, deletedAt },
    ]
    await writeTombstones(next)
    return { id, deletedAt }
  })

const readTombstones = async (): Promise<SessionTombstone[]> => {
  const parsed = await readJson<unknown>(TOMBSTONES_FILE)
  return Array.isArray(parsed)
    ? parsed.filter(
        (item): item is SessionTombstone =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as SessionTombstone).id === 'string' &&
          typeof (item as SessionTombstone).deletedAt === 'number'
      )
    : []
}

const writeTombstones = async (items: SessionTombstone[]) => {
  await ensureDir()
  await writeAtomic(TOMBSTONES_FILE, JSON.stringify(items))
}

export const listTombstones = (): Promise<SessionTombstone[]> => readTombstones()

/** 启动时清理历史版本曾同步上来的 SSH 凭据（只保留在本机浏览器） */
export const scrubSessionSecrets = (): Promise<void> =>
  serial(async () => {
    await ensureDir()
    const names = await readdir(SESSIONS_DIR).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.meta.json')) {
        continue
      }
      const file = path.join(SESSIONS_DIR, name)
      const session = await readJson<Record<string, unknown>>(file)
      if (session && 'ssh' in session) {
        await writeAtomic(file, JSON.stringify(withoutSecrets(session)))
      }
    }
  })
