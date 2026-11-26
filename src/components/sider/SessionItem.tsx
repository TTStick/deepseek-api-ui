import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconArchiveOutline16,
  IconCopyOutline16,
  IconDocOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderOutline16,
  IconInboxOutline16,
  IconLinkOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { exportSessionHtml, exportSessionMarkdown, exportSessionPdf } from '../../services/chat/export.js'
import { renameSession, selectSession, setSessionArchived, setSessionPinned, duplicateSession } from '../../services/chat/store.js'
import { showToast } from '../base/toastState.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import { MoveGroupDialog } from './MoveGroupDialog.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.title}>
        {displayTitle}
        {session.pinned ? <span className={styles.pinBadge}>📌</span> : null}
        {session.compressedRounds > 0 ? (
          <span className={styles.compressedBadge} title={t('contextCompressedBadge', { count: session.compressedRounds })}>
            🧩
          </span>
        ) : null}
        {session.group ? (
          <span className={styles.groupTag} title={session.group}>
            {session.group}
          </span>
        ) : null}
      </div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'group',
              label: t('sessionGroupMove'),
              icon: <IconFolderOutline16 />,
              onSelect: () => setMoving(true),
            },
            {
              key: 'duplicate',
              label: t('sessionDuplicate'),
              icon: <IconCopyOutline16 />,
              onSelect: () => {
                void duplicateSession(session.id).then((newId) => {
                  if (newId) {
                    showToast({ key: 'sessionDuplicated', params: { title: displayTitle } })
                  }
                })
              },
            },
            {
              key: 'pin',
              label: session.pinned ? t('sessionUnpinAction') : t('sessionPinAction'),
              icon: <IconPinOutline16 />,
              onSelect: () => setSessionPinned(session.id, !session.pinned),
            },
            {
              key: 'archive',
              label: session.archived ? t('sessionGroupUnarchiveAction') : t('sessionGroupArchiveAction'),
              icon: session.archived ? <IconInboxOutline16 /> : <IconArchiveOutline16 />,
              onSelect: () => setSessionArchived(session.id, !session.archived),
            },
            {
              key: 'export-md',
              label: t('exportMarkdown'),
              icon: <IconDocOutline16 />,
              onSelect: () => exportSessionMarkdown(session.id),
            },
            {
              key: 'export-pdf',
              label: t('exportPdf'),
              icon: <IconDownloadOutline16 />,
              onSelect: () => void exportSessionPdf(session.id),
            },
            {
              key: 'share-html',
              label: t('shareHtml'),
              icon: <IconLinkOutline16 />,
              onSelect: () => void exportSessionHtml(session.id),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
      {moving ? <MoveGroupDialog session={session} onClose={() => setMoving(false)} /> : null}
    </div>
  )
})
