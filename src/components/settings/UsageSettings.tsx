import { useCallback, useEffect, useState } from 'react'
import { getAgentApiOrigin } from '../../services/api/client.js'
import { useTranslate } from '../../i18n/index.js'
import { IconChartOutline16, IconRefreshOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import styles from './UsageSettings.module.css'

type TokenTotals = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  total: number
}

type UsageStats = {
  generatedAt: number
  sessions: number
  requests: number
  totals: TokenTotals
  today: TokenTotals & { requests: number }
  days: Array<TokenTotals & { date: string; requests: number }>
  models: Array<TokenTotals & { model: string; requests: number }>
  speed: { average: number | null; recent: number | null; samples: number }
  balance: {
    available: boolean
    currency?: string
    total?: number
    granted?: number
    toppedUp?: number
    checkedAt?: number
    stale?: boolean
    error?: string
  }
  cost: {
    perMillion: number | null
    currency?: string
    windowTokens: number
    since: number | null
  }
}

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`
  }
  return String(value)
}

const formatMoney = (value: number, currency?: string): string => {
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency ?? ''} `
  return `${symbol}${value.toFixed(2)}`
}

const formatSpeed = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)} tok/s`

/** 设置 → 消耗：token 汇总、生成速度、余额与按余额变化估算的平均成本 */
export const UsageSettings = () => {
  const t = useTranslate()
  const [data, setData] = useState<UsageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(false)
    try {
      const tzOffset = new Date().getTimezoneOffset()
      const response = await fetch(
        `${getAgentApiOrigin()}/api/usage?tzOffset=${tzOffset}${refresh ? '&refresh=1' : ''}`,
        { credentials: 'include' }
      )
      if (!response.ok) {
        throw new Error(String(response.status))
      }
      setData((await response.json()) as UsageStats)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const maxDay = data ? Math.max(1, ...data.days.map((day) => day.total)) : 1
  const balance = data?.balance
  const cost = data?.cost

  return (
    <div className={styles.panel}>
      <div className={styles.balanceCard}>
        <div className={styles.balanceTop}>
          <span className={styles.balanceLabel}>
            <IconChartOutline16 />
            {t('usageBalance')}
          </span>
          <Button variant="outlined" size="s" disabled={loading} onClick={() => void load(true)}>
            <IconRefreshOutline16 />
            {t('usageRefresh')}
          </Button>
        </div>
        {balance?.available && balance.total !== undefined ? (
          <>
            <div className={styles.balanceValue}>
              {formatMoney(balance.total, balance.currency)}
            </div>
            <div className={styles.balanceMeta}>
              {t('usageBalanceDetail', {
                granted: formatMoney(balance.granted ?? 0, balance.currency),
                toppedUp: formatMoney(balance.toppedUp ?? 0, balance.currency),
              })}
              {balance.stale ? ` · ${t('usageBalanceStale')}` : ''}
            </div>
          </>
        ) : (
          <div className={styles.balanceUnavailable}>
            {error
              ? t('usageLoadFailed')
              : balance?.error
                ? t('usageBalanceUnavailableDetail', { message: balance.error })
                : t('usageLoading')}
          </div>
        )}
        <div className={styles.costLine}>
          {cost?.perMillion !== null && cost?.perMillion !== undefined ? (
            <>
              <strong>
                {t('usageAverageCost', {
                  cost: formatMoney(cost.perMillion, cost.currency),
                })}
              </strong>
              <span>
                {t('usageCostWindow', { tokens: formatTokens(cost.windowTokens) })}
              </span>
            </>
          ) : (
            <span>{t('usageCostPending')}</span>
          )}
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.metric}>
          <span>{t('usageTotalTokens')}</span>
          <strong>{formatTokens(data?.totals.total ?? 0)}</strong>
        </div>
        <div className={styles.metric}>
          <span>{t('usageInputTokens')}</span>
          <strong>{formatTokens(data?.totals.input ?? 0)}</strong>
        </div>
        <div className={styles.metric}>
          <span>{t('usageOutputTokens')}</span>
          <strong>{formatTokens(data?.totals.output ?? 0)}</strong>
        </div>
        <div className={styles.metric}>
          <span>{t('usageCacheRead')}</span>
          <strong>{formatTokens(data?.totals.cacheRead ?? 0)}</strong>
        </div>
        <div className={styles.metric}>
          <span>{t('usageRequests')}</span>
          <strong>{data?.requests ?? 0}</strong>
        </div>
        <div className={styles.metric}>
          <span>{t('usageSpeedAverage')}</span>
          <strong>{formatSpeed(data?.speed.average ?? null)}</strong>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t('usageSpeedTitle')}</div>
        <div className={styles.speedRow}>
          <span>{t('usageSpeedRecent')}</span>
          <strong>{formatSpeed(data?.speed.recent ?? null)}</strong>
          <span className={styles.muted}>{t('usageSpeedSamples', { count: data?.speed.samples ?? 0 })}</span>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t('usageLast7Days')}</div>
        <div className={styles.days}>
          {(data?.days ?? []).map((day) => (
            <div key={day.date} className={styles.dayRow}>
              <span className={styles.dayDate}>{day.date.slice(5)}</span>
              <div className={styles.dayBar}>
                <span style={{ width: `${Math.max(day.total > 0 ? 3 : 0, (day.total / maxDay) * 100)}%` }} />
              </div>
              <span className={styles.dayValue}>{formatTokens(day.total)}</span>
            </div>
          ))}
        </div>
      </div>

      <p className={styles.note}>{t('usageNote')}</p>
    </div>
  )
}
