import { useEffect, useState } from 'react'
import { getAgentApiOrigin } from '../../services/api/client.js'
import { setPendingMemory, setSessionMemory, useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { IconTrashOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Toggle } from '../settings/Toggle.js'
import memoryStyles from '../settings/MemorySettings.module.css'
import styles from './MemoryPanel.module.css'

type MemoryOverview = {
  available: boolean
  userRepresentation: string
  userCard: string[]
  aiRepresentation: string
  aiCard: string[]
  conclusions: Array<{ id: string; content: string }>
}

/**
 * 记忆可视化面板：本对话记忆权限、用户画像、用户卡片、AI 自画像与结论列表。
 * sessionId 为 null 时（新对话页）配置待定权限，首条消息发出时应用到新会话。
 * 数据来自 Honcho 的 LLM 推导；未连接或尚未沉淀时显示空态。
 */
export const MemoryPanel = ({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) => {
  const t = useTranslate()
  const [overview, setOverview] = useState<MemoryOverview | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const globalEnabled = useSettings((state) => state.memoryEnabled)
  const sessionMemory = useChatStore((state) =>
    sessionId !== null ? state.sessionCache[sessionId]?.memory : undefined
  )
  const pendingMemory = useChatStore((state) => state.pendingMemory)
  const read = sessionId !== null ? (sessionMemory?.read ?? true) : pendingMemory.read
  const write = sessionId !== null ? (sessionMemory?.write ?? true) : pendingMemory.write
  const changePermissions = (nextRead: boolean, nextWrite: boolean) => {
    if (sessionId !== null) {
      setSessionMemory(sessionId, nextRead, nextWrite)
    } else {
      setPendingMemory(nextRead, nextWrite)
    }
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      // 非 200 / 超时 / 异常都要落一个结果，否则面板永远停在「检查中…」
      const empty: MemoryOverview = {
        available: false,
        userRepresentation: '',
        userCard: [],
        aiRepresentation: '',
        aiCard: [],
        conclusions: [],
      }
      try {
        const response = await fetch(`${getAgentApiOrigin()}/api/memory/overview`, {
          signal: AbortSignal.timeout(10_000),
        })
        if (!cancelled) {
          setOverview(response.ok ? ((await response.json()) as MemoryOverview) : empty)
        }
      } catch {
        if (!cancelled) {
          setOverview(empty)
        }
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
      if (response.ok) {
        setOverview((current) =>
          current ? { ...current, conclusions: current.conclusions.filter((item) => item.id !== id) } : current
        )
      }
    } catch {
      // 删除失败静默，用户可重试
    }
  }

  const sections = overview
    ? [
        { title: t('memoryPanelUserRepresentation'), content: overview.userRepresentation },
        {
          title: t('memoryPanelUserCard'),
          content: overview.userCard.length ? overview.userCard.map((item) => `- ${item}`).join('\n') : '',
        },
        { title: t('memoryPanelAiRepresentation'), content: overview.aiRepresentation },
        {
          title: t('memoryPanelAiCard'),
          content: overview.aiCard.length ? overview.aiCard.map((item) => `- ${item}`).join('\n') : '',
        },
      ].filter((section) => section.content.trim())
    : []
  const empty = overview !== null && sections.length === 0 && overview.conclusions.length === 0

  return (
    <Modal
      title={t('memoryPanelTitle')}
      className={styles.panel}
      closable
      onClose={onClose}
      footer={
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => setRefreshTick((tick) => tick + 1)}
        >
          {t('memoryStatusRefresh')}
        </button>
      }
    >
      <div className={styles.permissions}>
        <div className={styles.permissionsTitle}>{t('memorySessionPermissions')}</div>
        {!globalEnabled ? <div className={styles.permissionsHint}>{t('memorySessionGlobalOff')}</div> : null}
        <div className={styles.permissionRow}>
          <span className={styles.permissionLabel}>{t('memorySessionRead')}</span>
          <Toggle
            pressed={read}
            label={t('memorySessionRead')}
            onChange={(value) => changePermissions(value, write)}
          />
        </div>
        <div className={styles.permissionRow}>
          <span className={styles.permissionLabel}>{t('memorySessionWrite')}</span>
          <Toggle
            pressed={write}
            label={t('memorySessionWrite')}
            onChange={(value) => changePermissions(read, value)}
          />
        </div>
      </div>
      {overview === null ? (
        <div className={memoryStyles.empty}>{t('memoryStatusChecking')}</div>
      ) : !overview.available ? (
        <div className={memoryStyles.empty}>{t('memoryPanelUnavailable')}</div>
      ) : empty ? (
        <div className={memoryStyles.empty}>{t('memoryPanelEmpty')}</div>
      ) : (
        <>
          {sections.map((section) => (
            <div key={section.title} className={styles.section}>
              <div className={styles.sectionTitle}>{section.title}</div>
              <div className={styles.sectionBody}>{section.content}</div>
            </div>
          ))}
          {overview.conclusions.length > 0 ? (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>{t('memoryPanelConclusions')}</div>
              <div className={memoryStyles.memoryList}>
                {overview.conclusions.map((item) => (
                  <div key={item.id} className={memoryStyles.memoryItem}>
                    <span className={memoryStyles.memoryContent}>{item.content}</span>
                    <button
                      type="button"
                      className={memoryStyles.deleteButton}
                      aria-label={t('memoryDelete')}
                      onClick={() => void deleteConclusion(item.id)}
                    >
                      <IconTrashOutline16 />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  )
}
