import path from 'node:path'
import { env } from './env.js'
import { readSecureJson, writeSecureJson } from './storage/crypto.js'

/**
 * 服务端运行时可调配置。
 *
 * 优先级：GUI 保存到 runtime-config.json 的值 > .env / Compose 默认值。
 * 文件使用数据加密密钥加密；GET 接口永不返回 API Key 明文，只返回是否已配置。
 * 端口、HTTPS 域名、加密密钥文件等部署级参数不在这里改，它们属于容器/Compose 层。
 */

const CONFIG_FILE = path.join(env.dataRoot, 'runtime-config.json')
const CONFIG_AAD = 'runtime-config'
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/
const API_KEY_PATTERN = /^[\x21-\x7E]{8,512}$/

type StoredConfig = {
  deepseekApiKey?: string
  allowedModels?: string[]
  chatRateLimitPerMinute?: number
  agentMaxIterations?: number
  sshAllowPrivateHosts?: boolean
  trustProxy?: boolean
  requireAuth?: boolean
  corsOrigins?: string[]
  honchoBaseUrl?: string
  honchoApiKey?: string
}

export type EffectiveRuntimeConfig = {
  deepseekApiKey: string
  deepseekApiKeySource: 'server' | 'env' | 'none'
  allowedModels: Set<string>
  allowedModelsList: string[]
  chatRateLimitPerMinute: number
  agentMaxIterations: number
  sshAllowPrivateHosts: boolean
  trustProxy: boolean
  requireAuth: boolean
  corsOrigins: Set<string>
  corsOriginsList: string[]
  honchoBaseUrl: string
  honchoApiKey: string
}

export type PublicRuntimeConfig = {
  deepseekApiKeyConfigured: boolean
  deepseekApiKeySource: 'server' | 'env' | 'none'
  allowedModels: string[]
  chatRateLimitPerMinute: number
  agentMaxIterations: number
  sshAllowPrivateHosts: boolean
  trustProxy: boolean
  requireAuth: boolean
  corsOrigins: string[]
  honchoBaseUrl: string
  honchoApiKeyConfigured: boolean
  honchoApiKeySource: 'server' | 'env' | 'none'
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeConfigError'
  }
}

const clampInt = (value: unknown, min: number, max: number, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RuntimeConfigError(`${field} 必须是整数`)
  }
  if (value < min || value > max) {
    throw new RuntimeConfigError(`${field} 必须在 ${min}-${max} 之间`)
  }
  return value
}

const parseOrigins = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 50) {
    throw new RuntimeConfigError('CORS 来源必须是最多 50 项的数组')
  }
  const origins = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new RuntimeConfigError('CORS 来源不能为空')
    }
    const origin = item.trim().replace(/\/+$/, '')
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new RuntimeConfigError(`CORS 来源不合法：${origin}`)
    }
    if (parsed.origin !== origin || !/^https?:$/.test(parsed.protocol)) {
      throw new RuntimeConfigError(`CORS 来源必须是 http(s) 的 origin：${origin}`)
    }
    return origin
  })
  return [...new Set(origins)]
}

const parseModels = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new RuntimeConfigError('模型列表必须包含 1-50 个模型')
  }
  const models = value.map((item) => {
    if (typeof item !== 'string' || !MODEL_PATTERN.test(item.trim())) {
      throw new RuntimeConfigError(`模型名不合法：${String(item)}`)
    }
    return item.trim()
  })
  return [...new Set(models)]
}

const sanitizeStored = (raw: unknown): StoredConfig => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const value = raw as Record<string, unknown>
  const result: StoredConfig = {}
  if (value.deepseekApiKey === null || value.deepseekApiKey === undefined) {
    // null/undefined = 回退到环境变量
  } else if (typeof value.deepseekApiKey === 'string') {
    const key = value.deepseekApiKey.trim()
    if (key) {
      result.deepseekApiKey = key
    }
  }
  try {
    if (value.allowedModels !== undefined) {
      result.allowedModels = parseModels(value.allowedModels)
    }
    if (value.chatRateLimitPerMinute !== undefined) {
      result.chatRateLimitPerMinute = clampInt(
        value.chatRateLimitPerMinute,
        1,
        600,
        '每分钟请求上限'
      )
    }
    if (value.agentMaxIterations !== undefined) {
      result.agentMaxIterations = clampInt(value.agentMaxIterations, 1, 64, 'Agent 循环上限')
    }
    if (value.corsOrigins !== undefined) {
      result.corsOrigins = parseOrigins(value.corsOrigins)
    }
    if (value.honchoBaseUrl !== undefined) {
      if (typeof value.honchoBaseUrl !== 'string') {
        throw new RuntimeConfigError('Honcho 地址必须是字符串')
      }
      const base = value.honchoBaseUrl.trim().replace(/\/+$/, '')
      if (base) {
        const parsed = new URL(base)
        if (!/^https?:$/.test(parsed.protocol)) {
          throw new RuntimeConfigError('Honcho 地址必须是 http(s) URL')
        }
      }
      result.honchoBaseUrl = base
    }
    if (value.honchoApiKey !== undefined) {
      if (typeof value.honchoApiKey !== 'string') {
        throw new RuntimeConfigError('Honcho 凭据必须是字符串')
      }
      const key = value.honchoApiKey.trim()
      if (key) {
        result.honchoApiKey = key
      }
    }
    for (const key of ['sshAllowPrivateHosts', 'trustProxy', 'requireAuth'] as const) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== 'boolean') {
          throw new RuntimeConfigError(`${key} 必须是布尔值`)
        }
        result[key] = value[key]
      }
    }
  } catch {
    // 历史文件损坏/字段非法时不阻断启动；路由保存时会重新校验。
    return {}
  }
  return result
}

const resolve = (stored: StoredConfig): EffectiveRuntimeConfig => {
  const deepseekApiKey = stored.deepseekApiKey ?? env.deepseekApiKey
  const allowedModelsList = stored.allowedModels ?? [...env.allowedModels]
  const corsOriginsList = [
    ...new Set([...env.corsOrigins, ...(stored.corsOrigins ?? [])]),
  ]
  return {
    deepseekApiKey,
    deepseekApiKeySource: stored.deepseekApiKey
      ? 'server'
      : env.deepseekApiKey
        ? 'env'
        : 'none',
    allowedModels: new Set(allowedModelsList),
    allowedModelsList,
    chatRateLimitPerMinute:
      stored.chatRateLimitPerMinute ?? env.chatRateLimitPerMinute,
    agentMaxIterations: stored.agentMaxIterations ?? env.agentMaxIterations,
    sshAllowPrivateHosts:
      stored.sshAllowPrivateHosts ?? env.sshAllowPrivateHosts,
    trustProxy: stored.trustProxy ?? env.trustProxy,
    requireAuth: stored.requireAuth ?? env.requireAuth,
    corsOrigins: new Set(corsOriginsList),
    corsOriginsList,
    honchoBaseUrl: stored.honchoBaseUrl ?? env.honchoBaseUrl,
    honchoApiKey: stored.honchoApiKey ?? env.honchoApiKey,
  }
}

let stored: StoredConfig = {}
let effective: EffectiveRuntimeConfig = resolve(stored)
let initialized = false

export const initRuntimeConfig = async (): Promise<void> => {
  if (initialized) {
    return
  }
  try {
    stored = sanitizeStored(await readSecureJson<unknown>(CONFIG_FILE, CONFIG_AAD))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error('[runtime-config] 读取失败，使用环境变量默认值', error)
    }
    stored = {}
  }
  effective = resolve(stored)
  initialized = true
}

export const getRuntimeConfig = (): EffectiveRuntimeConfig => effective

export const getPublicRuntimeConfig = (): PublicRuntimeConfig => ({
  deepseekApiKeyConfigured: Boolean(effective.deepseekApiKey),
  deepseekApiKeySource: effective.deepseekApiKeySource,
  allowedModels: effective.allowedModelsList,
  chatRateLimitPerMinute: effective.chatRateLimitPerMinute,
  agentMaxIterations: effective.agentMaxIterations,
  sshAllowPrivateHosts: effective.sshAllowPrivateHosts,
  trustProxy: effective.trustProxy,
  requireAuth: effective.requireAuth,
  corsOrigins: effective.corsOriginsList,
  honchoBaseUrl: effective.honchoBaseUrl,
  honchoApiKeyConfigured: Boolean(effective.honchoApiKey),
  honchoApiKeySource: stored.honchoApiKey
    ? 'server'
    : env.honchoApiKey
      ? 'env'
      : 'none',
})

/**
 * 更新 GUI 覆盖项。字段缺省 = 保持原值；deepseekApiKey: null = 清除覆盖并回退 env。
 */
export const updateRuntimeConfig = async (input: unknown): Promise<PublicRuntimeConfig> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RuntimeConfigError('配置格式不合法')
  }
  const body = input as Record<string, unknown>
  const next: StoredConfig = { ...stored }

  if ('deepseekApiKey' in body) {
    if (body.deepseekApiKey === null || body.deepseekApiKey === '') {
      delete next.deepseekApiKey
    } else if (typeof body.deepseekApiKey === 'string') {
      const key = body.deepseekApiKey.trim()
      if (!API_KEY_PATTERN.test(key)) {
        throw new RuntimeConfigError('DeepSeek Key 格式不合法')
      }
      next.deepseekApiKey = key
    } else {
      throw new RuntimeConfigError('DeepSeek Key 格式不合法')
    }
  }
  if ('allowedModels' in body) {
    next.allowedModels = parseModels(body.allowedModels)
  }
  if ('chatRateLimitPerMinute' in body) {
    next.chatRateLimitPerMinute = clampInt(
      body.chatRateLimitPerMinute,
      1,
      600,
      '每分钟请求上限'
    )
  }
  if ('agentMaxIterations' in body) {
    next.agentMaxIterations = clampInt(
      body.agentMaxIterations,
      1,
      64,
      'Agent 循环上限'
    )
  }
  if ('corsOrigins' in body) {
    next.corsOrigins = parseOrigins(body.corsOrigins)
  }
  if ('honchoBaseUrl' in body) {
    if (typeof body.honchoBaseUrl !== 'string') {
      throw new RuntimeConfigError('Honcho 地址必须是字符串')
    }
    const base = body.honchoBaseUrl.trim().replace(/\/+$/, '')
    if (base) {
      let parsed: URL
      try {
        parsed = new URL(base)
      } catch {
        throw new RuntimeConfigError('Honcho 地址不是合法 URL')
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new RuntimeConfigError('Honcho 地址必须是 http(s) URL')
      }
    }
    next.honchoBaseUrl = base
  }
  if ('honchoApiKey' in body) {
    if (body.honchoApiKey === null || body.honchoApiKey === '') {
      delete next.honchoApiKey
    } else if (typeof body.honchoApiKey === 'string') {
      const key = body.honchoApiKey.trim()
      if (key.length > 2048) {
        throw new RuntimeConfigError('Honcho 凭据过长')
      }
      if (!key) {
        delete next.honchoApiKey
      } else {
        next.honchoApiKey = key
      }
    } else {
      throw new RuntimeConfigError('Honcho 凭据必须是字符串')
    }
  }
  for (const key of ['sshAllowPrivateHosts', 'trustProxy', 'requireAuth'] as const) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') {
        throw new RuntimeConfigError(`${key} 必须是布尔值`)
      }
      next[key] = body[key]
    }
  }

  await writeSecureJson(CONFIG_FILE, next, CONFIG_AAD)
  stored = next
  effective = resolve(stored)
  return getPublicRuntimeConfig()
}

/** 供 /auth/status 快速判断服务端是否已有可用 Key（不暴露内容）。 */
export const hasDeepseekApiKey = (): boolean => Boolean(effective.deepseekApiKey)
