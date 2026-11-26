import { useState } from 'react'
import { IconBrowseOutline16, IconDocOutline16, IconDownloadOutline16, IconLinkOutline16, IconMenuOutline20, IconNewChatOutline20, IconRefreshOutline16, IconRightUpOutline14 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { compressSession, newChat } from '../../services/chat/store.js'
import { exportSessionHtml, exportSessionMarkdown, exportSessionPdf } from '../../services/chat/export.js'
import { useSettings } from '../../services/settings.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { MemoryPanel } from '../memory/MemoryPanel.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题、压缩/记忆/导出/分享操作与开启新对话 */
export const MobileHeader = ({
  title,
  sessionId,
  streaming,
}: {
  title?: string
  sessionId?: string
  streaming?: boolean
}) => {
  const t = useTranslate()
  const compressionEnabled = useSettings((state) => state.compressionEnabled)
  const memoryEnabled = useSettings((state) => state.memoryEnabled)
  const [memoryOpen, setMemoryOpen] = useState(false)
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      {title === undefined ? null : (
        <>
          <div className={styles.title}>{title}</div>
          {sessionId && compressionEnabled ? (
            <IconButton
              size="xl"
              tone="primary"
              icon={<IconRefreshOutline16 />}
              aria-label={t('compressButton')}
              disabled={streaming}
              onClick={() => void compressSession(sessionId)}
            />
          ) : null}
          {sessionId && memoryEnabled ? (
            <IconButton
              size="xl"
              tone="primary"
              icon={<IconBrowseOutline16 />}
              aria-label={t('memoryPanelTitle')}
              onClick={() => setMemoryOpen(true)}
            />
          ) : null}
          {sessionId ? (
            <Menu
              options={[
                { key: 'md', label: t('exportMarkdown'), icon: <IconDocOutline16 />, onSelect: () => exportSessionMarkdown(sessionId) },
                { key: 'pdf', label: t('exportPdf'), icon: <IconDownloadOutline16 />, onSelect: () => void exportSessionPdf(sessionId) },
              ]}
            >
              {({ toggle }) => (
                <IconButton
                  size="xl"
                  tone="primary"
                  icon={<IconDownloadOutline16 />}
                  aria-label={t('exportButton')}
                  disabled={streaming}
                  onClick={toggle}
                />
              )}
            </Menu>
          ) : null}
          {sessionId ? (
            <Menu
              options={[
                { key: 'html', label: t('shareHtml'), icon: <IconLinkOutline16 />, onSelect: () => void exportSessionHtml(sessionId) },
              ]}
            >
              {({ toggle }) => (
                <IconButton
                  size="xl"
                  tone="primary"
                  icon={<IconRightUpOutline14 />}
                  aria-label={t('shareButton')}
                  disabled={streaming}
                  onClick={toggle}
                />
              )}
            </Menu>
          ) : null}
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        </>
      )}
      {memoryOpen && sessionId ? <MemoryPanel sessionId={sessionId} onClose={() => setMemoryOpen(false)} /> : null}
    </div>
  )
}
