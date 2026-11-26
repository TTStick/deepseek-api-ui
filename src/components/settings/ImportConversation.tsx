import { useRef, useState } from 'react'
import { importConversationFile } from '../../services/chat/importConversation.js'
import { useTranslate } from '../../i18n/index.js'
import { IconLoadingOutline16, IconUploadOutline14 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { SettingCell, type Status } from './SettingCell.js'
import styles from './Settings.module.css'

/** 导入单个对话：读 Markdown / HTML 分享文件，作为新会话加入列表（不影响现有对话） */
export const ImportConversation = () => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onSelect = async (file: File | undefined) => {
    if (!file || busy) {
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const title = await importConversationFile(file)
      if (title) {
        setStatus({ key: 'importConversationDone', params: { title } })
      } else {
        setStatus({ key: 'importConversationFailed', error: true })
      }
    } catch {
      setStatus({ key: 'importConversationFailed', error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('importConversation')}
      description={t('importConversationDescription')}
      status={status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            aria-busy={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? <IconLoadingOutline16 /> : <IconUploadOutline14 />}
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".md,.markdown,.html,.htm,text/markdown,text/html"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              void onSelect(file)
            }}
          />
        </>
      }
    />
  )
}
