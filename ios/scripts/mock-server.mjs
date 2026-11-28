#!/usr/bin/env node
// Minimal MyAgent-compatible mock used by the iOS UI tests.
// It streams both Anthropic Messages SSE (/api/chat) and OpenAI Chat Completions SSE
// (/v1/chat/completions) so the native transport and the server-mode path can be tested
// without a real backend or DeepSeek key.
import http from 'node:http'

const port = Number(process.env.PORT || 8099)
const host = process.env.HOST || '127.0.0.1'
const reply =
  process.env.MOCK_REPLY ||
  '这是来自 iOS 模拟服务的流式回复。**Markdown、KaTeX 与代码块**都会照常渲染。\n\n```js\nconsole.log("WyDeepSeek iOS")\n```\n\n[示例链接](https://example.com/) 可以打开 App 内置浏览器。'

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
}

const readBody = (req) =>
  new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
  })

const json = (res, status, value) => {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

const sseHeaders = (res) => {
  cors(res)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const chunks = (text) => {
  const parts = []
  for (let index = 0; index < text.length; index += 12) {
    parts.push(text.slice(index, index + 12))
  }
  return parts
}

async function streamOpenAI(res) {
  sseHeaders(res)
  const id = `chatcmpl-${Date.now()}`
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  for (const part of chunks(reply)) {
    send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })
    await sleep(18)
  }
  send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 24, completion_tokens: 48, total_tokens: 72 } })
  res.write('data: [DONE]\n\n')
  res.end()
}

async function streamAnthropic(res) {
  sseHeaders(res)
  const write = (event, payload) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  write('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'mock',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 24, output_tokens: 0 },
    },
  })
  write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const part of chunks(reply)) {
    write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } })
    await sleep(18)
  }
  write('content_block_stop', { type: 'content_block_stop', index: 0 })
  write('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 48 },
  })
  write('message_stop', { type: 'message_stop' })
  res.end()
}

const emptyTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || host}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }

  if (path === '/v1/chat/completions' && req.method === 'POST') {
    await readBody(req)
    await streamOpenAI(res)
    return
  }
  if (path === '/api/chat' && req.method === 'POST') {
    await readBody(req)
    await streamAnthropic(res)
    return
  }
  if (path === '/api/auth/login' && req.method === 'POST') {
    await readBody(req)
    json(res, 200, { token: 'test-token' })
    return
  }
  if (path === '/api/auth/status') {
    json(res, 200, { requireAuth: false, passwordSet: true })
    return
  }
  if (path === '/api/mobile/ping') {
    json(res, 200, { ok: true })
    return
  }
  if (path === '/api/sessions' && req.method === 'GET') {
    json(res, 200, { sessions: [], deleted: [] })
    return
  }
  if (path.startsWith('/api/sessions')) {
    await readBody(req)
    json(res, 200, { ok: true })
    return
  }
  if (path === '/api/usage') {
    json(res, 200, {
      generatedAt: Date.now(),
      sessions: 0,
      requests: 0,
      totals: emptyTotals,
      today: { ...emptyTotals, requests: 0 },
      days: [],
      speed: { average: null, recent: null, samples: 0 },
      balance: { available: false },
      cost: { perMillion: null, windowTokens: 0, since: null },
    })
    return
  }
  if (path === '/api/memory/overview') {
    json(res, 200, {
      available: true,
      userRepresentation: '模拟用户画像',
      userCard: ['偏好简洁回答'],
      aiRepresentation: '模拟 AI 自画像',
      aiCard: ['擅长代码'],
      conclusions: [],
    })
    return
  }
  if (path.startsWith('/api/memory/conclusions/')) {
    json(res, 200, { ok: true })
    return
  }
  if (path === '/api/compress') {
    await readBody(req)
    json(res, 200, { compressed: false, reason: 'mock' })
    return
  }
  if (path === '/api/agent/tree') {
    json(res, 200, { files: [], nodes: [] })
    return
  }
  if (path.startsWith('/api/agent/')) {
    await readBody(req)
    json(res, 200, { ok: true })
    return
  }
  if (path === '/api/mobile/complete') {
    await readBody(req)
    json(res, 200, { ok: true })
    return
  }
  if (path === '/api/export/md') {
    await readBody(req)
    cors(res)
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
    res.end('# mock export\n')
    return
  }

  if (path === '/' || path === '/health') {
    json(res, 200, { ok: true, port })
    return
  }
  json(res, 404, { error: `unknown path ${req.method} ${path}` })
})

server.listen(port, host, () => {
  console.log(`mock server listening on http://${host}:${port}`)
})
