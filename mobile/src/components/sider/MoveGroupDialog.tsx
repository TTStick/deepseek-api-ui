import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { listSessionGroups } from '../../services/chat/sessionGroups.js'
import { setSessionGroup, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Modal } from '../base/Modal.js'
import { IconCheckOutline16, IconFolderOutline16 } from '../base/icons.js'
import styles from './MoveGroupDialog.module.css'

/** 把会话移动到分组：选已有分组 / 新建分组 / 移出分组（与网页端一致） */
export const MoveGroupDialog = ({
  session,
  onClose,
}: {
  session: SessionSummary
  onClose: () => void
}) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const groups = listSessionGroups(sessions)
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
        {groups.map((group) => {
          const current = group === session.group
          return (
            <button
              key={group}
              type="button"
              className={styles.item}
              disabled={current}
              onClick={() => move(group)}
            >
              <span className={styles.icon}>
                <IconFolderOutline16 />
              </span>
              <span className={styles.name}>{group}</span>
              {current ? (
                <span className={styles.current}>
                  <IconCheckOutline16 />
                  {t('sessionGroupCurrent')}
                </span>
              ) : null}
            </button>
          )
        })}
        <button
          type="button"
          className={styles.item}
          disabled={!session.group}
          onClick={() => move(null)}
        >
          <span className={styles.icon}>↩</span>
          <span className={styles.name}>{t('sessionGroupNone')}</span>
          {!session.group ? (
            <span className={styles.current}>
              <IconCheckOutline16 />
              {t('sessionGroupCurrent')}
            </span>
          ) : null}
        </button>
      </div>
      {creating ? (
        <div className={styles.create}>
          <input
            autoFocus
            className={styles.input}
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
            {t('advancedSave')}
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
