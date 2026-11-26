import { useEffect, useState } from 'react'
import { android, saveAndroidHistory, saveAndroidImage } from '../../app/android.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useServerConfig } from '../../services/api/serverMode.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconDocOutline16,
  IconDownloadOutline16,
  IconSpinnerOutline16,
  IconWarningOutline16,
  IconWrenchOutline16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './AgentActivity.module.css'

type AgentEvent = NonNullable<AssistantMessage['agentEvents']>[number]
type ToolEvent = Extract<AgentEvent, { kind: 'tool' }>
type ArtifactEvent = Extract<AgentEvent, { kind: 'artifact' }>

const TOOL_LABEL_KEYS: Record<string, TranslationKey> = {
  list_files: 'agentToolListFiles',
  read_file: 'agentToolReadFile',
  write_file: 'agentToolWriteFile',
  delete_file: 'agentToolDeleteFile',
  run_python: 'agentToolRunPython',
  run_script: 'agentToolRunScript',
}

const toolLabel = (name: string, t: (key: TranslationKey) => string): string =>
  t(TOOL_LABEL_KEYS[name] ?? 'agentToolGeneric')

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

/** 用工单 Bearer 头读取交付文件，避免把长期 token 放进 URL 查询参数 */
const fetchArtifact = (
  baseUrl: string,
  token: string,
  sessionId: string,
  path: string
): Promise<Response> => {
  const query = new URLSearchParams({ sessionId, path })
  const headers: Record<string, string> = {}
  if (token && token !== 'open') {
    headers.Authorization = `Bearer ${token}`
  }
  return fetch(`${baseUrl}/api/agent/raw?${query.toString()}`, { headers })
}

const StepRow = ({ event }: { event: ToolEvent }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const running = event.status === 'running'
  const preview = (event.input ?? '').split('\n')[0] ?? ''
  return (
    <div className={styles.step} data-error={event.isError === true}>
      <button
        type="button"
        className={styles.stepHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        <span className={styles.stepStatus} data-running={running}>
          {running ? (
            <IconSpinnerOutline16 />
          ) : event.isError ? (
            <IconWarningOutline16 />
          ) : (
            <IconCheckOutline16 />
          )}
        </span>
        <span className={styles.stepName}>{toolLabel(event.name, t)}</span>
        <span className={styles.stepPreview}>
          {running ? t('agentToolRunningShort') : preview.length > 48 ? `${preview.slice(0, 48)}…` : preview}
        </span>
      </button>
      {open ? (
        <div className={styles.stepBody}>
          <div className={styles.sectionTitle}>{t('agentToolInput')}</div>
          <pre className={styles.pre}>{event.input}</pre>
          {event.output !== undefined ? (
            <>
              <div className={styles.sectionTitle}>{t('agentToolOutput')}</div>
              <pre className={styles.pre}>{event.output}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 交付文件卡片：图片缩略图 / 文档图标 + 预览、保存到相册或浏览器打开 */
const ArtifactCard = ({ event, sessionId }: { event: ArtifactEvent; sessionId: string }) => {
  const t = useTranslate()
  const config = useServerConfig()
  const [thumb, setThumb] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const name = event.path.split('/').at(-1) ?? event.path
  const image = isImageFile(event.path)

  useEffect(() => {
    if (!image || !config.url) {
      return
    }
    let revoked: string | null = null
    let cancelled = false
    void fetchArtifact(config.url, config.token, sessionId, event.path)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) {
          return
        }
        revoked = URL.createObjectURL(blob)
        setThumb(revoked)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (revoked) {
        URL.revokeObjectURL(revoked)
      }
    }
  }, [config.token, config.url, event.path, image, sessionId])

  const preview = async () => {
    setOpen(true)
    if (!image && content === null && config.url) {
      try {
        const response = await fetchArtifact(config.url, config.token, sessionId, event.path)
        setContent(response.ok ? await response.text() : '')
      } catch {
        setContent('')
      }
    }
  }

  const save = async () => {
    if (!config.url) {
      return
    }
    try {
      const response = await fetchArtifact(config.url, config.token, sessionId, event.path)
      if (!response.ok) {
        throw new Error()
      }
      const blob = await response.blob()
      if (android) {
        if (image) {
          await saveAndroidImage(name, blob)
          showToast({ key: 'agentArtifactSaved' })
        } else {
          if (!(await saveAndroidHistory(name, blob))) {
            throw new Error()
          }
          showToast({ key: 'agentWorkspaceSaved' })
        }
        return
      }
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
      showToast({ key: 'agentWorkspaceSaved' })
    } catch {
      showToast({ key: 'agentArtifactSaveFailed', type: 'error' })
    }
  }

  return (
    <div className={styles.artifact}>
      <button type="button" className={styles.artifactMain} onClick={() => void preview()}>
        {image && thumb ? (
          <img className={styles.thumb} src={thumb} alt={name} />
        ) : (
          <span className={styles.docIcon}>
            <IconDocOutline16 />
          </span>
        )}
        <span className={styles.artifactInfo}>
          <span className={styles.artifactName}>{name}</span>
          <span className={styles.artifactMeta}>
            {formatSize(event.size)}
            {event.size !== undefined ? ' · ' : ''}
            {event.action === 'generated' ? t('agentArtifactGenerated') : t('agentArtifactWritten')}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={styles.artifactAction}
        aria-label={image ? t('agentArtifactSave') : t('agentArtifactOpen')}
        onClick={() => void save()}
      >
        <IconDownloadOutline16 />
      </button>
      {open ? (
        <Modal title={name} className={styles.preview} onClose={() => setOpen(false)}>
          {image && thumb ? (
            <img className={styles.previewImage} src={thumb} alt={name} />
          ) : (
            <pre className={styles.previewText}>{content ?? t('pageLoading')}</pre>
          )}
        </Modal>
      ) : null}
    </div>
  )
}

/**
 * 消息内的 Agent 工具活动（与网页端一致）：
 * 多次工具调用整合为单卡片，运行中标签随步骤切换，结束后显示「调用工具 N 步」；
 * 一级展开为步骤列表，二级展开为单步参数与输出；交付文件独立成卡片。
 */
export const AgentActivity = ({ message, sessionId }: { message: AssistantMessage; sessionId: string }) => {
  const t = useTranslate()
  const events = message.agentEvents ?? []
  const tools = events.filter((event): event is ToolEvent => event.kind === 'tool')
  const artifacts = events.filter((event): event is ArtifactEvent => event.kind === 'artifact')
  const runningTool = tools.find((event) => event.status === 'running')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(Boolean(runningTool))
    // 仅在运行状态变化时自动开合，用户手动展开后保持
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(runningTool)])

  if (events.length === 0) {
    return null
  }
  return (
    <div className={styles.activity}>
      {tools.length > 0 ? (
        <div className={styles.toolCard}>
          <button
            type="button"
            className={styles.toolHeader}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span className={styles.wrench}>
              <IconWrenchOutline16 />
            </span>
            <span className={styles.toolTitle}>
              {runningTool
                ? t('agentToolRunning', { name: toolLabel(runningTool.name, t) })
                : t('agentToolsSummary', { count: tools.length })}
            </span>
            {!runningTool && tools.some((event) => event.isError) ? (
              <span className={styles.toolWarn}>
                <IconWarningOutline16 />
              </span>
            ) : null}
            {open ? <IconChevronDownOutline14 /> : null}
          </button>
          {open ? (
            <div className={styles.steps}>
              {tools.map((event, index) => (
                <StepRow key={`${event.toolUseId}-${index}`} event={event} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <div className={styles.artifacts}>
          <div className={styles.artifactsTitle}>{t('agentArtifacts')}</div>
          {artifacts.map((event, index) => (
            <ArtifactCard key={`${event.path}-${index}`} event={event} sessionId={sessionId} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
