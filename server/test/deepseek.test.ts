import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasFileBlocks, streamUpstream } from '../src/deepseek.js'

const request = (content: unknown[]) => ({
  model: 'deepseek-flash',
  system: '',
  messages: [{ role: 'user', content }],
})

describe('Anthropic 兼容代理', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('识别消息里的 image / document 文件块', () => {
    expect(hasFileBlocks(request([{ type: 'text', text: 'hi' }]).messages)).toBe(false)
    expect(
      hasFileBlocks(request([{ type: 'image', source: { type: 'file', file_id: 'f1' } }]).messages)
    ).toBe(true)
    expect(
      hasFileBlocks(
        request([{ type: 'document', source: { type: 'file', file_id: 'f2' } }]).messages
      )
    ).toBe(true)
  })

  it('有文件块时给上游补上 files-api beta header', async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init)
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      })
    )
    const blocks: string[] = []
    for await (const block of streamUpstream(
      request([{ type: 'image', source: { type: 'file', file_id: 'f1' } }]),
      'test-key',
      new AbortController().signal
    )) {
      blocks.push(block)
    }
    expect(blocks).toEqual([])
    expect(calls).toHaveLength(1)
    expect((calls[0]!.headers as Record<string, string>)['anthropic-beta']).toBe(
      'files-api-2025-04-14'
    )
  })

  it('没有文件块时不额外发送 beta header', async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init)
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      })
    )
    for await (const _block of streamUpstream(
      request([{ type: 'text', text: 'hi' }]),
      'test-key',
      new AbortController().signal
    )) {
      // drain
    }
    expect((calls[0]!.headers as Record<string, string>)['anthropic-beta']).toBeUndefined()
  })
})
