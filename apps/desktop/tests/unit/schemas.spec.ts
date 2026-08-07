import { describe, expect, it } from 'vitest'
import { parseBackendEvent } from '@shared/schemas'

const validStarted = {
  eventId: 'e1',
  sequence: 1,
  event: 'generation.started',
  generationId: 'gen-1',
  messageId: 'msg-1',
  responseId: 'rsp-1',
  conversationId: 'conv-1'
}

const validDelta = {
  eventId: 'e2',
  sequence: 2,
  event: 'generation.delta',
  generationId: 'gen-1',
  segmentId: 'seg-1',
  segmentIndex: 0,
  channel: 'inner_voice',
  kind: 'text',
  deltaSequence: 0,
  text: '片段'
}

describe('事件 Schema 校验', () => {
  it('合法事件通过校验', () => {
    expect(parseBackendEvent(validStarted).success).toBe(true)
    expect(parseBackendEvent(validDelta).success).toBe(true)
  })

  it('未知事件类型被拒绝', () => {
    const bad = { ...validStarted, event: 'generation.unknown' }
    expect(parseBackendEvent(bad).success).toBe(false)
  })

  it('缺失必填字段被拒绝', () => {
    const bad = { ...validStarted }
    delete (bad as Record<string, unknown>).eventId
    expect(parseBackendEvent(bad).success).toBe(false)
  })

  it('非法 channel 枚举被拒绝', () => {
    const bad = { ...validDelta, channel: 'side_channel' }
    expect(parseBackendEvent(bad).success).toBe(false)
  })

  it('负数 deltaSequence 被拒绝', () => {
    const bad = { ...validDelta, deltaSequence: -1 }
    expect(parseBackendEvent(bad).success).toBe(false)
  })

  it('未知可选字段被兼容(不报错)', () => {
    const bad = { ...validStarted, traceId: 'x', extra: { a: 1 } }
    expect(parseBackendEvent(bad).success).toBe(true)
  })

  it('父完成事件带 usage/model/emotion 通过校验', () => {
    const ok = {
      eventId: 'e3',
      sequence: 3,
      event: 'generation.completed',
      generationId: 'gen-1',
      responseId: 'rsp-1',
      usage: { input: 1, output: 2, total: 3, source: 'provider_reported' },
      model: 'm1',
      emotion: 'calm'
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })
})
