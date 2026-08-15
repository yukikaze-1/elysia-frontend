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

describe('语音/设置 BackendEvent schema 镜像（阶段4批次B）', () => {
  /** 13 个新事件各一个合法样例（eventId+sequence 必填） */
  const validSamples: Record<string, Record<string, unknown>> = {
    'voice.transcript': { event: 'voice.transcript', recordingId: 'rec_1', text: '转写文本', emotion: 'calm' },
    'voice_session.started': { event: 'voice_session.started', sessionId: 'vs_1', conversationId: 'conv-1' },
    'voice_session.partial': { event: 'voice_session.partial', sessionId: 'vs_1', turnId: 1, segmentIndex: 0, text: '字幕' },
    'voice_session.turn': { event: 'voice_session.turn', sessionId: 'vs_1', turnId: 1, messageId: 'msg-1', conversationId: 'conv-1', text: '轮次' },
    'voice_session.ack': { event: 'voice_session.ack', sessionId: 'vs_1', seq: 42 },
    'voice_session.ended': { event: 'voice_session.ended', sessionId: 'vs_1', reason: 'stopped' },
    'dictation.partial': { event: 'dictation.partial', text: '累积字幕' },
    'dictation.final': { event: 'dictation.final', clientRequestId: 'req_1', text: '终态文本' },
    'dictation.cancelled': { event: 'dictation.cancelled', clientRequestId: 'req_1' },
    'audio.session.started': { event: 'audio.session.started', streamId: 1, format: 'wav' },
    'audio.session.ready': { event: 'audio.session.ready', streamId: 1, url: 'cyrene://renderer/__cyrene-media/tts-live/x', durationMs: 3000, format: 'mp3' },
    'audio.session.cancelled': { event: 'audio.session.cancelled', streamId: 1 },
    'voice.error': { event: 'voice.error', code: 'STT_UNAVAILABLE', message: '语音服务不可用' }
  }
  let i = 100
  const envelope = () => ({ eventId: `e${i++}`, sequence: i })

  it('13 个新事件各一个合法样例 parse 通过', () => {
    for (const [name, body] of Object.entries(validSamples)) {
      const ok = { ...envelope(), ...body }
      expect(parseBackendEvent(ok).success, `事件 ${name} 应通过`).toBe(true)
    }
  })

  it('缺 eventId 与缺 sequence 均拒绝（两者必填）', () => {
    for (const [name, body] of Object.entries(validSamples)) {
      const withoutEventId = { ...envelope(), ...body }
      delete (withoutEventId as Record<string, unknown>).eventId
      expect(parseBackendEvent(withoutEventId).success, `事件 ${name} 缺 eventId 应拒绝`).toBe(false)
      const withoutSequence = { ...envelope(), ...body }
      delete (withoutSequence as Record<string, unknown>).sequence
      expect(parseBackendEvent(withoutSequence).success, `事件 ${name} 缺 sequence 应拒绝`).toBe(false)
    }
  })

  it('voice_session.ended 非法 reason 被拒绝', () => {
    const bad = { ...envelope(), event: 'voice_session.ended', sessionId: 'vs_1', reason: 'paused' }
    expect(parseBackendEvent(bad).success).toBe(false)
    for (const reason of ['stopped', 'cancelled', 'timeout', 'stt_disabled']) {
      expect(parseBackendEvent({ ...envelope(), event: 'voice_session.ended', sessionId: 'vs_1', reason }).success).toBe(true)
    }
  })

  it('dictation.final / dictation.cancelled 缺 clientRequestId 被拒绝', () => {
    const final = { ...envelope(), event: 'dictation.final', text: 'x' }
    expect(parseBackendEvent(final).success).toBe(false)
    const cancelled = { ...envelope(), event: 'dictation.cancelled' }
    expect(parseBackendEvent(cancelled).success).toBe(false)
  })

  it('audio.session.ready 缺 url / 非法 format 被拒绝,format 可缺省', () => {
    const noUrl = { ...envelope(), event: 'audio.session.ready', streamId: 1 }
    expect(parseBackendEvent(noUrl).success).toBe(false)
    const badFormat = { ...envelope(), event: 'audio.session.ready', streamId: 1, url: 'u', format: 'ogg' }
    expect(parseBackendEvent(badFormat).success).toBe(false)
    const noFormat = { ...envelope(), event: 'audio.session.ready', streamId: 1, url: 'u', durationMs: 100 }
    expect(parseBackendEvent(noFormat).success).toBe(true)
  })

  it('voice.error 缺 code / 空 code 被拒绝', () => {
    const noCode = { ...envelope(), event: 'voice.error', message: 'x' }
    expect(parseBackendEvent(noCode).success).toBe(false)
    const emptyCode = { ...envelope(), event: 'voice.error', code: '' }
    expect(parseBackendEvent(emptyCode).success).toBe(false)
  })
})
