import { create } from 'zustand'
import { android } from '../app/android.js'
import { applyTunnelAddr, restoreDirectUrl } from './api/serverMode.js'

/**
 * 内置 Tailscale（userspace 隧道）。
 *
 * 原生层用 tsnet 在 App 进程内加入 tailnet，并监听 127.0.0.1 的一个随机端口，
 * 所有发到该端口的 TCP 连接都会经 WireGuard 隧道转发到服务器。
 * 因此不需要系统 VPN（VpnService），不接管设备流量，也不会和其他 VPN 冲突。
 *
 * 登录：首次启动把节点状态保持在 starting 并给出 login.tailscale.com 链接，
 * 用户在浏览器授权后自动就绪；节点密钥持久化，之后无需再次登录。
 */

export type TunnelState = 'stopped' | 'starting' | 'ready' | 'error'

export type TunnelSnapshot = {
  state: TunnelState
  /** 回环代理地址，如 127.0.0.1:54321 */
  addr: string
  /** 本节点在 tailnet 内的 100.x 地址 */
  ip: string
  error: string
  /** 交互登录链接（浏览器登录时出现） */
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
  /** 用户是否已启用（决定界面展示与启动恢复） */
  enabled: boolean
  refresh: () => TunnelSnapshot
  start: (target: string, authKey?: string) => TunnelSnapshot
  stop: () => void
  setEnabled: (enabled: boolean) => void
}

/** 当前隧道目标，目标变化时需要重启 tsnet */
let activeTarget = ''

export const useTunnel = create<TunnelStore>((set, get) => ({
  ...EMPTY_TUNNEL,
  enabled: false,
  refresh: () => {
    const next = parse(android?.tsStatus?.())
    set(next)
    return next
  },
  start: (target, authKey) => {
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
    if (authKey) {
      device.tsSetAuthKey?.(authKey)
    }
    // 目标地址变化时先停掉旧隧道，tsnet 不会自己改转发目标
    if (activeTarget && activeTarget !== target) {
      device.tsStop?.()
    }
    activeTarget = target
    device.tsStart(authKey ?? '', target, 'wydeepseek')
    const next = get().refresh()
    set({ enabled: true })
    return next
  },
  stop: () => {
    android?.tsStop?.()
    activeTarget = ''
    set({ ...EMPTY_TUNNEL, enabled: false })
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

/** 用系统浏览器打开交互登录页 */
export const openLoginPage = (): boolean => android?.tsOpenLogin?.() ?? false

let watcher: ReturnType<typeof setInterval> | null = null

const stopWatching = () => {
  if (watcher) {
    clearInterval(watcher)
    watcher = null
  }
}

/**
 * 轮询隧道状态直到就绪或失败：
 * - 就绪：把服务器请求地址切到本地代理
 * - 失败：回退到直连地址
 * 交互登录期间会一直保持轮询（不设上限），界面实时显示状态与登录链接。
 */
export const watchTunnel = () => {
  stopWatching()
  watcher = setInterval(() => {
    const snapshot = useTunnel.getState().refresh()
    if (snapshot.state === 'ready') {
      applyTunnelAddr(snapshot.addr)
      stopWatching()
      return
    }
    if (snapshot.state === 'error') {
      restoreDirectUrl()
      stopWatching()
      return
    }
    if (snapshot.state === 'stopped') {
      stopWatching()
    }
  }, 1500)
}

/** 立即刷新一次并返回快照（用于等待就绪的同步场景） */
export const refreshTunnel = (): TunnelSnapshot => useTunnel.getState().refresh()
