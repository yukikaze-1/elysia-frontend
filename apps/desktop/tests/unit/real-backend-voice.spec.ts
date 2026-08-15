// tests/unit/real-backend-voice.spec.ts
// Task 4 (P4-B):real-backend 语音控制帧(wire JSON 逐字)+ 单活动语音会话注册表 +
// sendAudioBytes 双 guard + commitVoice pendingAck 复用 + 语音族错误路由(D-P15)+ 二进制接收忽略。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealBackend, type RealBackendOptions, type WebSocketLike } from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { CyreneErrorCode } from '@shared/errors'

/** 发送记录：文本帧解析为 JSON、二进制帧保留 Uint8Array（send 扩为 string | Uint8Array 后的捕获） */
type SentFrame = { kind: 'text'; frame: Record<string, unknown> } | { kind: 'binary'; bytes: Uint8Array }

class FakeWs {
  private handlers: Record<string, (arg?: unknown, arg2?: unknown) => void> = {}
  sent: SentFrame[] = []
  send = vi.fn((data: string | Uint8Array) => {
    if (typeof data === 'string') this.sent.push({ kind: 'text', frame: JSON.parse(data) })
    else this.sent.push({ kind: 'binary', bytes: data })
  })
  close = vi.fn()
  readyState = 1
  on(ev: string, cb: (arg?: unknown, arg2?: unknown) => void): this { this.handlers[ev] = cb; return this }
  /** 推文本 JSON 帧（message handler 注册后即可 push） */
  push(frame: unknown): void { this.handlers['message']?.(JSON.stringify(frame)) }
  /** 推二进制消息（对齐真实 ws 库 isBinary 第二参判别；验证 UNEXPECTED_BINARY 忽略） */
  pushBinary(bytes: Uint8Array): void { this.handlers['message']?.(Buffer.from(bytes), true) }
  /** 触发 socket close（真实 ws close 事件 → onSocketClosed → 重连退避；测试模拟掉线） */
  pushClose(): void { this.handlers['close']?.() }
}

/** 建立已连接 backend（同步推握手帧使 connect resolve）；返回 warnings/errors 捕获数组 */
async function makeBackend(opts: Partial<RealBackendOptions> = {}): Promise<{
  backend: RealBackend
  ws: FakeWs
  warnings: ProtocolWarning[]
  errors: unknown[]
  events: BackendEvent[]
}> {
  const ws = new FakeWs()
  const warnings: ProtocolWarning[] = []
  const errors: unknown[] = []
  const events: BackendEvent[] = []
  const backend = new RealBackend({
    now: () => Date.now(),
    wsFactory: () => ws as WebSocketLike,
    onProtocolWarning: (w) => warnings.push(w),
    onError: (e) => errors.push(e),
    ...opts
  })
  backend.subscribe((e) => events.push(e))
  const p = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
  ws.push({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })
  ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' })
  await p
  return { backend, ws, warnings, errors, events }
}

const binaryCount = (ws: FakeWs): number => ws.sent.filter((s) => s.kind === 'binary').length

beforeEach(() => { vi.clearAllMocks() })

describe('RealBackend 语音控制帧 wire JSON（Task 4）', () => {
  it('startRecordVoice → voice.record.start 仅 {recordingId}（无 conversationId；会话归属在 commit）', async () => {
    const { backend, ws } = await makeBackend()
    await expect(backend.startRecordVoice({ recordingId: 'rec-1' })).resolves.toEqual({ recordingId: 'rec-1' })
    expect(ws.sent[0]).toEqual({ kind: 'text', frame: { type: 'voice.record.start', recordingId: 'rec-1' } })
  })

  it('stopRecordVoice / discardVoice → voice.record.stop / voice.discard', async () => {
    const { backend, ws } = await makeBackend()
    await backend.startRecordVoice({ recordingId: 'rec-1' })
    await backend.stopRecordVoice({ recordingId: 'rec-1' })
    expect(ws.sent[1]).toEqual({ kind: 'text', frame: { type: 'voice.record.stop', recordingId: 'rec-1' } })
    await backend.startRecordVoice({ recordingId: 'rec-2' })
    await backend.discardVoice({ recordingId: 'rec-2' })
    expect(ws.sent[3]).toEqual({ kind: 'text', frame: { type: 'voice.discard', recordingId: 'rec-2' } })
  })

  it('startRealtimeVoice → voice_session.start；conversationId 传入带键、缺省省略键', async () => {
    const { backend, ws } = await makeBackend()
    await backend.startRealtimeVoice({ sessionId: 'vs-1', conversationId: 'conv-9' })
    expect(ws.sent[0]).toEqual({ kind: 'text', frame: { type: 'voice_session.start', sessionId: 'vs-1', conversationId: 'conv-9' } })
    // ended 回执清位后再次 start（无 conversationId → 键缺省省略，非 undefined 值）
    ws.push({ type: 'voice_session.ended', sessionId: 'vs-1', reason: 'stopped' })
    await backend.startRealtimeVoice({ sessionId: 'vs-2' })
    expect(ws.sent[1]).toEqual({ kind: 'text', frame: { type: 'voice_session.start', sessionId: 'vs-2' } })
    expect('conversationId' in (ws.sent[1] as { kind: 'text'; frame: Record<string, unknown> }).frame).toBe(false)
  })

  it('stopRealtimeVoice / cancelRealtimeVoice → voice_session.stop / voice_session.cancel', async () => {
    const { backend, ws } = await makeBackend()
    await backend.startRealtimeVoice({ sessionId: 'vs-1' })
    await backend.stopRealtimeVoice({ sessionId: 'vs-1' })
    expect(ws.sent[1]).toEqual({ kind: 'text', frame: { type: 'voice_session.stop', sessionId: 'vs-1' } })
    ws.push({ type: 'voice_session.ended', sessionId: 'vs-1', reason: 'stopped' })
    await backend.startRealtimeVoice({ sessionId: 'vs-2' })
    await backend.cancelRealtimeVoice({ sessionId: 'vs-2' })
    expect(ws.sent[3]).toEqual({ kind: 'text', frame: { type: 'voice_session.cancel', sessionId: 'vs-2' } })
  })

  it('startDictation → dictation.start；sttProfileId 缺省不带键、传入带键', async () => {
    const { backend, ws } = await makeBackend()
    const r = await backend.startDictation({ clientRequestId: 'd-1' })
    expect(r).toEqual({ clientRequestId: 'd-1' })
    expect(ws.sent[0]).toEqual({ kind: 'text', frame: { type: 'dictation.start', clientRequestId: 'd-1' } })
    expect('sttProfileId' in (ws.sent[0] as { kind: 'text'; frame: Record<string, unknown> }).frame).toBe(false)
    await backend.stopDictation({ clientRequestId: 'd-1' })
    await backend.startDictation({ clientRequestId: 'd-2', sttProfileId: 'sensevoice/sense-voice' })
    expect(ws.sent[2]).toEqual({ kind: 'text', frame: { type: 'dictation.start', clientRequestId: 'd-2', sttProfileId: 'sensevoice/sense-voice' } })
  })

  it('stopDictation / cancelDictation → dictation.stop / dictation.cancel', async () => {
    const { backend, ws } = await makeBackend()
    await backend.startDictation({ clientRequestId: 'd-1' })
    await backend.stopDictation({ clientRequestId: 'd-1' })
    expect(ws.sent[1]).toEqual({ kind: 'text', frame: { type: 'dictation.stop', clientRequestId: 'd-1' } })
    await backend.startDictation({ clientRequestId: 'd-2' })
    await backend.cancelDictation({ clientRequestId: 'd-2' })
    expect(ws.sent[3]).toEqual({ kind: 'text', frame: { type: 'dictation.cancel', clientRequestId: 'd-2' } })
  })

  it('audioCancel → audio.cancel（stream_id 下划线 wire 字段）', async () => {
    const { backend, ws } = await makeBackend()
    await backend.audioCancel({ streamId: 7 })
    expect(ws.sent[0]).toEqual({ kind: 'text', frame: { type: 'audio.cancel', stream_id: 7 } })
  })

  it('commitVoice → voice.commit 全字段 wire', async () => {
    const { backend, ws } = await makeBackend()
    const p = backend.commitVoice({ recordingId: 'rec-1', text: '你好', clientRequestId: 'c-1', clientMessageId: 'm-1', conversationId: 'conv-1' })
    expect(ws.sent[0]).toEqual({
      kind: 'text',
      frame: { type: 'voice.commit', recordingId: 'rec-1', text: '你好', clientRequestId: 'c-1', clientMessageId: 'm-1', conversationId: 'conv-1' }
    })
    ws.push({ type: 'user_message.ack', messageId: 'msg-ack', clientRequestId: 'c-1', receivedAt: '2026-08-16T00:00:00.000Z', status: 'accepted' })
    await expect(p).resolves.toEqual({ clientRequestId: 'c-1', serverMessageId: 'msg-ack' })
  })
})

describe('RealBackend 单活动语音会话注册表（Task 4）', () => {
  it('startRecordVoice 二次 → 抛「已有活动语音会话进行中」；stopRecordVoice 后再次 start 成功', async () => {
    const { backend } = await makeBackend()
    await backend.startRecordVoice({ recordingId: 'rec-1' })
    await expect(backend.startRecordVoice({ recordingId: 'rec-2' })).rejects.toThrow('已有活动语音会话进行中')
    await backend.stopRecordVoice({ recordingId: 'rec-1' })
    await expect(backend.startRecordVoice({ recordingId: 'rec-3' })).resolves.toEqual({ recordingId: 'rec-3' })
  })

  it('跨语音种类互斥：realtime 活跃时 dictation.start 被拒；ended 回执清位后放行（realtime stop/cancel 不立即清位）', async () => {
    const { backend, ws } = await makeBackend()
    await backend.startRealtimeVoice({ sessionId: 'vs-1' })
    await expect(backend.startDictation({ clientRequestId: 'd-1' })).rejects.toThrow('已有活动语音会话进行中')
    await backend.stopRealtimeVoice({ sessionId: 'vs-1' })
    // stop 后 ended 未到 → 注册表仍占位（防双会话）
    await expect(backend.startDictation({ clientRequestId: 'd-2' })).rejects.toThrow('已有活动语音会话进行中')
    ws.push({ type: 'voice_session.ended', sessionId: 'vs-1', reason: 'stopped' })
    await expect(backend.startDictation({ clientRequestId: 'd-2' })).resolves.toEqual({ clientRequestId: 'd-2' })
  })

  it('dictation.stop 清位后可再 start（普通 start/stop 不依赖 ended）', async () => {
    const { backend } = await makeBackend()
    await backend.startDictation({ clientRequestId: 'd-1' })
    await backend.stopDictation({ clientRequestId: 'd-1' })
    await expect(backend.startDictation({ clientRequestId: 'd-2' })).resolves.toEqual({ clientRequestId: 'd-2' })
  })

  it('未 start 时 sendAudioBytes 丢弃（VOICE_BINARY_NO_SESSION warn，不发送、不 throw）', async () => {
    const { backend, ws, warnings } = await makeBackend()
    expect(() => backend.sendAudioBytes(new Uint8Array([1, 2, 3]))).not.toThrow()
    expect(binaryCount(ws)).toBe(0)
    expect(warnings.some((w) => w.code === 'VOICE_BINARY_NO_SESSION')).toBe(true)
  })

  it('socket 掉线（close 无 ended 回执）→ activeVoice 清位，重连后语音 start 不再锁死（review Important fix）', async () => {
    // realtime 会话活跃；后端未发 voice_session.ended 即掉线 → 重连后若 activeVoice 残留，所有 start* 永久抛
    // 「已有活动语音会话进行中」。修复：onSocketClosed 清位。
    const { backend, ws } = await makeBackend({ reconnectBaseDelayMs: 5 })
    await backend.startRealtimeVoice({ sessionId: 'vs-1' })
    ws.pushClose()   // 触发 onSocketClosed（未发 ended）：ws 置 undefined、activeVoice 清位、进入重连退避
    // 等自动重连的 establishWs 复用同一 FakeWs 重新注册 handler（退避 5ms），再推握手帧恢复 connected
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5))
      if (backend.getConnectionState().status === 'connecting') break   // establishWs 已发起新握手（connect 置 connecting）
      ws.push({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })
      ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-2' })
      if (backend.getConnectionState().status === 'connected') break
    }
    await expect(backend.startRecordVoice({ recordingId: 'rec-after-reconnect' })).resolves.toEqual({ recordingId: 'rec-after-reconnect' })
    expect(backend.getConnectionState().status).toBe('connected')
  })

  it('显式 disconnect → activeVoice 清位，重新 connect 后语音 start 不再锁死（review Important fix）', async () => {
    const { backend, ws } = await makeBackend()
    await backend.startRealtimeVoice({ sessionId: 'vs-1' })
    await backend.disconnect()
    // 重新连接（connect 用同一 wsFactory 会返回同一 FakeWs，但其 closed；这里新建连接走真实 re-handshake）
    const p2 = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
    ws.push({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })
    ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-3' })
    await p2
    await expect(backend.startRecordVoice({ recordingId: 'rec-after-disc' })).resolves.toEqual({ recordingId: 'rec-after-disc' })
  })
})

describe('RealBackend commitVoice pendingAck 复用（Task 4）', () => {
  it('匹配 clientRequestId 的 user_message.ack → resolve ClientRequestRef；不匹配 ack 不结算', async () => {
    const { backend, ws } = await makeBackend()
    let settled = false
    const p = backend.commitVoice({ recordingId: 'rec-1', text: 'hi', clientRequestId: 'c-1', clientMessageId: 'm-1', conversationId: 'conv-1' })
      .then((ref) => { settled = true; return ref })
    ws.push({ type: 'user_message.ack', messageId: 'other-ack', clientRequestId: 'c-other', receivedAt: '2026-08-16T00:00:00.000Z', status: 'accepted' })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)   // 不匹配 clientRequestId → pending 保持
    ws.push({ type: 'user_message.ack', messageId: 'msg-ack', clientRequestId: 'c-1', receivedAt: '2026-08-16T00:00:00.000Z', status: 'accepted' })
    await expect(p).resolves.toEqual({ clientRequestId: 'c-1', serverMessageId: 'msg-ack' })
    expect(settled).toBe(true)
  })

  it('rejected ack（QUEUE_FULL）→ reject BACKEND_REJECTED + 后端码透传', async () => {
    const { backend, ws } = await makeBackend()
    const p = backend.commitVoice({ recordingId: 'rec-1', text: 'hi', clientRequestId: 'c-1', clientMessageId: 'm-1', conversationId: 'conv-1' })
    ws.push({ type: 'user_message.ack', messageId: '', clientRequestId: 'c-1', receivedAt: '2026-08-16T00:00:00.000Z', status: 'rejected', error: { code: 'QUEUE_FULL', message: '队列已满', retryable: true } })
    await expect(p).rejects.toMatchObject({ code: CyreneErrorCode.BACKEND_REJECTED, message: '队列已满', details: { backendCode: 'QUEUE_FULL', retryable: true } })
  })

  it('同 clientRequestId 二次 commit → 旧 pending reject GENERATION_CONFLICT，新 pending 正常结算（F7 同语义）', async () => {
    const { backend, ws } = await makeBackend()
    const first = backend.commitVoice({ recordingId: 'rec-1', text: 'hi', clientRequestId: 'c-1', clientMessageId: 'm-1', conversationId: 'conv-1' })
    const second = backend.commitVoice({ recordingId: 'rec-2', text: 'yo', clientRequestId: 'c-1', clientMessageId: 'm-2', conversationId: 'conv-1' })
    await expect(first).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    ws.push({ type: 'user_message.ack', messageId: 'msg-ack', clientRequestId: 'c-1', receivedAt: '2026-08-16T00:00:00.000Z', status: 'accepted' })
    await expect(second).resolves.toEqual({ clientRequestId: 'c-1', serverMessageId: 'msg-ack' })
  })

  it('commitVoice 超时 → TIMEOUT（ackTimeoutMs 注入小值）', async () => {
    const { backend } = await makeBackend({ ackTimeoutMs: 20 })
    await expect(backend.commitVoice({ recordingId: 'rec-1', text: 'hi', clientRequestId: 'c-t', clientMessageId: 'm-1', conversationId: 'conv-1' }))
      .rejects.toMatchObject({ code: CyreneErrorCode.TIMEOUT })
  })

  it('commitVoice 未连接 → NOT_CONNECTED（先 guard 再注册 pending，无悬空条目）', async () => {
    const ws = new FakeWs()
    const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => ws as WebSocketLike })
    await backend.setToken('t')
    await expect(backend.commitVoice({ recordingId: 'rec-1', text: 'hi', clientRequestId: 'c-1', clientMessageId: 'm-1', conversationId: 'conv-1' }))
      .rejects.toMatchObject({ code: CyreneErrorCode.NOT_CONNECTED })
    expect(ws.sent).toHaveLength(0)
  })
})

describe('RealBackend sendAudioBytes 双 guard（Task 4）', () => {
  it('connected + 活动会话 → ws 收到 Uint8Array 二进制（不经 JSON.stringify）', async () => {
    const { backend, ws } = await makeBackend()
    await backend.startRecordVoice({ recordingId: 'rec-1' })
    const bytes = new Uint8Array([1, 2, 3])
    backend.sendAudioBytes(bytes)
    expect(ws.sent).toHaveLength(2)
    expect(ws.sent[1]).toEqual({ kind: 'binary', bytes })
    expect(binaryCount(ws)).toBe(1)
  })

  it('断连 → VOICE_BINARY_NOT_CONNECTED warn 丢弃，不 throw', async () => {
    const ws = new FakeWs()
    const warnings: ProtocolWarning[] = []
    const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => ws as WebSocketLike, onProtocolWarning: (w) => warnings.push(w) })
    await backend.setToken('t')
    expect(() => backend.sendAudioBytes(new Uint8Array([1]))).not.toThrow()
    expect(binaryCount(ws)).toBe(0)
    expect(warnings.some((w) => w.code === 'VOICE_BINARY_NOT_CONNECTED')).toBe(true)
  })
})

describe('RealBackend 语音族错误路由（Task 4 / D-P15）', () => {
  it('error{code:VOICE_SESSION_CONFLICT} → emit voice.error（code 透传 + message）+ onError 照常', async () => {
    const { ws, events, errors } = await makeBackend()
    ws.push({ type: 'error', message: '已有活动语音会话', code: 'VOICE_SESSION_CONFLICT' })
    const ve = events.find((e) => e.event === 'voice.error')
    expect(ve).toMatchObject({ event: 'voice.error', code: 'VOICE_SESSION_CONFLICT', message: '已有活动语音会话' })
    expect(ve && typeof (ve as { eventId: string }).eventId).toBe('string')
    expect(ve && typeof (ve as { sequence: number }).sequence).toBe('number')
    expect(errors).toHaveLength(1)   // 既有 onError 路径不丢
  })

  it('error{code:UNKNOWN} → 不 emit voice.error、onError 照常（非语音族不变）', async () => {
    const { ws, events, errors } = await makeBackend()
    ws.push({ type: 'error', message: '未知错误', code: 'UNKNOWN' })
    expect(events.some((e) => e.event === 'voice.error')).toBe(false)
    expect(errors).toHaveLength(1)
  })

  it('error{code:CONTRACT_VALIDATION} 有 activeVoice → emit voice.error；无 activeVoice → 不 emit（Minor 9）', async () => {
    const { backend, ws, events, errors } = await makeBackend()
    // 语音会话活跃时的 CONTRACT 违规 → 视为语音错误 emit
    await backend.startRecordVoice({ recordingId: 'rec-1' })
    ws.push({ type: 'error', message: '契约违规', code: 'CONTRACT_VALIDATION' })
    expect(events.some((e) => e.event === 'voice.error' && e.code === 'CONTRACT_VALIDATION')).toBe(true)
    expect(errors).toHaveLength(1)
    // 无 activeVoice 的 CONTRACT → 不 emit voice.error（连接横幅不误抑制）
    events.length = 0
    errors.length = 0
    await backend.stopRecordVoice({ recordingId: 'rec-1' })
    ws.push({ type: 'error', message: '契约违规', code: 'CONTRACT_VALIDATION' })
    expect(events.some((e) => e.event === 'voice.error')).toBe(false)
    expect(errors).toHaveLength(1)
  })

  it('error{code:STT_UNAVAILABLE}（VOICE_ERROR_CODES 成员）→ emit voice.error 不依赖 activeVoice', async () => {
    const { ws, events, errors } = await makeBackend()
    ws.push({ type: 'error', message: 'STT 不可用', code: 'STT_UNAVAILABLE' })
    expect(events.some((e) => e.event === 'voice.error' && e.code === 'STT_UNAVAILABLE')).toBe(true)
    expect(errors).toHaveLength(1)
  })
})

describe('RealBackend 二进制接收（Task 4）', () => {
  it('收到二进制消息（Buffer）→ UNEXPECTED_BINARY warn 忽略，不崩、不解析为 JSON', async () => {
    const { ws, warnings, events } = await makeBackend()
    ws.pushBinary(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))   // 模拟意外二进制下行（非音频业务帧）
    expect(warnings.some((w) => w.code === 'UNEXPECTED_BINARY')).toBe(true)
    expect(events).toHaveLength(0)   // 未映射任何领域事件
    // 后续文本帧仍正常
    ws.push({ type: 'error', message: 'x', code: 'UNKNOWN' })
    expect(events).toHaveLength(0)
  })
})
