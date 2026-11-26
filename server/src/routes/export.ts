import { spawn } from 'node:child_process'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

/** 对话导出：Markdown 由前端生成，PDF/HTML 由容器内 python（reportlab/markdown）转换 */

const SCRIPT = path.resolve('/app/scripts/export.py')
const INPUT_LIMIT = 2 * 1024 * 1024
const EXPORT_TIMEOUT_MS = 60_000

const runExport = (mode: 'pdf' | 'html', markdown: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn('python3', [SCRIPT, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: EXPORT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => reject(new Error(`python 启动失败: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks))
      } else {
        reject(new Error(stderr.trim() || `python 退出码 ${code}`))
      }
    })
    child.stdin.write(markdown)
    child.stdin.end()
  })

export const registerExport = (app: FastifyInstance) => {
  app.post('/export/pdf', async (request, reply) => {
    const body = request.body as { markdown?: string }
    const markdown = typeof body.markdown === 'string' ? body.markdown : ''
    if (!markdown.trim()) {
      return reply.code(400).send({ error: { message: '缺少导出的 Markdown 内容' } })
    }
    if (Buffer.byteLength(markdown, 'utf8') > INPUT_LIMIT) {
      return reply.code(400).send({ error: { message: '导出内容超过 2MB 上限' } })
    }
    try {
      const pdf = await runExport('pdf', markdown)
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'attachment; filename="conversation.pdf"')
        .send(pdf)
    } catch (error) {
      return reply.code(500).send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })

  app.post('/export/html', async (request, reply) => {
    const body = request.body as { markdown?: string }
    const markdown = typeof body.markdown === 'string' ? body.markdown : ''
    if (!markdown.trim()) {
      return reply.code(400).send({ error: { message: '缺少导出的 Markdown 内容' } })
    }
    if (Buffer.byteLength(markdown, 'utf8') > INPUT_LIMIT) {
      return reply.code(400).send({ error: { message: '导出内容超过 2MB 上限' } })
    }
    try {
      const html = await runExport('html', markdown)
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="conversation.html"')
        .send(html)
    } catch (error) {
      return reply.code(500).send({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })
}
