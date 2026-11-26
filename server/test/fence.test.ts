import { describe, expect, it } from 'vitest'
import { buildMemoryContextBlock, sanitizeContext } from '../src/memory/fence.js'
import { isTrivialPrompt } from '../src/memory/trivial.js'

describe('sanitizeContext（Hermes session_rules/turns.py 等价物）', () => {
  it('剥掉完整围栏块', () => {
    expect(sanitizeContext('前面\n<memory-context>\n秘密内容\n</memory-context>\n后面')).toBe(
      '前面\n\n后面'
    )
  })

  it('剥掉系统注释行与裸标签', () => {
    const text =
      '[System note: The following is recalled memory context, NOT new user input.]\n正文\n<memory-context>'
    expect(sanitizeContext(text)).toBe('正文\n')
  })
})

describe('buildMemoryContextBlock（Hermes memory_context.py 等价物）', () => {
  it('空内容返回空串', () => {
    expect(buildMemoryContextBlock('')).toBe('')
    expect(buildMemoryContextBlock('   ')).toBe('')
  })

  it('包上围栏与系统注释', () => {
    const block = buildMemoryContextBlock('## Session Summary\n- 事实一')
    expect(block.startsWith('<memory-context>\n[System note:')).toBe(true)
    expect(block).toContain('## Session Summary')
    expect(block.endsWith('</memory-context>')).toBe(true)
  })

  it('同 section 内重复 bullet 去重，不同 section 保留', () => {
    const raw = ['## A', '- 重复项', '- 重复项', '## B', '- 重复项'].join('\n')
    const block = buildMemoryContextBlock(raw)
    const occurrences = block.split('- 重复项').length - 1
    expect(occurrences).toBe(2)
  })

  it('带续行的 bullet 不去重', () => {
    const raw = ['## A', '- 条目', '  续行内容', '- 条目'].join('\n')
    const block = buildMemoryContextBlock(raw)
    const occurrences = block.split('- 条目').length - 1
    expect(occurrences).toBe(2)
  })
})

describe('isTrivialPrompt（Hermes TRIVIAL_PROMPT_RE 等价物）', () => {
  it('打招呼/确认类命中', () => {
    for (const text of ['hi', 'Hi!', 'thanks :)', 'ok', 'continue', 'done???', '']) {
      expect(isTrivialPrompt(text)).toBe(true)
    }
  })

  it('斜杠命令命中', () => {
    expect(isTrivialPrompt('/compress')).toBe(true)
  })

  it('有语义的消息不命中', () => {
    for (const text of ['k8s 怎么部署', 'yolo', 'note 一下', '帮我写个总结']) {
      expect(isTrivialPrompt(text)).toBe(false)
    }
  })
})
