import { useEffect, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { android } from '../../app/android.js'
import whale from '../../assets/deepseek-whale.svg'
import {
  useAndroidColdStartGreeting,
  useAndroidWelcomeMessages,
  useTranslate,
} from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

let coldStartGreetingPending = true

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const coldStartGreeting = useAndroidColdStartGreeting()
  const androidMessages = useAndroidWelcomeMessages()
  const [hasPhotoSuggestions, setHasPhotoSuggestions] = useState(false)
  const [coldStart] = useState(coldStartGreetingPending)
  const [greeting] = useState(() => {
    if (!android) {
      return t('welcomeMessageChat250808')
    }
    if (coldStart) {
      return coldStartGreeting
    }
    return androidMessages[Math.floor(Math.random() * androidMessages.length)]
  })
  useEffect(() => {
    if (android) {
      coldStartGreetingPending = false
    }
  }, [])
  return (
    <div className={styles.container} data-drawer-free-pan={android ? '' : undefined}>
      {isMobile ? <MobileHeader /> : null}
      <div
        className={styles.welcome}
        data-side-shift={android ? 'center' : undefined}
        data-has-photo-suggestions={hasPhotoSuggestions ? 'true' : undefined}
      >
        <div className={styles.greeting}>
          {android ? <img src={whale} alt="" /> : null}
          {android ? <span className={styles.greetingText}>{greeting}</span> : greeting}
        </div>
        <ChatInput sessionId={null} onPhotoSuggestionsChange={setHasPhotoSuggestions} />
        {isMobile && !android ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
