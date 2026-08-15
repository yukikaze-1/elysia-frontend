import { afterEach, describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'
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