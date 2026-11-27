import { useEffect, useState } from 'react'
import { getAgentApiOrigin } from '../../services/api/client.js'
import {
  setCompressionEnabled,
  setConversationIndexEnabled,
  setMemoryEnabled,
  setReferenceIndexEnabled,
  setShowRecalledMemory,
  useSettings,
} from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { IconTrashOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { SettingCell, type Status } from './SettingCell.js'
import { Toggle } from './Toggle.js'
import settingsStyles from './Settings.module.css'
import styles from './MemorySettings.module.css'

type MemoryStatus = {
  available: boolean
  connected: boolean
  provider: string
  workspace: string
  lastError: string | null
}

type Conclusion = { id: string; content: string }

/**
 * 「记忆与上下文」设置分区：Honcho 连接状态、自我检索/压缩开关与记忆浏览。
 * 记忆数据存于自托管 Honcho；开关存 localStorage（与思考/搜索开关同构）。
 */
export const MemorySettings = () => {
  const t = useTranslate()
  const memoryEnabled = useSettings((state) => state.memoryEnabled)
  const showRecalledMemory = useSettings((state) => state.showRecalledMemory)
  const compressionEnabled = useSettings((state) => state.compressionEnabled)
  const conversationIndexEnabled = useSettings((state) => state.conversationIndexEnabled)
  const referenceIndexEnabled = useSettings((state) => state.referenceIndexEnabled)
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [conclusions, setConclusions] = useState<Conclusion[]>([])
  const [conclusionStatus, setConclusionStatus] = useState<Status>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      // 状态请求必须兜底：非 200、超时、异常都要落一个可展示的结果，
      // 否则界面会永远停在「检查中…」。
      try {
        const response = await fetch(`${getAgentApiOrigin()}/api/memory/status`, {
          signal: AbortSignal.timeout(10_000),
        })
        if (cancelled) {
          return
        }
        if (response.ok) {
          setStatus((await response.json()) as MemoryStatus)
        } else {
          setStatus({
            available: false,
            connected: false,
            provider: 'honcho',
            workspace: '',
            lastError: `HTTP ${response.status}`,
          })
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({
            available: false,
            connected: false,
            provider: 'honcho',
            workspace: '',
            lastError: error instanceof Error ? error.message : String(error),
          })
        }
      }
      try {
        const response = await fetch(`${getAgentApiOrigin()}/api/memory/conclusions`, {
          signal: AbortSignal.timeout(10_000),
        })
        if (response.ok && !cancelled) {
          setConclusions((await response.json()) as Conclusion[])
        }
      } catch {
        // 记忆列表加载失败不打断设置页
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  const deleteConclusion = async (id: string) => {
    try {
      const response = await fetch(`${getAgentApiOrigin()}/api/memory/conclusions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        setConclusionStatus({ key: 'memoryDeleteFailed', error: true })
        return
      }
      setConclusions((items) => items.filter((item) => item.id !== id))
    } catch {
      setConclusionStatus({ key: 'memoryDeleteFailed', error: true })
    }
  }

  const statusText = (() => {
    if (!status) {
      return t('memoryStatusChecking')
    }
    if (!status.available) {
      return status.lastError
        ? t('memoryStatusLoadFailed', { message: status.lastError })
        : t('memoryStatusUnavailable')
    }
    if (status.connected) {
      return t('memoryStatusConnected', { workspace: status.workspace })
    }
    return t('memoryStatusDisconnected')
  })()
  const statusError = status?.connected === false

  return (
    <>
      <SettingCell
        label={t('memoryProviderStatus')}
        description={t('memoryProviderStatusDescription')}
        status={
          status && statusError
            ? { key: 'memoryStatusCheckError', params: { message: statusText }, error: true }
            : { key: 'memoryStatusCheckOk', params: { message: statusText } }
        }
        action={
          <Button
            variant="outlined"
            size="s"
            className={settingsStyles.cellButton}
            onClick={() => setRefreshTick((tick) => tick + 1)}
          >
            {t('memoryStatusRefresh')}
          </Button>
        }
      />
      <SettingCell
        label={t('memoryRecallSwitch')}
        description={t('memoryRecallSwitchDescription')}
        status={null}
        action={
          <Toggle pressed={memoryEnabled} label={t('memoryRecallSwitch')} onChange={setMemoryEnabled} />
        }
      />
      <SettingCell
        label={t('memoryShowRecallSwitch')}
        description={t('memoryShowRecallSwitchDescription')}
        status={null}
        action={
          <Toggle
            pressed={showRecalledMemory}
            label={t('memoryShowRecallSwitch')}
            onChange={setShowRecalledMemory}
          />
        }
      />
      <SettingCell
        label={t('compressionSwitch')}
        description={t('compressionSwitchDescription')}
        status={null}
        action={
          <Toggle
            pressed={compressionEnabled}
            label={t('compressionSwitch')}
            onChange={setCompressionEnabled}
          />
        }
      />
      <SettingCell
        label={t('conversationIndexSwitch')}
        description={t('conversationIndexSwitchDescription')}
        status={null}
        action={
          <Toggle
            pressed={conversationIndexEnabled}
            label={t('conversationIndexSwitch')}
            onChange={setConversationIndexEnabled}
          />
        }
      />
      <SettingCell
        label={t('referenceIndexSwitch')}
        description={t('referenceIndexSwitchDescription')}
        status={null}
        action={
          <Toggle
            pressed={referenceIndexEnabled}
            label={t('referenceIndexSwitch')}
            onChange={setReferenceIndexEnabled}
          />
        }
      />
      <SettingCell
        label={t('memoryList')}
        description={t('memoryListDescription')}
        status={conclusionStatus}
        action={null}
      />
      {conclusions.length === 0 ? (
        <div className={styles.empty}>{t('memoryListEmpty')}</div>
      ) : (
        <div className={styles.memoryList}>
          {conclusions.map((item) => (
            <div key={item.id} className={styles.memoryItem}>
              <span className={styles.memoryContent}>{item.content}</span>
              <button
                type="button"
                className={styles.deleteButton}
                aria-label={t('memoryDelete')}
                onClick={() => void deleteConclusion(item.id)}
              >
                <IconTrashOutline16 />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
