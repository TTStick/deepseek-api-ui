import { streamUpstream, UpstreamError, type UpstreamRequest } from '../deepseek.js'
import type { IndexOptions } from '../indexing/store.js'
import {
  agentToolsFor,
  ToolExecutor,
  type AgentToolName,
  type ToolTarget,
} from './tools.js'

/**
 * Agent 循环（移植 claude-code QueryEngine 的 tool_use/tool_result 循环）：
 * - 每轮把带工具的请求发给模型，解析流式事件累积 tool_use 与正文块
 * - 收到 stop_reason=tool_use 时执行工具，把 tool_result 回灌给下一轮
 * - 最多 MAX_ITERATIONS 轮；到达上限后执行完最后一次工具，再发一次不带工具的收尾请求
 * - 中间轮的 message_stop 不转发（前端把整个循环视为一条回答），
 *   只在最终轮后转发一次 message_stop，保证前端流式消费兼容
 */

/**
 * 一次用户提问允许的工具循环轮数。
 * 读大量资料时 10 轮很容易在“还在读文件”时被截断；默认 24，
 * 到顶后仍会再发一次不带工具的收尾请求，保证用户拿到回答而不是静默结束。
 */
export const MAX_AGENT_ITERATIONS = Math.max(
  1,
  Math.min(64, Number(process.env.AGENT_MAX_ITERATIONS ?? 24) || 24)
)

const FINAL_LIMIT_NOTICE =
  '【系统提示】本轮工具调用次数已达到上限，不能再调用任何工具。' +
  '请直接基于目前已经读取/检索到的内容给出最终回答；如果还有未完成的部分，' +
  '明确说明哪些没有做完以及建议的下一步，不要再次请求调用工具。'

export type AgentSinkEvent =
  | { type: 'agent_tool'; toolUseId: string; name: string; input: unknown; status: 'running' }
  | { type: 'agent_tool_result'; toolUseId: string; name: string; output: string; isError: boolean; status: 'done' }
  | { type: 'agent_artifact'; path: string; action: 'created' | 'updated' | 'generated'; size?: number }

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

type ParsedTurn = {
  content: ContentBlock[]
  stopReason: string | null
}

/** 解析一行 SSE 块（"event: x\ndata: {...}"），data 无法解析时返回 null */
const parseSseBlock = (block: string): { event: string; data: Record<string, unknown> } | null => {
  const lines = block.split('\n')
  let event = ''
  let dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  if (!event || dataLines.length === 0) {
    return null
  }
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> }
  } catch {
    return null
  }
}

/** 一轮请求：转发除 message_stop 外的全部事件，累积正文与 tool_use 块 */
const iterate = async (
  request: UpstreamRequest,
  apiKey: string,
  signal: AbortSignal,
  forward: (block: string) => void,
  toolsForTurn: ReturnType<typeof agentToolsFor>,
  includeTools = true
): Promise<ParsedTurn> => {
  const upstream: UpstreamRequest = {
    ...request,
    ...(includeTools
      ? { tools: [...(request.tools ?? []), ...toolsForTurn] }
      : {}),
  }
  if (!includeTools) {
    delete upstream.tools
  }
  const content: ContentBlock[] = []
  let stopReason: string | null = null
  /** block index → tool_use 累积状态 */
  const tools = new Map<number, { id: string; name: string; chunks: string[] }>()
  /** block index → 文本累积 */
  const texts = new Map<number, string>()

  for await (const block of streamUpstream(upstream, apiKey, signal)) {
    const parsed = parseSseBlock(block)
    if (parsed) {
      const { event, data } = parsed
      if (event === 'content_block_start' && data.content_block) {
        const cb = data.content_block as Record<string, unknown>
        if (cb.type === 'tool_use' && typeof cb.id === 'string') {
          // Anthropic 协议：start 块的 input 是占位（{}），实际参数经 input_json_delta 流式到达；
          // 只有非空 input 才作为初始块，避免与增量拼接出非法 JSON。
          const initial = typeof cb.input === 'string' ? cb.input : ''
          tools.set(data.index as number, {
            id: cb.id,
            name: String(cb.name ?? ''),
            chunks: initial && initial !== '{}' ? [initial] : [],
          })
        } else if (cb.type === 'text') {
          texts.set(data.index as number, typeof cb.text === 'string' ? cb.text : '')
        }
      } else if (event === 'content_block_delta' && data.delta) {
        const delta = data.delta as Record<string, unknown>
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          tools.get(data.index as number)?.chunks.push(delta.partial_json)
        } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          const index = data.index as number
          texts.set(index, (texts.get(index) ?? '') + delta.text)
        }
      } else if (event === 'content_block_stop') {
        const index = data.index as number
        const tool = tools.get(index)
        if (tool) {
          let input: unknown = {}
          const joined = tool.chunks.join('')
          if (joined) {
            try {
              input = JSON.parse(joined)
            } catch {
              input = { raw: joined }
            }
          }
          content.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
          tools.delete(index)
        } else if (texts.has(index)) {
          content.push({ type: 'text', text: texts.get(index) ?? '' })
          texts.delete(index)
        }
      } else if (event === 'message_delta' && data.delta) {
        const delta = data.delta as Record<string, unknown>
        if (typeof delta.stop_reason === 'string') {
          stopReason = delta.stop_reason
        }
      }
    }
    // 中间轮的 message_stop 不转发；其余事件原样给前端
    if (parsed?.event !== 'message_stop') {
      forward(block)
    }
  }
  return { content, stopReason }
}

export type AgentLoopParams = {
  sessionId: string
  request: UpstreamRequest
  apiKey: string
  target: ToolTarget
  signal: AbortSignal
  /** 原始 SSE 块转发（前端流式消费） */
  forward: (block: string) => void
  /** 自定义事件（工具活动 / 交付物） */
  emit: (event: AgentSinkEvent) => void
  /** 进阶检索开关；未开启时不会向模型暴露索引工具 */
  indexes?: IndexOptions
}

export const runAgentLoop = async ({
  sessionId,
  request,
  apiKey,
  target,
  signal,
  forward,
  emit,
  indexes,
}: AgentLoopParams): Promise<{ iterations: number; toolCalls: number }> => {
  const messages = [...request.messages] as Array<Record<string, unknown>>
  const executor = new ToolExecutor(sessionId, target, indexes)
  const toolsForTurn = agentToolsFor(indexes)
  let toolCalls = 0
  let iterations = 0
  let limitReached = false
  try {
    for (iterations = 0; iterations < MAX_AGENT_ITERATIONS; iterations += 1) {
      const turn = await iterate({ ...request, messages }, apiKey, signal, forward, toolsForTurn)
      const toolUses = turn.content.filter(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
      )
      messages.push({ role: 'assistant', content: turn.content })
      if (turn.stopReason !== 'tool_use' || toolUses.length === 0) {
        break
      }

      // 即使这是最后一轮允许的模型调用，也先把这批工具执行完；
      // 工具结果留在 messages 里供收尾请求使用，而不是直接静默 break。
      const lastAllowedTurn = iterations + 1 >= MAX_AGENT_ITERATIONS
      const results: Array<Record<string, unknown>> = []
      for (const tool of toolUses) {
        if (signal.aborted) {
          break
        }
        toolCalls += 1
        emit({ type: 'agent_tool', toolUseId: tool.id, name: tool.name, input: tool.input, status: 'running' })
        const outcome = await executor.execute(tool.name as AgentToolName, tool.input)
        emit({
          type: 'agent_tool_result',
          toolUseId: tool.id,
          name: tool.name,
          output: outcome.content,
          isError: outcome.isError,
          status: 'done',
        })
        for (const artifact of outcome.artifacts) {
          emit({
            type: 'agent_artifact',
            path: artifact.path,
            action: artifact.action,
            size: artifact.size,
          })
        }
        results.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: outcome.content,
          is_error: outcome.isError,
        })
      }
      if (signal.aborted) {
        break
      }
      messages.push({ role: 'user', content: results })
      if (lastAllowedTurn) {
        limitReached = true
        break
      }
    }

    if (limitReached && !signal.aborted) {
      // 收尾请求不带工具：强制模型把已读到的内容组织成回答，并说明未完成部分。
      const finalRequest: UpstreamRequest = {
        ...request,
        system: `${request.system}\n\n${FINAL_LIMIT_NOTICE}`,
        messages,
      }
      const finalTurn = await iterate(finalRequest, apiKey, signal, forward, [], false)
      iterations += 1
      const finalText = finalTurn.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
      if (!finalText && !signal.aborted) {
        // 极少数情况下模型不产出正文；给用户一个可读的收尾提示，避免空白回答。
        const text = '本轮工具调用已达到上限，未能生成最终总结。请把问题拆小，或继续追问未完成的部分。'
        const start = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        const delta = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }
        const stop = { type: 'content_block_stop', index: 0 }
        forward(`event: content_block_start\ndata: ${JSON.stringify(start)}\n\n`)
        forward(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
        forward(`event: content_block_stop\ndata: ${JSON.stringify(stop)}\n\n`)
      }
    }
  } catch (error) {
    if (error instanceof UpstreamError) {
      throw error
    }
    throw error
  }
  // 整个循环结束，转发一次 message_stop，前端按单条回答收尾
  forward('event: message_stop\ndata: {"type":"message_stop"}')
  return { iterations, toolCalls }
}
