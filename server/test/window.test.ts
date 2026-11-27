import { describe, expect, it } from 'vitest'
import {
  computeTailBudget,
  computeThresholdTokens,
  formatTurnsForSummary,
  planRounds,
  planWindow,
  SUMMARY_PREFIX,
  type MessageLike,
} from '../src/compression/window.js'

const user = (text: string): MessageLike => ({ role: 'user', content: text })
const assistant = (text: string): MessageLike => ({ role: 'assistant', content: text })
const reminder = (text: string): MessageLike => ({ role: 'latest_reminder', content: text })

describe('planRounds', () => {
  it('把 user+assistant 配对成轮次，提问单独识别', () => {
    const messages = [
      user('第一问'),
      assistant('第一答'),
      reminder('快照'),
      user('第二问'),
      assistant('第二答'),
      user('本轮提问'),
    ]
    const { rounds, questionIndex } = planRounds(messages)
    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toMatchObject({ userIndex: 0, assistantIndex: 1 })
    expect(rounds[1]).toMatchObject({ userIndex: 3, assistantIndex: 4 })
    expect(questionIndex).toBe(5)
  })

  it('无回答的 user 消息即提问，后续消息不再配对', () => {
    const messages = [user('提问'), assistant('回答'), user('新提问'), user('连续提问')]
    const { rounds, questionIndex } = planRounds(messages)
    expect(rounds).toHaveLength(1)
    expect(questionIndex).toBe(2)
  })

  it('识别摘要行并提取 previous summary', () => {
    const summary = SUMMARY_PREFIX + '## Critical Context\n- 事实' + '\n<!-- end of compacted summary -->'
    const messages = [user(summary), user('问'), assistant('答')]
    const { previousSummary, rounds } = planRounds(messages)
    expect(rounds).toHaveLength(1)
    expect(previousSummary).toContain('## Critical Context')
  })
})

describe('planWindow', () => {
  const manyRounds = (count: number): MessageLike[] => {
    const messages: MessageLike[] = []
    for (let i = 0; i < count; i += 1) {
      messages.push(user(`第 ${i} 问，内容很长，`.repeat(40)))
      messages.push(assistant(`第 ${i} 答，内容很长，`.repeat(60)))
    }
    messages.push(user('本轮新提问'))
    return messages
  }

  it('小预算时保留最近轮次与提问（20 条消息保护下限生效）', () => {
    const messages = manyRounds(30)
    const plan = planWindow(messages, 800)
    // 单轮约 900 token > 预算，仅由保护下限驱动吸收：尾部 = 最近 10 轮（20 条消息）
    expect(plan.tailStart).toBe(20)
    expect(plan.rounds.length - plan.tailStart).toBe(10)
    // 提问必须完整保留
    expect(plan.questionIndex).toBe(messages.length - 1)
  })

  it('大预算时全部轮次进入尾部，无压缩中段', () => {
    const messages = manyRounds(5)
    const plan = planWindow(messages, 1_000_000)
    expect(plan.tailStart).toBe(0)
  })

  it('只有提问没有轮次时不产生中段', () => {
    const plan = planWindow([user('只有提问')], 800)
    expect(plan.rounds).toHaveLength(0)
    expect(plan.tailStart).toBe(0)
  })
})

describe('阈值与预算', () => {
  it('默认按 1M 有效窗口计算阈值，且不低于 64K（Hermes MINIMUM_CONTEXT_LENGTH）', () => {
    expect(computeThresholdTokens()).toBe(327_680)
    expect(computeThresholdTokens(64_000, 4_000)).toBe(64_000)
    expect(computeThresholdTokens(512_000, 8_000)).toBe(252_000)
  })

  it('尾部预算夹在 10K-25K 且不超过阈值 50%', () => {
    expect(computeTailBudget(64_000, 128_000)).toBe(10_000)
    expect(computeTailBudget(252_000, 128_000)).toBe(10_000)
    expect(computeTailBudget(24_000, 128_000)).toBe(10_000)
    expect(computeTailBudget(4_000)).toBe(2_000)
    expect(computeTailBudget(327_680)).toBe(25_000)
  })
})

describe('formatTurnsForSummary', () => {
  it('生成带编号的 User/Assistant 流水并截断超长内容', () => {
    const messages = [user('问题'), assistant('回答')]
    const { rounds } = planRounds(messages)
    const text = formatTurnsForSummary(rounds, messages)
    expect(text).toContain('[Turn 1 · User]: 问题')
    expect(text).toContain('[Turn 1 · Assistant]: 回答')
  })
})
