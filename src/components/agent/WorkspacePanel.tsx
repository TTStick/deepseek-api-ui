import { useEffect, useRef, useState } from 'react'
import { getAgentApiOrigin } from '../../services/api/client.js'
import { useTranslate } from '../../i18n/index.js'
import { deleteReference, listReferences, uploadReferenceFiles, type ReferenceItem } from '../../services/agent/references.js'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16, IconPaperclipOutline16, IconRefreshOutline16, IconTrashOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { FilePreview } from './FilePreview.js'
import styles from './WorkspacePanel.module.css'

type FileNode = {
  name: string
  path: string
  type: 'file' | 'dir'
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

const TreeNode = ({
  node,
  depth,
  onOpen,
}: {
  node: FileNode
  depth: number
  onOpen: (path: string) => void
}) => {
  const [expanded, setExpanded] = useState(depth < 1)
  if (node.type === 'dir') {
    return (
      <div>
        <button
          type="button"
          className={styles.treeRow}
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          <span className={styles.dirName}>{node.name}/</span>
        </button>
        {expanded
          ? (node.children ?? []).map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} onOpen={onOpen} />
            ))
          : null}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={styles.treeRow}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onOpen(node.path)}
    >
      <span className={styles.fileName}>{node.name}</span>
      {node.size !== undefined ? <span className={styles.fileSize}>{formatSize(node.size)}</span> : null}
    </button>
  )
}

/**
 * 会话工作区面板（右侧抽屉）：文件树 + 预览。
 * agent 模式下的交付文件都在这里；关闭 agent 或删除会话后整个目录被回收。
 */
export const WorkspacePanel = ({
  sessionId,
  target,
  onClose,
}: {
  sessionId: string
  target: 'local' | string
  onClose: () => void
}) => {
  const t = useTranslate()
  const [tree, setTree] = useState<FileNode[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [references, setReferences] = useState<ReferenceItem[]>([])
  const [uploading, setUploading] = useState(false)
  const referenceInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(`${getAgentApiOrigin()}/api/agent/tree?sessionId=${encodeURIComponent(sessionId)}`)
        if (response.ok && !cancelled) {
          setTree((await response.json()) as FileNode[])
        }
      } catch {
        // 面板加载失败保持空态
      }
    }
    const loadRefs = async () => {
      if (target !== 'local') {
        return
      }
      setReferences(await listReferences(sessionId))
    }
    void load()
    void loadRefs()
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshTick, target])

  const uploadReferences = async (files: File[]) => {
    if (files.length === 0 || uploading) {
      return
    }
    setUploading(true)
    try {
      const count = await uploadReferenceFiles(sessionId, files)
      if (count > 0) {
        setRefreshTick((tick) => tick + 1)
      }
    } finally {
      setUploading(false)
    }
  }

  const removeReference = async (path: string) => {
    if (await deleteReference(sessionId, path)) {
      setReferences((items) => items.filter((item) => item.path !== path))
      setRefreshTick((tick) => tick + 1)
    }
  }

  return (
    <div className={styles.panel} role="dialog" aria-label={t('agentWorkspaceTitle')}>
      <div className={styles.header}>
        <div className={styles.title}>
          {t('agentWorkspaceTitle')}
          <span className={styles.target}>
            {target === 'local' ? t('agentWorkspaceLocal') : `${t('agentWorkspaceSsh')} ${target}`}
          </span>
        </div>
        <div className={styles.actions}>
          <IconButton
            icon={<IconRefreshOutline16 />}
            aria-label={t('memoryStatusRefresh')}
            onClick={() => setRefreshTick((tick) => tick + 1)}
          />
          <IconButton icon={<IconCloseOutline16 />} aria-label={t('close')} onClick={onClose} />
        </div>
      </div>
      <div className={styles.references}>
        <div className={styles.referencesHead}>
          <span className={styles.referencesTitle}>{t('agentReferencesTitle')}</span>
          {target === 'local' ? (
            <>
              <button
                type="button"
                className={styles.referencesUpload}
                aria-busy={uploading}
                onClick={() => referenceInputRef.current?.click()}
              >
                <IconPaperclipOutline16 />
                {t('agentReferencesUpload')}
              </button>
              <input
                ref={referenceInputRef}
                type="file"
                accept=".zip,.md,.markdown,.txt,application/zip"
                multiple
                hidden
                onChange={(event) => {
                  // files 是活引用：先拷贝快照再清空 value，否则拿到空列表
                  const files = event.target.files ? Array.from(event.target.files) : []
                  event.target.value = ''
                  void uploadReferences(files)
                }}
              />
            </>
          ) : null}
        </div>
        {target !== 'local' ? (
          <div className={styles.referencesHint}>{t('agentReferencesSshOnly')}</div>
        ) : references.length === 0 ? (
          <div className={styles.referencesHint}>{t('agentReferencesEmpty')}</div>
        ) : (
          <div className={styles.referencesList}>
            {references.map((item) => (
              <div key={item.path} className={styles.referenceItem}>
                <div className={styles.referenceName} title={item.path}>
                  {item.path.replace(/^references\//, '')}
                </div>
                <div className={styles.referencePreview} title={item.preview}>
                  {item.preview || '…'}
                </div>
                <div className={styles.referenceMeta}>
                  {formatSize(item.size)}
                  <IconButton
                    icon={<IconTrashOutline16 />}
                    aria-label={t('memoryDelete')}
                    onClick={() => void removeReference(item.path)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={styles.body}>
        {tree.length === 0 ? (
          <div className={styles.empty}>{t('agentWorkspaceEmpty')}</div>
        ) : (
          tree.map((node) => <TreeNode key={node.path} node={node} depth={0} onOpen={setPreview} />)
        )}
      </div>
      {preview ? (
        <FilePreview sessionId={sessionId} path={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  )
}
