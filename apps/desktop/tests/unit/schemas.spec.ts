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

describe('扩展后的事件 Schema', () => {
  it('segment.started 合法事件通过', () => {
    const ok = {
      eventId: 'e9',
      sequence: 9,
      event: 'generation.segment.started',
      generationId: 'gen-1',
      segmentId: 'seg-1',
      segmentIndex: 0,
      channel: 'inner_voice',
      kind: 'text'
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })

  it('segment.completed 必填 kind,可选 content', () => {
    const withContent = {
      eventId: 'e10', sequence: 10, event: 'generation.segment.completed',
      generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0,
      channel: 'inner_voice', kind: 'text', content: '权威文本'
    }
    expect(parseBackendEvent(withContent).success).toBe(true)
    const noContent = { ...withContent }
    delete (noContent as Record<string, unknown>).content
    expect(parseBackendEvent(noContent).success).toBe(true)
    const noKind = { ...withContent }
    delete (noKind as Record<string, unknown>).kind
    expect(parseBackendEvent(noKind).success).toBe(false)
  })

  it('segment.completed 的 content 空串合法', () => {
    const ok = {
      eventId: 'e11', sequence: 11, event: 'generation.segment.completed',
      generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0,
      channel: 'public_reply', kind: 'markdown', content: ''
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })

  it('completed 事件带新 conversationUsage 形状通过', () => {
    const ok = {
      eventId: 'e12', sequence: 12, event: 'generation.completed',
      generationId: 'gen-1', responseId: 'rsp-1',
      conversationUsage: { total: 2100, byModel: { 'm1': 2100 }, source: 'server_aggregate' }
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })

  it('completed 事件拒绝旧虚构 conversationUsage 形状', () => {
    const bad = {
      eventId: 'e13', sequence: 13, event: 'generation.completed',
      generationId: 'gen-1', responseId: 'rsp-1',
      conversationUsage: { input: 1200, output: 900, total: 2100 }
    }
    expect(parseBackendEvent(bad).success).toBe(false)
  })

  it('failed 事件 error 带 retryable/details 通过', () => {
    const ok = {
      eventId: 'e14', sequence: 14, event: 'generation.failed',
      generationId: 'gen-1', messageId: 'msg-1',
      error: { code: 'GENERATION_TIMEOUT', message: '超时', retryable: true, details: { elapsed_ms: 30000 } }
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })

  it('completed 事件 usage.rounds 形状通过,非法 round 被拒', () => {
    const ok = {
      eventId: 'e16', sequence: 16, event: 'generation.completed',
      generationId: 'gen-1', responseId: 'rsp-1',
      usage: { input: 100, output: 20, total: 120, source: 'provider_reported', rounds: [{ model: 'm1', inputTokens: 100, outputTokens: 20, totalTokens: 120, roundNum: 0 }] }
    }
    expect(parseBackendEvent(ok).success).toBe(true) // roundNum 0 合法(后端 int 无下限)
    const bad = {
      ...ok,
      usage: { input: 100, output: 20, total: 120, source: 'provider_reported', rounds: [{ model: 'm1', inputTokens: 100, outputTokens: 20, totalTokens: -1, roundNum: 0 }] }
    }
    expect(parseBackendEvent(bad).success).toBe(false)
  })

  it('completed 事件 messageId/finishReason 可选', () => {
    const ok = {
      eventId: 'e15', sequence: 15, event: 'generation.completed',
      generationId: 'gen-1', responseId: 'rsp-1',
      messageId: 'msg-1', finishReason: 'stop'
    }
    expect(parseBackendEvent(ok).success).toBe(true)
  })
})
