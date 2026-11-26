import { countTokens } from 'gpt-tokenizer'

/** 图片/文档 block 的粗略 token 折算（DeepSeek 按分辨率计价，这里用固定估算） */
export const IMAGE_TOKEN_ESTIMATE = 1024

type ContentBlock = { type?: string; text?: unknown }
type MessageLike = { role?: string; content?: unknown }

/** 单条消息的 token 估算：字符串直接计数，块数组按类型折算 */
export const messageTokenEstimate = (message: MessageLike): number => {
  const content = message.content
  if (typeof content === 'string') {
    return countTokens(content)
  }
  if (Array.isArray(content)) {
    let total = 0
    for (const block of content as ContentBlock[]) {
      if (block && typeof block === 'object') {
        if (typeof block.text === 'string') {
          total += countTokens(block.text)
        } else if (block.type === 'image' || block.type === 'document') {
          total += IMAGE_TOKEN_ESTIMATE
        }
      }
    }
    return total
  }
  return 0
}

export const messagesTokenEstimate = (messages: MessageLike[]): number =>
  messages.reduce((sum, message) => sum + messageTokenEstimate(message), 0)
