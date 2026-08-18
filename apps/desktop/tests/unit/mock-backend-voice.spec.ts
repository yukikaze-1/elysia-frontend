import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockBackend, parseMockMouthLevelEnv, parseMockVoiceTranscriptDelayEnv } from '../../src/main/transport/mock-backend'
import { parseBackendEvent } from '@shared/schemas'
import type { BackendEvent } from '@shared/contracts'

let backend: MockBackend | undefined

afterEach(() => {
  backend?.dispose()
  backend = undefined
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('MockBackend 语音模拟（P4-B Task 7）', () => {
  it('record 全流程：start→stop→transcript→commit→ack→generation', async () => {
    backend = new MockBackend({ emitDelayMs: 1 })
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.connect({ serverUrl: 'mock://test' })

    await backend.startRecordVoice({ recordingId: 'rec1' })
    await backend.stopRecordVoice({ recordingId: 'rec1' })
    const trs = ev.filter((e) => e.event === 'voice.transcript')
    expect(trs).toHaveLength(1)
    expect(trs[0]?.recordingId).toBe('rec1')
    expect(trs[0]?.text).toBe('这是一段测试录音的转写文本')

    const ref = await backend.commitVoice({
      recordingId: 'rec1', text: '这是一段测试录音的转写文本',
      conversationId: 'conv-1001', clientRequestId: 'cc1', clientMessageId: 'cm1'
    })
    expect(ref.clientRequestId).toBe('cc1') // ack 以返回的 ClientRequestRef 体现（与 sendMessage 同构）
    expect(ref.serverMessageId).toMatch(/^msg-/) // Task 12 乐观消息迁移依赖 serverMessageId（real ack 同形状）

    // serverMessageId 即记录消息 messageId → 迁移 key 在 Mock 历史侧可解析（Task 12 乐观迁移闭环）
    const hist = await backend.queryChatHistory({ scope: { type: 'conversation', conversationId: 'conv-1001' }, limit: 20, timeZone: 'Asia/Shanghai', category: 'all' })
    expect(hist.items.some((h) => h.messageId === ref.serverMessageId && h.snippet === '这是一段测试录音的转写文本')).toBe(true)

    await sleep(60) // 等 generation 回放完成
    expect(ev.some((e) => e.event === 'generation.completed')).toBe(true)
  })

  it('empty voiceTranscriptText（未识别）→ stop 不 emit transcript（Minor 18）', async () => {
    backend = new MockBackend({ voiceTranscriptText: '' })
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.startRecordVoice({ recordingId: 'rec1' })
    await backend.stopRecordVoice({ recordingId: 'rec1' })
    expect(ev.filter((e) => e.event === 'voice.transcript')).toHaveLength(0)
  })

  it('discardVoice 清 active；未连接 commitVoice 抛 NOT_CONNECTED', async () => {
    backend = new MockBackend()
    await backend.startRecordVoice({ recordingId: 'rec1' })
    await backend.discardVoice({ recordingId: 'rec1' })
    // discard 后 stop 仍可发 transcript（后端已转写，与客户端活动态无关），仅断言不抛
    await backend.stopRecordVoice({ recordingId: 'rec1' })
    await expect(backend.commitVoice({
      recordingId: 'rec1', text: 't', conversationId: 'conv-1001', clientRequestId: 'c1', clientMessageId: 'm1'
    })).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })

  it('realtime：started→(chunk)→partial+turn→ended；每会话 turn 仅一次', async () => {
    backend = new MockBackend()
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.startRealtimeVoice({ sessionId: 'vs1', conversationId: 'conv-1001' })
    expect(ev.some((e) => e.event === 'voice_session.started' && e.sessionId === 'vs1' && e.conversationId === 'conv-1001')).toBe(true)

    backend.sendAudioBytes(new Uint8Array(0))
    backend.sendAudioBytes(new Uint8Array(0)) // 第二个 chunk 不再重复发 partial/turn
    const partials = ev.filter((e) => e.event === 'voice_session.partial')
    expect(partials).toHaveLength(1)
    expect(partials[0]?.sessionId).toBe('vs1')
    expect(partials[0]?.text).toBe('实时语音轮次文本')
    const turns = ev.filter((e) => e.event === 'voice_session.turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]?.messageId).toMatch(/^msg_/)
    expect(turns[0]?.conversationId).toBe('conv-1001')
    expect(turns[0]?.text).toBe('实时语音轮次文本')

    await backend.stopRealtimeVoice({ sessionId: 'vs1' })
    expect(ev.some((e) => e.event === 'voice_session.ended' && e.reason === 'stopped' && e.sessionId === 'vs1')).toBe(true)

    // 新会话重新计数（realtimeTurnEmitted 重置）
    await backend.startRealtimeVoice({ sessionId: 'vs2' })
    backend.sendAudioBytes(new Uint8Array(0))
    expect(ev.filter((e) => e.event === 'voice_session.partial')).toHaveLength(2)
    await backend.cancelRealtimeVoice({ sessionId: 'vs2' })
    expect(ev.some((e) => e.event === 'voice_session.ended' && e.reason === 'cancelled' && e.sessionId === 'vs2')).toBe(true)
  })

  it('dictation：partial→final；cancel→cancelled', async () => {
    backend = new MockBackend()
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.startDictation({ clientRequestId: 'd1' })
    expect(ev.filter((e) => e.event === 'dictation.partial')).toHaveLength(1)
    await backend.stopDictation({ clientRequestId: 'd1' })
    const finals = ev.filter((e) => e.event === 'dictation.final')
    expect(finals).toHaveLength(1)
    expect(finals[0]?.clientRequestId).toBe('d1')
    expect(finals[0]?.text).toBe('这是听写文本')

    await backend.startDictation({ clientRequestId: 'd2' })
    await backend.cancelDictation({ clientRequestId: 'd2' })
    expect(ev.some((e) => e.event === 'dictation.cancelled' && e.clientRequestId === 'd2')).toBe(true)
    expect(ev.filter((e) => e.event === 'dictation.final')).toHaveLength(1) // cancel 不发 final
  })

  it('receivedAudioChunks 计数：无会话 chunk 仅计数不抛、不 emit', async () => {
    backend = new MockBackend()
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    backend.sendAudioBytes(new Uint8Array(4))
    backend.sendAudioBytes(new Uint8Array(4))
    backend.sendAudioBytes(new Uint8Array(4))
    expect(backend.receivedAudioChunks).toBe(3)
    expect(ev).toHaveLength(0)
  })

  it('voiceError 注入：各语音 start* 仅 emit voice.error（不继续、不置 active）', async () => {
    backend = new MockBackend({ voiceError: { code: 'STT_UNAVAILABLE', message: '语音服务不可用' } })
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.startRecordVoice({ recordingId: 'rec1' })
    await backend.startRealtimeVoice({ sessionId: 'vs1', conversationId: 'conv-1001' })
    await backend.startDictation({ clientRequestId: 'd1' })
    const errs = ev.filter((e) => e.event === 'voice.error')
    expect(errs).toHaveLength(3)
    for (const err of errs) {
      expect(err.code).toBe('STT_UNAVAILABLE')
      expect(err.message).toBe('语音服务不可用')
    }
    // 未继续 → 无 start 后续事件
    expect(ev.some((e) => e.event === 'voice_session.started')).toBe(false)
    expect(ev.some((e) => e.event === 'dictation.partial')).toBe(false)
  })

  it('envelope 交错单调：voice + generation 事件 sequence 严格递增（共享计数器，Minor 11）', async () => {
    backend = new MockBackend({ emitDelayMs: 1 })
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.connect({ serverUrl: 'mock://test' })

    // ① record → transcript（seq 0）
    await backend.startRecordVoice({ recordingId: 'rec1' })
    await backend.stopRecordVoice({ recordingId: 'rec1' })

    // ② commit → generation 回放（seq 1..11，与 transcript 共享计数器）
    await backend.commitVoice({
      recordingId: 'rec1', text: 't', conversationId: 'conv-1001', clientRequestId: 'c1', clientMessageId: 'm1'
    })
    await sleep(60) // 等回放全部触发

    // ③ realtime → started（seq 12）+ partial/turn（13/14）+ ended（15）
    await backend.startRealtimeVoice({ sessionId: 'vs1', conversationId: 'conv-1001' })
    backend.sendAudioBytes(new Uint8Array(0))
    await backend.stopRealtimeVoice({ sessionId: 'vs1' })

    // ④ dictation final（seq 16）
    await backend.startDictation({ clientRequestId: 'd1' })
    await backend.stopDictation({ clientRequestId: 'd1' })

    const seqs = ev.map((e) => e.sequence)
    expect(new Set(seqs).size).toBe(seqs.length) // 无重复
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)) // 收到顺序即单调
    // 事件全部通过 Schema（envelope 必填）
    for (const e of ev) expect(parseBackendEvent(e as never).success, `事件 ${e.event} 应通过`).toBe(true)
    // 确实与 generation 事件交错（非单一来源）
    expect(ev.some((e) => e.event === 'voice.transcript')).toBe(true)
    expect(ev.some((e) => e.event === 'generation.started')).toBe(true)
  })

  it('envelope 挂起 replay 期间交错：信封在 emit 时刻打 → 收到顺序恒递增（review Important-1）', async () => {
    backend = new MockBackend({ emitDelayMs: 30 }) // 慢回放制造交错窗口（11 事件横跨 0..300ms）
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c1' }) // 调度回放（事件尚未 emit）
    // replay 仍挂起时立即发语音事件——emit 时刻 stamp 必须晚于已调度但未 emit 的 replay 事件
    await backend.startRealtimeVoice({ sessionId: 'vs1', conversationId: 'conv-1001' })
    backend.sendAudioBytes(new Uint8Array(0)) // partial + turn
    await sleep(400) // 等 replay 全部触发
    const seqs = ev.map((e) => e.sequence)
    expect(new Set(seqs).size).toBe(seqs.length) // 无重复
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)) // 收到顺序恒等于 stamp 顺序 → 严格递增
    // 交错确实发生：realtime 事件落在 replay 事件流内部（非全部位于 replay 前后）
    const iStarted = ev.findIndex((e) => e.event === 'voice_session.started')
    const iDelta = ev.findIndex((e) => e.event === 'generation.delta')
    expect(iStarted).toBeGreaterThanOrEqual(0)
    expect(iDelta).toBeGreaterThan(iStarted) // 语音 started 在 replay delta 之前（seq 更小）→ 已交错
  })

  it('ttsActive 判定与 TTS 事件：仅激活 ttsProfile 时触发（D-P13）', async () => {
    // 未激活 TTS → 无 audio 事件（LLM 驱动的 mock-backend-model-services 语义不变）
    backend = new MockBackend({ emitDelayMs: 1 })
    expect(backend.ttsActive).toBe(false)
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c1' })
    await sleep(60)
    expect(ev.some((e) => e.event === 'generation.completed')).toBe(true)
    expect(ev.filter((e) => e.event === 'audio.session.started')).toHaveLength(0)
    expect(ev.filter((e) => e.event === 'audio.session.ready')).toHaveLength(0)

    // 激活 TTS → generation.completed 后追加 started + ready
    backend = new MockBackend({ emitDelayMs: 1 })
    await backend.activateModelProfile({ profileId: 'edge/edge-tts', service: 'tts' })
    expect(backend.ttsActive).toBe(true)
    const ev2: BackendEvent[] = []
    backend.subscribe((e) => ev2.push(e))
    await backend.connect({ serverUrl: 'mock://test' })
    await backend.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c2' })
    await sleep(60)
    const started = ev2.filter((e) => e.event === 'audio.session.started')
    const ready = ev2.filter((e) => e.event === 'audio.session.ready')
    expect(started).toHaveLength(1)
    expect(ready).toHaveLength(1)
    expect(started[0]?.streamId).toBe(1)
    expect(started[0]?.format).toBe('wav')
    expect(ready[0]?.url).toBe('cyrene://renderer/__cyrene-media/tts-live/mock-silent')
    // 紧跟 generation.completed 之后（started 在 completed 后、ready 在 started 后）
    const iCompleted = ev2.findIndex((e) => e.event === 'generation.completed')
    const iStarted = ev2.findIndex((e) => e.event === 'audio.session.started')
    const iReady = ev2.findIndex((e) => e.event === 'audio.session.ready')
    expect(iStarted).toBeGreaterThan(iCompleted)
    expect(iReady).toBeGreaterThan(iStarted)
  })

  it('audioCancel → audio.session.cancelled', async () => {
    backend = new MockBackend()
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.audioCancel({ streamId: 7 })
    const cancels = ev.filter((e) => e.event === 'audio.session.cancelled')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]?.streamId).toBe(7)
  })
})

describe('MockBackend discardVoice 冻结契约五态（Task 3，R-S4-03）', () => {
  it('record 活跃 + recordingId 匹配 → 清 active；随后 IDLE 幂等', async () => {
    backend = new MockBackend()
    await backend.startRecordVoice({ recordingId: 'rec1' })
    await backend.discardVoice({ recordingId: 'rec1' })
    // 已清回 IDLE：再次 discard 幂等成功，不发 VOICE_RECORDING_NOT_FOUND
    await expect(backend.discardVoice({ recordingId: 'rec1' })).resolves.toBeUndefined()
  })

  it('record 活跃 + recordingId 不匹配（另一录音活跃）→ VOICE_RECORDING_NOT_FOUND，原录音不误清', async () => {
    backend = new MockBackend()
    await backend.startRecordVoice({ recordingId: 'rec-a' })
    await backend.startRecordVoice({ recordingId: 'rec-b' }) // Mock 单活动录音槽：rec-b 为当前录音
    await expect(backend.discardVoice({ recordingId: 'rec-a' })).rejects.toMatchObject({
      code: 'VOICE_RECORDING_NOT_FOUND', message: '无此活动录音'
    })
    // 原录音（rec-b）未被误清：正确 recordingId 仍可 discard（match 清）
    await expect(backend.discardVoice({ recordingId: 'rec-b' })).resolves.toBeUndefined()
    // 清后幂等
    await expect(backend.discardVoice({ recordingId: 'rec-b' })).resolves.toBeUndefined()
  })

  it('realtime 活跃 → VOICE_SESSION_CONFLICT，会话不动', async () => {
    backend = new MockBackend()
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.startRealtimeVoice({ sessionId: 'vs1', conversationId: 'conv-1001' })
    await expect(backend.discardVoice({ recordingId: 'whatever' })).rejects.toMatchObject({
      code: 'VOICE_SESSION_CONFLICT', message: '已有活动语音会话'
    })
    // 会话未动：仍可收 turn（同一会话仍活跃），正常结束
    backend.sendAudioBytes(new Uint8Array(0))
    expect(ev.filter((e) => e.event === 'voice_session.turn')).toHaveLength(1)
    await backend.stopRealtimeVoice({ sessionId: 'vs1' })
  })

  it('dictation 活跃 → VOICE_SESSION_CONFLICT，会话不动', async () => {
    backend = new MockBackend()
    const ev: BackendEvent[] = []
    backend.subscribe((e) => ev.push(e))
    await backend.startDictation({ clientRequestId: 'd1' })
    await expect(backend.discardVoice({ recordingId: 'whatever' })).rejects.toMatchObject({ code: 'VOICE_SESSION_CONFLICT' })
    // dictation 未动：仍可正常 stop（final 照发）
    await backend.stopDictation({ clientRequestId: 'd1' })
    expect(ev.filter((e) => e.event === 'dictation.final')).toHaveLength(1)
  })

  it('无活动会话（IDLE / 已自动重置）→ 幂等成功，不发 VOICE_RECORDING_NOT_FOUND', async () => {
    backend = new MockBackend()
    await expect(backend.discardVoice({ recordingId: 'rec1' })).resolves.toBeUndefined()
    await expect(backend.discardVoice({ recordingId: 'rec1' })).resolves.toBeUndefined()
  })
})

describe('parseMockVoiceTranscriptDelayEnv（Task 3，R-S4-05）', () => {
  it('undefined → undefined（未接线，不注入）', () => {
    expect(parseMockVoiceTranscriptDelayEnv(undefined)).toBeUndefined()
  })

  it("'0' → 0", () => {
    expect(parseMockVoiceTranscriptDelayEnv('0')).toBe(0)
  })

  it("'' 空串 → Number('')=0 → 0（延迟空串非合法注入，钳 0 无延迟）", () => {
    expect(parseMockVoiceTranscriptDelayEnv('')).toBe(0)
  })

  it('负数 → 钳 0', () => {
    expect(parseMockVoiceTranscriptDelayEnv('-5')).toBe(0)
  })

  it('超上限 → 钳 30000', () => {
    expect(parseMockVoiceTranscriptDelayEnv('50000')).toBe(30000)
  })

  it('NaN（非数字）→ 0', () => {
    expect(parseMockVoiceTranscriptDelayEnv('abc')).toBe(0)
  })

  it('正常正值原样透传', () => {
    expect(parseMockVoiceTranscriptDelayEnv('1500')).toBe(1500)
  })
})

describe('stopRecordVoice transcriptDelayMs 延迟 emit（Task 3，R-S4-05）', () => {
  it('transcriptDelayMs=50：延迟到达前不 emit，到达后 emit（fire-and-forget）且 active 同步清', async () => {
    vi.useFakeTimers()
    try {
      backend = new MockBackend({ transcriptDelayMs: 50 })
      const ev: BackendEvent[] = []
      backend.subscribe((e) => ev.push(e))
      await backend.startRecordVoice({ recordingId: 'rec1' })
      const p = backend.stopRecordVoice({ recordingId: 'rec1' })
      expect(ev.filter((e) => e.event === 'voice.transcript')).toHaveLength(0) // 未到延迟不 emit
      await vi.advanceTimersByTimeAsync(49)
      expect(ev.filter((e) => e.event === 'voice.transcript')).toHaveLength(0) // 50ms 前仍不 emit
      await vi.advanceTimersByTimeAsync(1)
      await p
      const trs = ev.filter((e) => e.event === 'voice.transcript')
      expect(trs).toHaveLength(1)
      expect(trs[0]?.recordingId).toBe('rec1')
      expect(trs[0]?.text).toBe('这是一段测试录音的转写文本')
      // activeVoice 于停被接受时同步清（Task 5 修正：不随延迟 emit 顺延）：随后 discard 落入 IDLE 幂等成功——
      // 若 activeVoice 未清，discard(other) 会因 mismatch 抛 VOICE_RECORDING_NOT_FOUND
      await expect(backend.discardVoice({ recordingId: 'other-rec' })).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('transcriptDelayMs>0 但 transcript 空（显式空串）→ 不延迟、不发 transcript、active 仍清', async () => {
    vi.useFakeTimers()
    try {
      backend = new MockBackend({ voiceTranscriptText: '', transcriptDelayMs: 50 })
      const ev: BackendEvent[] = []
      backend.subscribe((e) => ev.push(e))
      await backend.startRecordVoice({ recordingId: 'rec1' })
      await backend.stopRecordVoice({ recordingId: 'rec1' })
      // 空 transcript：不 emit，也不需要推进延迟计时器
      expect(ev.filter((e) => e.event === 'voice.transcript')).toHaveLength(0)
      await expect(backend.discardVoice({ recordingId: 'rec1' })).resolves.toBeUndefined() // active 已清 → IDLE 幂等
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('parseMockMouthLevelEnv（批次 C C1，合成包络源选择）', () => {
  it('未设/空串/非法 → undefined（不注入，用真实 Analyser 源）', () => {
    expect(parseMockMouthLevelEnv(undefined)).toBeUndefined()
    expect(parseMockMouthLevelEnv('')).toBeUndefined()
    expect(parseMockMouthLevelEnv('square')).toBeUndefined()
    expect(parseMockMouthLevelEnv('  step  ')).toBeUndefined() // 不去空白（与既有 parser 一致，非法即不注入）
  })
  it('仅 step/sine 合法透传', () => {
    expect(parseMockMouthLevelEnv('step')).toBe('step')
    expect(parseMockMouthLevelEnv('sine')).toBe('sine')
  })
})
