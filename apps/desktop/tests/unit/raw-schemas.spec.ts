import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseRawFrame, parseRawClientFrame, RawFrameSchema, RAW_FRAME_TYPES, rawSchemasFingerprint, rawSchemasFingerprintFor } from '../../src/main/transport/protocol-v2/raw-schemas'

const validCompleted = {
  type: 'generation.completed',
  generationId: 'gen-1',
  messageId: 'msg-1',
  channel: 'public_reply',
  finishReason: 'stop',
  usage: { rounds: [{ model: 'm1', input_tokens: 100, output_tokens: 20, total_tokens: 120, round_num: 1 }], turn_total: 120 },
  model: 'm1',
  mood: 'happy',
  completeness: 'complete'
}

describe('raw wire schema', () => {
  it('handshake 三帧合法构造通过', () => {
    expect(parseRawFrame({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }).success).toBe(true)
    expect(parseRawFrame({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {} }).success).toBe(true)
    expect(parseRawFrame({ type: 'expression', expression: 'idle', intensity: 0.5 }).success).toBe(true)
  })

  it('session 帧带 messages 条目(全字段)通过', () => {
    const session = {
      type: 'session',
      conversationId: 'conv-1',
      messages: [{
        role: 'user', message_id: 'msg-1', timestamp: '2026-08-10T00:00:00.000Z',
        parts: [{ content: 'hi' }], content: 'hi', mood: 'calm',
        inner_voice: '…', tool_calls: [], tool_call_id: 'tc-1', name: 'tool',
        success: true, error: '', error_type: '', duration_ms: 10, truncated: false,
        token_usage: { rounds: [], turn_total: 0 }
      }],
      token_stats: { total: 0, byModel: {} }
    }
    expect(parseRawFrame(session).success).toBe(true)
  })

  it('generation 各帧合法构造通过', () => {
    expect(parseRawFrame({ type: 'generation.started', generationId: 'g', messageId: 'm', conversationId: 'c', requestId: 'r', model: 'm1' }).success).toBe(true)
    expect(parseRawFrame({ type: 'generation.segment.started', generationId: 'g', segmentId: 's', segmentIndex: 0, channel: 'inner_voice', kind: 'text' }).success).toBe(true)
    expect(parseRawFrame({ type: 'generation.delta', generationId: 'g', segmentId: 's', segmentIndex: 0, deltaSequence: 0, delta: 'x' }).success).toBe(true)
    expect(parseRawFrame({ type: 'generation.segment.completed', generationId: 'g', segmentId: 's', segmentIndex: 0, channel: 'inner_voice', kind: 'text', content: '完整' }).success).toBe(true)
    expect(parseRawFrame(validCompleted).success).toBe(true)
    expect(parseRawFrame({ type: 'generation.failed', generationId: 'g', messageId: 'm', code: 'GENERATION_TIMEOUT', message: '超时', retryable: true, details: {} }).success).toBe(true)
  })

  it('channel status 被接受(raw 层三值)', () => {
    expect(parseRawFrame({ type: 'generation.segment.started', generationId: 'g', segmentId: 's', segmentIndex: 0, channel: 'status', kind: 'text' }).success).toBe(true)
  })

  it('未知 type 被拒绝', () => {
    expect(parseRawFrame({ type: 'generation.unknown', generationId: 'g' }).success).toBe(false)
  })

  it('strict:未知键被拒绝', () => {
    expect(parseRawFrame({ ...validCompleted, bogus: 1 }).success).toBe(false)
  })

  it('strict:缺 channel 的完成帧被拒绝(后端恒发)', () => {
    const noChannel = { ...validCompleted }
    delete (noChannel as Record<string, unknown>).channel
    expect(parseRawFrame(noChannel).success).toBe(false)
  })

  it('completeness 缺失/非 complete 字符串均通过(raw 层不拒,由 mapper 告警)', () => {
    const noCompleteness = { ...validCompleted }
    delete (noCompleteness as Record<string, unknown>).completeness
    expect(parseRawFrame(noCompleteness).success).toBe(true)
    expect(parseRawFrame({ ...validCompleted, completeness: 'partial' }).success).toBe(true)
  })

  it('finishReason 非法值被拒绝', () => {
    expect(parseRawFrame({ ...validCompleted, finishReason: 'error' }).success).toBe(false)
  })

  it('缺必填字段被拒绝(usage/model/finishReason/retryable)', () => {
    const noUsage = { ...validCompleted }
    delete (noUsage as Record<string, unknown>).usage
    expect(parseRawFrame(noUsage).success).toBe(false)
    const noModel = { ...validCompleted }
    delete (noModel as Record<string, unknown>).model
    expect(parseRawFrame(noModel).success).toBe(false)
    const noFinish = { ...validCompleted }
    delete (noFinish as Record<string, unknown>).finishReason
    expect(parseRawFrame(noFinish).success).toBe(false)
    const failedNoRetryable = { type: 'generation.failed', generationId: 'g', code: 'X', message: 'm', details: {} }
    expect(parseRawFrame(failedNoRetryable).success).toBe(false)
  })

  it('round_num 为 0 合法(后端 int 无下限)', () => {
    const r0 = { ...validCompleted, usage: { rounds: [{ model: 'm1', input_tokens: 0, output_tokens: 0, total_tokens: 0, round_num: 0 }], turn_total: 0 } }
    expect(parseRawFrame(r0).success).toBe(true)
  })

  it('session item 缺 message_id/timestamp → 帧校验失败（D2 契约收紧）', () => {
    expect(parseRawFrame({ type: 'session', messages: [{ role: 'tool', message_id: 'm1', timestamp: 't' }] }).success).toBe(true)
    expect(parseRawFrame({ type: 'session', messages: [{ role: 'tool', timestamp: 't' }] }).success).toBe(false) // 缺 message_id
    expect(parseRawFrame({ type: 'session', messages: [{ role: 'tool', message_id: 'm1' }] }).success).toBe(false) // 缺 timestamp
  })

  it('session 帧 tool duration_ms:null 通过（P0-02 replay wire 边界放行，映射层归一化）', () => {
    const session = {
      type: 'session', conversationId: 'conv-1',
      messages: [{ role: 'tool', message_id: 'm1', timestamp: '2026-08-11T00:00:00.000Z', duration_ms: null }],
      token_stats: { total: 0, byModel: {} }
    }
    expect(parseRawFrame(session).success).toBe(true)
  })
})

describe('raw schema ack/error 扩展(2B)', () => {
  it('user_message.ack accepted 通过', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'msg-1', clientRequestId: 'c1', receivedAt: '2026-08-11T00:00:00.000Z', status: 'accepted' })
    expect(r.success).toBe(true)
  })
  it('user_message.ack rejected 带完整 error 通过且字段不丢失', () => {
    const r = parseRawFrame({
      type: 'user_message.ack', messageId: '', clientRequestId: 'c1',
      receivedAt: '2026-08-11T00:00:00.000Z', status: 'rejected',
      error: {
        code: 'STORAGE_UNAVAILABLE', message: 'bad', retryable: true,
        retryAfterMs: 1000, details: { idempotency_durable: false }
      }
    })
    expect(r.success).toBe(true)
    if (r.success && r.data.type === 'user_message.ack' && r.data.status === 'rejected') {
      expect(r.data.error.retryAfterMs).toBe(1000)
      expect(r.data.error.details).toEqual({ idempotency_durable: false })
    }
  })
  it('error 帧的 clientRequestId/retryAfterMs/details 通过且完整保留', () => {
    const r = parseRawFrame({
      type: 'error', message: '请求过于频繁', code: 'RATE_LIMITED', requestId: 'req-1',
      clientRequestId: 'client-1', retryable: true, retryAfterMs: 1000,
      details: { scope: 'command' }
    })
    expect(r.success).toBe(true)
    if (r.success && r.data.type === 'error') {
      expect(r.data.clientRequestId).toBe('client-1')
      expect(r.data.retryAfterMs).toBe(1000)
      expect(r.data.details).toEqual({ scope: 'command' })
    }
  })
  it('ack status 非法拒绝', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'm', clientRequestId: 'c', receivedAt: 't', status: 'pending' })
    expect(r.success).toBe(false)
  })
  it('rejected + 空 messageId + QUEUE_FULL 通过 parseRawFrame', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: '', clientRequestId: 'c1', receivedAt: 't', status: 'rejected', error: { code: 'QUEUE_FULL', message: '队列已满', retryable: true } })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as { status?: string }).status).toBe('rejected')
  })
  it('rejected 缺 error 拒绝（后端判别联合要求必填）', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: '', clientRequestId: 'c1', receivedAt: 't', status: 'rejected' })
    expect(r.success).toBe(false)
  })
  it('accepted + 空 messageId 拒为非法帧', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: '', clientRequestId: 'c1', receivedAt: 't', status: 'accepted' })
    expect(r.success).toBe(false)
  })
  it('accepted 正常通过', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'm1', clientRequestId: 'c1', receivedAt: 't', status: 'accepted' })
    expect(r.success).toBe(true)
  })
  it('rejected 允许空 clientRequestId（缺字段的契约拒绝回显）', () => {
    const r = parseRawFrame({
      type: 'user_message.ack', messageId: '', clientRequestId: '', receivedAt: 't',
      status: 'rejected', error: { code: 'CONTRACT_VALIDATION', message: 'missing', retryable: false }
    })
    expect(r.success).toBe(true)
  })
  it('accepted 带 error / rejected 带非空 messageId 都拒绝', () => {
    expect(parseRawFrame({
      type: 'user_message.ack', messageId: 'm1', clientRequestId: 'c1', receivedAt: 't',
      status: 'accepted', error: { code: 'X', message: 'bad', retryable: false }
    }).success).toBe(false)
    expect(parseRawFrame({
      type: 'user_message.ack', messageId: 'm1', clientRequestId: 'c1', receivedAt: 't',
      status: 'rejected', error: { code: 'X', message: 'bad', retryable: false }
    }).success).toBe(false)
  })
})

describe('state/typing 兼容帧（FE-INT-P1-01）', () => {
  it('parseRawFrame 合法 state/typing 通过', () => {
    expect(parseRawFrame({ type: 'state', state: 'thinking' }).success).toBe(true)
    expect(parseRawFrame({ type: 'state', state: 'idle' }).success).toBe(true)
    expect(parseRawFrame({ type: 'typing', typing: true }).success).toBe(true)
    expect(parseRawFrame({ type: 'typing', typing: false }).success).toBe(true)
    expect(parseRawFrame({ type: 'state', state: '' }).success).toBe(true) // 契约允许空串,勿设 min(1)
  })
  it('畸形载荷仍失败（strict + 类型/缺失）', () => {
    expect(parseRawFrame({ type: 'state' }).success).toBe(false) // 缺 state
    expect(parseRawFrame({ type: 'typing', typing: 'yes' }).success).toBe(false) // 类型错
    expect(parseRawFrame({ type: 'state', state: 'idle', extra: 1 }).success).toBe(false) // strict 拒未知键
    expect(parseRawFrame({ type: 'unknown_frame' }).success).toBe(false) // 未知 type fail-closed
  })
})

describe('后端旧输出旁路兼容帧（阶段 6 真实联调）', () => {
  it('delta/message/token_usage 合法形状通过且保留完整字段', () => {
    const frames = [
      { type: 'delta', content: '增量', stream_id: 7 },
      { type: 'message', role: 'assistant', content: '完整消息', mood: 'neutral' },
      {
        type: 'token_usage',
        turn: { rounds: [{ model: 'm', input_tokens: 1, output_tokens: 2, total_tokens: 3, round_num: 1 }], turn_total: 3 },
        session: { total: 3, byModel: { m: 3 } }
      }
    ]
    for (const frame of frames) {
      const parsed = parseRawFrame(frame)
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data).toEqual(frame)
    }
  })

  it('兼容帧仍按字段类型与嵌套 strict fail-closed', () => {
    expect(parseRawFrame({ type: 'delta', content: 1 }).success).toBe(false)
    expect(parseRawFrame({ type: 'message', content: 'x', extra: true }).success).toBe(false)
    expect(parseRawFrame({ type: 'token_usage', turn: { extra: 1 } }).success).toBe(false)
    expect(parseRawFrame({ type: 'token_usage', session: { total: 1, byModel: {}, extra: 1 } }).success).toBe(false)
  })
})

describe('raw schemas fingerprint(2C)', () => {
  it('RAW_FRAME_TYPES 与 union 推导集合一致(I6),阶段6 实联调纳入 3 类后端旧输出兼容帧后为 36 型,多角色 FE-A 纳入角色状态/目录帧后为 38 型', () => {
    expect(RAW_FRAME_TYPES).toHaveLength(38)
    expect([...RAW_FRAME_TYPES].sort()).toEqual([
      'action', 'audio', 'audio_cancelled', 'audio_end', 'audio_start',
      'character.catalog.changed', 'character.state.changed',
      'delta', 'dictation.cancelled', 'dictation.final', 'dictation.partial',
      'error', 'expression', 'generation.completed', 'generation.delta',
      'generation.failed', 'generation.segment.completed', 'generation.segment.started',
      'generation.started', 'live2d.directive', 'message', 'server_info', 'session', 'set_tts_voice_result', 'state',
      'switch_model_result', 'token_usage', 'tool.completed', 'tool.request', 'tool.started', 'typing', 'user_message.ack',
      'voice.transcript', 'voice_session.ack', 'voice_session.ended',
      'voice_session.partial', 'voice_session.started', 'voice_session.turn'
    ])
    expect(RawFrameSchema.safeParse({
      type: 'user_message.ack', messageId: '', clientRequestId: '', receivedAt: 't',
      status: 'rejected', error: { code: 'X', message: 'x', retryable: false }
    }).success).toBe(true)
  })
  it('rawSchemasFingerprint 同 schema 恒等', () => {
    expect(rawSchemasFingerprint()).toBe(rawSchemasFingerprint())
  })
  it('枚举增减成员 → 指纹变化(敏感性,N6 样本)', () => {
    const a = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), e: z.enum(['p', 'q']) })]))
    const b = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), e: z.enum(['p', 'q', 'r']) })]))
    expect(a).not.toBe(b)
  })
  it('字段类型 string→number → 指纹变化(敏感性)', () => {
    const a = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), n: z.string() })]))
    const b = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), n: z.number() })]))
    expect(a).not.toBe(b)
  })
  it('非判别字面量值变更 → 指纹变化(_def.value,可执行性 6)', () => {
    const a = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), c: z.literal('a') })]))
    const b = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), c: z.literal('b') })]))
    expect(a).not.toBe(b)
  })
  it('加入 state/typing 成员 → 指纹变化（FE-INT-P1-01 敏感性）', () => {
    const a = rawSchemasFingerprintFor(z.discriminatedUnion('type', [z.object({ type: z.literal('x') })]))
    const b = rawSchemasFingerprintFor(z.discriminatedUnion('type', [z.object({ type: z.literal('x') }), z.object({ type: z.literal('state'), state: z.string() })]))
    expect(a).not.toBe(b)
  })
})

describe('媒体 ContentPart 过 raw schema + 指纹不变（D7，schemaHash 门禁）', () => {
  it('session 回放项 content 为媒体 ContentPart 数组可解析（schema 保持 content:unknown，无整条拒绝）', () => {
    const frame = {
      type: 'session', conversationId: 'conv-1',
      messages: [{ role: 'assistant', message_id: 'msg-1', timestamp: 't',
        content: [{ type: 'image', src: '/api/attachments/att_1', mime: 'image/png', attachment_id: 'att_1' }] }]
    }
    const r = parseRawFrame(frame)
    expect(r.success).toBe(true)
  })
  it('rawSchemasFingerprint 不含 content 嵌套结构（指纹不下探嵌套元素）', () => {
    const fp = rawSchemasFingerprint()
    // content 字段 zod 类型仍为 z.unknown().optional()，其 _def.type 不变；断言指纹为 64 位 hex 即可（相对不变性由 wire-fixtures 门禁兜）
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('阶段4 批次B 语音/TTS server 帧 raw schema', () => {
  it('13 个新 server 帧合法构造全部通过', () => {
    expect(parseRawFrame({ type: 'voice.transcript', recordingId: 'rec_1', text: '你好', emotion: 'happy' }).success).toBe(true)
    expect(parseRawFrame({ type: 'voice_session.started', sessionId: 'vs_1', conversationId: 'conv-1' }).success).toBe(true)
    expect(parseRawFrame({ type: 'voice_session.partial', sessionId: 'vs_1', turnId: 1, segmentIndex: 3, text: '字幕' }).success).toBe(true)
    expect(parseRawFrame({ type: 'voice_session.turn', sessionId: 'vs_1', turnId: 1, messageId: 'msg-1', conversationId: 'conv-1', text: '确认' }).success).toBe(true)
    expect(parseRawFrame({ type: 'voice_session.ack', sessionId: 'vs_1', seq: 42 }).success).toBe(true)
    expect(parseRawFrame({ type: 'voice_session.ended', sessionId: 'vs_1', reason: 'stopped' }).success).toBe(true)
    expect(parseRawFrame({ type: 'dictation.partial', text: '累积' }).success).toBe(true)
    expect(parseRawFrame({ type: 'dictation.final', clientRequestId: 'req_1', text: '最终' }).success).toBe(true)
    expect(parseRawFrame({ type: 'dictation.cancelled', clientRequestId: 'req_1' }).success).toBe(true)
    expect(parseRawFrame({ type: 'audio_start', stream_id: 7, format: 'wav', sampleRate: 16000, durationMs: 1200 }).success).toBe(true)
    expect(parseRawFrame({ type: 'audio', stream_id: 7, seq: 0, data: 'U29tZURhdGE=', is_final: false }).success).toBe(true)
    expect(parseRawFrame({ type: 'audio_end', stream_id: 7, format: 'mp3' }).success).toBe(true)
    expect(parseRawFrame({ type: 'audio_cancelled', stream_id: 7 }).success).toBe(true)
  })
  it('可选字段缺省省略通过（conversationId/emotion/sampleRate/durationMs/audio_end.format）', () => {
    expect(parseRawFrame({ type: 'voice.transcript', recordingId: 'rec_1', text: 't' }).success).toBe(true)
    expect(parseRawFrame({ type: 'voice_session.started', sessionId: 'vs_1' }).success).toBe(true)
    expect(parseRawFrame({ type: 'voice_session.turn', sessionId: 'vs_1', turnId: 1, messageId: 'm', text: 't' }).success).toBe(true)
    expect(parseRawFrame({ type: 'audio_start', stream_id: 1, format: 'mp3' }).success).toBe(true)
    expect(parseRawFrame({ type: 'audio_end', stream_id: 1 }).success).toBe(true)
  })
  it('voice_session.ended reason 四值合法、非法值拒绝', () => {
    for (const reason of ['stopped', 'cancelled', 'timeout', 'stt_disabled']) {
      expect(parseRawFrame({ type: 'voice_session.ended', sessionId: 'vs_1', reason }).success).toBe(true)
    }
    expect(parseRawFrame({ type: 'voice_session.ended', sessionId: 'vs_1', reason: 'paused' }).success).toBe(false)
  })
  it('audio_start.format 非法值拒绝（枚举收窄）', () => {
    expect(parseRawFrame({ type: 'audio_start', stream_id: 1, format: 'ogg' }).success).toBe(false)
  })
  it('缺必填字段拒绝（含 stream_id/seq/turnId 类型约束）', () => {
    expect(parseRawFrame({ type: 'voice.transcript', text: 't' }).success).toBe(false) // 缺 recordingId
    expect(parseRawFrame({ type: 'voice_session.ack', sessionId: 'vs_1' }).success).toBe(false) // 缺 seq
    expect(parseRawFrame({ type: 'audio_start', stream_id: 1 }).success).toBe(false) // 缺 format（非 Optional）
    expect(parseRawFrame({ type: 'audio', stream_id: '7', seq: 0, data: 'x', is_final: false }).success).toBe(false) // stream_id 类型错
    expect(parseRawFrame({ type: 'audio', stream_id: 7, seq: '0', data: 'x', is_final: false }).success).toBe(false) // seq 类型错
    expect(parseRawFrame({ type: 'dictation.final', text: 't' }).success).toBe(false) // 缺 clientRequestId
  })
  it('strict:新 server 帧未知键被拒绝', () => {
    expect(parseRawFrame({ type: 'voice.transcript', recordingId: 'rec_1', text: 't', bogus: 1 }).success).toBe(false)
    expect(parseRawFrame({ type: 'audio', stream_id: 1, seq: 0, data: 'x', is_final: false, extra: 1 }).success).toBe(false)
  })
})

describe('阶段4 批次B client 帧 raw schema（不进 RawFrameSchema）', () => {
  it('11 个 client 帧合法构造经 parseRawClientFrame 通过', () => {
    expect(parseRawClientFrame({ type: 'voice.record.start', recordingId: 'rec_1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'voice.record.stop', recordingId: 'rec_1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'voice.commit', recordingId: 'rec_1', text: '确认', clientRequestId: 'req_1', clientMessageId: 'local-1', conversationId: 'conv-1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'voice.discard', recordingId: 'rec_1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'voice_session.start', sessionId: 'vs_1', conversationId: 'conv-1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'voice_session.stop', sessionId: 'vs_1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'voice_session.cancel', sessionId: 'vs_1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'dictation.start', clientRequestId: 'req_1', sttProfileId: 'stt/m1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'dictation.stop', clientRequestId: 'req_1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'dictation.cancel', clientRequestId: 'req_1' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'audio.cancel', stream_id: 7 }).success).toBe(true)
  })
  it('client 帧不进 RawFrameSchema（parseRawFrame 拒绝）且不计数 RAW_FRAME_TYPES', () => {
    expect(parseRawFrame({ type: 'voice.record.start', recordingId: 'rec_1' }).success).toBe(false)
    expect(parseRawFrame({ type: 'voice.commit', recordingId: 'rec_1', text: 't', clientRequestId: 'r' }).success).toBe(false)
    expect(parseRawFrame({ type: 'audio.cancel', stream_id: 1 }).success).toBe(false)
    expect(RAW_FRAME_TYPES).not.toContain('voice.record.start')
    expect(RAW_FRAME_TYPES).not.toContain('voice.commit')
    expect(RAW_FRAME_TYPES).not.toContain('audio.cancel')
  })
  it('client 帧缺必填字段拒绝', () => {
    expect(parseRawClientFrame({ type: 'voice.record.stop' }).success).toBe(false)
    expect(parseRawClientFrame({ type: 'dictation.start' }).success).toBe(false)
    expect(parseRawClientFrame({ type: 'audio.cancel' }).success).toBe(false)
  })
})

describe('阶段5 批次C：live2d.directive raw schema（C3 契约冻结）', () => {
  it('合法扁平帧经 parseRawFrame 通过；非法 state / .strict() 未知字段整帧拒', () => {
    const ok = parseRawFrame({ type: 'live2d.directive', state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1 })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.type).toBe('live2d.directive')
      if (ok.data.type === 'live2d.directive') expect(ok.data.state).toBe('happy')
    }
    expect(parseRawFrame({ type: 'live2d.directive', state: 'working' as never }).success).toBe(false)
    expect(parseRawFrame({ type: 'live2d.directive', state: 'happy', unknown_field: 1 }).success).toBe(false)
    expect(parseRawFrame({ type: 'live2d.directive', priority: 5 }).success).toBe(false) // priority 越界 0-3
  })
  it('state 七值全合法；error 被剔除（D5C-07，error=3 必须 client 驱动）', () => {
    for (const state of ['idle', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'surprised']) {
      expect(parseRawFrame({ type: 'live2d.directive', state }).success).toBe(true)
    }
    expect(parseRawFrame({ type: 'live2d.directive', state: 'error' as never }).success).toBe(false)
    expect(parseRawFrame({ type: 'live2d.directive', state: 'waiting_permission' as never }).success).toBe(false)
  })
  it('durationMs/priority 边界：0 合法、越界拒绝（durationMs [0,30000]，priority [0,3]）', () => {
    expect(parseRawFrame({ type: 'live2d.directive', durationMs: 0, priority: 0 }).success).toBe(true)
    expect(parseRawFrame({ type: 'live2d.directive', durationMs: 30000, priority: 3 }).success).toBe(true)
    expect(parseRawFrame({ type: 'live2d.directive', durationMs: 30001 }).success).toBe(false)
    expect(parseRawFrame({ type: 'live2d.directive', durationMs: -1 }).success).toBe(false)
    expect(parseRawFrame({ type: 'live2d.directive', durationMs: 1000.5 }).success).toBe(false) // 非 int
    expect(parseRawFrame({ type: 'live2d.directive', priority: 1.5 }).success).toBe(false) // 非 int
  })
  it('空帧合法（全可选，仅 type 必填）；缺 type 拒绝', () => {
    expect(parseRawFrame({ type: 'live2d.directive' }).success).toBe(true)
    expect(parseRawFrame({ state: 'happy' }).success).toBe(false) // 非 live2d.directive 帧
  })
})

describe('阶段 6 批次 A 工具帧（Task 2）', () => {
  const validRequest = {
    type: 'tool.request', callId: 'call_1', toolName: 'desktop.file.read', toolVersion: '1.0',
    runtime: 'desktop', sourceCallId: 'tc_1', arguments: { resource_handle: 'h' },
    reason: '读取用户选中的文件', riskLevel: 'medium', permissionRequired: true,
    approvalAuthority: 'client', paramHash: 'abc123', expiresAt: '2026-08-20T12:00:00Z', requestId: 'req_1'
  }
  it('tool.request 合法帧全字段通过；sourceCallId 缺省拒；runtime 非法拒；未知字段整帧拒', () => {
    expect(parseRawFrame(validRequest).success).toBe(true)
    const noSource = { ...validRequest }
    delete (noSource as { sourceCallId?: string }).sourceCallId
    expect(parseRawFrame(noSource).success).toBe(false)
    expect(parseRawFrame({ ...validRequest, runtime: 'cloud' }).success).toBe(false)
    expect(parseRawFrame({ ...validRequest, unknown_field: 1 }).success).toBe(false)
  })
  it('tool.started/tool.completed 合法 + strict 拒未知字段；success 必填', () => {
    expect(parseRawFrame({ type: 'tool.started', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', inputSummary: 'query=<redacted>' }).success).toBe(true)
    expect(parseRawFrame({ type: 'tool.completed', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', success: true, outputSummary: '2026-08-20', durationMs: 12.5 }).success).toBe(true)
    expect(parseRawFrame({ type: 'tool.completed', callId: 'tc_1', toolName: 'get_time', runtime: 'backend' }).success).toBe(false) // success 必填
    expect(parseRawFrame({ type: 'tool.started', callId: 'tc_1', toolName: 'get_time', runtime: 'backend', extra: 1 }).success).toBe(false)
  })
  it('action 兼容帧（旧 trace 形状）通过；tool.status client 帧六态 + runtime str 放行', () => {
    expect(parseRawFrame({ type: 'action', action: 'tool_executing', params: { tool: 'save_memory', call_id: 'call_1' } }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'tool.status', callId: 'call_1', status: 'result', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'h', output: 'ok' }).success).toBe(true)
    expect(parseRawClientFrame({ type: 'tool.status', callId: 'call_1', status: 'accepted', toolName: 'x', toolVersion: '1', runtime: 'desktop', paramHash: 'h' }).success).toBe(true)
  })
})
