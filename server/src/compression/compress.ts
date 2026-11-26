import { chatCompletion } from '../llm.js'
import { buildStaticFallbackSummary, buildSummaryPrompt } from './prompt.js'
import { messagesTokenEstimate } from './tokens.js'
import {
  computeTailBudget,
  computeThresholdTokens,
  formatTurnsForSummary,
  isReminderRow,
  planWindow,
  SUMMARY_END_MARKER,
  SUMMARY_PREFIX,
  type MessageLike,
} from './window.js'

/**
 * 上下文压缩主流程（移植 Hermes context_compressor 的核心行为）：
 * - 触发：估算 token ≥ 阈值（默认 50% × 有效窗口，64K 下限）
 * - 三段式：摘要行(头部) + 中段轮次 → 迭代摘要；尾部按预算保留
 * - 防抖熔断：摘要失败 5 分钟冷却；压缩后仍超阈值计 1 次无效，≥2 次熔断 5 分钟后放行一次探测；
 *   无可压缩内容退避 5 分钟。状态存后端内存，摘要随前端会话持久化。
 */

const FAILURE_COOLDOWN_MS = 5 * 60 * 1000
const INEFFECTIVE_TRIP_LIMIT = 2
const TRIP_COOLDOWN_MS = 5 * 60 * 1000
const STRUCTURAL_BACKOFF_MS = 5 * 60 * 1000
const SUMMARY_MAX_TOKENS = 4000 // deepseek-chat 默认输出上限，超长摘要截断视为失败

type CompressState = {
  failureCooldownUntil: number
  structuralBackoffUntil: number
  ineffectiveCount: number
  trippedUntil: number
}

const freshState = (): CompressState => ({
  failureCooldownUntil: 0,
  structuralBackoffUntil: 0,
  ineffectiveCount: 0,
  trippedUntil: 0,
})

export type CompressionOutcome = {
  /** 是否实际压缩并改写了消息数组 */
  compressed: boolean
  /** 压缩后的新消息数组（未压缩时为原数组） */
  messages: MessageLike[]
  /** 本次并入摘要的轮次对数（前端据此归档展示层） */
  archiveRounds: number
  estimatedBefore: number
  estimatedAfter: number
  /** 压缩被跳过/失败的原因（诊断用，压缩成功为 null） */
  reason: string | null
}

const readSummaryRows = (messages: MessageLike[]): string[] =>
  messages
    .filter(
      (message): message is MessageLike & { content: string } =>
        typeof message.content === 'string' && message.content.startsWith('[CONTEXT COMPACTION')
    )
    .map((message) =>
      message.content.slice(SUMMARY_PREFIX.length, -SUMMARY_END_MARKER.length)
    )

export class ContextCompressor {
  private readonly states = new Map<string, CompressState>()

  private stateOf(sessionId: string): CompressState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = freshState()
      this.states.set(sessionId, state)
    }
    return state
  }

  /**
   * 在请求发出前调用：估算 token，超阈值时把中段轮次压缩进摘要并改写 messages。
   * force 为手动触发：跳过阈值与全部冷却/熔断门（Hermes /compress 语义）。
   * 任何失败都 fail-open——未压缩的消息原样转发，聊天不受影响。
   */
  async maybeCompress(
    sessionId: string,
    messages: MessageLike[],
    apiKey: string,
    options: { enabled?: boolean; thresholdTokens?: number; force?: boolean } = {}
  ): Promise<CompressionOutcome> {
    const estimatedBefore = messagesTokenEstimate(messages)
    const noop: CompressionOutcome = {
      compressed: false,
      messages,
      archiveRounds: 0,
      estimatedBefore,
      estimatedAfter: estimatedBefore,
      reason: null,
    }
    if (!options.enabled) {
      return noop
    }
    const threshold = options.thresholdTokens ?? computeThresholdTokens()
    const state = this.stateOf(sessionId)
    const now = Date.now()
    if (!options.force) {
      if (estimatedBefore < threshold) {
        return noop
      }
      if (state.failureCooldownUntil > now) {
        return { ...noop, reason: `failure-cooldown:${Math.ceil((state.failureCooldownUntil - now) / 1000)}s` }
      }
      if (state.structuralBackoffUntil > now) {
        return { ...noop, reason: `structural-backoff:${Math.ceil((state.structuralBackoffUntil - now) / 1000)}s` }
      }
      if (state.trippedUntil > now) {
        return { ...noop, reason: 'ineffective-tripped' }
      }
      if (state.ineffectiveCount >= INEFFECTIVE_TRIP_LIMIT) {
        // 熔断后到期放行一次探测
        state.trippedUntil = now + TRIP_COOLDOWN_MS
      }
    } else {
      // 手动压缩清除失败冷却与熔断，允许立刻重试
      state.failureCooldownUntil = 0
      state.structuralBackoffUntil = 0
      state.trippedUntil = 0
      state.ineffectiveCount = 0
    }

    const plan = planWindow(messages, computeTailBudget(threshold))
    const middle = plan.rounds.slice(0, plan.tailStart)
    const previous = plan.previousSummary ?? (readSummaryRows(messages).join('\n\n') || null)
    if (middle.length === 0 && !previous) {
      // 没有可压缩的中段且没有旧摘要 → 结构性退避（手动压缩不设退避，直接返回）
      if (!options.force) {
        state.structuralBackoffUntil = now + STRUCTURAL_BACKOFF_MS
      }
      return { ...noop, reason: 'structural-noop' }
    }

    const turnsText = formatTurnsForSummary(middle, messages)
    let summary: string
    let fallback = false
    try {
      const result = await chatCompletion(apiKey, buildSummaryPrompt(previous, turnsText), {
        temperature: 0,
        maxTokens: SUMMARY_MAX_TOKENS,
        timeoutMs: 120_000,
      })
      if (!result.content.trim() || result.finishReason === 'length') {
        throw new Error(result.finishReason === 'length' ? 'summary truncated (length)' : 'empty summary')
      }
      summary = result.content.trim()
    } catch {
      // 摘要失败：确定性回退摘要 + 失败冷却（Hermes _build_static_fallback_summary 路径）
      summary = buildStaticFallbackSummary(turnsText)
      fallback = true
      state.failureCooldownUntil = now + FAILURE_COOLDOWN_MS
    }

    // 组装：新摘要行 + 尾部（首个保留轮次起，含其前置提醒行、提问与续写段）
    let firstKept = plan.rounds[plan.tailStart]?.userIndex ?? plan.questionIndex
    if (firstKept > 0 && isReminderRow(messages[firstKept - 1])) {
      firstKept -= 1
    }
    const tail = messages.slice(firstKept)
    const summaryRow: MessageLike = {
      role: 'user',
      content: SUMMARY_PREFIX + summary + SUMMARY_END_MARKER,
    }
    const compressed = [summaryRow, ...tail]
    const estimatedAfter = messagesTokenEstimate(compressed)

    if (!fallback) {
      if (estimatedAfter >= threshold) {
        state.ineffectiveCount += 1
        if (state.ineffectiveCount >= INEFFECTIVE_TRIP_LIMIT) {
          state.trippedUntil = now + TRIP_COOLDOWN_MS
        }
      } else {
        state.ineffectiveCount = 0
      }
    }

    return {
      compressed: true,
      messages: compressed,
      archiveRounds: middle.length,
      estimatedBefore,
      estimatedAfter,
      reason: fallback ? 'summary-fallback' : null,
    }
  }
}

export const compressor = new ContextCompressor()
