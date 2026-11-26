import { useEffect, useState } from 'react'
import { getAgentApiOrigin } from '../../services/api/client.js'
import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import { Markdown } from '../markdown/Markdown.js'
import styles from './FilePreview.module.css'

const isImage = (path: string): boolean => /\.(png|jpe?g|gif|svg|webp)$/i.test(path)
const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)

/** 文件预览弹窗：markdown 渲染、图片直显、其余纯文本 */
export const FilePreview = ({
  sessionId,
  path,
  onClose,
}: {
  sessionId: string
  path: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(
          `${getAgentApiOrigin()}/api/agent/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
        )
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
          if (!cancelled) {
            setError(body?.error?.message ?? t('agentFileReadFailed'))
          }
          return
        }
        const body = (await response.json()) as { content: string }
        if (!cancelled) {
          setContent(body.content)
        }
      } catch {
        if (!cancelled) {
          setError(t('agentFileReadFailed'))
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [sessionId, path, t])

  const rawUrl = `${getAgentApiOrigin()}/api/agent/raw?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
  return (
    <Modal title={path} className={styles.preview} closable onClose={onClose}>
      {error ? (
        <div className={styles.error}>{error}</div>
      ) : isImage(path) ? (
        <img className={styles.image} src={rawUrl} alt={path} />
      ) : content === null ? (
        <div className={styles.loading}>{t('memoryStatusChecking')}</div>
      ) : isMarkdown(path) ? (
        <Markdown className={styles.markdown} content={content} loading={false} cacheKey={`agent-${sessionId}-${path}`} disableLink={false} />
      ) : (
        <pre className={styles.code}>{content}</pre>
      )}
    </Modal>
  )
}
