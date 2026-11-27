import { env } from './env.js'

/** Anthropic 兼容请求（透传自前端，形状见前端 CreateMessageRequest） */
export type UpstreamRequest = {
  model: string
  system: string
  messages: unknown[]
  thinking?: unknown
  tools?: unknown[]
  safety_check?: string
  title?: { enabled: boolean }
}

/** Files API / file_id 图片、文档请求必须在消息接口上携带的 beta 头 */
const FILES_BETA = 'files-api-2025-04-14'

/**
 * 前端直连 DeepSeek 时由浏览器携带 anthropic-beta；走服务端代理时
 * 头不会自动透传，需要根据消息里的 image/document 块重新加上，否则上游返回
 * “Missing or invalid anthropic-beta header”。
 */
export const hasFileBlocks = (messages: unknown[]): boolean =>
  messages.some((message) => {
    if (!message || typeof message !== 'object') {
      return false
    }
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) {
      return false
    }
    return content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        ((block as { type?: unknown }).type === 'image' ||
          (block as { type?: unknown }).type === 'document')
    )
  })

/** 上游非 2xx 响应；error.message 是原始响应体文本（可能为 JSON） */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/**
 * 向 DeepSeek 的 Anthropic 兼容接口发起流式请求，逐块产出原始 SSE 块文本
 * （形如 "event: message_delta\ndata: {...}"），由路由层原样转发给前端。
 */
export async function* streamUpstream(
  upstream: UpstreamRequest,
  apiKey: string,
  signal: AbortSignal
): AsyncGenerator<string> {
  const response = await fetch(`${env.deepseekApiOrigin}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(hasFileBlocks(upstream.messages) ? { 'anthropic-beta': FILES_BETA } : {}),
    },
    body: JSON.stringify({ ...upstream, stream: true }),
    signal,
  })
  if (!response.ok) {
    throw new UpstreamError(response.status, await response.text().catch(() => ''))
  }
  if (!response.body) {
    throw new UpstreamError(502, 'upstream returned an empty body')
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let cursor = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n\n', cursor)) !== -1) {
      const block = buffer.slice(cursor, index)
      cursor = index + 2
      if (block.trim()) {
        yield block
      }
    }
    // 控制缓冲区增长：已产出的部分丢弃
    if (cursor > 64 * 1024) {
      buffer = buffer.slice(cursor)
      cursor = 0
    }
  }
  const tail = buffer.slice(cursor)
  if (tail.trim()) {
    yield tail
  }
}
