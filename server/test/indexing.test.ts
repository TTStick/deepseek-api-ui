import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/indexing/chunk.js'

describe('chunkText', () => {
  it('keeps line numbers for markdown chunks', () => {
    const text = `# Title\n\n${'a'.repeat(200)}\n\n${'b'.repeat(200)}`
    const chunks = chunkText(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks.at(-1)?.endLine).toBe(5)
  })

  it('splits an oversized single line without dropping text', () => {
    const line = 'x'.repeat(500)
    const chunks = chunkText(line, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true)
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(line)
  })

  it('handles empty and short input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('hello')).toEqual([{ content: 'hello', startLine: 1, endLine: 1 }])
  })
})
