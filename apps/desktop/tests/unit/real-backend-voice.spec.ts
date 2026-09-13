// tests/unit/real-backend-voice.spec.ts
// Task 4 (P4-B):real-backend 语音控制帧(wire JSON 逐字)+ 单活动语音会话注册表 +
// sendAudioBytes 双 guard + commitVoice pendingAck 复用 + 语音族错误路由(D-P15)+ 二进制接收忽略。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealBackend, type RealBackendOptions } from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { CyreneErrorCode } from '@shared/errors'

/** 发送记录：文本帧解析为 JSON、二进制帧保留 Uint8Array（send 扩为 string | Uint8Array 后的捕获） */
type SentFrame = { kind: 'text'; frame: Record<string, unknown> } | { kind: 'binary'; bytes: Uint8Array }

class FakeWs {
  private handlers: Record<string, (arg?: unknown, arg2?: unknown) => void> = {}
  sent: SentFrame[] = []
  send = vi.fn((data: string | Uint8Array) => {
    if (typeof data === 'string') {
      const frame = JSON.parse(data) as Record<string, unknown>
      this.sent.push({ kind: 'text', frame })
      this.applyControl(frame)
    } else {
      this.sent.push({ kind: 'binary', bytes: data })
    }
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

  /** —— 有状态虚拟后端（Task 4 冻结 discard 契约；P0-01 / P1-01） —— */
  /** 服务端侧活动语音会话（RECORDING/TRANSCRIBING/PENDING/IDLE × record/realtime/dictation） */
  voiceSession: { kind: 'record' | 'realtime' | 'dictation'; key: string } | undefined
  /** 旧契约模式：RECORDING 态 discard → CONTRACT_VALIDATION（拒且保留会话）；持会话时再 start → VOICE_SESSION_CONFLICT */
  strictOldContract = false
  /** rejectControl 一次性配置：下一次 start/discard 收到时 deferred push error{code,message}（拒绝不清既有会话） */
  private nextReject: { code: string; message: string } | undefined

  /** 桩状态 API：直接置服务端侧会话（独立于客户端本地注册表） */
  setVoice(kind: 'record' | 'realtime' | 'dictation', key: string): void { this.voiceSession = { kind, key } }
  clearVoice(): void { this.voiceSession = undefined }
  /** 下一次 start/discard 收到时 deferred push error{code,message}；拒绝语义=服务端会话保留（不误清） */
  rejectControl(code: string, message: string): void { this.nextReject = { code, message } }

  /** 虚拟后端状态机：按冻结契约（默认）或旧契约（strictOldContract）处理语音控制帧（由 send 调用） */
  private applyControl(frame: Record<string, unknown>): void {
    const type = frame.type
    if (type === 'voice.record.start' || type === 'voice_session.start' || type === 'dictation.start') {
      this.handleStart(type, frame)
    } else if (type === 'voice.discard') {
      this.handleDiscard(frame)
    } else if (type === 'voice.record.stop') {
      // stop → 服务端进入转写/自动 IDLE，普通录音不再占用活动注册表（<640B 空转写即 IDLE）
      if (this.voiceSession?.kind === 'record') this.voiceSession = undefined
    }
  }

  private handleStart(type: string, frame: Record<string, unknown>): void {
    if (this.nextReject) { const { code, message } = this.nextReject; this.nextReject = undefined; this.schedulePush({ type: 'error', code, message }); return }
    if (this.strictOldContract && this.voiceSession) {
      // 旧契约：服务端仍持会话时再 start → 拒（漂移 canary 失配第二拍）
      this.schedulePush({ type: 'error', code: 'VOICE_SESSION_CONFLICT', message: '已有活动语音会话' })
      return
    }
    const kind = type === 'voice.record.start' ? 'record' : type === 'voice_session.start' ? 'realtime' : 'dictation'
    const key = (frame.recordingId ?? frame.sessionId ?? frame.clientRequestId) as string
    this.voiceSession = { kind, key }
  }

  private handleDiscard(frame: Record<string, unknown>): void {
    if (this.nextReject) { const { code, message } = this.nextReject; this.nextReject = undefined; this.schedulePush({ type: 'error', code, message }); return }
    if (this.strictOldContract && this.voiceSession?.kind === 'record') {
      // 旧契约：RECORDING 态 discard → CONTRACT_VALIDATION（拒且保留会话）
      this.schedulePush({ type: 'error', code: 'CONTRACT_VALIDATION', message: '录音中，先 stop 再 discard' })
      return
    }
    // 冻结契约：匹配当前录音 → 清回 IDLE；IDLE/迟到/重复 → 幂等成功（不发 VOICE_RECORDING_NOT_FOUND）
    if (this.voiceSession?.kind === 'record' && this.voiceSession.key === frame.recordingId) {
      this.voiceSession = undefined
    }
  }
  /** deferred push：对齐真实错误帧走网络到达的时序（发送方同步体先跑完再到达） */
  private schedulePush(frame: unknown): void {
    queueMicrotask(() => this.push(frame))
  }
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
    wsFactory: () => ws,
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

/** onError 收到的 CyreneError 中透传的 wire 错误码（details.code） */
const errorCodes = (errors: unknown[]): (string | undefined)[] =>
  errors.map((e) => (e as { details?: { code?: string } }).details?.code)

/** 冲刷 microtask（queueMicrotask）+ macrotask（setTimeout 0）——deferred push 在 flush 后已到达 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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
    const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => ws })
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
    const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => ws, onProtocolWarning: (w) => warnings.push(w) })
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

describe('RealBackend 冻结 discard 契约（Task 4 真实联调 P0-01/P1-01；有状态协议桩）', () => {
  it('桩状态 API：setVoice/clearVoice 驱动服务端侧会话（独立于客户端本地注册表）', async () => {
    const ws = new FakeWs()
    ws.setVoice('realtime', 'vs-1')
    expect(ws.voiceSession).toEqual({ kind: 'realtime', key: 'vs-1' })
    ws.clearVoice()
    expect(ws.voiceSession).toBeUndefined()
  })

  it('start(A)→discard(A)→start(B)：wire 严格 [start,discard,start]、全程无 error/voice.error（无需重连）', async () => {
    const { backend, ws, events, errors } = await makeBackend()
    await backend.startRecordVoice({ recordingId: 'rec-A' })
    await backend.discardVoice({ recordingId: 'rec-A' })
    await backend.startRecordVoice({ recordingId: 'rec-B' })
    await flush()
    const textFrames = ws.sent.filter((s) => s.kind === 'text').map((s) => s.frame)
    expect(textFrames).toEqual([
      { type: 'voice.record.start', recordingId: 'rec-A' },
      { type: 'voice.discard', recordingId: 'rec-A' },
      { type: 'voice.record.start', recordingId: 'rec-B' }
    ])
    expect(ws.voiceSession).toEqual({ kind: 'record', key: 'rec-B' })   // 服务端已完成 A 的 discard → 清位
    expect(errorCodes(errors)).toEqual([])                              // 无 CONTRACT_VALIDATION / VOICE_SESSION_CONFLICT
    expect(events.some((e) => e.event === 'voice.error')).toBe(false)
  })

  it('空转写序列 <640B → stop → discard：幂等成功、errors 空、events 无 voice.error', async () => {
    const { backend, ws, events, errors } = await makeBackend()
    await backend.startRecordVoice({ recordingId: 'rec-A' })
    await backend.stopRecordVoice({ recordingId: 'rec-A' })   // 服务端自动回 IDLE（<640B 不发 transcript）
    await backend.discardVoice({ recordingId: 'rec-A' })      // IDLE 迟到 discard → 幂等成功
    await flush()
    expect(ws.voiceSession).toBeUndefined()
    expect(errorCodes(errors)).toEqual([])
    expect(events.some((e) => e.event === 'voice.error')).toBe(false)
  })

  it('discard → discard 重复：两次均成功、无错误帧（IDLE 幂等）', async () => {
    const { backend, ws, events, errors } = await makeBackend()
    await backend.discardVoice({ recordingId: 'rec-A' })
    await backend.discardVoice({ recordingId: 'rec-A' })
    await flush()
    const textFrames = ws.sent.filter((s) => s.kind === 'text').map((s) => s.frame)
    expect(textFrames).toEqual([
      { type: 'voice.discard', recordingId: 'rec-A' },
      { type: 'voice.discard', recordingId: 'rec-A' }
    ])
    expect(errorCodes(errors)).toEqual([])
    expect(events.some((e) => e.event === 'voice.error')).toBe(false)
  })

  it('realtime 活跃 + discard：stub 拒 VOICE_SESSION_CONFLICT、realtime 会话不被误清', async () => {
    const { backend, ws, events, errors } = await makeBackend()
    await backend.startRealtimeVoice({ sessionId: 'vs-1' })
    expect(ws.voiceSession).toEqual({ kind: 'realtime', key: 'vs-1' })
    ws.rejectControl('VOICE_SESSION_CONFLICT', '已有活动语音会话')
    await backend.discardVoice({ recordingId: 'rec-9' })
    await flush()
    expect(ws.voiceSession).toEqual({ kind: 'realtime', key: 'vs-1' })  // 拒绝不动既有会话
    expect(events.some((e) => e.event === 'voice.error' && e.code === 'VOICE_SESSION_CONFLICT')).toBe(true)
    expect(errorCodes(errors)).toContain('VOICE_SESSION_CONFLICT')
  })

  it('mismatch discard（rec-X≠rec-A 且另一录音活跃）：stub 拒 VOICE_RECORDING_NOT_FOUND、原录音不被误清', async () => {
    const { backend, ws, events, errors } = await makeBackend()
    await backend.startRecordVoice({ recordingId: 'rec-A' })
    ws.rejectControl('VOICE_RECORDING_NOT_FOUND', '无此活动录音')
    await backend.discardVoice({ recordingId: 'rec-X' })
    await flush()
    expect(ws.voiceSession).toEqual({ kind: 'record', key: 'rec-A' })   // 原录音 A 未被误清
    expect(events.some((e) => e.event === 'voice.error' && e.code === 'VOICE_RECORDING_NOT_FOUND')).toBe(true)
    expect(errorCodes(errors)).toContain('VOICE_RECORDING_NOT_FOUND')
  })
})

describe('RealBackend 契约漂移 canary（Task 4 真实联调 §5.6 末行；证明 harness 可发现失配）', () => {
  it('旧契约：RECORDING 态 discard 拒 CONTRACT_VALIDATION（本地已清 vs 服务端仍持会话）+ 下次 start 触发 VOICE_SESSION_CONFLICT', async () => {
    const { backend, ws, events, errors } = await makeBackend()
    ws.strictOldContract = true
    await backend.startRecordVoice({ recordingId: 'rec-A' })
    // discardVoice 同步体（send → 清 activeVoice）先跑完；延迟到达的 CONTRACT_VALIDATION 帧只走 onError（activeVoice 已清）
    await backend.discardVoice({ recordingId: 'rec-A' })
    await flush()
    expect(errorCodes(errors)).toContain('CONTRACT_VALIDATION')          // load-bearing：harness 捕获「本地清 vs 服务端仍持」
    // 服务端仍持会话 A（旧契约拒 discard 不清）→ 下一次 start 本地放行、wire 发出，stub 拒 VOICE_SESSION_CONFLICT
    await expect(backend.startRecordVoice({ recordingId: 'rec-B' })).resolves.toEqual({ recordingId: 'rec-B' })
    await flush()
    expect(ws.voiceSession).toEqual({ kind: 'record', key: 'rec-A' })
    expect(errorCodes(errors)).toContain('VOICE_SESSION_CONFLICT')
    expect(events.some((e) => e.event === 'voice.error' && e.code === 'VOICE_SESSION_CONFLICT')).toBe(true)
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
