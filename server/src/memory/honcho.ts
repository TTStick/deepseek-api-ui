import { createHash } from 'node:crypto'
import { HonchoClient, getHonchoClient, type SessionContext } from '../honcho/api.js'
import { env } from '../env.js'
import { buildMemoryContextBlock, sanitizeContext } from './fence.js'
import { isTrivialPrompt } from './trivial.js'
import { rewriteMemoryQuery } from './queryRewrite.js'

/**
 * Honcho 记忆 provider（移植 hermes-plugin-honcho 的行为，单用户简化版）：
 * - session 名 = 前端 sessionId slug 化；user/agent 双 peer
 * - 每轮召回两层：基础上下文层（session summary + 用户 representation/card + AI 自画像）+
 *   辩证法层（peer.chat 后台推理，默认 depth 1，空结果 streak 退避，超龄结果丢弃）
 * - 每轮写入：batch add_messages（fence 清洗 + 分块），全部 fail-open——Honcho 不可用时聊天照常
 */

const USER_PEER = 'user'
const AGENT_PEER = 'myagent'
const WORKSPACE = env.honchoWorkspace

// 与 hermes-plugin-honcho 对齐的默认参数
const CONTEXT_TOKENS = Number(process.env.HONCHO_CONTEXT_TOKENS ?? 2000)
const CONTEXT_CHAR_BUDGET = CONTEXT_TOKENS * 4 // 约 4 字符/token
const DIALECTIC_MAX_CHARS = Number(process.env.HONCHO_DIALECTIC_MAX_CHARS ?? 600)
const DIALECTIC_CADENCE = Number(process.env.HONCHO_DIALECTIC_CADENCE ?? 1)
const MESSAGE_MAX_CHARS = 25_000 // Honcho 云上限，本地同样适用
const STALE_RESULT_MULTIPLIER = 2
const BACKOFF_MAX = 8
const FIRST_TURN_BASE_TIMEOUT_MS = 2_500
const LEVEL_ORDER = ['minimal', 'low', 'medium', 'high', 'max'] as const
type ReasoningLevel = (typeof LEVEL_ORDER)[number]

const slugify = (value: string): string => {
  const slug = value.replace(/[^a-zA-Z0-9_-]+/g, '-')
  if (slug.length <= 100) {
    return slug
  }
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `${slug.slice(0, 100 - suffix.length - 1)}-${suffix}`
}

/** 剥掉 <think> 块与规划文本（usable_honcho_summary 的等价物） */
const usableSummary = (summary: string | undefined | null): string => {
  if (!summary) {
    return ''
  }
  const cleaned = summary.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // 摘要以规划口吻开头（"Let me think about..."）时视为脏摘要丢弃
  if (/^(?:let me think|i should|first,|okay, let)/i.test(cleaned)) {
    return ''
  }
  return cleaned
}

/** 词边界截断 + " …"（_truncate_to_budget 的等价物） */
const truncateToBudget = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text
  }
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  const head = lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut
  return `${head.trimEnd()} …`
}

/** 超长消息按段落 → 句号 → 单词边界切块，续块带 [continued] 前缀（_chunk_message） */
const chunkMessage = (content: string): string[] => {
  if (content.length <= MESSAGE_MAX_CHARS) {
    return [content]
  }
  const chunks: string[] = []
  let rest = content
  while (rest.length > MESSAGE_MAX_CHARS) {
    const window = rest.slice(0, MESSAGE_MAX_CHARS)
    let split = window.lastIndexOf('\n\n')
    if (split < MESSAGE_MAX_CHARS * 0.5) {
      split = window.lastIndexOf('. ')
    }
    if (split < MESSAGE_MAX_CHARS * 0.5) {
      split = window.lastIndexOf(' ')
    }
    if (split < 1) {
      split = MESSAGE_MAX_CHARS
    }
    chunks.push(window.slice(0, split))
    rest = `[continued] ${rest.slice(split).trimStart()}`
  }
  if (rest) {
    chunks.push(rest)
  }
  return chunks
}

export type RecallSection = { title: string; content: string }

export type RecallInfo = {
  /** 注入请求的完整围栏块（无内容时为空串） */
  block: string
  /** 各段内容，供前端「本轮召回」面板展示 */
  sections: RecallSection[]
  /** 辩证法推理结果（就绪且未超龄才注入） */
  dialectic: string
  injected: boolean
}

type BaseCache = {
  summary?: string
  userRepresentation?: string
  userCard?: string[]
  aiRepresentation?: string
  aiCard?: string[]
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export class HonchoMemory {
  private readonly client: HonchoClient
  private readonly ensured = new Map<string, boolean>()
  private readonly baseCaches = new Map<string, BaseCache>()
  private readonly pendingDialectics = new Map<string, { content: string; firedAt: number }>()
  private readonly turnCounts = new Map<string, number>()
  private readonly emptyStreaks = new Map<string, number>()
  private readonly nextDialecticDue = new Map<string, number>()
  private readonly dialecticTokens = new Map<string, symbol>()
  private lastError: string | null = null
  private health: boolean | null = null

  constructor() {
    this.client = getHonchoClient()
  }

  get workspace(): string {
    return WORKSPACE
  }

  /** 是否配置了记忆服务（HONCHO_BASE_URL 为空时全部功能旁路） */
  enabled(): boolean {
    return Boolean(env.honchoBaseUrl)
  }

  /** 确保 workspace/session/peers 存在（幂等，失败 fail-open） */
  private async ensure(sessionId: string): Promise<void> {
    const sessionKey = slugify(sessionId)
    if (this.ensured.has(sessionKey)) {
      return
    }
    try {
      await this.client.ensureWorkspace(WORKSPACE)
      await this.client.ensurePeer(WORKSPACE, USER_PEER)
      await this.client.ensurePeer(WORKSPACE, AGENT_PEER)
      await this.client.ensureSession(WORKSPACE, sessionKey)
      // 关闭 observe：scope 观察会触发 deriver 的 embedding 链路（OpenAI 不可达），
      // 我们只依赖 LLM 推导的 representation/dialectic，不需要观察关系。
      await this.client.addPeers(WORKSPACE, sessionKey, {
        [USER_PEER]: { observe_me: false, observe_others: false },
        [AGENT_PEER]: { observe_me: false, observe_others: false },
      })
      this.ensured.set(sessionKey, true)
      this.lastError = null
      this.health = true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.health = false
    }
  }

  /** 基础上下文层：session summary + 用户 representation/card + AI 自画像 */
  private async fetchBase(sessionId: string, query: string): Promise<BaseCache> {
    const sessionKey = slugify(sessionId)
    const fetchTasks = async (): Promise<BaseCache> => {
      const [sessionCtx, userCtx, aiCtx] = await Promise.all([
        this.client.sessionContext(WORKSPACE, sessionKey, {
          summary: true,
          tokens: CONTEXT_TOKENS,
          search_query: query.slice(0, 4000),
          peer_target: USER_PEER,
          search_top_k: 8,
        }),
        this.client.peerContext(WORKSPACE, USER_PEER, { search_query: query.slice(0, 4000) }).catch(
          () => ({ representation: null, peer_card: null })
        ),
        this.client.peerContext(WORKSPACE, AGENT_PEER, {}).catch(() => ({
          representation: null,
          peer_card: null,
        })),
      ])
      const base: BaseCache = {
        summary: usableSummary((sessionCtx as SessionContext).summary?.text),
        userRepresentation: userCtx.representation ?? undefined,
        userCard: userCtx.peer_card ?? undefined,
        aiRepresentation: aiCtx.representation ?? undefined,
        aiCard: aiCtx.peer_card ?? undefined,
      }
      return base
    }
    const result = await withTimeout(fetchTasks(), FIRST_TURN_BASE_TIMEOUT_MS)
    if (result) {
      this.baseCaches.set(sessionKey, result)
    }
    return result ?? {}
  }

  /** 辩证法：reasoning level 按查询长度启发式（≥120 +1、≥400 +2），封顶 high */
  private resolveReasoningLevel(query: string): ReasoningLevel {
    const baseIndex = LEVEL_ORDER.indexOf('low')
    const bump = query.length < 120 ? 0 : query.length < 400 ? 1 : 2
    const capIndex = LEVEL_ORDER.indexOf('high')
    return LEVEL_ORDER[Math.min(baseIndex + bump, capIndex)]
  }

  /** 空结果 streak 退避：min(cadence + streak, cadence × 8) */
  private effectiveCadence(sessionKey: string): number {
    const streak = this.emptyStreaks.get(sessionKey) ?? 0
    const cadence = DIALECTIC_CADENCE
    return streak > 0 ? Math.min(cadence + streak, cadence * BACKOFF_MAX) : cadence
  }

  /** 后台跑一轮辩证法（depth 1），带换代 token 防旧结果发布 */
  private async runDialectic(sessionId: string, query: string, apiKey: string, firedAt: number) {
    const sessionKey = slugify(sessionId)
    const token = Symbol('dialectic')
    this.dialecticTokens.set(sessionKey, token)
    try {
      const isCold = !this.baseCaches.has(sessionKey)
      let prompt: string
      if (isCold) {
        const rewritten = await rewriteMemoryQuery(apiKey, query)
        prompt =
          rewritten ||
          'Who is this person? What are their preferences, goals, and working style? ' +
            'Focus on facts that would help an AI assistant be immediately useful.'
      } else {
        prompt =
          "Given what's been discussed in this session so far, what context about this user is most " +
          'relevant to the current conversation? Prioritize active context over biographical facts.'
      }
      const level = this.resolveReasoningLevel(query)
      const result = await this.client.peerChat(WORKSPACE, USER_PEER, {
        session_id: sessionKey,
        target: USER_PEER,
        query: prompt,
        stream: false,
        reasoning_level: level,
      })
      if (this.dialecticTokens.get(sessionKey) !== token) {
        return // 被更新的轮次取代，结果丢弃
      }
      const content = result.content?.trim() ?? ''
      if (content) {
        this.pendingDialectics.set(sessionKey, {
          content: truncateToBudget(content, DIALECTIC_MAX_CHARS),
          firedAt,
        })
        this.emptyStreaks.set(sessionKey, 0)
        this.nextDialecticDue.set(sessionKey, firedAt + DIALECTIC_CADENCE)
      } else {
        this.emptyStreaks.set(sessionKey, (this.emptyStreaks.get(sessionKey) ?? 0) + 1)
        this.nextDialecticDue.set(sessionKey, firedAt + this.effectiveCadence(sessionKey))
      }
    } catch {
      // 失败只加宽退避，不影响主流程（auth 失败等待也无济于事，同样归入退避）
      this.emptyStreaks.set(sessionKey, (this.emptyStreaks.get(sessionKey) ?? 0) + 1)
      this.nextDialecticDue.set(sessionKey, firedAt + this.effectiveCadence(sessionKey))
    }
  }

  /** 每轮召回入口：基础层 + 就绪的辩证法结果，格式化为围栏块 */
  async recall(sessionId: string, query: string): Promise<RecallInfo> {
    if (isTrivialPrompt(query) || !env.honchoBaseUrl) {
      return { block: '', sections: [], dialectic: '', injected: false }
    }
    await this.ensure(sessionId)
    const sessionKey = slugify(sessionId)
    let base = this.baseCaches.get(sessionKey)
    if (!base) {
      base = await this.fetchBase(sessionId, query)
    }
    const turn = this.turnCounts.get(sessionKey) ?? 0
    const pending = this.pendingDialectics.get(sessionKey)
    let dialectic = ''
    if (pending) {
      const staleLimit = DIALECTIC_CADENCE * STALE_RESULT_MULTIPLIER
      if (turn - pending.firedAt > staleLimit) {
        this.pendingDialectics.delete(sessionKey)
      } else {
        dialectic = pending.content
        this.pendingDialectics.delete(sessionKey)
      }
    }

    const sections: RecallSection[] = []
    const push = (title: string, content: string) => {
      if (content.trim()) {
        sections.push({ title, content: content.trim() })
      }
    }
    push('Session Summary', base.summary ?? '')
    push('User Representation', base.userRepresentation ?? '')
    if (base.userCard?.length) {
      push('User Peer Card', base.userCard.map((item) => `- ${item}`).join('\n'))
    }
    push('AI Self-Representation', base.aiRepresentation ?? '')
    if (base.aiCard?.length) {
      push('AI Identity Card', base.aiCard.map((item) => `- ${item}`).join('\n'))
    }

    const raw = sections.map((s) => `## ${s.title}\n${s.content}`).join('\n\n')
    const budgeted = truncateToBudget(raw, CONTEXT_CHAR_BUDGET)
    const block = buildMemoryContextBlock(budgeted)
    return { block, sections, dialectic, injected: block !== '' }
  }

  /** 每轮写入：fence 清洗 + 分块 + batch add_messages，失败只记录状态 */
  async syncTurn(sessionId: string, userContent: string, assistantContent: string): Promise<void> {
    const user = sanitizeContext(userContent).trim()
    const assistant = sanitizeContext(assistantContent).trim()
    if ((!user && !assistant) || !env.honchoBaseUrl) {
      return
    }
    await this.ensure(sessionId)
    const sessionKey = slugify(sessionId)
    const now = new Date().toISOString()
    const messages: Array<{ peer_id: string; content: string; created_at?: string }> = []
    for (const chunk of chunkMessage(user)) {
      messages.push({ peer_id: USER_PEER, content: chunk, created_at: now })
    }
    for (const chunk of chunkMessage(assistant)) {
      messages.push({ peer_id: AGENT_PEER, content: chunk, created_at: now })
    }
    try {
      await this.client.addMessages(WORKSPACE, sessionKey, messages)
      this.lastError = null
      this.health = true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.health = false
    }
  }

  /** 轮次收尾：计数 + 后台刷新基础层 + 到期跑辩证法 */
  onTurnComplete(sessionId: string, query: string, apiKey: string): void {
    if (!env.honchoBaseUrl || isTrivialPrompt(query)) {
      return
    }
    const sessionKey = slugify(sessionId)
    const turn = (this.turnCounts.get(sessionKey) ?? 0) + 1
    this.turnCounts.set(sessionKey, turn)
    // 后台执行，不阻塞响应；任何失败都只记录，不能变成未处理拒绝
    void (async () => {
      await this.ensure(sessionId)
      await this.fetchBase(sessionId, query).catch(() => undefined)
      const due = this.nextDialecticDue.get(sessionKey) ?? 0
      if (turn >= due) {
        await this.runDialectic(sessionId, query, apiKey, turn)
      }
    })().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error)
    })
  }

  /** 供 /api/memory/status：可用性 + 连接状态 */
  async status(): Promise<{ available: boolean; connected: boolean; provider: string; workspace: string; lastError: string | null }> {
    if (!env.honchoBaseUrl) {
      return { available: false, connected: false, provider: 'honcho', workspace: WORKSPACE, lastError: null }
    }
    if (this.health === null) {
      try {
        const response = await fetch(`${env.honchoBaseUrl.replace(/\/+$/, '')}/health`, {
          signal: AbortSignal.timeout(2_500),
        })
        this.health = response.ok
      } catch {
        this.health = false
      }
    }
    return {
      available: true,
      connected: this.health,
      provider: 'honcho',
      workspace: WORKSPACE,
      lastError: this.lastError,
    }
  }

  /** 记忆管理：浏览 conclusions 列表 */
  async listConclusions(size = 50): Promise<Array<{ id: string; content: string }>> {
    const page = await this.client.listConclusions(WORKSPACE, size)
    return page.items ?? []
  }

  /** 记忆可视化总览：用户画像/卡片、AI 自画像/卡片、结论列表 */
  async overview(): Promise<{
    userRepresentation: string
    userCard: string[]
    aiRepresentation: string
    aiCard: string[]
    conclusions: Array<{ id: string; content: string }>
  }> {
    const empty = { representation: null, peer_card: null }
    const [userCtx, aiCtx, conclusions] = await Promise.all([
      this.client.peerContext(WORKSPACE, USER_PEER, {}).catch(() => empty),
      this.client.peerContext(WORKSPACE, AGENT_PEER, {}).catch(() => empty),
      this.client.listConclusions(WORKSPACE, 100).catch(() => ({ items: [] })),
    ])
    return {
      userRepresentation: userCtx.representation ?? '',
      userCard: userCtx.peer_card ?? [],
      aiRepresentation: aiCtx.representation ?? '',
      aiCard: aiCtx.peer_card ?? [],
      conclusions: conclusions.items ?? [],
    }
  }

  async deleteConclusion(id: string): Promise<void> {
    await this.client.deleteConclusion(WORKSPACE, id)
  }
}

export const memory = new HonchoMemory()
