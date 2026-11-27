import type { FastifyInstance } from 'fastify'
import type { IndexOptions } from '../indexing/store.js'
import { chatRateGuard } from '../rateLimit.js'
import { getRuntimeConfig } from '../runtimeConfig.js'
import { hasExcessiveDepth } from '../validation.js'
import { runChatPipeline, type ChatRequest } from './chat.js'

/**
 * 手机 App 专用聊天接口：App 端只提交标准 Anthropic 请求体
 * （model/system/messages/max_tokens），后端补齐会话作用域后走同一管线
 * （记忆召回、上下文压缩、agent 工具循环）。
 * 鉴权：Authorization: Bearer <登录 token>（由 /api/auth/login 返回）。
 */
export const registerMobile = (app: FastifyInstance) => {
  app.post('/mobile/messages', { preHandler: chatRateGuard }, async (request, reply) => {
    const body = request.body as
      | {
          model?: string
          system?: string
          messages?: unknown[]
          max_tokens?: number
          sessionId?: string
          apiKey?: string
          thinking?: unknown
          tools?: unknown[]
          safety_check?: string
          title?: { enabled?: boolean }
          agent?: { enabled?: boolean }
          memory?: { enabled?: boolean; read?: boolean; write?: boolean }
          compression?: { enabled?: boolean }
          indexes?: IndexOptions
        }
      | undefined
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: { message: '请求格式不合法' } })
    }
    if (Array.isArray(body.messages) && hasExcessiveDepth(body.messages)) {
      return reply.code(400).send({ error: { message: 'messages 嵌套层级过深' } })
    }
    const config = getRuntimeConfig()
    if (body.model && !config.allowedModels.has(body.model)) {
      return reply.code(400).send({ error: { message: '不支持的模型' } })
    }
    if (
      body.apiKey !== undefined &&
      (typeof body.apiKey !== 'string' ||
        (body.apiKey.trim() !== '' && !/^[\x21-\x7E]{8,512}$/.test(body.apiKey.trim())))
    ) {
      return reply.code(400).send({ error: { message: 'API Key 格式不合法' } })
    }
    const apiKey =
      (typeof body.apiKey === 'string' && body.apiKey.trim()) || config.deepseekApiKey
    if (!apiKey) {
      return reply
        .code(400)
        .send({ error: { message: '服务端未配置 DEEPSEEK_API_KEY，请在 .env 中设置或让 App 携带 Key' } })
    }
    if (!Array.isArray(body.messages)) {
      return reply.code(400).send({ error: { message: '缺少 messages' } })
    }
    // DeepSeek 约束：thinking 模式下 read_url 客户端工具必须与 web_search 同时声明，
    // 否则上游直接报错。这里在不满足时剔除客户端工具（Agent 工具由 agent 循环自行注入）。
    const thinkingEnabled =
      typeof body.thinking === 'object' &&
      body.thinking !== null &&
      (body.thinking as { type?: string }).type === 'enabled'
    let tools = Array.isArray(body.tools) ? body.tools : undefined
    if (
      tools &&
      thinkingEnabled &&
      !tools.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as { type?: string }).type === 'deepseek_web_search'
      )
    ) {
      tools = undefined
    }
    const input: ChatRequest = {
      apiKey,
      // App 的会话 id 用于工作区与记忆作用域；缺省落到移动端共享会话
      sessionId: body.sessionId?.trim() || 'mobile-default',
      request: {
        model: body.model || 'deepseek-flash',
        system: body.system || '',
        messages: body.messages,
        // 透传 App 的思考 / 搜索工具 / 安全审核 / 标题请求
        ...(body.thinking ? { thinking: body.thinking } : {}),
        ...(tools ? { tools } : {}),
        ...(body.safety_check ? { safety_check: body.safety_check } : {}),
        ...(body.title?.enabled ? { title: { enabled: true } } : {}),
      },
      // 手机端默认开启服务端能力，App 可在设置里关闭
      memory: {
        enabled: body.memory?.enabled ?? true,
        read: body.memory?.read ?? true,
        write: body.memory?.write ?? true,
      },
      compression: { enabled: body.compression?.enabled ?? true },
      agent: { enabled: body.agent?.enabled ?? true },
      ...(body.indexes ? { indexes: body.indexes } : {}),
    }
    return runChatPipeline(reply, input, apiKey)
  })

  /** 轮次收尾：写入记忆（App 调用，fire-and-forget） */
  app.post('/mobile/complete', async (request) => {
    const body = request.body as {
      sessionId?: string
      query?: string
      userContent?: string
      assistantContent?: string
      write?: boolean
    }
    const sessionId = body.sessionId?.trim() || 'mobile-default'
    const { memory } = await import('../memory/honcho.js')
    if (body.write !== false && body.userContent && body.assistantContent) {
      void memory
        .syncTurn(sessionId, body.userContent, body.assistantContent)
        .catch((error) => request.log.warn({ err: error }, '写入记忆失败'))
    }
    memory.onTurnComplete(
      sessionId,
      body.query ?? body.userContent ?? '',
      getRuntimeConfig().deepseekApiKey
    )
    return { ok: true }
  })

  /** 连通性检查：登录后 App 用它验证服务器配置 */
  app.get('/mobile/ping', async () => ({ ok: true, server: 'myagent', version: '0.1.0' }))
}
