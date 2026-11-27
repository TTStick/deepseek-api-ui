import { create } from 'zustand'
import { getAbortReason, throwIfAborted } from '../../utils/abort.js'
import { createId } from '../../utils/id.js'
import { ApiError, getAgentApiOrigin, streamChat } from '../api/client.js'
import type { ChatModel, CreateMessageRequest } from '../api/types.js'
import { showToast } from '../../components/base/toastState.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import {
  cancelUpload,
  checkImageFileIds,
  describeUploadError,
  uploadAttachment,
  useUploads,
} from '../attachments.js'
import { useSettings } from '../settings.js'
import { isServerApiKeyConfigured } from '../serverKey.js'
import { translate } from '../../i18n/index.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  getReplyText,
  settleReply,
  toCompressMessages,
  toRequestMessages,
} from './reply.js'
import { notifySessionDeleted, notifySessionSaved } from './syncEvents.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSshConfig,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  /** 新对话页的待定偏好：发送首条消息时应用到新会话（不创建、不落盘空会话） */
  pendingAgentEnabled: boolean
  pendingMemory: { read: boolean; write: boolean }
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  pendingAgentEnabled: false,
  pendingMemory: { read: true, write: true },
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort(
    (a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt
  )

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (
  a: Pick<SessionSummary, 'title' | 'createdAt' | 'updatedAt' | 'group' | 'archived' | 'pinned'>,
  b: Pick<SessionSummary, 'title' | 'createdAt' | 'updatedAt' | 'group' | 'archived' | 'pinned'>
) =>
  a.title === b.title &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  a.group === b.group &&
  a.archived === b.archived &&
  a.pinned === b.pinned

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  // 每次落盘都推进更新时间：既用于会话排序，也让服务端同步按后写覆盖判断
  updateSession(sessionId, (session) => ({ ...session, updatedAt: Date.now() }))
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        notifySessionSaved(sessionId)
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search，模型来自设置。 */
const createReply = (): AssistantMessage => {
  const { thinking, search, model } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model,
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
        // 界面就绪后开始与服务端同步会话（未配置服务端时自动静默失败）
        void import('./sync.js')
          .then(({ startSessionSync }) => startSessionSync())
          .catch(() => undefined)
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

/** 回收会话的 agent 工作区与 SSH 连接（fire-and-forget，服务端幂等） */
const cleanupAgentWorkspace = (sessionId: string) => {
  fetch(`${getAgentApiOrigin()}/api/agent/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  }).catch(() => {
    // 清理失败不阻塞删除；服务端重启后残留目录不影响会话隔离
  })
}

/** 切换会话的 agent 模式；关闭时立即回收工作区与 SSH 连接 */
export const setSessionAgentEnabled = (sessionId: string, enabled: boolean) => {
  updateSession(sessionId, (session) => ({
    ...session,
    agentEnabled: enabled,
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  if (!enabled) {
    cleanupAgentWorkspace(sessionId)
  }
}

/** 保存会话的 SSH 主机配置（服务端按配置指纹自动重连，凭据只存本会话） */
export const setSessionSsh = (sessionId: string, ssh: SessionSshConfig | null) => {
  updateSession(sessionId, (session) => ({
    ...session,
    ssh: ssh ?? undefined,
    updatedAt: Date.now(),
  }))
  persist(sessionId)
}

/** 导入单个对话：以新会话加入列表顶部并落盘（附件原件不随文本导入） */
export const importSession = async (session: Session): Promise<string> => {
  if (get().importingHistory) {
    return session.id
  }
  const id = createId()
  const imported: Session = { ...session, id, createdAt: Date.now(), updatedAt: Date.now() }
  set((state) => ({
    sessionCache: { ...state.sessionCache, [id]: imported },
    sessions: sortSessions([toSessionSummary(imported), ...state.sessions]),
  }))
  await db.saveSession(imported, [])
  notifySessionSaved(imported.id)
  return id
}

/**
 * 回溯对话：截断该消息之后的所有内容（Hermes /rewind 语义），
 * 该消息成为当前路径的终点，之后可以继续发送新消息。
 */
export const rewindSession = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId) || get().streaming[sessionId]) {
    return
  }
  const session = getSession(sessionId)
  if (!session) {
    return
  }
  const index = session.messages.findIndex((message) => message.id === messageId)
  if (index < 0) {
    return
  }
  const messages = session.messages.slice(0, index + 1)
  messages[index] = { ...messages[index], selectedChildId: undefined }
  updateSession(sessionId, (current) => ({
    ...current,
    messages,
    updatedAt: Date.now(),
  }))
  persist(sessionId)
}

/** 新对话页的待定 agent 开关（发送首条消息时应用，不创建空会话） */
export const setPendingAgentEnabled = (enabled: boolean) => {
  set({ pendingAgentEnabled: enabled })
}

/** 新对话页的待定记忆权限（发送首条消息时应用） */
export const setPendingMemory = (read: boolean, write: boolean) => {
  set({ pendingMemory: { read, write } })
}

/** 手动压缩当前会话的中段轮次（头部按钮 / /compress 命令）；压缩开关关闭或轮次太少时忽略 */
export const compressSession = async (sessionId: string) => {  const state = get()
  const session = getSession(sessionId)
  if (!session || state.streaming[sessionId]) {
    return
  }
  const { apiKey, compressionEnabled } = useSettings.getState()
  if ((!apiKey && !isServerApiKeyConfigured()) || !compressionEnabled) {
    return
  }
  const history = getVisibleMessages(session)
  const rounds = getContextRounds(history, session.compression?.archivedRounds ?? 0).length
  if (rounds < 4) {
    showToast({ key: 'compressNothingToDo' })
    return
  }
  const messages = toCompressMessages(history, session.compression)
  try {
    const response = await fetch(`${getAgentApiOrigin()}/api/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        sessionId,
        messages,
        // 不传 thresholdTokens：force 模式跳过触发门，尾部预算按后端默认阈值计算
        compression: { enabled: true },
      }),
    })
    const result = (await response.json()) as {
      compressed?: boolean
      summary?: string
      archiveRounds?: number
    }
    if (result.compressed && result.summary && result.archiveRounds) {
      const summaryRow = result.summary
      const archiveRounds = result.archiveRounds
      updateSession(sessionId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        compression: {
          summaryRow,
          archivedRounds: (current.compression?.archivedRounds ?? 0) + archiveRounds,
          updatedAt: Date.now(),
        },
      }))
      showToast({ key: 'compressDone', params: { count: archiveRounds } })
    } else {
      showToast({ key: 'compressNothingToDo' })
    }
  } catch {
    showToast({ key: 'compressFailed', type: 'error' })
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    const now = Date.now()
    set((state) => ({
      sessions: sortSessions(
        state.sessions.map((session) =>
          session.id === id ? { ...session, title, updatedAt: now } : session
        )
      ),
    }))
    void db
      .patchSessionMeta(id, (session) => {
        session.title = title
        session.updatedAt = now
      })
      .catch(db.reportStorageError('rename session'))
  }
}

/** 移动会话到分组（null 为移出分组） */
export const setSessionGroup = (id: string, group: string | null) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, group: group ?? undefined }))
    persist(id)
  } else {
    const now = Date.now()
    set((state) => ({
      sessions: sortSessions(
        state.sessions.map((session) =>
          session.id === id
            ? { ...session, group: group ?? undefined, updatedAt: now }
            : session
        )
      ),
    }))
    void db
      .patchSessionMeta(id, (session) => {
        session.group = group ?? undefined
        session.updatedAt = now
      })
      .catch(db.reportStorageError('set session group'))
  }
}

/** 设置本对话的记忆权限（read 读取历史记忆 / write 写入新记忆） */
export const setSessionMemory = (id: string, read: boolean, write: boolean) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const memory = { read, write }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, memory }))
    persist(id)
  } else {
    const now = Date.now()
    set((state) => ({
      sessions: sortSessions(
        state.sessions.map((session) =>
          session.id === id ? { ...session, updatedAt: now } : session
        )
      ),
    }))
    void db
      .patchSessionMeta(id, (session) => {
        session.memory = memory
        session.updatedAt = now
      })
      .catch(db.reportStorageError('set session memory'))
  }
}

/** 置顶 / 取消置顶会话（置顶后排在列表最前） */
export const setSessionPinned = (id: string, pinned: boolean) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, pinned }))
    persist(id)
  } else {
    const now = Date.now()
    set((state) => ({
      sessions: sortSessions(
        state.sessions.map((session) =>
          session.id === id ? { ...session, pinned, updatedAt: now } : session
        )
      ),
    }))
    void db
      .patchSessionMeta(id, (session) => {
        session.pinned = pinned
        session.updatedAt = now
      })
      .catch(db.reportStorageError('set session pinned'))
  }
}

/**
 * 复制对话：深拷贝全部消息与分支（id 全部重映射），附件沿用原件的本地引用（原件共享、按引用计数清理）。
 * 保留标题（加副本后缀）、分组、记忆权限、压缩状态与 agent 开关；
 * 不复制 SSH 凭据、置顶与归档状态，agent 交付事件（指向原工作区文件）一并清除。
 */
export const duplicateSession = async (id: string): Promise<string | null> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return null
  }
  const loaded = getSession(id) ?? (await db.loadSession(id).catch(() => undefined))
  const source = loaded ? normalizeSession(loaded) : undefined
  if (!source || source.messages.length === 0) {
    return null
  }
  const idMap = new Map<string, string>()
  for (const message of source.messages) {
    idMap.set(message.id, createId())
  }
  const remap = (messageId: string | null | undefined): string | undefined =>
    messageId ? (idMap.get(messageId) ?? messageId) : undefined
  const messages = source.messages.map((message) => ({
    ...message,
    id: idMap.get(message.id) as string,
    parentId: remap(message.parentId),
    selectedChildId: remap(message.selectedChildId),
    // 交付事件指向原会话工作区文件，复制后不可用
    agentEvents: undefined,
  }))
  const now = Date.now()
  const duplicated: Session = {
    ...source,
    id: createId(),
    title: `${source.title}${translate('sessionCopySuffix')}`,
    createdAt: now,
    updatedAt: now,
    messages,
    rootMessageId: remap(source.rootMessageId),
    pinned: undefined,
    archived: undefined,
    ssh: undefined,
  }
  set((state) => ({
    sessionCache: { ...state.sessionCache, [duplicated.id]: duplicated },
    sessions: sortSessions([toSessionSummary(duplicated), ...state.sessions]),
  }))
  await db.saveSession(duplicated, [])
  notifySessionSaved(duplicated.id)
  return duplicated.id
}

/** 归档 / 取消归档会话（归档后移到侧边栏底部折叠区） */
export const setSessionArchived = (id: string, archived: boolean) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, archived }))
    persist(id)
  } else {
    const now = Date.now()
    set((state) => ({
      sessions: sortSessions(
        state.sessions.map((session) =>
          session.id === id ? { ...session, archived, updatedAt: now } : session
        )
      ),
    }))
    void db
      .patchSessionMeta(id, (session) => {
        session.archived = archived
        session.updatedAt = now
      })
      .catch(db.reportStorageError('set session archived'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    // 会话删除即回收其 agent 工作区与 SSH 连接（对话资源不跨会话）
    void cleanupAgentWorkspace(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    notifySessionDeleted(id)
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/** 服务端同步：把远端会话写入本地状态（调用方负责先写 IndexedDB），不触发反向推送 */
export const applySyncedSession = (session: Session): boolean => {
  if (get().importingHistory || get().streaming[session.id]) {
    return false
  }
  touchSession(session.id)
  set((state) => ({
    sessionCache: { ...state.sessionCache, [session.id]: session },
    sessions: sortSessions([
      ...state.sessions.filter((summary) => summary.id !== session.id),
      toSessionSummary(session),
    ]),
  }))
  return true
}

/** 服务端墓碑同步：只删除本地副本，不回调删除通知（避免把删除再次发回服务端） */
export const removeSyncedSession = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    await waitForIdle(id)
    await db.deleteSession(id)
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete synced session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
  }
}

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
      // 新对话页配置的待定偏好：首条消息时应用到新会话
      agentEnabled: get().pendingAgentEnabled,
      memory: { ...get().pendingMemory },
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
      // 待定偏好消费后复位
      pendingAgentEnabled: false,
      pendingMemory: { read: true, write: true },
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      // 草稿附件已上传成功，每张图片都在上传前检查过长边，超限的已缩小。
      imageSizeChecked: isImage,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? MODEL,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/**
 * 将 serverId 写回所有引用同一附件的消息。传入 null 会清除超限旧图的 ID，触发补传。
 * 尺寸标记随有效 ID 保存，因为本地保留的是原图，刷新后可以直接复用已检查的上传副本。
 */
const saveServerIds = (sessionId: string, serverIds: ReadonlyMap<string, string | null>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) => {
              const serverId = serverIds.get(file.id)
              return serverId === undefined
                ? file
                : { ...file, serverId, imageSizeChecked: file.isImage && serverId !== null }
            }),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(getAbortReason(signal)), { once: true })
  })
  // 旧图片超限时先清除 ID，交给下方已有的附件补传流程。
  const files = [
    ...request.question.files,
    ...getContextRounds(request.history).flatMap(([user]) => user.files),
  ]
  const checked = await Promise.race([checkImageFileIds(files, signal), aborted])
  if (checked.size > 0) {
    saveServerIds(sessionId, checked)
    request = refreshRequest(sessionId, request)
  }
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId && serverId !== file.serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).reverse()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    throwIfAborted(signal)
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      throwIfAborted(signal)
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/** 提问转纯文本（写入记忆后端用）：正文 + 附件名清单 */
const describeQuestion = (question: UserMessage): string => {
  const parts = [question.content]
  if (question.files.length) {
    parts.push(question.files.map((file) => `[附件: ${file.name}]`).join(' '))
  }
  return parts.filter(Boolean).join('\n')
}

/** 轮次收尾后通知后端写入记忆并后台刷新召回（fire-and-forget） */
const notifyTurnComplete = (
  sessionId: string,
  apiKey: string,
  turn: { query: string; userContent: string; assistantContent: string }
) => {
  fetch(`${getAgentApiOrigin()}/api/chat/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, sessionId, ...turn }),
    keepalive: true,
  }).catch(() => {
    // 记忆写入失败不影响聊天主流程，后端会记录状态
  })
}

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const startedAt = Date.now()
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  /** 成功收尾的轮次内容，finally 里通知后端写入记忆 */
  let completedTurn: { query: string; userContent: string; assistantContent: string } | null = null
  /** 本轮提问的纯文本，供 catch 分支使用（prepared 声明在 try 内不可见） */
  let questionText = ''
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        questionText = describeQuestion(prepared.question)
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const compression = getSession(sessionId)?.compression
        const messages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder,
          compression
            ? { summaryRow: compression.summaryRow, archivedRounds: compression.archivedRounds }
            : undefined
        )
        const events = streamChat(
          {
            apiKey: useSettings.getState().apiKey ?? '',
            sessionId,
            request: {
              model: initial.model ?? MODEL,
              system: SYSTEM_PROMPT,
              messages,
              thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
              safety_check: SAFETY_CHECK,
              tools: serverTools(initial.search ?? false),
              ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
            },
            // 记忆开关：全局总开关 + 本对话的读/写权限（缺省均允许）
            memory: {
              enabled: useSettings.getState().memoryEnabled,
              read: getSession(sessionId)?.memory?.read ?? true,
              write: getSession(sessionId)?.memory?.write ?? true,
            },
            compression: { enabled: useSettings.getState().compressionEnabled },
            agent: {
              enabled: getSession(sessionId)?.agentEnabled ?? false,
              ssh: getSession(sessionId)?.ssh,
            },
          },
          controller.signal
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          // 记忆召回是后端追加的元事件：存入回复供展示面板渲染，不参与块合并
          if (event.type === 'memory_recall') {
            reply = {
              ...reply,
              recalledMemory: {
                injected: event.injected,
                sections: event.sections,
                dialectic: event.dialectic,
              },
            }
            continue
          }
          // 上下文压缩：更新会话的摘要行与归档轮数，展示层据此渲染分隔条
          if (event.type === 'context_compressed') {
            if (event.archiveRounds > 0 && event.summary) {
              updateSession(sessionId, (session) => ({
                ...session,
                updatedAt: Date.now(),
                compression: {
                  summaryRow: event.summary,
                  archivedRounds: (session.compression?.archivedRounds ?? 0) + event.archiveRounds,
                  updatedAt: Date.now(),
                },
              }))
            }
            continue
          }
          // agent 工具活动与交付物：累积进回复，供消息内时间线渲染
          if (event.type === 'agent_tool') {
            reply = {
              ...reply,
              agentEvents: [
                ...(reply.agentEvents ?? []),
                {
                  kind: 'tool',
                  toolUseId: event.toolUseId,
                  name: event.name,
                  input: JSON.stringify(event.input ?? {}, null, 2),
                  status: 'running',
                },
              ],
            }
            continue
          }
          if (event.type === 'agent_tool_result') {
            reply = {
              ...reply,
              agentEvents: (reply.agentEvents ?? []).map((entry) =>
                entry.kind === 'tool' && entry.toolUseId === event.toolUseId
                  ? { ...entry, status: 'done', output: event.output, isError: event.isError }
                  : entry
              ),
            }
            continue
          }
          if (event.type === 'agent_artifact') {
            reply = {
              ...reply,
              agentEvents: [
                ...(reply.agentEvents ?? []),
                { kind: 'artifact', path: event.path, action: event.action, size: event.size },
              ],
            }
            continue
          }
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        completedTurn = {
          query: questionText,
          userContent: questionText,
          assistantContent: getReplyText(reply),
        }
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
          completedTurn = {
            query: questionText,
            userContent: questionText,
            assistantContent: getReplyText(reply),
          }
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    // 记录本轮生成耗时（续写累加），供 token 速度统计使用
    reply = {
      ...reply,
      elapsedMs: (reply.elapsedMs ?? 0) + Math.max(0, Date.now() - startedAt),
    }
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
    // 轮次成功收尾后通知后端：写入记忆 + 后台刷新下一轮召回（本对话写入权限关闭时跳过）
    if (
      completedTurn &&
      useSettings.getState().memoryEnabled &&
      (getSession(sessionId)?.memory?.write ?? true)
    ) {
      notifyTurnComplete(sessionId, useSettings.getState().apiKey ?? '', completedTurn)
    }
  }
}
