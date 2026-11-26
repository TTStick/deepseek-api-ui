import { env } from '../env.js'

/** Honcho v3 REST 客户端（对齐自托管 server 3.7 的 /v3 路由，见官方仓库 src/routers） */
export class HonchoApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HonchoApiError'
  }
}

export type SessionPeerConfig = {
  observe_me?: boolean
  observe_others?: boolean
}

export type SessionContext = {
  summary?: { text?: string } | null
  peer_representation?: string | null
  peer_card?: string[] | null
}

export type PeerContext = {
  representation?: string | null
  peer_card?: string[] | null
}

export class HonchoClient {
  readonly base: string

  constructor(
    private readonly token: string,
    baseUrl: string
  ) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    timeoutMs = 15_000
  ): Promise<unknown> {
    const url = new URL(`${this.base}/v3${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new HonchoApiError(response.status, await response.text().catch(() => ''))
    }
    if (response.status === 204) {
      return undefined
    }
    return response.json().catch(() => undefined)
  }

  // -- 资源 get-or-create ---------------------------------------------------

  async ensureWorkspace(id: string) {
    return this.call('POST', '/workspaces', { id })
  }

  async ensureSession(workspace: string, id: string) {
    return this.call('POST', `/workspaces/${encodeURIComponent(workspace)}/sessions`, { id })
  }

  async ensurePeer(workspace: string, id: string) {
    return this.call('POST', `/workspaces/${encodeURIComponent(workspace)}/peers`, { id })
  }

  async addPeers(workspace: string, session: string, peers: Record<string, SessionPeerConfig>) {
    return this.call(
      'POST',
      `/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}/peers`,
      peers
    )
  }

  // -- 消息 -----------------------------------------------------------------

  async addMessages(
    workspace: string,
    session: string,
    messages: Array<{ peer_id: string; content: string; created_at?: string }>
  ) {
    return this.call(
      'POST',
      `/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}/messages`,
      { messages }
    )
  }

  // -- 召回 -----------------------------------------------------------------

  async sessionContext(
    workspace: string,
    session: string,
    params: {
      summary?: boolean
      tokens?: number
      search_query?: string
      peer_target?: string
      search_top_k?: number
    }
  ): Promise<SessionContext> {
    return (await this.call(
      'GET',
      `/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}/context`,
      undefined,
      params,
      12_000
    )) as SessionContext
  }

  async peerContext(
    workspace: string,
    peer: string,
    params: { target?: string; search_query?: string }
  ): Promise<PeerContext> {
    return (await this.call(
      'GET',
      `/workspaces/${encodeURIComponent(workspace)}/peers/${encodeURIComponent(peer)}/context`,
      undefined,
      params,
      12_000
    )) as PeerContext
  }

  /** 辩证法：让 Honcho 的 LLM 以该 peer 视角推理出当前最有用的用户上下文 */
  async peerChat(
    workspace: string,
    peer: string,
    body: {
      session_id?: string
      target?: string
      query: string
      stream: false
      reasoning_level: string
    }
  ): Promise<{ content?: string | null }> {
    return (await this.call(
      'POST',
      `/workspaces/${encodeURIComponent(workspace)}/peers/${encodeURIComponent(peer)}/chat`,
      body,
      undefined,
      60_000
    )) as { content?: string | null }
  }

  // -- conclusions（记忆管理 UI 用） -----------------------------------------

  async createConclusions(
    workspace: string,
    conclusions: Array<{ content: string; observer_id: string; observed_id: string; session_id?: string }>
  ) {
    return this.call('POST', `/workspaces/${encodeURIComponent(workspace)}/conclusions`, {
      conclusions,
    })
  }

  async listConclusions(workspace: string, size = 50): Promise<{ items?: Array<{ id: string; content: string }> }> {
    return (await this.call(
      'POST',
      `/workspaces/${encodeURIComponent(workspace)}/conclusions/list`,
      { size }
    )) as { items?: Array<{ id: string; content: string }> }
  }

  async queryConclusions(
    workspace: string,
    query: string,
    topK = 8
  ): Promise<Array<{ id: string; content: string }>> {
    return (await this.call(
      'POST',
      `/workspaces/${encodeURIComponent(workspace)}/conclusions/query`,
      { query, top_k: topK }
    )) as Array<{ id: string; content: string }>
  }

  async deleteConclusion(workspace: string, id: string) {
    return this.call(
      'DELETE',
      `/workspaces/${encodeURIComponent(workspace)}/conclusions/${encodeURIComponent(id)}`
    )
  }
}

/** 唯一实例：自托管单工作区，凭据来自服务端环境 */
let shared: HonchoClient | null = null

export const getHonchoClient = (): HonchoClient => {
  if (!shared) {
    shared = new HonchoClient(env.honchoApiKey || 'local', env.honchoBaseUrl || 'http://localhost:8000')
  }
  return shared
}
