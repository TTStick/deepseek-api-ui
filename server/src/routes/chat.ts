import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { runAgentLoop } from '../agent/loop.js'
import { buildReferencesPrompt } from '../agent/references.js'
import type { ToolTarget } from '../agent/tools.js'
import type { SshConfig } from '../agent/ssh.js'
import { workspaces } from '../agent/workspace.js'
import { compressor } from '../compression/compress.js'
import type { MessageLike } from '../compression/window.js'
import { streamUpstream, UpstreamError, type UpstreamRequest } from '../deepseek.js'
import { env } from '../env.js'
import { memory } from '../memory/honcho.js'
import { chatRateGuard } from '../rateLimit.js'
import { hasExcessiveDepth } from '../validation.js'

/** 前端 → 后端的聊天请求信封 */
export type ChatRequest = {
  apiKey?: string
  sessionId: string
  request: UpstreamRequest
  memory?: { enabled?: boolean; read?: boolean; write?: boolean }
  compression?: { enabled?: boolean; thresholdTokens?: number }
  agent?: { enabled?: boolean; ssh?: SshConfig }
}

type UserMessageLike = { role?: string; content?: unknown }

/** 取消息列表里最后一条用户消息的纯文本（召回查询用），latest_reminder 行跳过 */
export const extractQueryText = (messages: unknown[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as UserMessageLike
    if (message?.role === 'user' && message.content !== undefined) {
      return contentToText(message.content)
    }
  }
  return ''
}

const contentToText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type?: string; text?: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
      )
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n')
  }
  return ''
}

/** 把围栏块追加到最后一条用户消息内容（string 或 block 数组两种形态） */
export const appendToLastUserMessage = (messages: unknown[], block: string): void => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as UserMessageLike
    if (message?.role === 'user') {
      if (typeof message.content === 'string') {
        message.content = `${message.content}\n\n${block}`
      } else if (Array.isArray(message.content)) {
        message.content = [...message.content, { type: 'text', text: block }]
      }
      return
    }
  }
}

/** 上游错误可能包含解析器/反序列化内部细节，只向用户透出可操作的信息 */
const sanitizeUpstreamMessage = (message: string): string => {
  const cleaned = message.replace(/\s*\(request_id:[^)]*\)/gi, '').trim()
  if (
    /api[-_ ]?key|authentication|unauthorized|permission|balance|insufficient|余额|rate limit|too many/i.test(
      cleaned
    )
  ) {
    return cleaned.slice(0, 500)
  }
  if (
    /deserialize|recursion limit|maximum call stack|serde|missing field|invalid type|parse the request body|headers\.append|invalid header value/i.test(
      cleaned
    )
  ) {
    return '请求参数不合法，请检查模型与消息格式'
  }
  return cleaned.slice(0, 500)
}

/** 从上游错误体（可能是 JSON）中提取用户可读信息 */
const extractUpstreamMessage = (error: UpstreamError): { message: string; status: number } => {
  try {
    const body: unknown = JSON.parse(error.message)
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const err = (body as { error: unknown }).error
      if (
        typeof err === 'object' &&
        err !== null &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string'
      ) {
        return {
          message: sanitizeUpstreamMessage((err as { message: string }).message),
          status: error.status,
        }
      }
    }
  } catch {
    // 非 JSON 错误体：清洗后透出
  }
  return { message: sanitizeUpstreamMessage(error.message), status: error.status }
}

const writeEvent = (raw: NodeJS.WritableStream, event: string, data: unknown) => {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * 聊天管线核心：记忆召回注入 → 上下文压缩 → agent 工具循环或直通上游。
 * 桌面 Web（/api/chat）与手机 App（/api/mobile/messages）共用。
 */
export const runChatPipeline = async (
  reply: FastifyReply,
  input: ChatRequest,
  apiKey: string
) => {
  // 自我检索：全局开关 + 本对话读取权限（read=false 时不召回历史记忆）；
  // trivial 查询自动跳过（provider 内部判定）；结果围栏注入最后一条用户消息
  const messages = input.request.messages as MessageLike[]
  const queryText = extractQueryText(messages)
  const recall =
    input.memory?.enabled && input.memory.read !== false
      ? await memory.recall(input.sessionId, queryText)
      : null
  if (recall?.injected) {
    appendToLastUserMessage(messages, recall.block)
  }

  // 上下文压缩：估算超阈值时压缩中段轮次并改写消息数组（fail-open）
  const outcome = await compressor.maybeCompress(input.sessionId, messages, apiKey, {
    enabled: input.compression?.enabled,
    thresholdTokens: input.compression?.thresholdTokens,
  })
  if (outcome.compressed) {
    input.request = { ...input.request, messages: outcome.messages }
  }

  // 前置参考资料：agent 本地模式下把资料（含小文件内联）注入 system prompt
  if (input.agent?.enabled && !input.agent.ssh?.host) {
    const referencesPrompt = await buildReferencesPrompt(input.sessionId)
    if (referencesPrompt) {
      input.request = { ...input.request, system: `${input.request.system}\n\n${referencesPrompt}` }
    }
  }

  // DeepSeek 客户端工具约束（双向上游都会直接报错）：
  // - 思考模式下声明 read_url 时，必须同时声明 web_search；
  // - 非思考模式下不能声明 web_search。
  // 这里按当前思考状态裁剪客户端工具；Agent 工具由工具循环另行注入，不受影响。
  const requestThinking = input.request.thinking as { type?: string } | undefined
  const thinkingEnabled = requestThinking?.type === 'enabled'
  if (Array.isArray(input.request.tools)) {
    const tools = input.request.tools.filter(
      (tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null
    )
    const webSearch = tools.filter((tool) => tool.type === 'deepseek_web_search')
    const clientTools = tools.filter((tool) => tool.type !== 'deepseek_web_search')
    let next: unknown[] | undefined
    if (thinkingEnabled) {
      // 思考模式：有 web_search 才保留 read_url 等客户端工具
      next = webSearch.length > 0 ? [...clientTools, ...webSearch] : []
    } else {
      // 非思考模式：只保留 read_url（去掉 web_search）
      next = clientTools
    }
    input.request = { ...input.request, tools: next.length > 0 ? next : undefined }
  }

  const allowedOrigin = corsOrigin(reply.request)
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    Vary: 'Origin',
    ...(allowedOrigin
      ? {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Credentials': 'true',
        }
      : {}),
  })

  // 召回信息作为首个事件下发，前端据此渲染「本轮召回」面板
  if (recall) {
    writeEvent(reply.raw, 'memory_recall', {
      type: 'memory_recall',
      injected: recall.injected,
      sections: recall.sections,
      dialectic: recall.dialectic,
    })
  }
  // 压缩发生时下发归档边界与摘要，前端据此更新投影与「上下文已压缩」分隔条
  if (outcome.compressed) {
    writeEvent(reply.raw, 'context_compressed', {
      type: 'context_compressed',
      summary: outcome.messages[0]?.content ?? '',
      archiveRounds: outcome.archiveRounds,
      estimatedBefore: outcome.estimatedBefore,
      estimatedAfter: outcome.estimatedAfter,
      fallback: outcome.reason === 'summary-fallback',
    })
  } else if (outcome.reason) {
    writeEvent(reply.raw, 'context_compressed', {
      type: 'context_compressed',
      summary: '',
      archiveRounds: 0,
      estimatedBefore: outcome.estimatedBefore,
      estimatedAfter: outcome.estimatedAfter,
      skipped: outcome.reason,
    })
  }

  // 客户端断开时中止上游；另设 30 分钟硬超时防止悬挂。
  // 注意监听 reply.raw（响应流）：request.raw 的 close 在 Fastify 读完请求体后即触发，
  // 会立即误杀上游请求。
  const controller = new AbortController()
  const onClose = () => controller.abort()
  reply.raw.on('close', onClose)
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)])

  try {
    if (input.agent?.enabled) {
      // Agent 模式：工具循环（文件操作 + 隔离执行 + 可选 SSH 主机）
      const target: ToolTarget = input.agent.ssh?.host
        ? { kind: 'ssh', config: input.agent.ssh }
        : { kind: 'local' }
      if (target.kind === 'local') {
        await workspaces.ensure(input.sessionId)
      }
      await runAgentLoop({
        sessionId: input.sessionId,
        request: input.request,
        apiKey,
        target,
        signal,
        forward: (block) => reply.raw.write(block + '\n\n'),
        emit: (event) => writeEvent(reply.raw, event.type, event),
      })
    } else {
      for await (const block of streamUpstream(input.request, apiKey, signal)) {
        reply.raw.write(block + '\n\n')
      }
    }
  } catch (error) {
    const { message, status } =
      error instanceof UpstreamError
        ? extractUpstreamMessage(error)
        : {
            message: error instanceof Error ? error.message : String(error),
            status: undefined,
          }
    const body = status === undefined ? { error: { message } } : { error: { message, status } }
    writeEvent(reply.raw, 'error', body)
  } finally {
    reply.raw.off('close', onClose)
    reply.raw.end()
  }
  return reply
}

/** 跨域来源：只回显白名单内的 Origin，避免任意站点读取 SSE */
const corsOrigin = (request: FastifyRequest): string | undefined => {
  const origin = request.headers.origin
  return origin && env.corsOrigins.has(origin) ? origin : undefined
}

/**
 * POST /api/chat：桌面 Web 的 SSE 聊天代理。
 * 前端发送可见路径快照与 DeepSeek 请求参数；后端做记忆召回注入、上下文压缩与 agent 循环后转发。
 */
export const registerChat = (app: FastifyInstance) => {
  app.post('/chat', { preHandler: chatRateGuard }, async (request, reply) => {
    const input = request.body as ChatRequest | undefined
    if (!input || typeof input !== 'object' || !input.request || !Array.isArray(input.request.messages)) {
      return reply.code(400).send({ error: { message: '请求格式不合法' } })
    }
    if (hasExcessiveDepth(input.request.messages)) {
      return reply.code(400).send({ error: { message: 'messages 嵌套层级过深' } })
    }
    if (!env.allowedModels.has(input.request.model)) {
      return reply.code(400).send({ error: { message: '不支持的模型' } })
    }
    if (
      input.apiKey !== undefined &&
      (typeof input.apiKey !== 'string' ||
        (input.apiKey.trim() !== '' && !/^[\x21-\x7E]{8,512}$/.test(input.apiKey.trim())))
    ) {
      return reply.code(400).send({ error: { message: 'API Key 格式不合法' } })
    }
    const apiKey = input.apiKey?.trim() || env.deepseekApiKey
    if (!apiKey) {
      return reply.code(400).send({ error: { message: '缺少 API Key：请在请求中携带 apiKey 或配置 DEEPSEEK_API_KEY' } })
    }
    return runChatPipeline(reply, input, apiKey)
  })

  /** 前端在轮次收尾后调用（fire-and-forget）：写入 Honcho 并后台刷新召回 */
  app.post('/chat/complete', async (request, reply) => {
    const body = request.body as {
      apiKey?: string
      sessionId: string
      query: string
      userContent: string
      assistantContent: string
      /** 本对话写入权限；write=false 时不写入新记忆 */
      write?: boolean
    }
    if (!body || typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      return reply.code(400).send({ error: { message: '缺少 sessionId' } })
    }
    if (body.write !== false) {
      // fire-and-forget 也必须兜底：未处理拒绝会按 Node 默认策略终止进程
      void memory
        .syncTurn(
          body.sessionId,
          typeof body.userContent === 'string' ? body.userContent : '',
          typeof body.assistantContent === 'string' ? body.assistantContent : ''
        )
        .catch((error) => request.log.warn({ err: error }, '写入记忆失败'))
    }
    memory.onTurnComplete(body.sessionId, body.query, body.apiKey?.trim() || env.deepseekApiKey)
    return { ok: true }
  })

  /** 手动压缩（/compress 命令或头部按钮）：立即压缩中段轮次，返回摘要与归档数 */
  app.post('/compress', { preHandler: chatRateGuard }, async (request, reply) => {
    const body = request.body as {
      apiKey?: string
      sessionId: string
      messages: unknown[]
      compression?: { enabled?: boolean; thresholdTokens?: number }
    }
    const apiKey = body.apiKey?.trim() || env.deepseekApiKey
    if (!apiKey) {
      return reply.code(400).send({ error: { message: '缺少 API Key' } })
    }
    const outcome = await compressor.maybeCompress(body.sessionId, body.messages as MessageLike[], apiKey, {
      enabled: body.compression?.enabled ?? true,
      // 手动压缩不传阈值：force 跳过触发门，但尾部预算仍按默认阈值计算
      thresholdTokens: body.compression?.thresholdTokens,
      force: true,
    })
    if (!outcome.compressed) {
      return { compressed: false, reason: outcome.reason ?? 'nothing-to-compress' }
    }
    const summaryRow = outcome.messages[0]
    return {
      compressed: true,
      summary: typeof summaryRow?.content === 'string' ? summaryRow.content : '',
      archiveRounds: outcome.archiveRounds,
      estimatedBefore: outcome.estimatedBefore,
      estimatedAfter: outcome.estimatedAfter,
      fallback: outcome.reason === 'summary-fallback',
    }
  })
}
