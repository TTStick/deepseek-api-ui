import type { Session, SessionSummary } from './types.js'

/**
 * 会话列表级元数据旁路存储。
 * Android 原生 SQLite 的 summaries 表只保存 id/title/时间，分组、归档等字段仅存在于完整会话 JSON 里；
 * 为了在未打开会话时也能正确分区，这里用 localStorage 保存一份轻量索引（与原生存储同生命周期）。
 */
export type SessionListMeta = Pick<
  Session,
  'group' | 'archived' | 'agentEnabled' | 'memory' | 'compressionEnabled'
> & { compressedRounds?: number; title?: string; updatedAt?: number }

const KEY = 'myagent:session-list-meta'
let cache: Record<string, SessionListMeta> | null = null

const load = (): Record<string, SessionListMeta> => {
  if (cache) {
    return cache
  }
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as unknown
    cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, SessionListMeta>) : {}
  } catch {
    cache = {}
  }
  return cache
}

const save = () => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(cache ?? {}))
  } catch {
    // 存储不可用时退化为仅当前会话有效。
  }
}

/** 只保留已定义字段，避免把 undefined 覆盖到已有元数据。 */
export const pickSessionMeta = (session: Session): SessionListMeta => {
  const meta: SessionListMeta = {}
  if (session.group !== undefined) {
    meta.group = session.group
  }
  if (session.archived !== undefined) {
    meta.archived = session.archived
  }
  if (session.agentEnabled !== undefined) {
    meta.agentEnabled = session.agentEnabled
  }
  if (session.memory !== undefined) {
    meta.memory = session.memory
  }
  if (session.compressionEnabled !== undefined) {
    meta.compressionEnabled = session.compressionEnabled
  }
  if (session.compression?.archivedRounds) {
    meta.compressedRounds = session.compression.archivedRounds
  }
  return meta
}

export const readSessionMetas = (): Record<string, SessionListMeta> => load()

export const writeSessionMeta = (id: string, meta: SessionListMeta) => {
  const all = load()
  const merged = { ...all[id], ...meta }
  all[id] = merged
  save()
}

export const clearSessionMeta = (id: string) => {
  const all = load()
  if (Object.hasOwn(all, id)) {
    delete all[id]
    save()
  }
}

/** 把旁路元数据合并回列表摘要（原生存储读出的摘要缺少这些字段）。 */
export const applySessionMeta = (summaries: SessionSummary[]): SessionSummary[] => {
  const all = readSessionMetas()
  return summaries.map((summary) => {
    const meta = all[summary.id]
    if (!meta) {
      return summary
    }
    const next: SessionSummary = { ...summary }
    if (meta.group !== undefined) {
      next.group = meta.group
    }
    if (meta.archived !== undefined) {
      next.archived = meta.archived
    }
    if (meta.compressedRounds !== undefined) {
      next.compressedRounds = meta.compressedRounds
    }
    return next
  })
}
