// tests/unit/chat-history-query.spec.ts
// Task 15:buildQuery 纯函数（spec §4.4，D15）——UI 状态 → ChatHistoryQuery 映射。
// env=node：Intl 取本机时区，测试断言结构不依赖具体时区值。
import { describe, expect, it } from 'vitest'
import { buildQuery } from '../../src/renderer/src/stores/historyViewer.store'

describe('buildQuery（UI 状态 → ChatHistoryQuery）', () => {
  it('scope=conversation 传 conversationId；scope=all 不传', () => {
    const q1 = buildQuery({ keyword: '', localDate: '', scope: 'conversation', category: 'all', conversationId: 'c1' })
    expect(q1.scope).toEqual({ type: 'conversation', conversationId: 'c1' })
    const q2 = buildQuery({ keyword: '', localDate: '', scope: 'all', category: 'all' })
    expect(q2.scope).toEqual({ type: 'all_conversations' })
  })
  it('关键词空串不传 query（空白 trim）', () => {
    const q = buildQuery({ keyword: '   ', localDate: '', scope: 'all', category: 'sticker' })
    expect(q.query).toBeUndefined()
  })
  it('关键词非空 → query；localDate → 传 localDate 并必带 timeZone', () => {
    const q = buildQuery({ keyword: '你好', localDate: '2026-08-14', scope: 'all', category: 'all' })
    expect(q.query).toBe('你好')
    expect(q.localDate).toBe('2026-08-14')
    expect(q.timeZone).toBeTruthy()
  })
  it('无日期无关键词：不传 localDate，timeZone 仍必带', () => {
    const q = buildQuery({ keyword: '', localDate: '', scope: 'all', category: 'all' })
    expect(q.localDate).toBeUndefined()
    expect(q.timeZone).toBeTruthy()
  })
  it('limit 默认 50；cursor 透传', () => {
    const q = buildQuery({ keyword: '', localDate: '', scope: 'all', category: 'all', cursor: 'abc' })
    expect(q.limit).toBe(50)
    expect(q.cursor).toBe('abc')
  })
})
