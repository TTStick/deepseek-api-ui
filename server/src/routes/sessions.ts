import type { FastifyInstance } from 'fastify'
import { workspaces } from '../agent/workspace.js'
import { deleteSessionIndex } from '../indexing/store.js'
import {
  deleteSession,
  isValidSessionId,
  listSessions,
  listTombstones,
  readSession,
  writeSession,
} from '../sessions.js'

/** 会话同步：网页端与手机端共用的服务端会话库 */
export const registerSessions = (app: FastifyInstance) => {
  app.get('/sessions', async () => ({
    sessions: await listSessions(),
    deleted: await listTombstones(),
  }))

  app.get('/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isValidSessionId(id)) {
      return reply.code(400).send({ error: { message: '会话 id 不合法' } })
    }
    const session = await readSession(id)
    return session ?? reply.code(404).send({ error: { message: '会话不存在' } })
  })

  app.put('/sessions/:id', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isValidSessionId(id)) {
      return reply.code(400).send({ error: { message: '会话 id 不合法' } })
    }
    const body = request.body as { session?: unknown } | undefined
    const session = body?.session && typeof body.session === 'object' ? body.session : body
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      return reply.code(400).send({ error: { message: '缺少会话内容' } })
    }
    let serialized: string
    try {
      serialized = JSON.stringify(session)
    } catch {
      return reply.code(400).send({ error: { message: '会话内容无法序列化' } })
    }
    if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024 * 1024) {
      return reply.code(413).send({ error: { message: '会话内容超过 16MB 上限' } })
    }
    try {
      return await writeSession(id, session as Record<string, unknown>)
    } catch (error) {
      return reply
        .code(400)
        .send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })

  app.delete('/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isValidSessionId(id)) {
      return reply.code(400).send({ error: { message: '会话 id 不合法' } })
    }
    try {
      const tombstone = await deleteSession(id)
      // 删除会话即回收其 agent 工作区、SSH 连接与本次会话的检索索引
      await Promise.all([
        workspaces.cleanup(id).catch(() => undefined),
        deleteSessionIndex(id).catch(() => undefined),
      ])
      return tombstone
    } catch (error) {
      return reply
        .code(400)
        .send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })
}
