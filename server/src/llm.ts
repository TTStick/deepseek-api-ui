import { env } from './env.js'

/** OpenAI 兼容的 chat.completions 调用（DeepSeek 端点），用于查询改写与压缩摘要 */
export const chatCompletion = async (
  apiKey: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}
): Promise<{ content: string; finishReason: string | null }> => {
  const origin = env.deepseekApiOrigin.replace(/\/+$/, '')
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`LLM call failed (${response.status}): ${text.slice(0, 300)}`)
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>
  }
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    finishReason: body.choices?.[0]?.finish_reason ?? null,
  }
}
