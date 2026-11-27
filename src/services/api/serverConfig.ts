import { getAgentApiOrigin } from './client.js'

export type ServerConfig = {
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
  passwordSet: boolean
}

export type ServerConfigInput = Partial<{
  /** null = 清除 GUI 覆盖并回退环境变量 */
  deepseekApiKey: string | null
  allowedModels: string[]
  chatRateLimitPerMinute: number
  agentMaxIterations: number
  sshAllowPrivateHosts: boolean
  trustProxy: boolean
  requireAuth: boolean
  corsOrigins: string[]
  honchoBaseUrl: string
  honchoApiKey: string | null
}>

const url = () => `${getAgentApiOrigin()}/api/server-config`

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') {
      return body.error.message
    }
  } catch {
    // 非 JSON 错误体
  }
  return `HTTP ${response.status}`
}

export const fetchServerConfig = async (): Promise<ServerConfig> => {
  const response = await fetch(url(), { credentials: 'include' })
  if (!response.ok) {
    throw new Error(await errorMessage(response))
  }
  return (await response.json()) as ServerConfig
}

export const saveServerConfig = async (
  input: ServerConfigInput
): Promise<ServerConfig> => {
  const response = await fetch(url(), {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(await errorMessage(response))
  }
  return (await response.json()) as ServerConfig
}
