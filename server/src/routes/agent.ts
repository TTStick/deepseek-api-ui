import type { FastifyInstance } from 'fastify'
import { deleteReference, listReferences, saveReferences } from '../agent/references.js'
import { sshManager, type SshConfig } from '../agent/ssh.js'
import { workspaces } from '../agent/workspace.js'
import { sshTestRateGuard } from '../rateLimit.js'

/**
 * Agent 工作区接口：文件树、文件预览、清理与 SSH 连通性测试。
 * 文件一律限定在会话工作区内；清理随会话删除/关闭 agent 触发。
 */
export const registerAgent = (app: FastifyInstance) => {
  app.get('/agent/status', async (request) => {
    const { sessionId } = request.query as { sessionId?: string }
    if (!sessionId) {
      return { exists: false, fileCount: 0 }
    }
    const info = await workspaces.info(sessionId)
    return { exists: info.exists, fileCount: info.fileCount, root: info.root }
  })

  app.get('/agent/tree', async (request) => {
    const { sessionId } = request.query as { sessionId?: string }
    if (!sessionId) {
      return []
    }
    return workspaces.tree(sessionId)
  })

  app.get('/agent/file', async (request, reply) => {
    const { sessionId, path } = request.query as { sessionId?: string; path?: string }
    if (!sessionId || !path) {
      return reply.code(400).send({ error: { message: '缺少 sessionId 或 path' } })
    }
    try {
      return workspaces.readFile(sessionId, path)
    } catch (error) {
      return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })

  /** 原始字节读取（图片预览 <img src>） */
  app.get('/agent/raw', async (request, reply) => {
    const { sessionId, path } = request.query as { sessionId?: string; path?: string }
    if (!sessionId || !path) {
      return reply.code(400).send({ error: { message: '缺少 sessionId 或 path' } })
    }
    try {
      const buffer = await workspaces.readRaw(sessionId, path)
      const type = /\.png$/i.test(path)
        ? 'image/png'
        : /\.jpe?g$/i.test(path)
          ? 'image/jpeg'
          : /\.svg$/i.test(path)
            ? 'image/svg+xml'
            : /\.pdf$/i.test(path)
              ? 'application/pdf'
              : 'text/plain; charset=utf-8'
      return reply.type(type).send(buffer)
    } catch (error) {
      return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })

  app.delete('/agent/file', async (request, reply) => {
    const body = request.body as { sessionId?: string; path?: string }
    if (!body.sessionId || !body.path) {
      return reply.code(400).send({ error: { message: '缺少 sessionId 或 path' } })
    }
    try {
      await workspaces.deleteFile(body.sessionId, body.path)
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })

  /** 会话删除 / agent 关闭时调用：清空工作区并断开 SSH */
  app.post('/agent/cleanup', async (request) => {
    const body = request.body as { sessionId?: string }
    if (!body.sessionId) {
      return { ok: false }
    }
    await workspaces.cleanup(body.sessionId)
    sshManager.cleanup(body.sessionId)
    return { ok: true }
  })

  /** 测试 SSH 连接（不落盘任何凭据，配置只存前端会话） */
  app.post('/agent/ssh/test', { preHandler: sshTestRateGuard }, async (request) => {
    const config = request.body as SshConfig
    return sshManager.test(config)
  })

  /** 前置参考资料：列出（含预览） */
  app.get('/agent/references', async (request) => {
    const { sessionId } = request.query as { sessionId?: string }
    if (!sessionId) {
      return []
    }
    return listReferences(sessionId)
  })

  /** 前置参考资料：写入一批（前端解压 zip 后上传文本） */
  app.post('/agent/references', async (request, reply) => {
    const body = request.body as { sessionId?: string; files?: Array<{ path: string; content: string }> }
    if (!body.sessionId || !Array.isArray(body.files)) {
      return reply.code(400).send({ error: { message: '缺少 sessionId 或 files' } })
    }
    return saveReferences(body.sessionId, body.files)
  })

  /** 前置参考资料：删除单个 */
  app.delete('/agent/references', async (request, reply) => {
    const body = request.body as { sessionId?: string; path?: string }
    if (!body.sessionId || !body.path) {
      return reply.code(400).send({ error: { message: '缺少 sessionId 或 path' } })
    }
    try {
      await deleteReference(body.sessionId, body.path)
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })
}
