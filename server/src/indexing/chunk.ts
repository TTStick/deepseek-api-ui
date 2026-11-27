/**
 * Markdown 文本分块（思路移植自 goose 的 services/ask-ai-bot/utils/ai/chunk-markdown.ts，
 * 去掉 Discord 的 marked AST 依赖，改为保留行号的轻量切分）：
 * - 优先按行/段落累积，避免把普通行切碎
 * - 超长单行按字符兜底切分
 * - 每个 chunk 记录原始起止行，检索命中后可用 read_file offset/limit 回读
 */

export type TextChunk = {
  content: string
  startLine: number
  endLine: number
}

const DEFAULT_MAX_CHARS = 4000
const OVERLAP_LINES = 1

export const chunkText = (text: string, maxChars = DEFAULT_MAX_CHARS): TextChunk[] => {
  if (!text.trim()) {
    return []
  }
  const limit = Math.max(200, maxChars)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const chunks: TextChunk[] = []
  let start = 0

  while (start < lines.length) {
    const current: string[] = []
    let chars = 0
    let end = start

    while (end < lines.length) {
      const line = lines[end]
      const cost = line.length + 1
      if (current.length > 0 && chars + cost > limit) {
        break
      }
      if (current.length === 0 && cost > limit) {
        // 超长单行：按字符切，行号保持同一行
        for (let offset = 0; offset < line.length; offset += limit) {
          chunks.push({
            content: line.slice(offset, offset + limit),
            startLine: end + 1,
            endLine: end + 1,
          })
        }
        end += 1
        break
      }
      current.push(line)
      chars += cost
      end += 1
    }

    if (current.length > 0) {
      chunks.push({
        content: current.join('\n'),
        startLine: start + 1,
        endLine: end,
      })
    }

    if (end >= lines.length) {
      break
    }
    // 保留一行重叠，避免段落/列表恰好跨块时完全丢失上下文
    start = Math.max(start + 1, end - OVERLAP_LINES)
  }

  return chunks
}
