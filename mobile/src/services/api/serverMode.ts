import { create } from 'zustand'

/**
 * 服务器模式：不直连 DeepSeek，而是把请求转发到自建 MyAgent 后端
 * （模型以外还能用记忆、上下文压缩与服务端 Agent 工具）。
 * 登录后后端返回 Bearer token，保存在本机 localStorage。
 */

export type ServerConfig = {
  /** 后端根地址，如 http://192.168.1.10:8090 或 https://myagent.example.com */
  url: string
  /** 登录 token（/api/auth/login 返回） */
  token: string
  /** 是否启用服务端 Agent 工具（文件操作 / 沙箱执行） */
  agent: boolean
  /** 是否启用长期记忆 */
  memory: boolean
}

const KEY = 'myagent:server-config'

const read = (): ServerConfig => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ServerConfig> | null
    if (parsed && typeof parsed.url === 'string' && typeof parsed.token === 'string') {
      return {
        url: parsed.url.replace(/\/+$/, ''),
        token: parsed.token,
        agent: parsed.agent !== false,
        memory: parsed.memory !== false,
      }
    }
  } catch {
    // 忽略损坏配置
  }
  return { url: '', token: '', agent: true, memory: true }
}

const write = (config: ServerConfig) => {
  try {
    if (!config.url || !config.token) {
      localStorage.removeItem(KEY)
    } else {
      localStorage.setItem(KEY, JSON.stringify(config))
    }
  } catch {
    // 存储不可用时仅内存生效
  }
}

export const useServerConfig = create<ServerConfig>(() => read())

const apply = (config: ServerConfig) => {
  write(config)
  useServerConfig.setState(config)
}

/** 是否处于服务器模式（已配置地址与登录 token） */
export const isServerMode = (): boolean => {
  const { url, token } = useServerConfig.getState()
  return Boolean(url && token)
}

export type ServerLoginResult = { ok: boolean; message?: string }

/** 局域网/本机地址允许 HTTP；公网地址必须 HTTPS，避免密码与 Bearer token 明文传输 */
const isPrivateHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '::1' ||
  hostname.startsWith('127.') ||
  hostname.startsWith('10.') ||
  hostname.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
  (hostname.includes(':') &&
    (hostname.startsWith('fe80:') || hostname.startsWith('fc') || hostname.startsWith('fd')))

/** 登录自建服务器：校验地址 → 密码登录 → 记录 token */
export const serverLogin = async (
  urlInput: string,
  password: string
): Promise<ServerLoginResult> => {
  const url = urlInput.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, message: '地址需以 http:// 或 https:// 开头' }
  }
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return { ok: false, message: '服务器地址格式不正确' }
  }
  if (/^http:\/\//i.test(url) && !isPrivateHost(hostname)) {
    return { ok: false, message: '公网地址必须使用 HTTPS（http 会明文传输密码和 token）' }
  }
  try {
    const loginResponse = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-myagent-client': 'mobile' },
      body: JSON.stringify({ password, remember: true }),
      signal: AbortSignal.timeout(15_000),
    })
    if (loginResponse.status === 400) {
      // 服务器尚未设置访问密码。公网模式（REQUIRE_AUTH=true）会拒绝开放访问，需先配置密码。
      const status = await fetch(`${url}/api/auth/status`, {
        signal: AbortSignal.timeout(10_000),
      })
        .then(
          (response) =>
            response.ok
              ? (response.json() as Promise<{ requireAuth?: boolean; passwordSet?: boolean }>)
              : null
        )
        .catch(() => null)
      if (status?.requireAuth && !status.passwordSet) {
        return { ok: false, message: '服务器要求访问密码，但尚未设置。请先在服务端配置 ACCESS_PASSWORD。' }
      }
      // 开放模式：允许直接连接
      const ping = await fetch(`${url}/api/mobile/ping`, { signal: AbortSignal.timeout(10_000) })
      if (!ping.ok) {
        return { ok: false, message: '服务器未就绪' }
      }
      apply({ ...useServerConfig.getState(), url, token: 'open' })
      return { ok: true }
    }
    if (!loginResponse.ok) {
      return { ok: false, message: loginResponse.status === 401 ? '密码错误' : `连接失败（${loginResponse.status}）` }
    }
    const body = (await loginResponse.json()) as { token?: string }
    if (!body.token) {
      return { ok: false, message: '服务器未返回登录凭据' }
    }
    const pingResponse = await fetch(`${url}/api/mobile/ping`, {
      headers: { Authorization: `Bearer ${body.token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!pingResponse.ok) {
      return { ok: false, message: '登录成功但接口不可用，请检查服务器版本' }
    }
    apply({ ...useServerConfig.getState(), url, token: body.token })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: `无法连接服务器：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 修改服务端能力开关（Agent / 记忆） */
export const setServerOptions = (options: Partial<Pick<ServerConfig, 'agent' | 'memory'>>) => {
  apply({ ...useServerConfig.getState(), ...options })
}

/** 断开服务器模式，回到直连 DeepSeek */
export const serverLogout = () => {
  apply({ url: '', token: '', agent: true, memory: true })
}

/** 轮次收尾上报（写入长期记忆，fire-and-forget）；write=false 时不写入 */
export const completeServerTurn = (
  sessionId: string,
  userContent: string,
  assistantContent: string,
  write = true
) => {
  const { url, token, memory } = useServerConfig.getState()
  if (!url || !token || !memory) {
    return
  }
  void fetch(`${url}/api/mobile/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      sessionId,
      query: userContent,
      userContent,
      assistantContent,
      write,
    }),
    keepalive: true,
  }).catch(() => {
    // 记忆写入失败不影响聊天
  })
}

/** 关闭 Agent 后回收服务端工作区与 SSH 连接 */
export const cleanupServerWorkspace = (sessionId: string) => {
  const { url, token } = useServerConfig.getState()
  if (!url || !token) {
    return
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== 'open') {
    headers.Authorization = `Bearer ${token}`
  }
  void fetch(`${url}/api/agent/cleanup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId }),
    keepalive: true,
  }).catch(() => undefined)
}

export type ServerCompressResult = {
  compressed: boolean
  summary?: string
  archiveRounds?: number
  reason?: string
}

/** 手动压缩：后端 force 压缩当前上下文，返回摘要行与归档轮数 */
export const serverCompress = async (
  sessionId: string,
  messages: unknown[]
): Promise<ServerCompressResult> => {
  const { url, token } = useServerConfig.getState()
  if (!url || !token) {
    throw new Error('服务器模式未连接')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== 'open') {
    headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(`${url}/api/compress`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sessionId,
      messages,
      compression: { enabled: true },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('登录已失效，请重新连接服务器')
    }
    throw new Error(`压缩失败（${response.status}）`)
  }
  return (await response.json()) as ServerCompressResult
}
