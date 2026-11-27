import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/deepseek.js', () => {
  class UpstreamError extends Error {
    readonly status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'UpstreamError'
    }
  }

  const toolTurn = (index: number): string[] => [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-' +
      index +
      '","name":"list_files","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]

  const finalTurn = (): string[] => [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"FINAL ANSWER"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]

  return {
    UpstreamError,
    async *streamUpstream(req: Record<string, unknown>) {
      state.calls.push(req)
      const isFinal = !Array.isArray(req.tools) || req.tools.length === 0
      const blocks = isFinal ? finalTurn() : toolTurn(state.calls.length)
      for (const block of blocks) {
        yield block
      }
    },
  }
})

import { MAX_AGENT_ITERATIONS, runAgentLoop } from '../src/agent/loop.js'

describe('Agent 工具循环上限', () => {
  beforeEach(() => {
    state.calls.length = 0
  })

  it('到达上限后仍会执行最后一批工具，并发起无工具收尾请求', async () => {
    const forwarded: string[] = []
    const result = await runAgentLoop({
      sessionId: 'agent-loop-test',
      request: {
        model: 'deepseek-flash',
        system: 'test',
        messages: [{ role: 'user', content: '读文件' }],
      },
      apiKey: 'test-key',
      target: { kind: 'local' },
      signal: new AbortController().signal,
      forward: (block) => forwarded.push(block),
      emit: () => undefined,
    })

    expect(result.toolCalls).toBe(MAX_AGENT_ITERATIONS)
    expect(state.calls).toHaveLength(MAX_AGENT_ITERATIONS + 1)
    expect(state.calls.at(-1)?.tools).toBeUndefined()
    expect(String(state.calls.at(-1)?.system)).toContain('工具调用次数已达到上限')
    expect(forwarded.join('')).toContain('FINAL ANSWER')
    expect(forwarded.join('')).toContain('message_stop')
  })
})
