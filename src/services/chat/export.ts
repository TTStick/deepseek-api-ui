import { getAgentApiOrigin } from '../api/client.js'
import { showToast } from '../../components/base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { getVisibleMessages, normalizeSession } from './branches.js'
import * as db from './db.js'
import { getReplyText, summaryDisplayText } from './reply.js'
import type { Session } from './types.js'

/** 对话导出/分享：Markdown 由前端构建；PDF 与自包含 HTML 分享页由后端 python 转换 */

const safeName = (title: string): string => {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 60)
  return cleaned || 'conversation'
}

const formatTime = (time: number): string => {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 会话 → Markdown（沿当前分支的可见消息；附件与交付文件以清单形式保留） */
export const sessionToMarkdown = (session: Session): string => {
  const lines: string[] = []
  lines.push(`# ${session.title || '未命名对话'}`)
  lines.push('')
  lines.push(`> 导出自 MyAgent · ${formatTime(session.createdAt)}`)
  for (const message of getVisibleMessages(normalizeSession(session))) {
    if (message.role === 'user') {
      lines.push('')
      lines.push('## 👤 用户')
      lines.push('')
      lines.push(message.content)
      if (message.files.length > 0) {
        lines.push('')
        lines.push(`_附件：${message.files.map((file) => file.name).join('、')}_`)
      }
    } else {
      const text = getReplyText(message)
      if (!text) {
        continue
      }
      lines.push('')
      lines.push(`## 🤖 助手 · ${formatTime(message.createdAt)}`)
      lines.push('')
      lines.push(text)
      const artifacts = message.agentEvents?.filter((event) => event.kind === 'artifact')
      if (artifacts && artifacts.length > 0) {
        lines.push('')
        lines.push(`_交付文件：${artifacts.map((artifact) => artifact.path).join('、')}_`)
      }
    }
  }
  if (session.compression && session.compression.archivedRounds > 0) {
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(`> 上下文压缩摘要（${session.compression.archivedRounds} 轮已归档）`)
    lines.push('')
    lines.push(summaryDisplayText(session.compression.summaryRow))
  }
  return lines.join('\n')
}

/** 从缓存或 IndexedDB 取会话（导出未打开的会话时按需加载） */
const loadForExport = async (sessionId: string): Promise<Session | null> => {
  const { useChatStore } = await import('./store.js')
  const cached = useChatStore.getState().sessionCache[sessionId]
  if (cached) {
    return cached
  }
  const stored = await db.loadSession(sessionId).catch(() => undefined)
  return stored ?? null
}

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const withSession = async (
  sessionId: string,
  action: (session: Session) => Promise<void> | void
) => {
  const session = await loadForExport(sessionId)
  if (!session) {
    showToast({ key: 'exportFailed', type: 'error' })
    return
  }
  await action(session)
}

/** 导出 Markdown 文件 */
export const exportSessionMarkdown = (sessionId: string) =>
  withSession(sessionId, (session) => {
    downloadBlob(
      new Blob([sessionToMarkdown(session)], { type: 'text/markdown; charset=utf-8' }),
      `${safeName(session.title)}.md`
    )
  })

const postExport = async (session: Session, kind: 'pdf' | 'html') => {
  const response = await fetch(`${getAgentApiOrigin()}/api/export/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: sessionToMarkdown(session) }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
    showToast({
      key: 'exportFailed',
      type: 'error',
      ...(body?.error?.message ? { params: { message: body.error.message } } : {}),
    })
    return
  }
  const blob = await response.blob()
  downloadBlob(blob, `${safeName(session.title)}.${kind === 'pdf' ? 'pdf' : 'html'}`)
}

/** 导出 PDF 文件（后端 reportlab 转换，内置 CJK 字体） */
export const exportSessionPdf = (sessionId: string) =>
  withSession(sessionId, async (session) => {
    try {
      await postExport(session, 'pdf')
    } catch {
      showToast({ key: 'exportFailed', type: 'error' })
    }
  })

/** 分享：自包含 HTML 文件（双击即可阅读，适合发给别人） */
export const exportSessionHtml = (sessionId: string) =>
  withSession(sessionId, async (session) => {
    try {
      await postExport(session, 'html')
    } catch {
      showToast({ key: 'exportFailed', type: 'error' })
    }
  })

/** 分享：复制 Markdown 到剪贴板 */
export const copySessionMarkdown = (sessionId: string) =>
  withSession(sessionId, async (session) => {
    const ok = await copyText(sessionToMarkdown(session))
    showToast({ key: ok ? 'copied' : 'copyFailed', type: ok ? undefined : 'error' })
  })
