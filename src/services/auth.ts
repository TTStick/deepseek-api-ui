import { getAgentApiOrigin } from './api/client.js'
import { setServerApiKeyConfigured } from './serverKey.js'

/** 单用户访问密码：登录状态、登录/登出、设置密码 */

export type AuthStatus = {
  passwordSet: boolean
  authenticated: boolean
  requireAuth?: boolean
  /** 服务端是否已配置 DeepSeek Key（只有布尔值，不含 Key 本身） */
  serverApiKey?: boolean
}

const base = () => getAgentApiOrigin()

export const fetchAuthStatus = async (): Promise<AuthStatus> => {
  const response = await fetch(`${base()}/api/auth/status`, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const status = (await response.json()) as AuthStatus
  setServerApiKeyConfigured(status.serverApiKey === true)
  return status
}

const post = async (path: string, body: unknown): Promise<{ ok: boolean; message?: string }> => {
  const response = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.ok) {
    return { ok: true }
  }
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
  return { ok: false, message: payload?.error?.message }
}

export const login = (password: string, remember: boolean) =>
  post('/api/auth/login', { password, remember })

export const logout = () => post('/api/auth/logout', {})

export const changePassword = (currentPassword: string, newPassword: string) =>
  post('/api/auth/password', { currentPassword, newPassword })

/** 全局 401 广播：任何 API 返回 401 时通知登录页重新验证 */
export const AUTH_REQUIRED_EVENT = 'myagent:auth-required'

export const notifyAuthRequired = () => {
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
}
