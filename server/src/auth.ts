import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from './env.js'

/**
 * 单用户访问密码：
 * - 密码只存 scrypt 哈希（data/auth.json），从不落明文
 * - 登录成功后签发 HMAC 签名的 HttpOnly Cookie 会话（默认 30 天，浏览器可记住）
 * - 所有 /api 接口（除登录相关与健康检查）都需要有效会话
 * - 未设置密码时应用保持开放（首次部署开箱即用），在设置里设置后即生效
 */

const SESSION_COOKIE = 'myagent_session'
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 天
const SCRYPT_KEYLEN = 64

type StoredAuth = {
  salt: string
  hash: string
  updatedAt: number
}

const paths = () => ({
  dir: env.dataRoot,
  authFile: path.join(env.dataRoot, 'auth.json'),
  secretFile: path.join(env.dataRoot, 'session-secret'),
  revokedFile: path.join(env.dataRoot, 'revoked-sessions.json'),
})

const ensureDir = async () => {
  await mkdir(paths().dir, { recursive: true })
}

const hashPassword = (password: string, salt: string): string =>
  scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const readStored = async (): Promise<StoredAuth | null> => {
  try {
    const raw = await readFile(paths().authFile, 'utf8')
    const parsed = JSON.parse(raw) as StoredAuth
    if (typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
      return parsed
    }
  } catch {
    // 文件不存在或损坏：视为未设置
  }
  return null
}

const writeStored = async (password: string): Promise<void> => {
  await ensureDir()
  const salt = randomBytes(16).toString('hex')
  const stored: StoredAuth = {
    salt,
    hash: hashPassword(password, salt),
    updatedAt: Date.now(),
  }
  await writeFile(paths().authFile, JSON.stringify(stored), { mode: 0o600 })
}

/**
 * 已登出的 token 黑名单：token 是无状态 HMAC，登出若只清 Cookie，
 * 被复制的 token 仍可用。这里持久化 token 哈希到过期时间，重启后依然有效。
 */
let revokedCache: Map<string, number> | null = null
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

const loadRevoked = async (): Promise<Map<string, number>> => {
  if (revokedCache) {
    return revokedCache
  }
  const map = new Map<string, number>()
  try {
    const parsed = JSON.parse(await readFile(paths().revokedFile, 'utf8')) as unknown
    if (Array.isArray(parsed)) {
      const now = Date.now()
      for (const item of parsed) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { hash?: unknown }).hash === 'string' &&
          typeof (item as { exp?: unknown }).exp === 'number' &&
          (item as { exp: number }).exp > now
        ) {
          map.set((item as { hash: string }).hash, (item as { exp: number }).exp)
        }
      }
    }
  } catch {
    // 首次运行或文件损坏：视为空黑名单
  }
  revokedCache = map
  return map
}

const persistRevoked = async (map: Map<string, number>): Promise<void> => {
  await ensureDir()
  const now = Date.now()
  const entries = [...map.entries()]
    .filter(([, exp]) => exp > now)
    .slice(-5000)
    .map(([hash, exp]) => ({ hash, exp }))
  await writeFile(paths().revokedFile, JSON.stringify(entries), { mode: 0o600 })
}

/** 登出时撤销当前 token（只影响这一个 token，不影响其他设备） */
export const revokeSession = async (token: string | undefined): Promise<void> => {
  if (!token) {
    return
  }
  const [payload] = token.split('.')
  if (!payload) {
    return
  }
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number
    }
    if (typeof exp !== 'number' || exp <= Date.now()) {
      return
    }
    const map = await loadRevoked()
    map.set(tokenHash(token), exp)
    await persistRevoked(map)
  } catch {
    // 非法 token 无需撤销
  }
}

/** 会话签名密钥：首次生成后持久化，容器重启不会让已登录设备掉线 */
let cachedSecret: string | null = null
const sessionSecret = async (): Promise<string> => {
  if (cachedSecret) {
    return cachedSecret
  }
  await ensureDir()
  try {
    cachedSecret = (await readFile(paths().secretFile, 'utf8')).trim()
    if (cachedSecret) {
      return cachedSecret
    }
  } catch {
    // 首次启动
  }
  cachedSecret = randomBytes(32).toString('hex')
  await writeFile(paths().secretFile, cachedSecret, { mode: 0o600 })
  return cachedSecret
}

/** 首次启动时若配置了 ACCESS_PASSWORD 且尚未设置，自动写入 */
export const initAuth = async (): Promise<void> => {
  await loadRevoked()
  if (env.accessPassword && !(await readStored())) {
    if (env.accessPassword.length < 10) {
      throw new Error('ACCESS_PASSWORD 至少需要 10 位字符')
    }
    await writeStored(env.accessPassword)
  }
}

export const isPasswordSet = async (): Promise<boolean> => (await readStored()) !== null

export const verifyPassword = async (password: string): Promise<boolean> => {
  if (password.length > 1024) {
    return false
  }
  const stored = await readStored()
  if (!stored) {
    return false
  }
  return safeEqual(hashPassword(password, stored.salt), stored.hash)
}

const sign = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url')

/** 签发会话 token：payload 为过期时间与随机 nonce，签名防篡改 */
export const issueSession = async (ttlSeconds = SESSION_TTL_SECONDS): Promise<{
  token: string
  maxAge: number
}> => {
  const secret = await sessionSecret()
  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + ttlSeconds * 1000,
      n: randomBytes(12).toString('base64url'),
    })
  ).toString('base64url')
  return { token: `${payload}.${sign(payload, secret)}`, maxAge: ttlSeconds }
}

/** 轮换会话签名密钥：修改密码后使所有旧 Cookie/Bearer token 立即失效 */
export const rotateSessionSecret = async (): Promise<void> => {
  await ensureDir()
  cachedSecret = randomBytes(32).toString('hex')
  await writeFile(paths().secretFile, cachedSecret, { mode: 0o600 })
}

export const verifySession = async (token: string | undefined): Promise<boolean> => {
  if (!token) {
    return false
  }
  const [payload, signature] = token.split('.')
  if (!payload || !signature) {
    return false
  }
  const secret = await sessionSecret()
  if (!safeEqual(signature, sign(payload, secret))) {
    return false
  }
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number
    }
    if (typeof exp !== 'number' || exp <= Date.now()) {
      return false
    }
    const revoked = await loadRevoked()
    return !revoked.has(tokenHash(token))
  } catch {
    return false
  }
}

export const setPassword = async (password: string): Promise<void> => {
  await writeStored(password)
}

export const clearPassword = async (): Promise<void> => {
  const { rm } = await import('node:fs/promises')
  await rm(paths().authFile, { force: true })
  await rotateSessionSecret()
}

export const sessionCookie = (token: string, maxAge: number, secure: boolean): string =>
  [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')

export const clearSessionCookie = (): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

export { SESSION_COOKIE }
