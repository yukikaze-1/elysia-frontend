import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseRawFrame, RawFrameSchema, RAW_FRAME_TYPES, rawSchemasFingerprint, rawSchemasFingerprintFor } from '../../src/main/transport/protocol-v2/raw-schemas'

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

describe('raw schemas fingerprint(2C)', () => {
  it('RAW_FRAME_TYPES 与 union 推导集合一致(I6)', () => {
    expect([...RAW_FRAME_TYPES].sort()).toEqual([
      'error', 'expression', 'generation.completed', 'generation.delta',
      'generation.failed', 'generation.segment.completed', 'generation.segment.started',
      'generation.started', 'server_info', 'session', 'set_tts_voice_result', 'state',
      'switch_model_result', 'typing', 'user_message.ack'
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
  it('rawSchemasFingerprint 不含 content 嵌套结构（指纹不下探嵌套元素）→ 本批不改 schema 故指纹不变', () => {
    const fp = rawSchemasFingerprint()
    // content 字段 zod 类型仍为 z.unknown().optional()，其 _def.type 不变；断言指纹为 64 位 hex 即可（相对不变性由 wire-fixtures 门禁兜）
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
})
