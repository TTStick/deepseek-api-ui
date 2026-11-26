import type { Session } from './types.js'

/** 会话级 token 消耗统计（来自各轮回答的 usage 快照） */
export type TokenTotals = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export const sessionTokenTotals = (session: Session): TokenTotals => {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  for (const message of session.messages) {
    if (message.role !== 'assistant' || !message.usage) {
      continue
    }
    totals.input += message.usage.input_tokens
    totals.output += message.usage.output_tokens
    totals.cacheRead += message.usage.cache_read_input_tokens
    totals.cacheCreation += message.usage.cache_creation_input_tokens
  }
  return totals
}

/** 模型上下文窗口（token）；与网页端一致按 128K 显示 */
export const CONTEXT_WINDOW_TOKENS = 128_000

/** 当前上下文占用 = 最近一轮请求的真实 prompt token（含缓存），无请求时回退估算 */
export const contextPromptTokens = (session: Session): number => {
  let latest = 0
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i]
    if (message.role === 'assistant' && message.usage) {
      latest =
        message.usage.input_tokens +
        message.usage.cache_read_input_tokens +
        message.usage.cache_creation_input_tokens
      break
    }
  }
  if (latest > 0) {
    return latest
  }
  // 尚未请求过：按可见消息字符数粗估（约 1 token ≈ 2.5 字符）
  let chars = 0
  for (const message of session.messages) {
    chars += message.role === 'user' ? message.content.length : 0
  }
  return Math.round(chars / 2.5)
}
