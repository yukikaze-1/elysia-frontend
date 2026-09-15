import { describe, expect, it } from 'vitest'
import { FrameMapper } from '../../src/main/transport/protocol-v2/frame-mapper'
import { ProtocolWarningCode } from '@shared/contracts/protocol'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type {
  GenerationCompletedEvent, GenerationDeltaEvent, GenerationFailedEvent,
  GenerationStartedEvent, SegmentCompletedEvent,
  VoiceTranscriptEvent, VoiceSessionStartedEvent, VoiceSessionPartialEvent,
  VoiceSessionTurnEvent, VoiceSessionAckEvent, VoiceSessionEndedEvent,
  DictationPartialEvent, DictationFinalEvent, DictationCancelledEvent,
  AudioSessionStartedEvent, AudioSessionReadyEvent, AudioSessionCancelledEvent, VoiceErrorEvent,
  ToolRequestEvent, ToolStartedEvent, ToolCompletedEvent
} from '@shared/contracts/events'
import type { RawFrame } from '../../src/main/transport/protocol-v2/raw-types'

function collectWarnings(): { warnings: { code: string; message: string }[]; onWarning: (w: { code: string; message: string }) => void } {
  const warnings: { code: string; message: string }[] = []
  return { warnings, onWarning: (w) => warnings.push(w) }
}

describe('FrameMapper raw → 领域', () => {
  it('generation.started 映射 responseId=generationId,保留 conversationId/model', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1', conversationId: 'conv-1', model: 'm1' }) as GenerationStartedEvent
    expect(ev).not.toBeNull()
    expect(ev.event).toBe('generation.started')
    expect(ev.responseId).toBe('gen-1')
    expect(ev.messageId).toBe('msg-1')
    expect(ev.conversationId).toBe('conv-1')
    expect(ev.model).toBe('m1')
  })

  it('generation.started 无法补齐 conversationId 抛 PROTOCOL_MISMATCH', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    expect(() => mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })).toThrow(CyreneError)
    try {
      mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    } catch (e) {
      expect((e as CyreneError).code).toBe(CyreneErrorCode.PROTOCOL_MISMATCH)
    }
  })

  it('setActiveConversationId 后缺 conversationId 的帧被补齐', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    mapper.setActiveConversationId('conv-9')
    const ev = mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' }) as GenerationStartedEvent
    expect(ev.conversationId).toBe('conv-9')
  })

  it('segment.started 建立 meta,delta 用缓存 channel/kind 补全', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' })
    const delta = mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, deltaSequence: 0, delta: '第一句' }) as GenerationDeltaEvent
    expect(delta.event).toBe('generation.delta')
    expect(delta.channel).toBe('inner_voice')
    expect(delta.kind).toBe('text')
    expect(delta.text).toBe('第一句')
  })

  it('delta 无 segment meta 抛 PROTOCOL_MISMATCH(不默认 public_reply/text)', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    expect(() => mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-x', segmentIndex: 0, deltaSequence: 0, delta: 'x' })).toThrow(CyreneError)
  })

  // —— C8（2026-09-15 契约评审）：元数据键含代 + 终态回收 ——
  it('C8：segment meta 按代键控——另一代的同 id 段不会被静默错归因（抛 PROTOCOL_MISMATCH 而非按上一代 channel 归位）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' })
    // 新一代复用同一个 segmentId，但**没有**再发 segment.started
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-2', messageId: 'msg-2' })
    expect(() => mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-2', segmentId: 'seg-1', segmentIndex: 0, deltaSequence: 0, delta: 'x' }))
      .toThrow(CyreneError)
  })

  it('C8：终态（completed/failed）回收该代全部 segment meta——终态后的迟到 delta 不再被归位', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'public_reply', kind: 'text' })
    mapper.mapFrame({ type: 'generation.completed', generationId: 'gen-1', messageId: 'msg-1', model: 'm', channel: 'public_reply', finishReason: 'stop', usage: { rounds: [{ model: 'm', input_tokens: 1, output_tokens: 1, total_tokens: 2, round_num: 1 }], turn_total: 2 } })
    expect(() => mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, deltaSequence: 1, delta: 'late' }))
      .toThrow(CyreneError)
  })

  // —— C7（2026-09-15 契约评审）：整段缺失检测 ——
  it('C7：分段索引不连续 ⇒ 终态标 segmentGap + MAPPER_SEGMENT_GAP 告警', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-0', segmentIndex: 0, channel: 'public_reply', kind: 'text' })
    // 索引 1 从未到达（整段丢失），直接来 2
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-2', segmentIndex: 2, channel: 'inner_voice', kind: 'text' })
    const done = mapper.mapFrame({ type: 'generation.completed', generationId: 'gen-1', messageId: 'msg-1', model: 'm', channel: 'public_reply', finishReason: 'stop', usage: { rounds: [{ model: 'm', input_tokens: 1, output_tokens: 1, total_tokens: 2, round_num: 1 }], turn_total: 2 } }) as GenerationCompletedEvent
    expect(done.segmentGap).toBe(true)
    expect(warnings.some((w) => w.code === ProtocolWarningCode.MAPPER_SEGMENT_GAP)).toBe(true)
  })

  it('C7：索引连续 ⇒ 不标 segmentGap（避免对完整回复误报"不完整"）', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-0', segmentIndex: 0, channel: 'public_reply', kind: 'text' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 1, channel: 'inner_voice', kind: 'text' })
    const done = mapper.mapFrame({ type: 'generation.completed', generationId: 'gen-1', messageId: 'msg-1', model: 'm', channel: 'public_reply', finishReason: 'stop', usage: { rounds: [{ model: 'm', input_tokens: 1, output_tokens: 1, total_tokens: 2, round_num: 1 }], turn_total: 2 } }) as GenerationCompletedEvent
    expect(done.segmentGap).toBeUndefined()
    expect(warnings.some((w) => w.code === ProtocolWarningCode.MAPPER_SEGMENT_GAP)).toBe(false)
  })

  it('C7：status 段计入索引空间——只有 status 段缺失不会被误判（它不进事件流，但在 mapper 视野内）', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 1, channel: 'public_reply', kind: 'text' })
    const done = mapper.mapFrame({ type: 'generation.completed', generationId: 'gen-1', messageId: 'msg-1', model: 'm', channel: 'public_reply', finishReason: 'stop', usage: { rounds: [{ model: 'm', input_tokens: 1, output_tokens: 1, total_tokens: 2, round_num: 1 }], turn_total: 2 } }) as GenerationCompletedEvent
    expect(done.segmentGap).toBeUndefined()
    expect(warnings).toHaveLength(0)
  })

  it('segmentIndex 与缓存不一致告警且以 meta 为准', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'public_reply', kind: 'text' })
    const delta = mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 9, deltaSequence: 0, delta: 'x' }) as GenerationDeltaEvent
    expect(delta.segmentIndex).toBe(0) // meta 为准
    expect(warnings.some((w) => w.code === ProtocolWarningCode.MAPPER_SEGMENT_INDEX_MISMATCH)).toBe(true)
  })

  it('status 段三类帧均返回 null 不告警', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    const started = mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })
    const delta = mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, deltaSequence: 0, delta: 'x' })
    const completed = mapper.mapFrame({ type: 'generation.segment.completed', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })
    expect(started).toBeNull()
    expect(delta).toBeNull()
    expect(completed).toBeNull()
    expect(warnings).toHaveLength(0)
  })

  it('segment.completed 保留 kind/content,完成后清理 meta', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' })
    const ev = mapper.mapFrame({ type: 'generation.segment.completed', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text', content: '权威文本' }) as SegmentCompletedEvent
    expect(ev.content).toBe('权威文本')
    expect(ev.kind).toBe('text')
    // meta 已清理 → 同一 segment 的迟到 delta 无 meta → 抛 PROTOCOL_MISMATCH(证明已清理)
    expect(() => mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, deltaSequence: 1, delta: '迟到' })).toThrow(CyreneError)
  })

  it('segment.completed 无 content 时 kind/channel 来自 meta,content 为 undefined', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' })
    const ev = mapper.mapFrame({ type: 'generation.segment.completed', generationId: 'gen-1', segmentId: 'seg-1', segmentIndex: 0, channel: 'inner_voice', kind: 'text' }) as SegmentCompletedEvent
    expect(ev.content).toBeUndefined()
    expect(ev.channel).toBe('inner_voice')
    expect(ev.kind).toBe('text')
  })

  it('status 段 completed 后保留 meta:迟到 delta 返回 null 而非抛错', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    mapper.mapFrame({ type: 'generation.segment.started', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })
    expect(mapper.mapFrame({ type: 'generation.segment.completed', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, channel: 'status', kind: 'text' })).toBeNull()
    // status meta 保留 → 迟到 delta 走 status 过滤返回 null,不抛 PROTOCOL_MISMATCH
    expect(mapper.mapFrame({ type: 'generation.delta', generationId: 'gen-1', segmentId: 'seg-s', segmentIndex: 0, deltaSequence: 1, delta: 'x' })).toBeNull()
  })

  it('generation.completed 映射 emotion=mood/finishReason/messageId/usage/conversationUsage', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    const raw: RawFrame = {
      type: 'generation.completed',
      generationId: 'gen-1',
      messageId: 'msg-1',
      channel: 'public_reply',
      finishReason: 'stop',
      usage: { rounds: [{ model: 'm1', input_tokens: 100, output_tokens: 20, total_tokens: 120, round_num: 1 }], turn_total: 120 },
      model: 'm1',
      mood: 'happy',
      completeness: 'complete',
      conversationUsage: { total: 2100, byModel: { 'm1': 2100 } }
    }
    const ev = mapper.mapFrame(raw) as GenerationCompletedEvent
    expect(ev.event).toBe('generation.completed')
    expect(ev.responseId).toBe('gen-1')
    expect(ev.messageId).toBe('msg-1')
    expect(ev.emotion).toBe('happy')
    expect(ev.finishReason).toBe('stop')
    expect(ev.usage).toEqual({ input: 100, output: 20, total: 120, source: 'provider_reported', rounds: [{ model: 'm1', inputTokens: 100, outputTokens: 20, totalTokens: 120, roundNum: 1 }] })
    expect(ev.conversationUsage).toEqual({ total: 2100, byModel: { 'm1': 2100 }, source: 'server_aggregate' })
  })

  it('F-1：generation.completed 中文 mood（开心）原样透传为 emotion（前端归一在 state-source normalizeEmotionCode）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    const raw: RawFrame = {
      type: 'generation.completed',
      generationId: 'gen-1',
      messageId: 'msg-1',
      channel: 'public_reply',
      finishReason: 'stop',
      model: 'm1',
      mood: '开心',
      usage: { rounds: [{ model: 'm1', input_tokens: 10, output_tokens: 5, total_tokens: 15, round_num: 1 }], turn_total: 15 },
      completeness: 'complete'
    }
    const ev = mapper.mapFrame(raw) as GenerationCompletedEvent
    expect(ev.event).toBe('generation.completed')
    expect(ev.emotion).toBe('开心') // 透传不裁剪；归一由 live2d/state-source 消费
  })

  it('Σtotal_tokens !== turn_total 告警但保留服务端 turn_total', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    const raw: RawFrame = {
      type: 'generation.completed', generationId: 'gen-1', messageId: 'msg-1', channel: 'public_reply',
      finishReason: 'stop',
      usage: { rounds: [{ model: 'm1', input_tokens: 1, output_tokens: 1, total_tokens: 2, round_num: 1 }], turn_total: 100 },
      model: 'm1'
    }
    const ev = mapper.mapFrame(raw) as GenerationCompletedEvent
    expect(ev.usage!.total).toBe(100) // 服务端权威
    expect(warnings.some((w) => w.code === ProtocolWarningCode.MAPPER_TOKEN_SUM_MISMATCH)).toBe(true)
  })

  it('completeness 非 complete 告警(不静默丢弃)', () => {
    const { warnings, onWarning } = collectWarnings()
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1', onProtocolWarning: onWarning })
    const raw: RawFrame = {
      type: 'generation.completed', generationId: 'gen-1', messageId: 'msg-1', channel: 'public_reply',
      finishReason: 'stop',
      usage: { rounds: [], turn_total: 0 }, model: 'm1', completeness: 'partial'
    }
    mapper.mapFrame(raw)
    expect(warnings.some((w) => w.code === ProtocolWarningCode.MAPPER_UNEXPECTED_COMPLETENESS)).toBe(true)
  })

  it('generation.failed 平铺 → error 结构', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    const ev = mapper.mapFrame({
      type: 'generation.failed', generationId: 'gen-1', messageId: 'msg-1',
      code: 'GENERATION_TIMEOUT', message: '超时', retryable: true, details: { elapsed_ms: 30000 }
    }) as GenerationFailedEvent
    expect(ev.event).toBe('generation.failed')
    expect(ev.error).toEqual({ code: 'GENERATION_TIMEOUT', message: '超时', retryable: true, details: { elapsed_ms: 30000 } })
    expect(ev.messageId).toBe('msg-1')
  })

  it('eventId/sequence 按收帧顺序单调唯一', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1', activeConversationId: 'conv-1' })
    const a = mapper.mapFrame({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-1' })
    const b = mapper.mapFrame({ type: 'generation.failed', generationId: 'gen-1', code: 'X', message: 'm', retryable: false, details: {} })
    expect(a!.eventId).toBe('conn-1:1')
    expect(b!.eventId).toBe('conn-1:2')
    expect(a!.sequence).toBe(1)
    expect(b!.sequence).toBe(2)
  })

  it('非 generation 帧(握手/工具)返回 null', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    expect(mapper.mapFrame({ type: 'session', messages: [] })).toBeNull()
    expect(mapper.mapFrame({ type: 'server_info', protocol_version: '2.0', server_version: 'v', features: {}, services: {} })).toBeNull()
    expect(mapper.mapFrame({ type: 'expression', expression: 'idle' })).toBeNull()
  })
})

describe('FrameMapper 语音/TTS 帧 → 领域（阶段4 批次B）', () => {
  it('voice.transcript → voice.transcript 事件,保留 recordingId/text/emotion', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({ type: 'voice.transcript', recordingId: 'rec_1', text: '你好', emotion: 'happy' }) as VoiceTranscriptEvent
    expect(ev.event).toBe('voice.transcript')
    expect(ev.recordingId).toBe('rec_1')
    expect(ev.text).toBe('你好')
    expect(ev.emotion).toBe('happy')
  })
  it('voice_session.* 各帧映射正确（started/partial/turn/ack/ended）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const started = mapper.mapFrame({ type: 'voice_session.started', sessionId: 'vs_1', conversationId: 'conv-1' }) as VoiceSessionStartedEvent
    expect(started.event).toBe('voice_session.started')
    expect(started.sessionId).toBe('vs_1')
    expect(started.conversationId).toBe('conv-1')
    const partial = mapper.mapFrame({ type: 'voice_session.partial', sessionId: 'vs_1', turnId: 1, segmentIndex: 3, text: '字幕' }) as VoiceSessionPartialEvent
    expect(partial.event).toBe('voice_session.partial')
    expect(partial.turnId).toBe(1)
    expect(partial.segmentIndex).toBe(3)
    expect(partial.text).toBe('字幕')
    const turn = mapper.mapFrame({ type: 'voice_session.turn', sessionId: 'vs_1', turnId: 1, messageId: 'msg-1', conversationId: 'conv-1', text: '确认' }) as VoiceSessionTurnEvent
    expect(turn.event).toBe('voice_session.turn')
    expect(turn.messageId).toBe('msg-1')
    expect(turn.conversationId).toBe('conv-1')
    expect(turn.text).toBe('确认')
    const ack = mapper.mapFrame({ type: 'voice_session.ack', sessionId: 'vs_1', seq: 42 }) as VoiceSessionAckEvent
    expect(ack.event).toBe('voice_session.ack')
    expect(ack.seq).toBe(42)
    const ended = mapper.mapFrame({ type: 'voice_session.ended', sessionId: 'vs_1', reason: 'cancelled' }) as VoiceSessionEndedEvent
    expect(ended.event).toBe('voice_session.ended')
    expect(ended.reason).toBe('cancelled')
  })
  it('conversationId 缺省省略,voice_session.started/turn 不抛 PROTOCOL_MISMATCH（非 generation 帧无补齐逻辑）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const started = mapper.mapFrame({ type: 'voice_session.started', sessionId: 'vs_1' }) as VoiceSessionStartedEvent
    expect(started.conversationId).toBeUndefined()
    const turn = mapper.mapFrame({ type: 'voice_session.turn', sessionId: 'vs_1', turnId: 1, messageId: 'm', text: 't' }) as VoiceSessionTurnEvent
    expect(turn.conversationId).toBeUndefined()
  })
  it('dictation.* 各帧映射正确（partial/final/cancelled）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const partial = mapper.mapFrame({ type: 'dictation.partial', text: '累积' }) as DictationPartialEvent
    expect(partial.event).toBe('dictation.partial')
    expect(partial.text).toBe('累积')
    const final = mapper.mapFrame({ type: 'dictation.final', clientRequestId: 'req_1', text: '最终' }) as DictationFinalEvent
    expect(final.event).toBe('dictation.final')
    expect(final.clientRequestId).toBe('req_1')
    expect(final.text).toBe('最终')
    const cancelled = mapper.mapFrame({ type: 'dictation.cancelled', clientRequestId: 'req_1' }) as DictationCancelledEvent
    expect(cancelled.event).toBe('dictation.cancelled')
    expect(cancelled.clientRequestId).toBe('req_1')
  })
  it('audio_start → audio.session.started（streamId=stream_id,format 透传）;audio_cancelled → audio.session.cancelled', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const started = mapper.mapFrame({ type: 'audio_start', stream_id: 7, format: 'wav', sampleRate: 16000, durationMs: 1200 }) as AudioSessionStartedEvent
    expect(started.event).toBe('audio.session.started')
    expect(started.streamId).toBe(7)
    expect(started.format).toBe('wav')
    const cancelled = mapper.mapFrame({ type: 'audio_cancelled', stream_id: 7 }) as AudioSessionCancelledEvent
    expect(cancelled.event).toBe('audio.session.cancelled')
    expect(cancelled.streamId).toBe(7)
  })
  it('audio / audio_end 返回 null（transport 消费，不进 mapper）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    expect(mapper.mapFrame({ type: 'audio', stream_id: 7, seq: 0, data: 'x', is_final: false })).toBeNull()
    expect(mapper.mapFrame({ type: 'audio_end', stream_id: 7 })).toBeNull()
  })
  it('stampEvent 与 mapFrame 交错 sequence 严格递增（共享单调计数器不碰撞）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const a = mapper.mapFrame({ type: 'voice.transcript', recordingId: 'rec_1', text: 't' }) as VoiceTranscriptEvent
    const b = mapper.stampEvent<VoiceErrorEvent>({ event: 'voice.error', code: 'STT_UNAVAILABLE', message: 'STT 未启用' })
    const c = mapper.mapFrame({ type: 'dictation.partial', text: 'p' }) as DictationPartialEvent
    const d = mapper.stampEvent<AudioSessionReadyEvent>({ event: 'audio.session.ready', streamId: 9, url: 'cyrene://renderer/__cyrene-media/tts-live/1', format: 'wav' })
    expect(a.sequence).toBe(1)
    expect(b.sequence).toBe(2)
    expect(c.sequence).toBe(3)
    expect(d.sequence).toBe(4)
    expect([a.sequence, b.sequence, c.sequence, d.sequence]).toEqual([1, 2, 3, 4])
    expect(a.eventId).toBe('conn-1:1')
    expect(b.eventId).toBe('conn-1:2')
    expect(c.eventId).toBe('conn-1:3')
    expect(d.eventId).toBe('conn-1:4')
  })
  it('stampEvent 打全事件:eventId/sequence 由同一计数器,partial 字段原样保留', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ready = mapper.stampEvent<AudioSessionReadyEvent>({ event: 'audio.session.ready', streamId: 1, url: 'u', durationMs: 100, format: 'mp3' })
    expect(ready).toEqual({ eventId: 'conn-1:1', sequence: 1, event: 'audio.session.ready', streamId: 1, url: 'u', durationMs: 100, format: 'mp3' })
  })
})

describe('FrameMapper live2d.directive → 领域（阶段5 批次C）', () => {
  it('FrameMapper.mapFrame 把 raw 帧映射为 Live2DDirectiveEvent', () => {
    const m = new FrameMapper()
    const ev = m.mapFrame({ type: 'live2d.directive', motion: 'motions/idle.motion3.json', durationMs: 8000 })
    expect(ev).not.toBeNull()
    if (ev) { expect(ev.event).toBe('live2d.directive'); if (ev.event === 'live2d.directive') expect(ev.motion).toBe('motions/idle.motion3.json') }
  })
  it('扁平字段透传：state/expression/priority/durationMs 原样映射,envelope 单调打戳', () => {
    const m = new FrameMapper({ connectionId: 'conn-1' })
    const ev = m.mapFrame({ type: 'live2d.directive', state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1, durationMs: 3000 })
    expect(ev).not.toBeNull()
    if (ev && ev.event === 'live2d.directive') {
      expect(ev.state).toBe('happy')
      expect(ev.expression).toBe('expressions/F01.exp3.json')
      expect(ev.priority).toBe(1)
      expect(ev.durationMs).toBe(3000)
      expect(ev.eventId).toBe('conn-1:1')
      expect(ev.sequence).toBe(1)
    }
  })
  it('缺省字段不写键（undefined 不落事件）；空帧只带 event 判别', () => {
    const m = new FrameMapper({ connectionId: 'conn-1' })
    const ev = m.mapFrame({ type: 'live2d.directive' })
    expect(ev).not.toBeNull()
    if (ev && ev.event === 'live2d.directive') {
      expect(ev.motion).toBeUndefined()
      expect(ev.state).toBeUndefined()
      expect(ev.priority).toBeUndefined()
      expect(ev.durationMs).toBeUndefined()
    }
  })
  it('mapDirective 与既有帧共享单调计数器,sequence 全局递增不碰撞', () => {
    const m = new FrameMapper({ connectionId: 'conn-1' })
    const a = m.mapFrame({ type: 'voice.transcript', recordingId: 'rec_1', text: 't' })
    const b = m.mapFrame({ type: 'live2d.directive', state: 'thinking' })
    expect(a!.sequence).toBe(1)
    expect(b!.sequence).toBe(2)
    expect(a!.eventId).toBe('conn-1:1')
    expect(b!.eventId).toBe('conn-1:2')
  })
})

describe('阶段 6 批次 A 工具帧映射（Task 4）', () => {
  it('tool.started → ToolStartedEvent（直映）', () => {
    const ev = new FrameMapper({ connectionId: 'conn-1' }).mapFrame({ type: 'tool.started', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', inputSummary: 'q=<redacted>', generationId: 'gen-1' }) as ToolStartedEvent
    expect(ev.event).toBe('tool.started')
    expect(ev.callId).toBe('tc_1')
    expect(ev.inputSummary).toBe('q=<redacted>')
    expect(ev.generationId).toBe('gen-1')
  })
  it('tool.completed success/失败 → ToolCompletedEvent（error record 提取 code/message）', () => {
    const ok = new FrameMapper({ connectionId: 'c' }).mapFrame({ type: 'tool.completed', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', success: true, outputSummary: '2026-08-20', durationMs: 12.5 }) as ToolCompletedEvent
    expect(ok.success).toBe(true)
    expect(ok.outputSummary).toBe('2026-08-20')
    const fail = new FrameMapper({ connectionId: 'c' }).mapFrame({ type: 'tool.completed', callId: 'tc_1', toolName: 'web_search', runtime: 'backend', success: false, error: { code: 'NETWORK', message: '超时', extra: 1 } }) as ToolCompletedEvent
    expect(fail.success).toBe(false)
    expect(fail.error).toEqual({ code: 'NETWORK', message: '超时' }) // 未知键不透传
  })
  it('tool.request → ToolRequestEvent 脱敏 emit（arguments/paramHash 不在事件内；toolVersion/expiresAt 必填直映）', () => {
    const ev = new FrameMapper({ connectionId: 'c' }).mapFrame({ type: 'tool.request', callId: 'call_1', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', sourceCallId: 'tc_1', arguments: { path: '/etc/passwd', resource_handle: 'h' }, reason: '读取文件', riskLevel: 'medium', permissionRequired: true, approvalAuthority: 'client', paramHash: 'h', expiresAt: '2026-08-20T12:00:00Z', requestId: 'req_1' }) as ToolRequestEvent
    expect(ev.event).toBe('tool.request')
    expect(ev.sourceCallId).toBe('tc_1')
    expect(ev.toolVersion).toBe('1.0')
    expect(ev.expiresAt).toBe('2026-08-20T12:00:00Z')
    expect(ev.inputSummary).toBe('path=<redacted>, resource_handle=<str:1>')
    expect('arguments' in ev).toBe(false)
    expect('paramHash' in ev).toBe(false)
    // D4-1（2026-09-15）：风险元数据**改为直映**（此前 `'riskLevel' in ev === false`）。
    // 语义变更的理由：`ToolRequestEvent` 是 **Main 内部领域事件**（real-backend 的 tool.request case 消费后
    // 交给 tool-service 重算/审计），不是 `tool:event` 通道——下发 Renderer 的是 `PublicToolEvent`（D6-07），
    // 那条通道仍然无 arguments/paramHash/expiresAt，且只带重算后的三档枚举。
    expect(ev.riskLevel).toBe('medium')
    expect(ev.permissionRequired).toBe(true)
    expect(ev.approvalAuthority).toBe('client')
  })
  it('action → null 且不告警（onProtocolWarning 未被调用）', () => {
    const warnings: string[] = []
    const mapper = new FrameMapper({ connectionId: 'c', onProtocolWarning: (w) => warnings.push(w.code) })
    expect(mapper.mapFrame({ type: 'action', action: 'tool_executing', params: { tool: 'save_memory' } })).toBeNull()
    expect(warnings).toHaveLength(0)
  })
})
