import { create } from 'zustand'

/**
 * 服务器模式：不直连 DeepSeek，而是把请求转发到自建 MyAgent 后端
 * （模型以外还能用记忆、上下文压缩与服务端 Agent 工具）。
 * 登录后后端返回 Bearer token，保存在本机 localStorage。
 */

export type ServerConfig = {
  /** 实际请求使用的根地址；内置 Tailscale 就绪时会指向 127.0.0.1 代理 */
  url: string
  /** 用户填写的服务器地址（直连地址），隧道关闭时与 url 相同 */
  directUrl: string
  /** 是否通过内置 Tailscale 隧道访问 */
  tunnel: boolean
  /** 登录 token（/api/auth/login 返回） */
  token: string
  /** 是否启用服务端 Agent 工具（文件操作 / 沙箱执行） */
  agent: boolean
  /** 是否启用长期记忆 */
  memory: boolean
  /** 进阶：当前对话消息索引 */
  conversationIndex: boolean
  /** 进阶：当前对话资料索引 */
  referenceIndex: boolean
}

const KEY = 'myagent:server-config'

const read = (): ServerConfig => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ServerConfig> | null
    if (parsed && typeof parsed.url === 'string' && typeof parsed.token === 'string') {
      const url = parsed.url.replace(/\/+$/, '')
      return {
        url,
        directUrl:
          typeof parsed.directUrl === 'string' ? parsed.directUrl.replace(/\/+$/, '') : url,
        tunnel: parsed.tunnel === true,
        token: parsed.token,
        agent: parsed.agent !== false,
        memory: parsed.memory !== false,
        conversationIndex: parsed.conversationIndex === true,
        referenceIndex: parsed.referenceIndex === true,
      }
    }
  } catch {
    // 忽略损坏配置
  }
  return {
    url: '',
    directUrl: '',
    tunnel: false,
    token: '',
    agent: true,
    memory: true,
    conversationIndex: false,
    referenceIndex: false,
  }
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

/** 把请求地址切到内置 Tailscale 的本地回环代理 */
export const applyTunnelAddr = (addr: string) => {
  const config = useServerConfig.getState()
  const direct = config.directUrl || config.url
  if (!direct || !addr) {
    return
  }
  apply({ ...config, url: `http://${addr}`, directUrl: direct, tunnel: true })
}

/** 关闭内置 Tailscale，恢复用户填写的直连地址 */
export const restoreDirectUrl = () => {
  const config = useServerConfig.getState()
  const direct = config.directUrl || config.url
  if (!direct) {
    apply({ ...config, tunnel: false })
    return
  }
  apply({ ...config, url: direct, directUrl: direct, tunnel: false })
}

/** 记住用户填写的直连地址（尚未登录、隧道可能先于连接启动） */
export const rememberDirectUrl = (url: string) => {
  const value = url.trim().replace(/\/+$/, '')
  if (!value) {
    return
  }
  const config = useServerConfig.getState()
  apply({ ...config, directUrl: value, url: config.tunnel ? config.url || value : value })
}

/** 对外展示的服务器地址（用户填写的那个，而非隧道代理地址） */
export const displayUrl = (config: ServerConfig): string => config.directUrl || config.url

/** 是否处于服务器模式（已配置地址与登录 token） */
export const isServerMode = (): boolean => {
  const { url, token } = useServerConfig.getState()
  return Boolean(url && token)
}

export type ServerLoginResult = { ok: boolean; message?: string }

/** IPv4 点分十进制转 32 位整数，非法返回 null */
const ipv4ToInt = (value: string): number | null => {
  const parts = value.split('.')
  if (parts.length !== 4) {
    return null
  }
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }
    const octet = Number(part)
    if (octet > 255) {
      return null
    }
    result = result * 256 + octet
  }
  return result
}

/** 判断 IPv4 是否落在指定 CIDR 内 */
const inIPv4Range = (host: string, base: string, bits: number): boolean => {
  const target = ipv4ToInt(host)
  const baseValue = ipv4ToInt(base)
  if (target === null || baseValue === null) {
    return false
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (target & mask) === (baseValue & mask)
}

/**
 * 局域网/本机地址允许 HTTP；公网地址必须 HTTPS，避免密码与 Bearer token 明文传输。
 * 覆盖：环回、RFC1918 私有网段、链路本地、CGNAT（Tailscale 使用 100.64.0.0/10）、
 * IPv6 ULA/链路本地、localhost 及常见内网域名后缀（.local/.lan/.internal/.ts.net）。
 */
const isPrivateHost = (hostname: string): boolean => {
  // URL.hostname 对 IPv6 会保留方括号
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true
  }
  // 局域网域名后缀，以及 Tailscale MagicDNS（*.ts.net 解析到 100.64.0.0/10）
  if (/\.(local|lan|internal|home\.arpa|ts\.net)$/.test(host)) {
    return true
  }

  if (host.includes(':')) {
    return (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fe80:') || // IPv6 链路本地
      /^f[cd]/.test(host) // IPv6 ULA（fc00::/7）
    )
  }

  // 单标签主机名（如 nas、myagent）只能在局域网内解析
  if (!host.includes('.')) {
    return true
  }

  return (
    inIPv4Range(host, '127.0.0.0', 8) || // 环回
    inIPv4Range(host, '10.0.0.0', 8) || // 私有 A
    inIPv4Range(host, '172.16.0.0', 12) || // 私有 B
    inIPv4Range(host, '192.168.0.0', 16) || // 私有 C
    inIPv4Range(host, '100.64.0.0', 10) || // CGNAT / Tailscale
    inIPv4Range(host, '169.254.0.0', 16) // 链路本地
  )
}

/** 登录自建服务器：校验地址 → 密码登录 → 记录 token */
export const serverLogin = async (
  urlInput: string,
  password: string,
  options?: { directUrl?: string; tunnel?: boolean }
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
    return {
      ok: false,
      message: '公网地址必须使用 HTTPS（http 会明文传输密码和 token）；内网或 Tailscale（100.x）地址可用 http',
    }
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
      apply({
        ...useServerConfig.getState(),
        url,
        directUrl: options?.directUrl ?? url,
        tunnel: options?.tunnel ?? false,
        token: 'open',
      })
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
    apply({
      ...useServerConfig.getState(),
      url,
      directUrl: options?.directUrl ?? url,
      tunnel: options?.tunnel ?? false,
      token: body.token,
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: `无法连接服务器：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 修改服务端能力开关（Agent / 记忆） */
export const setServerOptions = (
  options: Partial<
    Pick<ServerConfig, 'agent' | 'memory' | 'conversationIndex' | 'referenceIndex'>
  >
) => {
  apply({ ...useServerConfig.getState(), ...options })
}

/** 断开服务器模式，回到直连 DeepSeek */
export const serverLogout = () => {
  apply({
    url: '',
    directUrl: '',
    tunnel: false,
    token: '',
    agent: true,
    memory: true,
    conversationIndex: false,
    referenceIndex: false,
  })
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
