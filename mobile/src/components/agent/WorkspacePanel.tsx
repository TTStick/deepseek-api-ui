import { useEffect, useState } from 'react'
import { android, saveAndroidHistory } from '../../app/android.js'
import { useTranslate } from '../../i18n/index.js'
import { useServerConfig } from '../../services/api/serverMode.js'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconDocOutline16,
  IconDownloadOutline16,
  IconFolderOutline16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './WorkspacePanel.module.css'

type FileNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  children?: FileNode[]
}

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
const isTextFile = (path: string): boolean =>
  /\.(txt|md|markdown|csv|json|ya?ml|toml|ini|log|py|js|ts|tsx|jsx|html|css|sh|sql|xml)$/i.test(path)

/** 工作区文件树与预览：只读浏览 Agent 会话在服务器上的文件 */
export const WorkspacePanel = ({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const config = useServerConfig()
  const [nodes, setNodes] = useState<FileNode[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [preview, setPreview] = useState<FileNode | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const headers: Record<string, string> = {}
      if (config.token && config.token !== 'open') {
        headers.Authorization = `Bearer ${config.token}`
      }
      try {
        const response = await fetch(
          `${config.url}/api/agent/tree?sessionId=${encodeURIComponent(sessionId)}`,
          { headers, signal: AbortSignal.timeout(20_000) }
        )
        if (!response.ok) {
          throw new Error()
        }
        const tree = (await response.json()) as FileNode[]
        if (!cancelled) {
          setNodes(tree)
          setFailed(false)
        }
      } catch {
        if (!cancelled) {
          setFailed(true)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [config.token, config.url, sessionId])

  const fetchRaw = (path: string): Promise<Response> => {
    const query = new URLSearchParams({ sessionId, path })
    const headers: Record<string, string> = {}
    if (config.token && config.token !== 'open') {
      headers.Authorization = `Bearer ${config.token}`
    }
    return fetch(`${config.url}/api/agent/raw?${query.toString()}`, { headers })
  }

  useEffect(() => {
    setImageUrl(null)
    if (!preview || !isImageFile(preview.path) || !config.url) {
      return
    }
    let revoked: string | null = null
    let cancelled = false
    void fetchRaw(preview.path)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) {
          return
        }
        revoked = URL.createObjectURL(blob)
        setImageUrl(revoked)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (revoked) {
        URL.revokeObjectURL(revoked)
      }
    }
    // fetchRaw 由 config/sessionId 派生；依赖项已覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.token, config.url, preview, sessionId])

  const openFile = async (node: FileNode) => {
    setPreview(node)
    setContent(null)
    if (isImageFile(node.path) || !isTextFile(node.path)) {
      return
    }
    const headers: Record<string, string> = {}
    if (config.token && config.token !== 'open') {
      headers.Authorization = `Bearer ${config.token}`
    }
    try {
      const response = await fetch(
        `${config.url}/api/agent/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(node.path)}`,
        { headers, signal: AbortSignal.timeout(20_000) }
      )
      const body = response.ok ? ((await response.json()) as { content?: string }) : null
      setContent(body?.content ?? '')
    } catch {
      setContent('')
    }
  }

  const save = async (node: FileNode) => {
    if (saving) {
      return
    }
    setSaving(node.path)
    try {
      const response = await fetchRaw(node.path)
      if (!response.ok) {
        throw new Error()
      }
      const blob = await response.blob()
      if (android) {
        const saved = await saveAndroidHistory(node.name, blob)
        if (saved) {
          showToast({ key: 'agentWorkspaceSaved' })
        }
      } else {
        const objectUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = objectUrl
        link.download = node.name
        link.click()
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
        showToast({ key: 'agentWorkspaceSaved' })
      }
    } catch {
      showToast({ key: 'agentWorkspaceSaveFailed', type: 'error' })
    } finally {
      setSaving(null)
    }
  }

  const renderNodes = (list: FileNode[], depth: number) =>
    list.map((node) => {
      const isDir = node.type === 'dir'
      const open = !collapsed.has(node.path)
      return (
        <div key={node.path}>
          <div className={styles.row} style={{ paddingLeft: 8 + depth * 16 }}>
            <button
              type="button"
              className={styles.name}
              onClick={() => {
                if (isDir) {
                  setCollapsed((previous) => {
                    const next = new Set(previous)
                    if (next.has(node.path)) {
                      next.delete(node.path)
                    } else {
                      next.add(node.path)
                    }
                    return next
                  })
                } else {
                  void openFile(node)
                }
              }}
            >
              <span className={styles.chevron}>
                {isDir ? (
                  open ? (
                    <IconChevronDownOutline14 />
                  ) : (
                    <IconChevronRightOutline14 />
                  )
                ) : null}
              </span>
              <span className={styles.icon} data-dir={isDir || undefined}>
                {isDir ? <IconFolderOutline16 /> : <IconDocOutline16 />}
              </span>
              <span className={styles.label}>{node.name}</span>
              {!isDir ? <span className={styles.size}>{formatSize(node.size)}</span> : null}
            </button>
            {!isDir ? (
              <button
                type="button"
                className={styles.download}
                aria-label={t('agentWorkspaceDownload')}
                disabled={saving !== null}
                onClick={() => void save(node)}
              >
                <IconDownloadOutline16 />
              </button>
            ) : null}
          </div>
          {isDir && open && node.children?.length ? renderNodes(node.children, depth + 1) : null}
        </div>
      )
    })

  return (
    <Modal title={t('agentWorkspaceTitle')} className={styles.dialog} closable onClose={onClose}>
      <div className={styles.body}>
        {failed ? (
          <div className={styles.notice}>{t('agentWorkspaceLoadFailed')}</div>
        ) : nodes === null ? (
          <div className={styles.notice}>{t('agentWorkspaceLoading')}</div>
        ) : nodes.length === 0 ? (
          <div className={styles.notice}>{t('agentWorkspaceEmpty')}</div>
        ) : (
          <div className={styles.tree}>{renderNodes(nodes, 0)}</div>
        )}
      </div>
      {preview ? (
        <Modal
          title={preview.path.split('/').at(-1) ?? preview.path}
          className={styles.preview}
          closable
          onClose={() => setPreview(null)}
        >
          {isImageFile(preview.path) ? (
            imageUrl ? (
              <img className={styles.previewImage} src={imageUrl} alt={preview.name} />
            ) : (
              <div className={styles.notice}>{t('agentWorkspaceLoading')}</div>
            )
          ) : isTextFile(preview.path) ? (
            <pre className={styles.previewText}>
              {content ?? t('agentWorkspaceLoading')}
            </pre>
          ) : (
            <div className={styles.notice}>{t('agentWorkspacePreviewFailed')}</div>
          )}
        </Modal>
      ) : null}
    </Modal>
  )
}
