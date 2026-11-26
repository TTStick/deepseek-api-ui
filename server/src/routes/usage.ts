import type { FastifyInstance } from 'fastify'
import { collectUsage } from '../usage.js'

/** 消耗统计：token、速度、余额与估算成本（网页端/手机端共用） */
export const registerUsage = (app: FastifyInstance) => {
  app.get('/usage', async (request) => {
    const query = request.query as { tzOffset?: string; refresh?: string }
    const parsed = Number(query.tzOffset ?? 0)
    const tzOffset = Number.isFinite(parsed) ? Math.max(-840, Math.min(840, parsed)) : 0
    return collectUsage(tzOffset, query.refresh === '1')
  })
}
