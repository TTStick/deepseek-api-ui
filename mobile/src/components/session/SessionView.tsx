import clsx from 'clsx'
import { memo, useState } from 'react'
import { android } from '../../app/android.js'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { ContextStats } from './ContextStats.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = memo(function SessionView({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [attachmentPanelOpen, setAttachmentPanelOpen] = useState(false)
  const title = session.title || t('untitledChat')
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} session={session} streaming={streaming} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
          <div className={styles.headerStats}>
            <ContextStats session={session} streaming={streaming} showText />
          </div>
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div
            className={styles.inputContainer}
            data-side-shift={android ? 'center' : undefined}
            data-attachment-open={attachmentPanelOpen ? 'true' : undefined}
          >
            <ChatInput sessionId={session.id} onAttachmentPanelChange={setAttachmentPanelOpen} />
            <div className={styles.caveatSlot}>
              <div className={styles.caveat}>
                {t(android ? 'androidContentCaveat' : 'contentCaveat')}
              </div>
            </div>
          </div>
        }
      />
    </div>
  )
})
