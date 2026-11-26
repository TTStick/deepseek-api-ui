import { useEffect, useState } from 'react'
import { getAgentApiOrigin } from '../../services/api/client.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { AgentActivityEvent } from '../../services/chat/types.js'
import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconDocOutline16,
  IconDownloadOutline16,
  IconLoadingOutline16,
  IconRightUpOutline14,
  IconWarningOutline16,
  IconWrenchOutline16,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { FilePreview } from './FilePreview.js'
import styles from './AgentActivity.module.css'

/** 工具名 → 展示标签（i18n key） */
const TOOL_LABEL_KEYS: Record<string, TranslationKey> = {
  list_files: 'agentToolListFiles',
  read_file: 'agentToolReadFile',
  write_file: 'agentToolWriteFile',
  delete_file: 'agentToolDeleteFile',
  run_python: 'agentToolRunPython',
  run_script: 'agentToolRunScript',
}

const toolLabel = (name: string): TranslationKey => TOOL_LABEL_KEYS[name] ?? 'agentToolGeneric'

type ToolEvent = Extract<AgentActivityEvent, { kind: 'tool' }>
type ArtifactEvent = Extract<AgentActivityEvent, { kind: 'artifact' }>

const formatSize = (size?: number): string => {
  if (size === undefined) {
    return ''
  }
  if (size < 1024) {
    return `${size}B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)}KB`
  }
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

const isImageFile = (path: string): boolean => /\.(png|jpe?g|gif|svg|webp)$/i.test(path)

const statusIcon = (event: ToolEvent) => {
  if (event.status === 'running') {
    return <IconLoadingOutline16 />
  }
  return event.isError ? <IconWarningOutline16 /> : <IconCheckedOutline14 />
}

/** 单个工具步骤行：一行摘要，展开显示参数与输出 */
const ToolRow = ({ event }: { event: ToolEvent }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const running = event.status === 'running'
  const inputPreview = (event.input ?? '').split('\n')[0] ?? ''
  const preview = inputPreview.length > 60 ? `${inputPreview.slice(0, 60)}…` : inputPreview
  return (
    <div className={styles.toolStep} data-error={event.isError === true}>
      <button
        type="button"
        className={styles.toolStepHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        <span className={styles.toolStepStatus} data-running={running}>
          {statusIcon(event)}
        </span>
        <span className={styles.toolStepName}>{t(toolLabel(event.name))}</span>
        <span className={styles.toolStepInput}>{running ? t('agentToolRunningShort') : preview}</span>
      </button>
      {open ? (
        <div className={styles.toolStepBody}>
          <div className={styles.toolSectionTitle}>{t('agentToolInput')}</div>
          <pre className={styles.toolPre}>{event.input}</pre>
          {event.output !== undefined ? (
            <>
              <div className={styles.toolSectionTitle}>{t('agentToolOutput')}</div>
              <pre className={styles.toolPre}>{event.output}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 交付文件卡片：缩略图/文件图标 + 名称大小 + 预览与下载 */
const ArtifactRow = ({
  event,
  sessionId,
}: {
  event: ArtifactEvent
  sessionId: string
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const rawUrl = `${getAgentApiOrigin()}/api/agent/raw?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(event.path)}`
  const name = event.path.split('/').at(-1) ?? event.path
  const image = isImageFile(event.path)
  return (
    <div className={styles.artifactCard}>
      <button type="button" className={styles.artifactMain} onClick={() => setOpen(true)}>
        {image ? (
          <img className={styles.artifactThumb} src={rawUrl} alt={name} />
        ) : (
          <span className={styles.artifactIcon}>
            <IconDocOutline16 />
          </span>
        )}
        <span className={styles.artifactInfo}>
          <span className={styles.artifactName} title={event.path}>
            {name}
          </span>
          <span className={styles.artifactMeta}>
            {formatSize(event.size)}
            {event.size !== undefined ? ' · ' : ''}
            {event.action === 'generated' ? t('agentArtifactGenerated') : t('agentArtifactWritten')}
          </span>
        </span>
      </button>
      <div className={styles.artifactActions}>
        <IconButton
          icon={<IconRightUpOutline14 />}
          tooltip={t('agentArtifactPreview')}
          tooltipPlacement="bottom"
          aria-label={t('agentArtifactPreview')}
          onClick={() => setOpen(true)}
        />
        <a
          className={styles.artifactDownload}
          href={rawUrl}
          download={name}
          title={t('agentArtifactDownload')}
          aria-label={t('agentArtifactDownload')}
        >
          <IconDownloadOutline16 />
        </a>
      </div>
      {open ? <FilePreview sessionId={sessionId} path={event.path} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

/**
 * 消息内的 agent 活动：工具调用整合为单卡片（运行中标签随当前步骤切换，
 * 结束后显示「调用工具 N 步」；展开 = 步骤列表，二次展开 = 参数与输出），
 * 交付文件独立成卡片。
 */
export const AgentActivity = ({
  events,
  sessionId,
}: {
  events: AgentActivityEvent[]
  sessionId: string
}) => {
  const t = useTranslate()
  const tools = events.filter((event): event is ToolEvent => event.kind === 'tool')
  const artifacts = events.filter((event): event is ArtifactEvent => event.kind === 'artifact')
  const runningTool = tools.find((event) => event.status === 'running')
  const isRunning = Boolean(runningTool)
  const [open, setOpen] = useState(false)

  // 运行中自动展开，收尾后收起为摘要
  useEffect(() => {
    if (isRunning) {
      setOpen(true)
    } else {
      setOpen(false)
    }
  }, [isRunning, tools.length])

  if (events.length === 0) {
    return null
  }
  return (
    <div className={styles.activity}>
      {tools.length > 0 ? (
        <div className={styles.toolCard}>
          <button
            type="button"
            className={styles.toolCardHeader}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span className={styles.toolCardLogo}>
              <IconWrenchOutline16 />
            </span>
            <span className={styles.toolCardTitle}>
              {runningTool
                ? t('agentToolRunning', { name: t(toolLabel(runningTool.name)) })
                : t('agentToolsSummary', { count: tools.length })}
            </span>
            {!runningTool && tools.some((event) => event.isError) ? (
              <span className={styles.toolCardWarn}>
                <IconWarningOutline16 />
              </span>
            ) : null}
            {open ? (
              <span className={styles.toolCardChevron}>
                <IconChevronDownOutline14 />
              </span>
            ) : null}
          </button>
          {open ? (
            <div className={styles.toolList}>
              {tools.map((event, index) => (
                <ToolRow key={`${event.toolUseId}-${index}`} event={event} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <div className={styles.artifacts}>
          <div className={styles.artifactsTitle}>{t('agentArtifacts')}</div>
          {artifacts.map((event, index) => (
            <ArtifactRow key={`${event.path}-${index}`} event={event} sessionId={sessionId} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
