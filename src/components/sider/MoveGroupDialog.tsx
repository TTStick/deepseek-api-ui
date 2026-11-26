import { useState } from 'react'
import { listSessionGroups } from '../../services/chat/sessionGroups.js'
import { setSessionGroup, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import styles from './MoveGroupDialog.module.css'

/** 把会话移动到分组：选已有分组 / 新建分组 / 移出分组 */
export const MoveGroupDialog = ({
  session,
  onClose,
}: {
  session: SessionSummary
  onClose: () => void
}) => {
  const t = useTranslate()
  const groups = useChatStore((state) => listSessionGroups(state.sessions))
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const move = (group: string | null) => {
    setSessionGroup(session.id, group)
    onClose()
  }

  const create = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      return
    }
    move(trimmed)
  }

  return (
    <Modal title={t('sessionGroupMove')} className={styles.dialog} closable onClose={onClose}>
      <div className={styles.list}>
        {groups.map((group) => (
          <button
            key={group}
            type="button"
            className={styles.item}
            onClick={() => move(group)}
            disabled={group === session.group}
          >
            <span className={styles.groupIcon}>📁</span>
            <span className={styles.groupName}>{group}</span>
            {group === session.group ? <span className={styles.current}>{t('sessionGroupCurrent')}</span> : null}
          </button>
        ))}
        <button type="button" className={styles.item} onClick={() => move(null)} disabled={!session.group}>
          <span className={styles.groupIcon}>↩️</span>
          <span className={styles.groupName}>{t('sessionGroupNone')}</span>
        </button>
      </div>
      {creating ? (
        <div className={styles.create}>
          <input
            autoFocus
            value={name}
            placeholder={t('sessionGroupNewPlaceholder')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                create()
              } else if (event.key === 'Escape') {
                setCreating(false)
              }
            }}
          />
          <button type="button" className={styles.createConfirm} onClick={create}>
            {t('save')}
          </button>
        </div>
      ) : (
        <button type="button" className={styles.newGroup} onClick={() => setCreating(true)}>
          ＋ {t('sessionGroupNew')}
        </button>
      )}
    </Modal>
  )
}
