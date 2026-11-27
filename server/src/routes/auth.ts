import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  isPasswordSet,
  issueSession,
  revokeSession,
  rotateSessionSecret,
  setPassword,
  sessionCookie,
  verifyPassword,
  verifySession,
} from '../auth.js'
import { env } from '../env.js'
import { clientAddress } from '../rateLimit.js'

/** 无需登录即可访问的路径（登录相关与健康检查） */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/status', '/api/auth/login'])

/** 登录爆破防护：单 IP 10 分钟内最多 5 次失败，超限封禁 15 分钟 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_BLOCK_MS = 15 * 60 * 1000
const loginAttempts = new Map<string, { count: number; first: number; blockedUntil: number }>()

const loginBlockedFor = (request: FastifyRequest): number => {
  const key = clientAddress(request)
  const record = loginAttempts.get(key)
  if (!record) {
    return 0
  }
  const now = Date.now()
  if (record.blockedUntil > now) {
    return Math.ceil((record.blockedUntil - now) / 1000)
  }
  if (now - record.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key)
  }
  return 0
}

const recordLoginFailure = (request: FastifyRequest) => {
  const key = clientAddress(request)
  const now = Date.now()
  if (loginAttempts.size > 5000) {
    for (const [address, attempt] of loginAttempts) {
      if (now - attempt.first > LOGIN_WINDOW_MS && attempt.blockedUntil <= now) {
        loginAttempts.delete(address)
      }
    }
  }
  const record = loginAttempts.get(key)
  if (!record || now - record.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now, blockedUntil: 0 })
    return
  }
  record.count += 1
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    record.blockedUntil = now + LOGIN_BLOCK_MS
  }
}

const clearLoginFailures = (request: FastifyRequest) => {
  loginAttempts.delete(clientAddress(request))
}

const readCookie = (request: FastifyRequest, name: string): string | undefined => {
  const header = request.headers.cookie
  if (!header) {
    return undefined
  }
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      return rest.join('=')
    }
  }
  return undefined
}

const isSecureRequest = (request: FastifyRequest): boolean =>
  request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https'

/** 手机 App 使用 Authorization: Bearer <token>（WebView 跨域下 Cookie 不可靠） */
const readBearer = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return undefined
  }
  return header.slice(7).trim()
}

const isAuthenticated = async (request: FastifyRequest): Promise<boolean> => {
  if (!(await isPasswordSet())) {
    // 未设置密码：默认开放（本地/局域网）；公网部署可 REQUIRE_AUTH=true 强制拒绝
    return !env.requireAuth
  }
  const token = readCookie(request, SESSION_COOKIE) ?? readBearer(request)
  return verifySession(token)
}

/** 跨域支持：只允许手机 WebView 本地页与显式配置的来源，避免任意站点携带 Cookie */
const applyCors = (request: FastifyRequest, reply: FastifyReply) => {
  const origin = request.headers.origin
  reply.header('Vary', 'Origin')
  if (origin && env.corsOrigins.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Access-Control-Allow-Credentials', 'true')
  }
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  reply.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-myagent-client'
  )
  reply.header('Access-Control-Max-Age', '86400')
}

/**
 * CSRF 防护：Cookie 会话的写操作必须来自同源页面或显式允许的来源。
 * 浏览器跨站表单/ fetch 会带 Origin；无 Origin 的非浏览器客户端（curl/手机 Bearer）不受影响。
 */
const isAllowedWriteOrigin = (request: FastifyRequest): boolean => {
  const origin = request.headers.origin
  if (!origin) {
    return true
  }
  if (env.corsOrigins.has(origin)) {
    return true
  }
  try {
    const parsed = new URL(origin)
    const protoHeader = request.headers['x-forwarded-proto']
    const scheme = (
      typeof protoHeader === 'string' ? protoHeader.split(',')[0]!.trim() : request.protocol
    ).replace(/:$/, '')
    if (parsed.protocol !== `${scheme}:`) {
      return false
    }
    const forwardedHost = request.headers['x-forwarded-host']
    if (typeof forwardedHost === 'string' && forwardedHost.trim()) {
      // 前置代理给了带端口的原始 Host：scheme + host + port 精确比对
      const expected = new URL(`${scheme}://${forwardedHost.split(',')[0]!.trim()}`)
      return parsed.host === expected.host
    }
    const hostHeader = request.headers.host
    if (typeof hostHeader !== 'string' || !hostHeader.trim()) {
      return false
    }
    // 无代理头时也做完整 origin（scheme + host + port）比对；
    // nginx 必须通过 X-Forwarded-Host 传递带端口的原始 Host（见 docker/nginx.conf）。
    const expected = new URL(`${scheme}://${hostHeader.trim()}`)
    return parsed.host === expected.host
  } catch {
    return false
  }
}

/** 全局守卫：/api 接口除公开路径外都要求有效会话（Cookie 或 Bearer） */
export const registerAuthGuard = (app: FastifyInstance) => {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0] ?? ''
    if (!url.startsWith('/api')) {
      return
    }
    applyCors(request, reply)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') {
      // 预检请求：直接放行（未授权来源不会拿到 Allow-Origin，浏览器会拦截）
      return reply.code(204).send()
    }
    if (PUBLIC_PATHS.has(url)) {
      return
    }
    const hasBearer = request.headers.authorization?.toLowerCase().startsWith('bearer ') ?? false
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !hasBearer &&
      !isAllowedWriteOrigin(request)
    ) {
      return reply.code(403).send({ error: { message: '请求来源不被允许' } })
    }
    if (!(await isAuthenticated(request))) {
      reply.code(401).send({ error: { message: '需要登录访问' } })
    }
  })
}

export const registerAuth = (app: FastifyInstance) => {
  /** 登录状态：是否已设置密码、当前会话是否有效 */
  app.get('/auth/status', async (request) => {
    const passwordSet = await isPasswordSet()
    const token = readCookie(request, SESSION_COOKIE) ?? readBearer(request)
    const authenticated = passwordSet ? await verifySession(token) : false
    return {
      passwordSet,
      authenticated,
      requireAuth: env.requireAuth,
      // 只暴露布尔值：网页端据此决定是否还需要用户填写本机 API Key
      serverApiKey: Boolean(env.deepseekApiKey),
    }
  })

  app.post('/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    const blockedFor = loginBlockedFor(request)
    if (blockedFor > 0) {
      return reply
        .code(429)
        .header('Retry-After', String(blockedFor))
        .send({ error: { message: `尝试次数过多，请 ${blockedFor} 秒后再试` } })
    }
    if (!(await isPasswordSet())) {
      return reply.code(400).send({ error: { message: '尚未设置访问密码' } })
    }
    const body = request.body as { password?: string; remember?: boolean }
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!password || password.length > 1024 || !(await verifyPassword(password))) {
      recordLoginFailure(request)
      return reply.code(401).send({ error: { message: '密码错误' } })
    }
    clearLoginFailures(request)
    const ttl = body.remember === false ? 12 * 60 * 60 : undefined
    const { token, maxAge } = await issueSession(ttl)
    reply.header('Set-Cookie', sessionCookie(token, maxAge, isSecureRequest(request)))
    // 仅手机 App 需要把 Bearer token 存在本机；网页端依赖 HttpOnly Cookie，不向 JS 暴露 token
    if (request.headers['x-myagent-client'] === 'mobile') {
      return { ok: true, token, expiresIn: maxAge }
    }
    return { ok: true, expiresIn: maxAge }
  })

  app.post('/auth/logout', async (request, reply) => {
    // 撤销当前 token，避免被复制的 Cookie/Bearer 在登出后继续可用
    await revokeSession(readCookie(request, SESSION_COOKIE) ?? readBearer(request))
    reply.header('Set-Cookie', clearSessionCookie())
    return { ok: true }
  })

  /** 设置或修改密码：已设置密码时需校验当前密码 */
  app.post('/auth/password', { bodyLimit: 4096 }, async (request, reply) => {
    const body = request.body as { currentPassword?: string; newPassword?: string }
    const passwordSet = await isPasswordSet()
    if (passwordSet && !(await verifyPassword(body?.currentPassword ?? ''))) {
      return reply.code(401).send({ error: { message: '当前密码错误' } })
    }
    const next = body?.newPassword ?? ''
    if (next.length < 10) {
      return reply.code(400).send({ error: { message: '密码至少 10 位' } })
    }
    if (next.length > 1024) {
      return reply.code(400).send({ error: { message: '密码过长' } })
    }
    await setPassword(next)
    // 改密后轮换会话密钥，所有旧 Cookie/Bearer token 立即失效
    await rotateSessionSecret()
    const { token, maxAge } = await issueSession()
    reply.header('Set-Cookie', sessionCookie(token, maxAge, isSecureRequest(request)))
    return { ok: true }
  })
}
