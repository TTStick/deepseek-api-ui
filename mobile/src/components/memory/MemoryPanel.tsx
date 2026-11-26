import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useServerConfig } from '../../services/api/serverMode.js'
import { IconRefreshOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import styles from './MemoryPanel.module.css'

type MemoryOverview = {
  available: boolean
  userRepresentation: string
  userCard: string[]
  aiRepresentation: string
  aiCard: string[]
  conclusions: Array<{ id: string; content: string }>
}

const EMPTY: MemoryOverview = {
  available: false,
  userRepresentation: '',
  userCard: [],
  aiRepresentation: '',
  aiCard: [],
  conclusions: [],
}

/** 记忆可视化：本对话召回来源的用户画像 / AI 自画像 / 记忆结论，与网页端 MemoryPanel 对应 */
export const MemoryPanel = ({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const config = useServerConfig()
  const [overview, setOverview] = useState<MemoryOverview | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const headers: Record<string, string> = {}
      if (config.token && config.token !== 'open') {
        headers.Authorization = `Bearer ${config.token}`
      }
      try {
        const response = await fetch(`${config.url}/api/memory/overview`, {
          headers,
          signal: AbortSignal.timeout(12_000),
        })
        if (!cancelled) {
          setOverview(response.ok ? ((await response.json()) as MemoryOverview) : EMPTY)
        }
      } catch {
        if (!cancelled) {
          setOverview(EMPTY)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [config.token, config.url, sessionId, tick])

  const removeConclusion = async (id: string) => {
    const headers: Record<string, string> = {}
    if (config.token && config.token !== 'open') {
      headers.Authorization = `Bearer ${config.token}`
    }
    try {
      const response = await fetch(
        `${config.url}/api/memory/conclusions/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers }
      )
      if (response.ok) {
        setOverview((current) =>
          current
            ? { ...current, conclusions: current.conclusions.filter((item) => item.id !== id) }
            : current
        )
      }
    } catch {
      // 删除失败静默，用户可刷新重试
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
  const empty =
    overview !== null &&
    (overview.available === false || (sections.length === 0 && overview.conclusions.length === 0))

  return (
    <Modal
      title={t('memoryPanelTitle')}
      className={styles.panel}
      closable
      onClose={onClose}
      footer={
        <button type="button" className={styles.refresh} onClick={() => setTick((value) => value + 1)}>
          <IconRefreshOutline16 />
          {t('memoryStatusRefresh')}
        </button>
      }
    >
      <div className={styles.body}>
        <div className={styles.intro}>{t('memoryPanelIntro')}</div>
        {overview === null ? (
          <div className={styles.notice}>{t('memoryPanelLoading')}</div>
        ) : empty ? (
          <div className={styles.notice}>
            {overview.available === false
              ? t('memoryPanelUnavailable')
              : t('memoryPanelEmpty')}
          </div>
        ) : (
          <>
            {sections.map((section) => (
              <div key={section.title} className={styles.section}>
                <div className={styles.sectionTitle}>{section.title}</div>
                <div className={styles.sectionContent}>{section.content}</div>
              </div>
            ))}
            {overview.conclusions.length > 0 ? (
              <div className={styles.section}>
                <div className={styles.sectionTitle}>{t('memoryPanelConclusions')}</div>
                <div className={styles.conclusions}>
                  {overview.conclusions.map((conclusion) => (
                    <div key={conclusion.id} className={styles.conclusion}>
                      <span className={styles.conclusionText}>{conclusion.content}</span>
                      <button
                        type="button"
                        className={styles.delete}
                        aria-label={t('memoryDeleteConclusion')}
                        onClick={() => void removeConclusion(conclusion.id)}
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
      </div>
    </Modal>
  )
}
