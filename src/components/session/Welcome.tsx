import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { IconBrowseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { MemoryPanel } from '../memory/MemoryPanel.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/**
 * 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底。
 * 右上角提供记忆入口：只配置待定偏好，首条消息发出时应用到新会话，不创建空会话。
 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const memoryEnabled = useSettings((state) => state.memoryEnabled)
  const [memoryOpen, setMemoryOpen] = useState(false)
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      {!isMobile && memoryEnabled ? (
        <div className={styles.header}>
          <IconButton
            icon={<IconBrowseOutline16 />}
            tooltip={t('memoryPanelTitle')}
            tooltipPlacement="bottom"
            aria-label={t('memoryPanelTitle')}
            onClick={() => setMemoryOpen(true)}
          />
        </div>
      ) : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
      {memoryOpen ? <MemoryPanel sessionId={null} onClose={() => setMemoryOpen(false)} /> : null}
    </div>
  )
}
