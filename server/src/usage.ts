import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from './env.js'

/**
 * 用量统计：扫描服务端会话库里的 usage 快照，汇总 token、请求数与生成速度；
 * 余额来自 DeepSeek 官方 /user/balance，并结合余额变化与 token 增量估算平均成本。
 * 所有数据以服务端已同步会话为准，网页端与手机端读取同一份统计。
 */

const SESSIONS_DIR = path.join(env.dataRoot, 'sessions')
const STATE_FILE = path.join(env.dataRoot, 'usage-state.json')
const BALANCE_URL = `${env.deepseekApiOrigin.replace(/\/+$/, '')}/user/balance`
const BALANCE_CACHE_MS = 30_000
const SAMPLE_INTERVAL_MS = 60_000
const MAX_SAMPLES = 500
/** 余额按分计费且可能有延迟，样本 token 太少时估算噪声过大，达到该量级后再展示平均值 */
const MIN_COST_WINDOW_TOKENS = 20_000

export type TokenTotals = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  total: number
}

export type DayUsage = TokenTotals & {
  date: string
  requests: number
}

export type ModelUsage = TokenTotals & {
  model: string
  requests: number
}

export type SpeedStats = {
  /** 平均输出速度（tokens/s），仅统计记录了 elapsedMs 的回复 */
  average: number | null
  /** 最近 20 条回复的平均输出速度 */
  recent: number | null
  /** 参与速度统计的回复数 */
  samples: number
}

export type BalanceInfo = {
  available: boolean
  currency?: string
  total?: number
  granted?: number
  toppedUp?: number
  checkedAt?: number
  stale?: boolean
  error?: string
}

export type CostInfo = {
  /** 估算的每百万 token 平均成本（与余额币种一致） */
  perMillion: number | null
  currency?: string
  windowTokens: number
  since: number | null
}

export type UsageStats = {
  generatedAt: number
  sessions: number
  requests: number
  totals: TokenTotals
  today: TokenTotals & { requests: number }
  days: DayUsage[]
  models: ModelUsage[]
  speed: SpeedStats
  balance: BalanceInfo
  cost: CostInfo
}

type UsageSample = {
  at: number
  tokens: number
  balance: number
  currency: string
}

type UsageState = {
  samples: UsageSample[]
}

type RawMessage = {
  role?: string
  model?: string | null
  createdAt?: number
  elapsedMs?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

type RawSession = { messages?: RawMessage[] }

const emptyTotals = (): TokenTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
})

const addUsage = (totals: TokenTotals, message: RawMessage) => {
  const usage = message.usage
  if (!usage) {
    return false
  }
  const input = Number.isFinite(usage.input_tokens) ? (usage.input_tokens as number) : 0
  const output = Number.isFinite(usage.output_tokens) ? (usage.output_tokens as number) : 0
  const cacheRead = Number.isFinite(usage.cache_read_input_tokens)
    ? (usage.cache_read_input_tokens as number)
    : 0
  const cacheCreation = Number.isFinite(usage.cache_creation_input_tokens)
    ? (usage.cache_creation_input_tokens as number)
    : 0
  totals.input += input
  totals.output += output
  totals.cacheRead += cacheRead
  totals.cacheCreation += cacheCreation
  totals.total += input + output + cacheRead + cacheCreation
  return true
}

const dateKey = (time: number, tzOffset: number): string =>
  new Date(time - tzOffset * 60_000).toISOString().slice(0, 10)

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

let balanceCache: { at: number; data: BalanceInfo } | null = null

const fetchBalance = async (force = false): Promise<BalanceInfo> => {
  const now = Date.now()
  if (!force && balanceCache && now - balanceCache.at < BALANCE_CACHE_MS) {
    return balanceCache.data
  }
  if (!env.deepseekApiKey) {
    return { available: false, error: '服务端未配置 DEEPSEEK_API_KEY' }
  }
  try {
    const response = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${env.deepseekApiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      return { available: false, error: `余额接口返回 ${response.status}` }
    }
    const body = (await response.json()) as {
      is_available?: boolean
      balance_infos?: Array<{
        currency?: string
        total_balance?: string
        granted_balance?: string
        topped_up_balance?: string
      }>
    }
    const info =
      body.balance_infos?.find((item) => item.currency === 'CNY') ?? body.balance_infos?.[0]
    if (!info) {
      return { available: false, error: '余额接口未返回余额信息' }
    }
    const data: BalanceInfo = {
      available: body.is_available !== false,
      currency: info.currency ?? 'CNY',
      total: Number(info.total_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
      checkedAt: now,
    }
    balanceCache = { at: now, data }
    return data
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

let stateQueue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const result = stateQueue.then(task)
  stateQueue = result.catch(() => {})
  return result
}

const readState = async (): Promise<UsageState> => {
  const parsed = await readJson<UsageState>(STATE_FILE)
  return {
    samples: Array.isArray(parsed?.samples)
      ? parsed.samples.filter(
          (sample): sample is UsageSample =>
            typeof sample?.at === 'number' &&
            typeof sample?.tokens === 'number' &&
            typeof sample?.balance === 'number' &&
            typeof sample?.currency === 'string'
        )
      : [],
  }
}

const writeState = async (state: UsageState) => {
  await mkdir(env.dataRoot, { recursive: true })
  const temporary = `${STATE_FILE}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(state), 'utf8')
  await rename(temporary, STATE_FILE)
}

const recordSample = (
  balance: BalanceInfo,
  tokens: number
): Promise<{ samples: UsageSample[]; current: UsageSample }> =>
  serial(async () => {
    const state = await readState()
    const current: UsageSample = {
      at: Date.now(),
      tokens,
      balance: balance.total ?? 0,
      currency: balance.currency ?? 'CNY',
    }
    const last = state.samples.at(-1)
    if (
      !last ||
      current.balance !== last.balance ||
      current.tokens !== last.tokens ||
      current.at - last.at >= SAMPLE_INTERVAL_MS
    ) {
      state.samples.push(current)
      if (state.samples.length > MAX_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_SAMPLES)
      }
      await writeState(state)
    }
    return { samples: state.samples, current }
  })

const estimateCost = (samples: UsageSample[], current: UsageSample): CostInfo => {
  // 与至少 2 万 tokens 之前的样本比较：余额按分计费且到账有延迟，相邻小样本噪声太大
  const latest = samples.at(-1) ?? current
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const previous = samples[index]
    if (previous.currency !== latest.currency) {
      continue
    }
    const tokenDelta = latest.tokens - previous.tokens
    const balanceDelta = previous.balance - latest.balance
    if (tokenDelta >= MIN_COST_WINDOW_TOKENS && balanceDelta > 0) {
      return {
        perMillion: (balanceDelta / tokenDelta) * 1_000_000,
        currency: latest.currency,
        windowTokens: tokenDelta,
        since: previous.at,
      }
    }
  }
  return {
    perMillion: null,
    currency: current.currency,
    windowTokens: 0,
    since: null,
  }
}

export const collectUsage = async (
  tzOffset: number,
  refreshBalance = false
): Promise<UsageStats> => {
  const names = await readdir(SESSIONS_DIR).catch(() => [] as string[])
  const totals = emptyTotals()
  const today = { ...emptyTotals(), requests: 0 }
  const days = new Map<string, DayUsage>()
  const models = new Map<string, ModelUsage>()
  const speedSamples: Array<{ at: number; tokens: number; seconds: number }> = []
  const todayKey = dateKey(Date.now(), tzOffset)
  let sessions = 0
  let requests = 0

  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.meta.json')) {
      continue
    }
    const session = await readJson<RawSession>(path.join(SESSIONS_DIR, name))
    if (!session || !Array.isArray(session.messages)) {
      continue
    }
    sessions += 1
    for (const message of session.messages) {
      if (message.role !== 'assistant' || !addUsage(totals, message)) {
        continue
      }
      requests += 1
      const time = typeof message.createdAt === 'number' ? message.createdAt : Date.now()
      const key = dateKey(time, tzOffset)
      const day =
        days.get(key) ??
        ({ ...emptyTotals(), date: key, requests: 0 } as DayUsage)
      addUsage(day, message)
      day.requests += 1
      days.set(key, day)
      if (key === todayKey) {
        addUsage(today, message)
        today.requests += 1
      }
      const model = typeof message.model === 'string' && message.model ? message.model : 'unknown'
      const modelStat =
        models.get(model) ?? ({ ...emptyTotals(), model, requests: 0 } as ModelUsage)
      addUsage(modelStat, message)
      modelStat.requests += 1
      models.set(model, modelStat)
      const elapsed = typeof message.elapsedMs === 'number' ? message.elapsedMs : 0
      const output = message.usage?.output_tokens ?? 0
      if (elapsed > 0 && output > 0) {
        speedSamples.push({
          at: time,
          tokens: output,
          seconds: elapsed / 1000,
        })
      }
    }
  }

  speedSamples.sort((a, b) => a.at - b.at)
  const speedTotals = speedSamples.reduce(
    (acc, sample) => ({
      tokens: acc.tokens + sample.tokens,
      seconds: acc.seconds + sample.seconds,
    }),
    { tokens: 0, seconds: 0 }
  )
  const recentSamples = speedSamples.slice(-20)
  const recentTotals = recentSamples.reduce(
    (acc, sample) => ({
      tokens: acc.tokens + sample.tokens,
      seconds: acc.seconds + sample.seconds,
    }),
    { tokens: 0, seconds: 0 }
  )

  const now = Date.now()
  const dayList: DayUsage[] = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const key = dateKey(now - offset * 86_400_000, tzOffset)
    dayList.push(days.get(key) ?? { ...emptyTotals(), date: key, requests: 0 })
  }

  let balance = await fetchBalance(refreshBalance)
  let samples: UsageSample[] = []
  let current: UsageSample | null = null
  if (balance.available) {
    const recorded = await recordSample(balance, totals.total)
    samples = recorded.samples
    current = recorded.current
  } else {
    const state = await readState()
    const last = state.samples.at(-1)
    if (last) {
      balance = {
        available: true,
        stale: true,
        currency: last.currency,
        total: last.balance,
        checkedAt: last.at,
        error: balance.error,
      }
    }
  }
  const cost: CostInfo =
    balance.available && current
      ? estimateCost(samples, current)
      : { perMillion: null, windowTokens: 0, since: null, currency: balance.currency }

  return {
    generatedAt: now,
    sessions,
    requests,
    totals,
    today,
    days: dayList,
    models: [...models.values()].sort((a, b) => b.total - a.total).slice(0, 8),
    speed: {
      average:
        speedTotals.seconds > 0 ? speedTotals.tokens / speedTotals.seconds : null,
      recent:
        recentTotals.seconds > 0 ? recentTotals.tokens / recentTotals.seconds : null,
      samples: speedSamples.length,
    },
    balance,
    cost,
  }
}
