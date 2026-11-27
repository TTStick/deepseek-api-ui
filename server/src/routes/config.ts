import type { FastifyInstance } from 'fastify'
import { isPasswordSet } from '../auth.js'
import { memory } from '../memory/honcho.js'
import {
  getPublicRuntimeConfig,
  RuntimeConfigError,
  updateRuntimeConfig,
} from '../runtimeConfig.js'

/** 图形化服务端配置：只暴露安全字段，API Key 永不回显。 */
export const registerConfig = (app: FastifyInstance) => {
  app.get('/server-config', async () => ({
    ...getPublicRuntimeConfig(),
    passwordSet: await isPasswordSet(),
  }))

  app.put('/server-config', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined
    try {
      if (body?.requireAuth === true && !(await isPasswordSet())) {
        return reply
          .code(400)
          .send({ error: { message: '请先设置访问密码，再开启强制登录' } })
      }
      const config = await updateRuntimeConfig(body)
      memory.reconfigure()
      return { ...config, passwordSet: await isPasswordSet() }
    } catch (error) {
      if (error instanceof RuntimeConfigError) {
        return reply.code(400).send({ error: { message: error.message } })
      }
      request.log.error({ err: error }, '保存服务端配置失败')
      return reply.code(500).send({ error: { message: '保存服务端配置失败' } })
    }
  })
}
