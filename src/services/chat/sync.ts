import { AUTH_REQUIRED_EVENT } from '../auth.js'
import { getAgentApiOrigin } from '../api/client.js'
import * as db from './db.js'
import { applySyncedSession, removeSyncedSession, useChatStore } from './store.js'
import { setSessionSyncListeners } from './syncEvents.js'
import type { Session, SessionSummary } from './types.js'

/**
 * 会话同步：服务端保存唯一一份对话，网页端与手机端启动/定时拉取、保存后推送。
 * - 以 updatedAt 做后写覆盖；元数据（标题/分组/归档/置顶）变化也会被比较并推送
 * - 删除先删本地再写服务端墓碑；离线删除记录在 localStorage，联网后补发
 * - 拉取到服务端更新时直接替换本地缓存，正在流式生成的会话暂不覆盖
 */

type ServerSummary = SessionSummary & { messageCount?: number }
type Tombstone = { id: string; deletedAt: number }
type SyncList = { sessions: ServerSummary[]; deleted: Tombstone[] }

const PENDING_KEY = 'myagent:pending-session-deletes'
const PUSH_DELAY_MS = 1_200
const SYNC_INTERVAL_MS = 30_000

let started = false
let running: Promise<void> | null = null
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
let pendingDeletes = new Map<string, number>()
let nextSyncTimer: ReturnType<typeof setTimeout> | null = null

const loadPending = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as unknown
    if (Array.isArray(parsed)) {
      pendingDeletes = new Map(
        parsed.filter(
          (item): item is [string, number] =>
            Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number'
        )
      )
    }
  } catch {
    pendingDeletes = new Map()
  }
}

const savePending = () => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify([...pendingDeletes.entries()]))
  } catch {
    // 存储不可用时仅当前会话内生效
  }
}

const api = async (path: string, init?: RequestInit): Promise<Response> => {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) }
  // DELETE 没有请求体；只在实际发送 JSON 时声明 Content-Type
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  const response = await fetch(`${getAgentApiOrigin()}/api${path}`, {
    credentials: 'include',
    ...init,
    headers,
  })
  if (response.status === 401) {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
  }
  return response
}

const fetchList = async (): Promise<SyncList | null> => {
  const response = await api('/sessions')
  if (!response.ok) {
    return null
  }
  const body = (await response.json()) as Partial<SyncList>
  return {
    sessions: Array.isArray(body.sessions) ? body.sessions : [],
    deleted: Array.isArray(body.deleted) ? body.deleted : [],
  }
}

const fetchSession = async (id: string): Promise<Session | null> => {
  const response = await api(`/sessions/${encodeURIComponent(id)}`)
  if (!response.ok) {
    return null
  }
  return (await response.json()) as Session
}

const canPush = () => {
  const state = useChatStore.getState()
  return state.ready && !state.importingHistory
}

const pushSession = async (id: string): Promise<void> => {
  if (!canPush() || useChatStore.getState().streaming[id]) {
    return
  }
  const state = useChatStore.getState()
  const session =
    state.sessionCache[id] ?? (await db.loadSession(id).catch(() => undefined))
  if (!session) {
    return
  }
  try {
    // SSH 凭据只留在本机浏览器，不上传
    const payload = { ...session } as Record<string, unknown>
    delete payload.ssh
    const response = await api(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ session: payload }),
    })
    if (!response.ok) {
      return
    }
    const result = (await response.json()) as { applied?: boolean; summary?: ServerSummary }
    if (result.applied === false && result.summary) {
      // 服务端已有更新版本：拉回覆盖本地（正在生成时跳过）
      if (useChatStore.getState().streaming[id]) {
        return
      }
      const remote = await fetchSession(id)
      if (remote) {
        await db.saveSession(remote, [])
        applySyncedSession(remote)
      }
    }
  } catch {
    // 网络失败：等下一次同步
  }
}

const queuePush = (id: string) => {
  const existing = pushTimers.get(id)
  if (existing) {
    clearTimeout(existing)
  }
  pushTimers.set(
    id,
    setTimeout(() => {
      pushTimers.delete(id)
      void pushSession(id)
    }, PUSH_DELAY_MS)
  )
}

const queueDelete = (id: string) => {
  pendingDeletes.set(id, Date.now())
  savePending()
  void flushPendingDeletes()
}

const flushPendingDeletes = async () => {
  for (const [id] of [...pendingDeletes.entries()]) {
    try {
      const response = await api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (response.ok || response.status === 404) {
        pendingDeletes.delete(id)
        savePending()
      }
    } catch {
      // 离线：保留待删除记录
    }
  }
}

const applyRemote = async (session: Session) => {
  if (pendingDeletes.has(session.id) || useChatStore.getState().streaming[session.id]) {
    return
  }
  // 服务端不保存 SSH 凭据；用本地配置补回，避免同步后丢失
  const remote = { ...session }
  delete (remote as { ssh?: unknown }).ssh
  const local =
    useChatStore.getState().sessionCache[session.id] ??
    (await db.loadSession(session.id).catch(() => undefined))
  const merged = local?.ssh ? { ...remote, ssh: local.ssh } : remote
  await db.saveSession(merged, [])
  applySyncedSession(merged)
}

const summaryDiffers = (local: SessionSummary, remote: ServerSummary): boolean =>
  local.title !== remote.title ||
  (local.group ?? '') !== (remote.group ?? '') ||
  Boolean(local.archived) !== Boolean(remote.archived) ||
  Boolean(local.pinned) !== Boolean(remote.pinned) ||
  (local.compressedRounds ?? 0) !== (remote.compressedRounds ?? 0)

const runSync = async (): Promise<void> => {
  if (!canPush()) {
    return
  }
  await flushPendingDeletes()
  const list = await fetchList()
  if (!list || !canPush()) {
    return
  }
  const state = useChatStore.getState()
  const local = new Map(state.sessions.map((session) => [session.id, session]))
  const remote = new Map(list.sessions.map((session) => [session.id, session]))
  const tombstones = new Map(list.deleted.map((item) => [item.id, item.deletedAt]))

  for (const [id, deletedAt] of tombstones) {
    if (pendingDeletes.has(id)) {
      continue
    }
    const summary = local.get(id)
    if (!summary) {
      continue
    }
    if (summary.updatedAt > deletedAt) {
      // 本地在删除之后仍有编辑：重新上传，让会话复活
      await pushSession(id)
    } else {
      await removeSyncedSession(id)
      local.delete(id)
    }
  }

  for (const meta of list.sessions) {
    if (tombstones.has(meta.id) || pendingDeletes.has(meta.id)) {
      continue
    }
    const summary = local.get(meta.id)
    if (!summary) {
      const session = await fetchSession(meta.id)
      if (session) {
        await applyRemote(session)
      }
      continue
    }
    if (meta.updatedAt > summary.updatedAt) {
      const session = await fetchSession(meta.id)
      if (session) {
        await applyRemote(session)
      }
    } else if (summary.updatedAt > meta.updatedAt || summaryDiffers(summary, meta)) {
      await pushSession(meta.id)
    }
  }

  for (const summary of local.values()) {
    if (!remote.has(summary.id) && !tombstones.has(summary.id) && !pendingDeletes.has(summary.id)) {
      await pushSession(summary.id)
    }
  }
}

export const syncSessions = (): Promise<void> => {
  if (running) {
    return running
  }
  running = runSync()
    .catch(() => {
      // 离线或服务端未启动：保持本地可用，稍后重试
    })
    .finally(() => {
      running = null
    })
  return running
}

const scheduleSync = (delay = 0) => {
  if (nextSyncTimer) {
    return
  }
  nextSyncTimer = setTimeout(() => {
    nextSyncTimer = null
    void syncSessions()
  }, delay)
}

export const startSessionSync = () => {
  if (started) {
    return
  }
  started = true
  loadPending()
  setSessionSyncListeners({ saved: queuePush, deleted: queueDelete })
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => scheduleSync())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleSync()
      }
    })
    setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void syncSessions()
      }
    }, SYNC_INTERVAL_MS)
  }
  scheduleSync(300)
}
