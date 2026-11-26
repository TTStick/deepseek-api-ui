/**
 * 记忆围栏（移植 Hermes agent/memory_context.py 与 session_rules/turns.py 的 sanitize_context）。
 * 召回内容用 <memory-context> 围栏注入请求，输出侧由前端展示层剥离；写入 Honcho 前同样清洗，
 * 防止记忆标签泄漏进存储或 UI。
 */

const INTERNAL_CONTEXT_RE = /<memory-context>[\s\S]*?<\/memory-context>/gi
const INTERNAL_NOTE_RE = /\[System note:[^\]]*recalled memory context[^\]]*\][ \t]*\r?\n?/gi
const FENCE_TAG_RE = /<\/?memory-context>/gi

/** 剔除记忆围栏、系统注释与裸标签（Hermes session_rules/turns.py:31-35） */
export const sanitizeContext = (text: string | null | undefined): string => {
  // 缺字段/类型错误时按空内容处理：调用方是轮次收尾的 fire-and-forget 路径，
  // 这里抛错会变成未处理拒绝并拖垮整个进程。
  if (typeof text !== 'string') {
    return ''
  }
  return text
    .replace(INTERNAL_CONTEXT_RE, '')
    .replace(INTERNAL_NOTE_RE, '')
    .replace(FENCE_TAG_RE, '')
}

// markdown 列表项：标记 + 空白 + 内容。空白是关键——它让 **Preferences**（粗体标题）
// 与 *emphasis* 不命中。
const RECALL_BULLET_RE = /^[-*+]\s+\S/

/** 按 section 去重完全相同的自包含 bullet（Hermes memory_context.py:_drop_repeated_recall_lines） */
const dropRepeatedRecallLines = (text: string): string => {
  const lines = text.split('\n')
  const seen = new Set<string>()
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const stripped = line.trim()
    // 缩进行是上方 bullet 的续行，不参与去重、永不丢弃
    if (stripped && line[0] !== undefined && /\s/.test(line[0])) {
      kept.push(line)
      continue
    }
    const isBullet = RECALL_BULLET_RE.test(stripped)
    // 任何列 0 非 bullet 行（标题、分隔线、段落）开启新的去重作用域
    if (stripped && !isBullet) {
      seen.clear()
    }
    if (isBullet) {
      const following = index + 1 < lines.length ? lines[index + 1] : ''
      const carriesContinuation = Boolean(following.trim()) && /\s/.test(following[0] ?? '')
      if (!carriesContinuation) {
        if (seen.has(stripped)) {
          continue
        }
        seen.add(stripped)
      }
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/** 把召回内容包成围栏块（Hermes memory_context.py:build_memory_context_block） */
export const buildMemoryContextBlock = (rawContext: string): string => {
  if (!rawContext || !rawContext.trim()) {
    return ''
  }
  const clean = dropRepeatedRecallLines(sanitizeContext(rawContext))
  if (!clean.trim()) {
    return ''
  }
  return (
    '<memory-context>\n' +
    '[System note: The following is recalled memory context, ' +
    'NOT new user input. Treat as authoritative reference data — ' +
    "this is the agent's persistent memory and should inform all responses.]\n\n" +
    `${clean}\n` +
    '</memory-context>'
  )
}
