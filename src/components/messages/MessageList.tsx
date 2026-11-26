import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { isUsableReply, summaryDisplayText } from '../../services/chat/reply.js'
import { rewindSession, selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const t = useTranslate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const messages = getVisibleMessages(session)
  /** 压缩分隔条位置：已归档轮数之后的第一条消息下标；无压缩为 -1 */
  const compressionBoundary = useMemo(() => {
    const archived = session.compression?.archivedRounds ?? 0
    if (archived <= 0) {
      return -1
    }
    let rounds = 0
    for (let i = 0; i + 1 < messages.length; i++) {
      if (messages[i].role === 'user' && isUsableReply(messages[i + 1])) {
        rounds += 1
        if (rounds === archived) {
          return i + 2
        }
        i += 1
      }
    }
    return -1
  }, [session.compression?.archivedRounds, messages])
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  const [dividerOpen, setDividerOpen] = useState(false)
  const [rewindTarget, setRewindTarget] = useState<Message | null>(null)
  const rewindCount = rewindTarget
    ? session.messages.length - session.messages.findIndex((message) => message.id === rewindTarget.id) - 1
    : 0
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
          <div ref={contentRef} className={styles.column}>
            {messages.map((message, index) => (
              <Fragment key={message.id}>
                {index === compressionBoundary && session.compression ? (
                  <CompressionDivider
                    session={session}
                    open={dividerOpen}
                    onToggle={() => setDividerOpen((open) => !open)}
                  />
                ) : null}
                {message.role === 'user' ? (
                  <UserMessage
                    key={message.id}
                    sessionId={session.id}
                    message={message}
                    retryUploadId={uploadRetryId}
                    isFirst={index === 0}
                    isLast={index === lastIndex || index === lastIndex - 1}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                    onRewind={setRewindTarget}
                  />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    sessionId={session.id}
                    message={message}
                    isLast={index === lastIndex}
                    streaming={streaming && index === lastIndex}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                    onRewind={setRewindTarget}
                  />
                )}
              </Fragment>
            ))}
          </div>
        </div>
        {footer}
      </div>
      {rewindTarget ? (
        <Modal
          title={t('rewindConfirmTitle')}
          onClose={() => setRewindTarget(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setRewindTarget(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  rewindSession(session.id, rewindTarget.id)
                  showToast({ key: 'rewindDone' })
                  setRewindTarget(null)
                }}
              >
                {t('rewindConfirm')}
              </Button>
            </>
          }
        >
          {t('rewindConfirmDescription', { count: rewindCount })}
        </Modal>
      ) : null}
    </ScrollToBottomContext.Provider>
  )
}

/** 压缩分隔条：标记归档边界，可展开查看摘要正文 */
const CompressionDivider = ({
  session,
  open,
  onToggle,
}: {
  session: Session
  open: boolean
  onToggle: () => void
}) => {
  const t = useTranslate()
  const compression = session.compression
  if (!compression) {
    return null
  }
  return (
    <div className={styles.compressionDivider}>
      <button
        type="button"
        className={styles.compressionToggle}
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        {t('contextCompressedNotice', { count: compression.archivedRounds })}
      </button>
      {open ? (
        <div className={styles.compressionSummary}>{summaryDisplayText(compression.summaryRow)}</div>
      ) : null}
    </div>
  )
}
