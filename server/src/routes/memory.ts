import type { FastifyInstance } from 'fastify'
import { memory } from '../memory/honcho.js'

/** 记忆状态与管理的只读/管理接口：状态查询、总览（可视化）、conclusions 浏览与删除 */
export const registerMemory = (app: FastifyInstance) => {
  app.get('/memory/status', async () => memory.status())

  /** 记忆可视化总览：画像/卡片/结论 */
  app.get('/memory/overview', async () => {
    if (!memory.enabled()) {
      return {
        available: false,
        userRepresentation: '',
        userCard: [],
        aiRepresentation: '',
        aiCard: [],
        conclusions: [],
      }
    }
    try {
      return { available: true, ...(await memory.overview()) }
    } catch {
      return {
        available: true,
        userRepresentation: '',
        userCard: [],
        aiRepresentation: '',
        aiCard: [],
        conclusions: [],
      }
    }
  })

  app.get('/memory/conclusions', async (request) => {
    const query = request.query as { size?: string }
    const size = Math.min(Number(query.size ?? 50), 200)
    return memory.listConclusions(Number.isFinite(size) ? size : 50)
  })

  app.delete('/memory/conclusions/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await memory.deleteConclusion(id)
      return reply.code(204).send()
    } catch (error) {
      return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })
}
