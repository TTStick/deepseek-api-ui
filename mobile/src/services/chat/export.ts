import { android, saveAndroidHistory } from '../../app/android.js'
import { showToast } from '../../components/base/toastState.js'
import { getVisibleMessages, normalizeSession } from './branches.js'
import { useChatStore } from './store.js'
import { getReplyText, summaryDisplayText } from './reply.js'
import type { Session } from './types.js'

/** 对话导出：Markdown 由前端构建；PDF/HTML 由服务器 python 转换后下载到手机/电脑 */

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

/** 保存 Blob：Android 走系统文件选择器，桌面走浏览器下载 */
const saveBlob = async (blob: Blob, filename: string): Promise<boolean> => {
  if (android) {
    return saveAndroidHistory(filename, blob)
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

const loadSession = (sessionId: string): Session | null =>
  useChatStore.getState().sessionCache[sessionId] ?? null

/** 服务器模式导出 PDF/HTML（后端转换，内置 CJK 字体） */
const exportRemote = async (session: Session, kind: 'pdf' | 'html'): Promise<boolean> => {
  const { url, token } = (await import('../api/serverMode.js')).useServerConfig.getState()
  if (!url || !token) {
    showToast({ key: 'exportFailed', type: 'error' })
    return false
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== 'open') {
    headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(`${url}/api/export/${kind}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ markdown: sessionToMarkdown(session) }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    showToast({ key: 'exportFailed', type: 'error' })
    return false
  }
  const blob = await response.blob()
  return saveBlob(blob, `${safeName(session.title)}.${kind}`)
}

/** 导出当前会话；返回是否成功 */
export const exportSession = async (
  sessionId: string,
  kind: 'md' | 'pdf' | 'html'
): Promise<boolean> => {
  const session = loadSession(sessionId)
  if (!session) {
    showToast({ key: 'exportFailed', type: 'error' })
    return false
  }
  if (session.messages.length === 0) {
    showToast({ key: 'exportEmpty' })
    return false
  }
  try {
    if (kind === 'md') {
      const saved = await saveBlob(
        new Blob([sessionToMarkdown(session)], { type: 'text/markdown; charset=utf-8' }),
        `${safeName(session.title)}.md`
      )
      if (saved) {
        showToast({ key: 'exportSaved' })
      }
      return saved
    }
    const saved = await exportRemote(session, kind)
    if (saved) {
      showToast({ key: 'exportSaved' })
    }
    return saved
  } catch {
    showToast({ key: 'exportFailed', type: 'error' })
    return false
  }
}

/** 导出指定类型时的文件名（供 UI 预览/调试） */
export const exportFileName = (session: Session, kind: 'md' | 'pdf' | 'html'): string =>
  `${safeName(session.title)}.${kind}`
