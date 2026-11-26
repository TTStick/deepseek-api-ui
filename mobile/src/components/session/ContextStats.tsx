import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isServerMode, useServerConfig } from '../../services/api/serverMode.js'
import { exportSession } from '../../services/chat/export.js'
import {
  compressSession,
  setSessionAgentEnabled,
  setSessionCompressionEnabled,
  setSessionMemory,
} from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { contextPromptTokens, CONTEXT_WINDOW_TOKENS, sessionTokenTotals } from '../../services/chat/usage.js'
import { WINDOW_TOKENS } from '../../services/chat/context.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconBrowseOutline16,
  IconDocOutline16,
  IconDownloadOutline16,
  IconFolderOutline16,
  IconLinkOutline16,
  IconRefreshOutline16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { WorkspacePanel } from '../agent/WorkspacePanel.js'
import { MemoryPanel } from '../memory/MemoryPanel.js'
import styles from './ContextStats.module.css'

const formatTokens = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value)

/** 上下文占用圆环：按最近一轮真实 prompt token 计算占比，颜色随占用率变化 */
export const ContextRing = ({
  used,
  capacity,
  size = 22,
}: {
  used: number
  capacity: number
  size?: number
}) => {
  const percent = Math.min(100, Math.round((used / capacity) * 100))
  const tone = percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'normal'
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(percent, 100) / 100)
  return (
    <svg
      className={styles.ring}
      data-tone={tone}
      width={size}
      height={size}
      viewBox="0 0 22 22"
      role="img"
    >
      <circle cx="11" cy="11" r={radius} className={styles.ringTrack} />
      <circle
        cx="11"
        cy="11"
        r={radius}
        className={styles.ringFill}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 11 11)"
      />
    </svg>
  )
}

const SwitchRow = ({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) => (
  <div className={styles.switchRow}>
    <div className={styles.switchText}>
      <div className={styles.switchLabel}>{label}</div>
      {description ? <div className={styles.switchDescription}>{description}</div> : null}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={styles.switch}
      data-on={checked ? '' : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.switchThumb} />
    </button>
  </div>
)

/**
 * 上下文与用量面板（对应网页端 HeaderStats）：
 * token 消耗、上下文圆环、手动压缩、会话级 Agent/记忆/压缩开关、工作区入口与导出。
 */
export const ContextStats = ({
  session,
  streaming,
  showText = false,
}: {
  session: Session
  streaming: boolean
  showText?: boolean
}) => {
  const t = useTranslate()
  const config = useServerConfig()
  const server = isServerMode()
  const [open, setOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const totals = sessionTokenTotals(session)
  const promptTokens = contextPromptTokens(session)
  const capacity = server ? CONTEXT_WINDOW_TOKENS : WINDOW_TOKENS
  const percent = Math.min(100, Math.round((promptTokens / capacity) * 100))
  const compressed = session.compression?.archivedRounds ?? 0
  const hasStats = totals.input + totals.output > 0
  const agentEnabled = session.agentEnabled ?? config.agent
  const memoryRead = session.memory?.read ?? true
  const memoryWrite = session.memory?.write ?? true
  const compressionEnabled = session.compressionEnabled ?? true
  const ringLabel = t('contextRingLabel', {
    used: formatTokens(promptTokens),
    capacity: formatTokens(capacity),
    percent,
  })

  const compress = async () => {
    if (compressing || streaming) {
      return
    }
    setCompressing(true)
    const result = await compressSession(session.id)
    setCompressing(false)
    if (typeof result === 'number') {
      showToast({ key: 'compressDone', params: { count: result } })
    } else if (result === 'nothing') {
      showToast({ key: 'compressNothingToDo' })
    } else {
      showToast({ key: 'compressFailed', type: 'error' })
    }
  }

  return (
    <div className={styles.stats}>
      {showText && hasStats ? (
        <span className={styles.tokenText} title={t('tokenStatsDetail', { cache: formatTokens(totals.cacheRead) })}>
          {t('tokenStats', {
            input: formatTokens(totals.input),
            output: formatTokens(totals.output),
          })}
        </span>
      ) : null}
      <IconButton
        className={styles.ringButton}
        size="m"
        icon={
          <span className={styles.ringWrap}>
            <ContextRing used={promptTokens} capacity={capacity} />
            {compressed > 0 ? <span className={styles.ringDot} /> : null}
          </span>
        }
        tooltip={`${ringLabel}${compressed > 0 ? ` · ${t('contextCompressedBadge', { count: compressed })}` : ''}`}
        tooltipPlacement="bottom"
        aria-label={ringLabel}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <Modal title={t('contextPanelTitle')} className={styles.dialog} closable onClose={() => setOpen(false)}>
          <div className={styles.usage}>
            <div className={styles.usageRing}>
              <ContextRing used={promptTokens} capacity={capacity} size={72} />
              <span className={styles.usagePercent}>{percent}%</span>
            </div>
            <div className={styles.usageRows}>
              <div className={styles.usageRow}>
                <span>{t('contextUsedTokens')}</span>
                <span>
                  {formatTokens(promptTokens)} / {formatTokens(capacity)}
                </span>
              </div>
              <div className={styles.usageRow}>
                <span>{t('tokenStats', { input: formatTokens(totals.input), output: formatTokens(totals.output) })}</span>
              </div>
              {totals.cacheRead > 0 ? (
                <div className={styles.usageRow}>
                  <span>{t('tokenStatsDetail', { cache: formatTokens(totals.cacheRead) })}</span>
                </div>
              ) : null}
              {compressed > 0 ? (
                <div className={styles.usageRow}>
                  <span>{t('contextCompressedBadge', { count: compressed })}</span>
                </div>
              ) : null}
            </div>
          </div>
          {server ? (
            <>
              <div className={styles.compressCard}>
                <div className={styles.compressText}>
                  <div className={styles.compressTitle}>{t('sessionCompressionTitle')}</div>
                  <div className={styles.compressHint}>{t('compressHint')}</div>
                </div>
                <button
                  type="button"
                  className={styles.compressButton}
                  disabled={streaming || compressing || !compressionEnabled}
                  onClick={() => void compress()}
                >
                  <IconRefreshOutline16 />
                  {compressing ? t('compressRunning') : t('compressButton')}
                </button>
              </div>
              <div className={styles.switches}>
                <SwitchRow
                  label={t('sessionAgentTitle')}
                  description={t('sessionAgentDescription')}
                  checked={agentEnabled}
                  onChange={(value) => setSessionAgentEnabled(session.id, value)}
                />
                <SwitchRow
                  label={t('sessionMemoryTitle')}
                  description={t('sessionMemoryRead')}
                  checked={memoryRead}
                  onChange={(value) => setSessionMemory(session.id, value, memoryWrite)}
                  disabled={!config.memory}
                />
                <SwitchRow
                  label={t('sessionMemoryWrite')}
                  checked={memoryWrite}
                  onChange={(value) => setSessionMemory(session.id, memoryRead, value)}
                  disabled={!config.memory}
                />
                <SwitchRow
                  label={t('sessionCompressionTitle')}
                  description={t('sessionCompressionDescription')}
                  checked={compressionEnabled}
                  onChange={(value) => setSessionCompressionEnabled(session.id, value)}
                />
              </div>
            </>
          ) : null}
          <div className={styles.actions}>
            {server && agentEnabled ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  setOpen(false)
                  setWorkspaceOpen(true)
                }}
              >
                <IconFolderOutline16 />
                {t('agentWorkspaceTitle')}
              </button>
            ) : null}
            {server && config.memory ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  setOpen(false)
                  setMemoryOpen(true)
                }}
              >
                <IconBrowseOutline16 />
                {t('memoryPanelTitle')}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                setOpen(false)
                void exportSession(session.id, 'md')
              }}
            >
              <IconDocOutline16 />
              {t('exportMarkdown')}
            </button>
            {server ? (
              <>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => {
                    setOpen(false)
                    void exportSession(session.id, 'pdf')
                  }}
                >
                  <IconDownloadOutline16 />
                  {t('exportPdf')}
                </button>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => {
                    setOpen(false)
                    void exportSession(session.id, 'html')
                  }}
                >
                  <IconLinkOutline16 />
                  {t('exportHtml')}
                </button>
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {workspaceOpen ? (
        <WorkspacePanel sessionId={session.id} onClose={() => setWorkspaceOpen(false)} />
      ) : null}
      {memoryOpen ? (
        <MemoryPanel sessionId={session.id} onClose={() => setMemoryOpen(false)} />
      ) : null}
    </div>
  )
}
