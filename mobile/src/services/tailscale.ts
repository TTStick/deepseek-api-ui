import { create } from 'zustand'
import { android } from '../app/android.js'

/**
 * 内置 Tailscale（userspace 隧道）。
 *
 * 原生层用 tsnet 在 App 进程内加入 tailnet，并监听 127.0.0.1 的一个随机端口，
 * 所有发到该端口的 TCP 连接都会经 WireGuard 隧道转发到服务器。
 * 因此不需要系统 VPN（VpnService），不接管设备流量，也不会和其他 VPN 冲突。
 */

export type TunnelState = 'stopped' | 'starting' | 'ready' | 'error'

export type TunnelSnapshot = {
  state: TunnelState
  /** 回环代理地址，如 127.0.0.1:54321 */
  addr: string
  /** 本节点在 tailnet 内的 100.x 地址 */
  ip: string
  error: string
  /** 交互登录链接（未填 Auth Key 时出现） */
  loginUrl: string
}

export const EMPTY_TUNNEL: TunnelSnapshot = {
  state: 'stopped',
  addr: '',
  ip: '',
  error: '',
  loginUrl: '',
}

const parse = (raw: string | null | undefined): TunnelSnapshot => {
  if (!raw) {
    return EMPTY_TUNNEL
  }
  try {
    const value = JSON.parse(raw) as Partial<TunnelSnapshot>
    const state = value.state
    return {
      state:
        state === 'starting' || state === 'ready' || state === 'error' ? state : 'stopped',
      addr: typeof value.addr === 'string' ? value.addr : '',
      ip: typeof value.ip === 'string' ? value.ip : '',
      error: typeof value.error === 'string' ? value.error : '',
      loginUrl: typeof value.loginUrl === 'string' ? value.loginUrl : '',
    }
  } catch {
    return EMPTY_TUNNEL
  }
}

type TunnelStore = TunnelSnapshot & {
  /** 是否启用（用户开关，持久化在 server 配置里） */
  enabled: boolean
  refresh: () => TunnelSnapshot
  start: (authKey: string, target: string) => TunnelSnapshot
  stop: () => void
  setEnabled: (enabled: boolean) => void
}

export const useTunnel = create<TunnelStore>((set, get) => ({
  ...EMPTY_TUNNEL,
  enabled: false,
  refresh: () => {
    const next = parse(android?.tsStatus?.())
    set(next)
    return next
  },
  start: (authKey, target) => {
    const device = android
    if (!device?.tsStart) {
      const next: TunnelSnapshot = {
        ...EMPTY_TUNNEL,
        state: 'error',
        error: '当前平台不支持内置 Tailscale（仅 Android）',
      }
      set(next)
      return next
    }
    device.tsSetAuthKey?.(authKey || null)
    device.tsStart(authKey, target, 'wydeepseek')
    const next = get().refresh()
    return next
  },
  stop: () => {
    android?.tsStop?.()
    set(EMPTY_TUNNEL)
  },
  setEnabled: (enabled) => set({ enabled }),
}))

/** 从服务器地址推导隧道目标（host:port），默认端口按协议补齐 */
export const targetFromUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    return `${parsed.hostname}:${port}`
  } catch {
    return ''
  }
}

export const savedAuthKey = (): string => android?.tsAuthKey?.() ?? ''

/** 轮询直到隧道就绪或失败，返回最终快照 */
export const waitTunnel = async (timeoutMs = 90_000): Promise<TunnelSnapshot> => {
  const started = Date.now()
  let snapshot = useTunnel.getState().refresh()
  while (snapshot.state === 'starting' && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 800))
    snapshot = useTunnel.getState().refresh()
  }
  return snapshot
}
