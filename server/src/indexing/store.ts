import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { workspaces } from '../agent/workspace.js'
import { env } from '../env.js'
import { readSession } from '../sessions.js'
import { decryptBuffer, isEncrypted, writeSecure } from '../storage/crypto.js'
import { chunkText } from './chunk.js'

/**
 * 每会话检索索引（按 sessionId 哈希分库，绝不跨对话）：
 * - conversation_fts：当前对话的全部可见消息，用于 Agent 回查较早内容
 * - references_fts：当前对话 references/ 下的 Markdown 分块，用于按需查资料
 *
 * 设计参考 goose 的 crates/goose/src/session/chat_history_search.rs（关键词检索）
 * 和 services/ask-ai-bot/utils/ai/tools/codebase-search.ts（带路径/行号的片段返回），
 * 存储改用 Node 内置 SQLite FTS5，避免引入原生依赖。
 */

const INDEX_DIR = path.join(env.dataRoot, 'indexes')
const MAX_MESSAGE_CHARS = 50_000
const MAX_SNIPPET_CHARS = 1_200
const MAX_RESULTS = 20

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  content,
  message_id UNINDEXED,
  role UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS references_fts USING fts5(
  content,
  path UNINDEXED,
  chunk_index UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED,
  tokenize = 'unicode61'
);
`

export type IndexOptions = {
  conversation?: boolean
  references?: boolean
}

export type ConversationHit = {
  messageId: string
  role: string
  createdAt: number
  snippet: string
}

export type ReferenceHit = {
  path: string
  chunkIndex: number
  startLine: number
  endLine: number
  snippet: string
}

const indexHash = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('hex').slice(0, 40)

const indexFile = (sessionId: string): string =>
  path.join(INDEX_DIR, `${indexHash(sessionId)}.sqlite`)

const indexAad = (sessionId: string): string => `index:${indexHash(sessionId)}`

/**
 * 索引文件整体加密，查询/构建时解密到内存 SQLite（Node 24 serialize/deserialize），
 * 关闭时再整体写回密文。这样 FTS 表里的消息正文不会以明文出现在磁盘上。
 */
const openIndex = async (sessionId: string): Promise<DatabaseSync> => {
  const file = indexFile(sessionId)
  const db = new DatabaseSync(':memory:')
  try {
    const raw = await readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined
      }
      throw error
    })
    if (raw && raw.length > 0) {
      const plain = isEncrypted(raw) ? decryptBuffer(raw, indexAad(sessionId)) : raw
      db.deserialize(plain)
    }
    db.exec(SCHEMA)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

const saveIndex = async (sessionId: string, db: DatabaseSync): Promise<void> => {
  const bytes = Buffer.from(db.serialize())
  await writeSecure(indexFile(sessionId), bytes, indexAad(sessionId))
}

const readMeta = (db: DatabaseSync, key: string): string | null => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value?: unknown }
    | undefined
  return typeof row?.value === 'string' ? row.value : null
}

const writeMeta = (db: DatabaseSync, key: string, value: string) => {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

const hasFts = (db: DatabaseSync, table: string): boolean => {
  try {
    db.prepare(`SELECT rowid FROM ${table} LIMIT 1`).get()
    return true
  } catch {
    return false
  }
}

const contentText = (content: unknown, depth = 0): string => {
  if (depth > 4) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`[工具 ${block.name}]`)
    } else if (block.type === 'tool_result') {
      parts.push(contentText(block.content, depth + 1))
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      // 不把思维链写入可检索内容，避免把内部推理当作可引用事实
      continue
    }
  }
  return parts.join('\n')
}

type ConversationRow = {
  messageId: string
  role: string
  createdAt: number
  content: string
}

const normalizeConversation = (messages: unknown[]): ConversationRow[] => {
  const rows: ConversationRow[] = []
  messages.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      return
    }
    const message = raw as Record<string, unknown>
    const content = contentText(message.content).trim().slice(0, MAX_MESSAGE_CHARS)
    if (!content) {
      return
    }
    rows.push({
      messageId:
        typeof message.id === 'string' && message.id
          ? message.id
          : `message-${index}`,
      role: typeof message.role === 'string' ? message.role : 'unknown',
      createdAt: typeof message.createdAt === 'number' ? message.createdAt : 0,
      content,
    })
  })
  return rows
}

const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 构建/刷新单个对话的消息索引；stored session 不存在时回退到本次请求的消息快照 */
const buildConversationIndex = async (
  sessionId: string,
  fallbackMessages: unknown[]
): Promise<void> => {
  const stored = await readSession(sessionId)
  const messages = Array.isArray(stored?.messages) ? stored.messages : fallbackMessages
  const rows = normalizeConversation(messages)
  const print = fingerprint(rows)
  const db = await openIndex(sessionId)
  try {
    if (readMeta(db, 'conversation') === print) {
      return
    }
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM conversation_fts')
      const insert = db.prepare(
        'INSERT INTO conversation_fts(content, message_id, role, created_at) VALUES(?, ?, ?, ?)'
      )
      for (const row of rows) {
        insert.run(row.content, row.messageId, row.role, String(row.createdAt))
      }
      writeMeta(db, 'conversation', print)
      db.exec('COMMIT')
      await saveIndex(sessionId, db)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

const isReferenceFile = (filePath: string): boolean => /\.(md|markdown|txt)$/i.test(filePath)

/** 构建/刷新当前会话 references/ 的分块索引 */
const buildReferenceIndex = async (sessionId: string): Promise<void> => {
  const files = (await workspaces.listFilesRecursive(sessionId, 'references')).filter((file) =>
    isReferenceFile(file.path)
  )
  const signature = fingerprint(
    files.map((file) => [file.path, file.size, Math.round(file.mtimeMs)])
  )
  const db = await openIndex(sessionId)
  try {
    if (readMeta(db, 'references') === signature) {
      return
    }
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM references_fts')
      const insert = db.prepare(
        'INSERT INTO references_fts(content, path, chunk_index, start_line, end_line) VALUES(?, ?, ?, ?, ?)'
      )
      for (const file of files) {
        const { content } = await workspaces.readFileFull(sessionId, file.path)
        const chunks = chunkText(content)
        chunks.forEach((chunk, chunkIndex) => {
          if (chunk.content.trim()) {
            insert.run(
              chunk.content,
              file.path,
              String(chunkIndex),
              String(chunk.startLine),
              String(chunk.endLine)
            )
          }
        })
      }
      writeMeta(db, 'references', signature)
      db.exec('COMMIT')
      await saveIndex(sessionId, db)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

/**
 * 同一会话的索引构建/删除串行化：避免两个标签页同时请求时
 * 一个构建 DELETE/INSERT 尚未提交、另一个构建又打开同一 SQLite 文件。
 */
const buildQueues = new Map<string, Promise<unknown>>()
const withBuildLock = <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
  const previous = buildQueues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  buildQueues.set(sessionId, next.catch(() => undefined))
  return next
}

export const ensureConversationIndex = (
  sessionId: string,
  fallbackMessages: unknown[]
): Promise<void> =>
  withBuildLock(sessionId, () => buildConversationIndex(sessionId, fallbackMessages))

export const ensureReferenceIndex = (sessionId: string): Promise<void> =>
  withBuildLock(sessionId, () => buildReferenceIndex(sessionId))

export const ensureIndexes = async (
  sessionId: string,
  messages: unknown[],
  options: IndexOptions
): Promise<void> => {
  if (options.conversation) {
    await ensureConversationIndex(sessionId, messages)
  }
  if (options.references) {
    await ensureReferenceIndex(sessionId)
  }
}

const snippetAround = (content: string, query: string): string => {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_SNIPPET_CHARS) {
    return normalized
  }
  const lower = normalized.toLowerCase()
  const index = lower.indexOf(query.toLowerCase())
  const start = index >= 0 ? Math.max(0, index - 240) : 0
  return `${start > 0 ? '…' : ''}${normalized.slice(start, start + MAX_SNIPPET_CHARS)}${
    start + MAX_SNIPPET_CHARS < normalized.length ? '…' : ''
  }`
}

const ftsQuery = (query: string): string => {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
  return terms.join(' AND ')
}

const likePattern = (query: string): string =>
  `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`

const searchRows = (
  db: DatabaseSync,
  table: 'conversation_fts' | 'references_fts',
  query: string,
  limit: number
): Array<Record<string, unknown>> => {
  const trimmed = query.trim()
  if (!trimmed) {
    return []
  }
  const max = Math.max(1, Math.min(MAX_RESULTS, Math.floor(limit) || 8))
  const fts = ftsQuery(trimmed)
  if (fts && hasFts(db, table)) {
    try {
      const rows = db
        .prepare(
          `SELECT *, snippet(${table}, 0, '', '', '…', 24) AS snippet FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(fts, max) as Array<Record<string, unknown>>
      if (rows.length > 0) {
        return rows
      }
    } catch {
      // 中文短词、标点等情况 FTS 可能无法匹配；回退到 LIKE
    }
  }
  try {
    // FTS 对中文短语/数字单位组合容易漏命中；回退时按空格拆词做 OR，
    // 这样 "CAGR 口径" 不会因为原文没有连续出现整句而返回空。
    const terms = trimmed.split(/\s+/).filter(Boolean).slice(0, 8)
    const where = terms.map(() => `content LIKE ? ESCAPE '\\'`).join(' OR ')
    return db
      .prepare(
        `SELECT * FROM ${table} WHERE ${where} ORDER BY rowid DESC LIMIT ?`
      )
      .all(...terms.map(likePattern), max) as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

export const searchConversation = async (
  sessionId: string,
  query: string,
  limit = 8
): Promise<ConversationHit[]> => {
  const file = indexFile(sessionId)
  await stat(file).catch(() => {
    throw new Error('当前对话尚未建立索引')
  })
  const db = await openIndex(sessionId)
  try {
    const rows = searchRows(db, 'conversation_fts', query, limit)
    return rows.map((row) => ({
      messageId: String(row.message_id ?? ''),
      role: String(row.role ?? ''),
      createdAt: Number(row.created_at ?? 0),
      snippet:
        typeof row.snippet === 'string'
          ? row.snippet
          : snippetAround(String(row.content ?? ''), query),
    }))
  } finally {
    db.close()
  }
}

export const searchReferences = async (
  sessionId: string,
  query: string,
  limit = 8
): Promise<ReferenceHit[]> => {
  const file = indexFile(sessionId)
  await stat(file).catch(() => {
    throw new Error('当前对话尚未建立资料索引')
  })
  const db = await openIndex(sessionId)
  try {
    const rows = searchRows(db, 'references_fts', query, limit)
    return rows.map((row) => ({
      path: String(row.path ?? ''),
      chunkIndex: Number(row.chunk_index ?? 0),
      startLine: Number(row.start_line ?? 0),
      endLine: Number(row.end_line ?? 0),
      snippet:
        typeof row.snippet === 'string'
          ? row.snippet
          : snippetAround(String(row.content ?? ''), query),
    }))
  } finally {
    db.close()
  }
}

/** 删除会话时清理该会话的索引与 WAL 文件；先等待正在进行的构建结束 */
export const deleteSessionIndex = (sessionId: string): Promise<void> =>
  withBuildLock(sessionId, async () => {
    const file = indexFile(sessionId)
    await Promise.all([
      rm(file, { force: true }),
      rm(`${file}-wal`, { force: true }),
      rm(`${file}-shm`, { force: true }),
    ])
  })

/**
 * 启动迁移：历史索引是明文 SQLite 文件。
 * 旧文件处于 WAL 模式，不能直接 deserialize 到内存（会因找不到 -wal 报错），
 * 所以先用文件连接 checkpoint 并切回 DELETE 模式，再序列化成密文。
 * 转换失败的文件直接删除——索引是可重建的派生数据，不能把明文留在盘上。
 */
export const migrateIndexStorage = async (): Promise<number> => {
  await mkdir(INDEX_DIR, { recursive: true })
  const names = await readdir(INDEX_DIR).catch(() => [] as string[])
  let migrated = 0
  for (const name of names) {
    if (!name.endsWith('.sqlite')) {
      continue
    }
    const file = path.join(INDEX_DIR, name)
    const hash = name.slice(0, -'.sqlite'.length)
    const raw = await readFile(file)
    if (isEncrypted(raw)) {
      await Promise.all([
        rm(`${file}-wal`, { force: true }),
        rm(`${file}-shm`, { force: true }),
      ])
      continue
    }
    if (raw.length === 0) {
      await Promise.all([
        rm(file, { force: true }),
        rm(`${file}-wal`, { force: true }),
        rm(`${file}-shm`, { force: true }),
      ])
      continue
    }
    let legacy: DatabaseSync | undefined
    try {
      legacy = new DatabaseSync(file)
      try {
        legacy.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // 非 WAL 数据库会直接报错，忽略即可
      }
      legacy.exec('PRAGMA journal_mode=DELETE')
      const bytes = Buffer.from(legacy.serialize())
      legacy.close()
      legacy = undefined
      await writeSecure(file, bytes, `index:${hash}`)
      migrated += 1
    } catch {
      legacy?.close()
      await rm(file, { force: true })
    } finally {
      await Promise.all([
        rm(`${file}-wal`, { force: true }),
        rm(`${file}-shm`, { force: true }),
      ])
    }
  }
  return migrated
}
