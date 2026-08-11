import { describe, expect, it } from 'vitest'
import { parseRawFrame } from '../../src/main/transport/protocol-v2/raw-schemas'

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
})

describe('raw schema ack/error 扩展(2B)', () => {
  it('user_message.ack accepted 通过', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'msg-1', clientRequestId: 'c1', receivedAt: '2026-08-11T00:00:00.000Z', status: 'accepted' })
    expect(r.success).toBe(true)
  })
  it('user_message.ack rejected 带 error 通过', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'msg-1', clientRequestId: 'c1', receivedAt: '2026-08-11T00:00:00.000Z', status: 'rejected', error: { code: 'CONTRACT_VALIDATION', message: 'bad', retryable: false } })
    expect(r.success).toBe(true)
  })
  it('error 帧通过', () => {
    const r = parseRawFrame({ type: 'error', message: '会话不存在', code: 'SESSION_NOT_FOUND', requestId: 'req-1', retryable: false })
    expect(r.success).toBe(true)
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
  it('rejected 缺 error 通过（走退化分支）', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: '', clientRequestId: 'c1', receivedAt: 't', status: 'rejected' })
    expect(r.success).toBe(true)
  })
  it('accepted + 空 messageId 拒为非法帧', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: '', clientRequestId: 'c1', receivedAt: 't', status: 'accepted' })
    expect(r.success).toBe(false)
  })
  it('accepted 正常通过', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'm1', clientRequestId: 'c1', receivedAt: 't', status: 'accepted' })
    expect(r.success).toBe(true)
  })
})
