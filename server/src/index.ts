import Fastify, { type FastifyError } from 'fastify'
import { cleanupExecutionTmp } from './agent/workspace.js'
import { initAuth, isPasswordSet } from './auth.js'
import { env } from './env.js'
import { registerAgent } from './routes/agent.js'
import { registerAuth, registerAuthGuard } from './routes/auth.js'
import { registerChat } from './routes/chat.js'
import { registerExport } from './routes/export.js'
import { registerMemory } from './routes/memory.js'
import { registerMobile } from './routes/mobile.js'
import { registerSessions } from './routes/sessions.js'
import { registerUsage } from './routes/usage.js'
import { scrubSessionSecrets } from './sessions.js'
import { initEncryption } from './storage/crypto.js'
import { migrateAtRest } from './storage/migrate.js'

// 单个坏请求绝不能拖垮整个服务：后台任务/第三方调用产生的拒绝只记录。
// 未捕获异常同样兜底（Fastify 已捕获路由内的同步/异步异常，这里只处理漏网情况）。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})
process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error)
})

const app = Fastify({
  logger: true,
  // 历史快照含图片 block（file_id 引用，不含字节），64MB 上限足够
  bodyLimit: 64 * 1024 * 1024,
})

// DELETE 等无请求体请求可能带 application/json 头：空体视为 undefined，避免 400
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) {
    done(null, undefined)
    return
  }
  try {
    done(null, JSON.parse(text))
  } catch (error) {
    // 语法错误属于客户端问题：标记 400，避免默认变成 500 并回显解析器细节
    const parseError = error as Error & { statusCode?: number }
    parseError.statusCode = 400
    done(parseError, undefined)
  }
})

/** 统一错误出口：4xx 保留业务提示，5xx 只回通用文案并记录详细日志 */
app.setErrorHandler((error: FastifyError, request, reply) => {
  const status =
    typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500
  if (status >= 500) {
    request.log.error({ err: error }, 'request failed')
    return reply.code(500).send({ error: { message: '服务器内部错误' } })
  }
  if (status === 400 && error instanceof SyntaxError) {
    return reply.code(400).send({ error: { message: '请求体不是合法 JSON' } })
  }
  return reply.code(status).send({ error: { message: error.message } })
})

await initAuth()

// 访问密码守卫必须在业务路由之前注册
registerAuthGuard(app)

app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }))

app.register(registerAuth, { prefix: '/api' })
app.register(registerChat, { prefix: '/api' })
app.register(registerMemory, { prefix: '/api' })
app.register(registerAgent, { prefix: '/api' })
app.register(registerExport, { prefix: '/api' })
app.register(registerMobile, { prefix: '/api' })
app.register(registerSessions, { prefix: '/api' })
app.register(registerUsage, { prefix: '/api' })

const start = async () => {
  try {
    const crypto = await initEncryption()
    app.log.info(
      { source: crypto.source },
      crypto.source === 'generated'
        ? '已生成新的服务端数据加密密钥；请立即备份 DATA_ENCRYPTION_KEY_FILE，丢失后无法恢复数据'
        : '服务端数据加密已启用'
    )
    const staleExecDirs = await cleanupExecutionTmp()
    if (staleExecDirs > 0) {
      app.log.info({ staleExecDirs }, '已清理异常退出遗留的 Python 临时明文目录')
    }
    const migrated = await migrateAtRest()
    if (
      migrated.sessions ||
      migrated.metas ||
      migrated.tombstones ||
      migrated.workspaceFiles ||
      migrated.indexes ||
      migrated.usageState ||
      migrated.authSecret
    ) {
      app.log.info(migrated, '历史明文数据已完成加密迁移')
    }
    await scrubSessionSecrets()
    if (!(await isPasswordSet())) {
      app.log.warn(
        '访问密码尚未设置：当前接口在局域网内开放。公网部署请设置 ACCESS_PASSWORD 与 REQUIRE_AUTH=true。'
      )
    }
    await app.listen({ port: env.port, host: '0.0.0.0' })
  } catch (error) {
    app.log.error(error)
    process.exit(1)
  }
}

void start()
