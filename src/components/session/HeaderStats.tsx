import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { compressSession } from '../../services/chat/store.js'
import { copySessionMarkdown, exportSessionHtml, exportSessionMarkdown, exportSessionPdf } from '../../services/chat/export.js'
import type { Session } from '../../services/chat/types.js'
import {
  contextPromptTokens,
  CONTEXT_WINDOW_TOKENS,
  sessionTokenTotals,
} from '../../services/chat/usage.js'
import { useSettings } from '../../services/settings.js'
import {
  IconBrowseOutline16,
  IconCodeOutline14,
  IconCopyOutline16,
  IconDocOutline16,
  IconDownloadOutline16,
  IconLinkOutline16,
  IconPanelLeftOutline16,
  IconRefreshOutline16,
  IconRightUpOutline14,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { MemoryPanel } from '../memory/MemoryPanel.js'
import { SshConfigDialog } from '../agent/SshConfigDialog.js'
import { WorkspacePanel } from '../agent/WorkspacePanel.js'
import styles from './HeaderStats.module.css'

const formatTokens = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value)

/** 上下文占用圆环：按最近一轮真实 prompt token 计算占比，颜色随占用率变化 */
const ContextRing = ({ used, capacity }: { used: number; capacity: number }) => {
  const percent = Math.min(100, Math.round((used / capacity) * 100))
  const tone = percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'normal'
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(percent, 100) / 100)
  return (
    <svg
      className={styles.ring}
      data-tone={tone}
      width="22"
      height="22"
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

/** 会话页头部的统计与操作：token 消耗、上下文圆环、手动压缩、记忆面板入口 */
export const HeaderStats = ({ session, streaming }: { session: Session; streaming: boolean }) => {
  const t = useTranslate()
  const compressionEnabled = useSettings((state) => state.compressionEnabled)
  const memoryEnabled = useSettings((state) => state.memoryEnabled)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [sshOpen, setSshOpen] = useState(false)
  const totals = sessionTokenTotals(session)
  const promptTokens = contextPromptTokens(session)
  const percent = Math.min(100, Math.round((promptTokens / CONTEXT_WINDOW_TOKENS) * 100))
  const compressed = session.compression?.archivedRounds ?? 0
  const agentEnabled = session.agentEnabled === true
  const hasStats = totals.input + totals.output > 0
  const ringLabel = t('contextRingLabel', {
    used: formatTokens(promptTokens),
    capacity: formatTokens(CONTEXT_WINDOW_TOKENS),
    percent,
  })
  return (
    <div className={styles.stats}>
      {hasStats ? (
        <span className={styles.tokenText} title={t('tokenStatsDetail', { cache: formatTokens(totals.cacheRead) })}>
          {t('tokenStats', {
            input: formatTokens(totals.input),
            output: formatTokens(totals.output),
          })}
        </span>
      ) : null}
      <IconButton
        icon={<ContextRing used={promptTokens} capacity={CONTEXT_WINDOW_TOKENS} />}
        tooltip={`${ringLabel}${compressed > 0 ? ` · ${t('contextCompressedBadge', { count: compressed })}` : ''}`}
        tooltipPlacement="bottom"
        aria-label={ringLabel}
      />
      {agentEnabled ? (
        <>
          <IconButton
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('agentWorkspaceTitle')}
            tooltipPlacement="bottom"
            aria-label={t('agentWorkspaceTitle')}
            onClick={() => setWorkspaceOpen(true)}
          />
          <IconButton
            icon={<IconCodeOutline14 />}
            tooltip={t('agentSshTitle')}
            tooltipPlacement="bottom"
            aria-label={t('agentSshTitle')}
            onClick={() => setSshOpen(true)}
          />
        </>
      ) : null}
      {compressionEnabled ? (
        <IconButton
          icon={<IconRefreshOutline16 />}
          tooltip={t('compressButton')}
          tooltipPlacement="bottom"
          aria-label={t('compressButton')}
          disabled={streaming}
          onClick={() => void compressSession(session.id)}
        />
      ) : null}
      <Menu
        options={[
          {
            key: 'md',
            label: t('exportMarkdown'),
            icon: <IconDocOutline16 />,
            onSelect: () => exportSessionMarkdown(session.id),
          },
          {
            key: 'pdf',
            label: t('exportPdf'),
            icon: <IconDownloadOutline16 />,
            onSelect: () => void exportSessionPdf(session.id),
          },
        ]}
      >
        {({ toggle }) => (
          <IconButton
            icon={<IconDownloadOutline16 />}
            tooltip={t('exportButton')}
            tooltipPlacement="bottom"
            aria-label={t('exportButton')}
            disabled={streaming}
            onClick={toggle}
          />
        )}
      </Menu>
      <Menu
        options={[
          {
            key: 'html',
            label: t('shareHtml'),
            icon: <IconLinkOutline16 />,
            onSelect: () => void exportSessionHtml(session.id),
          },
          {
            key: 'copy',
            label: t('copyMarkdown'),
            icon: <IconCopyOutline16 />,
            onSelect: () => void copySessionMarkdown(session.id),
          },
        ]}
      >
        {({ toggle }) => (
          <IconButton
            icon={<IconRightUpOutline14 />}
            tooltip={t('shareButton')}
            tooltipPlacement="bottom"
            aria-label={t('shareButton')}
            disabled={streaming}
            onClick={toggle}
          />
        )}
      </Menu>
      {memoryEnabled ? (
        <IconButton
          icon={<IconBrowseOutline16 />}
          tooltip={t('memoryPanelTitle')}
          tooltipPlacement="bottom"
          aria-label={t('memoryPanelTitle')}
          onClick={() => setMemoryOpen(true)}
        />
      ) : null}
      {memoryOpen ? <MemoryPanel sessionId={session.id} onClose={() => setMemoryOpen(false)} /> : null}
      {workspaceOpen ? (
        <WorkspacePanel
          sessionId={session.id}
          target={session.ssh?.host ?? 'local'}
          onClose={() => setWorkspaceOpen(false)}
        />
      ) : null}
      {sshOpen ? (
        <SshConfigDialog
          sessionId={session.id}
          initial={session.ssh}
          onClose={() => setSshOpen(false)}
        />
      ) : null}
    </div>
  )
}
