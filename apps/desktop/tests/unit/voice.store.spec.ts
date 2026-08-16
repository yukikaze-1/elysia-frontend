// tests/unit/voice.store.spec.ts
// Task 12（spec §5.9）：voiceStore——三模式语音会话编排（setDesktopApi mock + fake PcmCapture 注入）。
// 覆盖：record 全流程（D-P19 start 先于采集、transcript→commit、无 transcript 门禁、discard、45s 兜底、
// 300s/600s 计时、micError）；realtime（started/partial/turn/ack 背压窗口边界 200/201、5s ack-stall 兜底、
// ended 清态、统一守卫）；dictation（sttProfileId 透传、final→finalText + clearDictationFinal、cancel）；
// TTS（autoReadReply 门、started 打断、cancelled/onerror 清态）；voice.error 路由；consent 拦截/confirm/dismiss；
// replayRecord；reset 清理。
// env=node：store 经 stores/desktop-api 注入 mock api + setCaptureFactory 注入 fake capture。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { BackendEvent } from '@shared/contracts'
import {
  ACK_STALL_MS, MAX_UNACKED_FRAMES, RECORD_HARD_CAP_MS, RECORD_WARN_MS, TRANSCRIPT_WAIT_MS,
  setCaptureFactory, useVoiceStore
} from '../../src/renderer/src/stores/voice.store'
import type { PcmCaptureLike, PcmCaptureOptions } from '../../src/renderer/src/voice/voice-capture'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn((_h: (e: BackendEvent) => void) => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(),
  attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(), testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn(),
  // P4-B 语音/设置面
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(), settingsLoad: vi.fn(), settingsSave: vi.fn()
}

/** fake PcmCapture（PcmCaptureLike 形状；start 捕获 options 供测试驱动 onChunk/onStop） */
interface FakeCapture extends PcmCaptureLike {
  start: ReturnType<typeof vi.fn<(opts: PcmCaptureOptions) => Promise<void>>>
  pause: ReturnType<typeof vi.fn<() => Promise<void>>>
  resume: ReturnType<typeof vi.fn<() => Promise<void>>>
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
}
function makeFakeCapture(): FakeCapture {
  return {
    start: vi.fn(async (_opts: PcmCaptureOptions) => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
}
let fake: FakeCapture

function state() {
  return {
    version: 1 as const,
    voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: true },
    dictation: { insertMode: 'append' as const }
  }
}

/** 事件外壳：BackendEvent 判别字段 + envelope 最小集 */
function ev<T extends { event: string }>(partial: T): BackendEvent {
  return { eventId: 'e1', sequence: 1, ...partial } as unknown as BackendEvent
}

function onChunk(bytes: Uint8Array): void {
  const opts = fake.start.mock.calls[0][0] as PcmCaptureOptions
  opts.onChunk(bytes)
}

function subscribe(store: ReturnType<typeof useVoiceStore>): (e: BackendEvent) => void {
  store.init()
  return mockApi.onChatEvent.mock.calls.at(-1)?.[0] as unknown as (e: BackendEvent) => void
}

/** store 生成的当前录音 recordingId（从 voiceStartRecord 调用参数取） */
function lastRecordingId(): string {
  return mockApi.voiceStartRecord.mock.calls.at(-1)![0].recordingId
}

describe('voiceStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.clearAllMocks()
    fake = makeFakeCapture()
    setCaptureFactory(() => fake)
    mockApi.voiceStartRecord.mockResolvedValue({ recordingId: 'rec_1' })
    mockApi.voiceStopRecord.mockResolvedValue(undefined)
    mockApi.voiceCommit.mockResolvedValue({ clientRequestId: 'c1', serverMessageId: 'msg-v1' })
    mockApi.voiceDiscard.mockResolvedValue(undefined)
    mockApi.voiceStartRealtime.mockResolvedValue({ sessionId: 'vs_1' })
    mockApi.voiceStopRealtime.mockResolvedValue(undefined)
    mockApi.voiceCancelRealtime.mockResolvedValue(undefined)
    mockApi.voiceStartDictation.mockResolvedValue({ clientRequestId: 'req_1' })
    mockApi.voiceStopDictation.mockResolvedValue(undefined)
    mockApi.voiceCancelDictation.mockResolvedValue(undefined)
    mockApi.audioCancel.mockResolvedValue(undefined)
    mockApi.settingsSave.mockImplementation(async (patch: unknown) => {
      // 仅测试需回包一致；voiceStore 不读 settingsSave 返回值
      return { ...state(), voice: { ...state().voice, ...(patch as { voice?: object }).voice } }
    })
    useConnectionStore().state = { status: 'connected', connectionId: 'cid-1' }
    useConversationStore().$patch({ currentId: 'conv-1' })
    const settings = useSettingsStore()
    settings.voice.consentBackendStt = true   // 默认已同意（consent 拦截单独测）
    settings.voice.realtimeEnabled = true
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // —— 统一守卫（D-P11） ——

  it('guardStart：未连接 → start 全部 no-op（不调控制帧/不开采集）', async () => {
    useConnectionStore().state = { status: 'disconnected' }
    const store = useVoiceStore()
    await store.startRecord()
    await store.startRealtime()
    await store.startDictation()
    expect(mockApi.voiceStartRecord).not.toHaveBeenCalled()
    expect(mockApi.voiceStartRealtime).not.toHaveBeenCalled()
    expect(mockApi.voiceStartDictation).not.toHaveBeenCalled()
    expect(fake.start).not.toHaveBeenCalled()
    expect(store.mode).toBe('idle')
  })

  it('startRecord 且 voice.enabled=false → 拒绝（不开采集）', async () => {
    useSettingsStore().voice.enabled = false
    const store = useVoiceStore()
    await store.startRecord()
    expect(mockApi.voiceStartRecord).not.toHaveBeenCalled()
    expect(fake.start).not.toHaveBeenCalled()
    expect(store.mode).toBe('idle')
  })

  it('startRealtime 且 realtimeEnabled=false → 拒绝（不开采集）', async () => {
    useSettingsStore().voice.realtimeEnabled = false
    const store = useVoiceStore()
    await store.startRealtime()
    expect(mockApi.voiceStartRealtime).not.toHaveBeenCalled()
    expect(fake.start).not.toHaveBeenCalled()
    expect(store.mode).toBe('idle')
  })

  it('record_pending 期间新 start 被 mode≠idle 拦截（须先丢弃/重录/确认）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.mode).toBe('record_pending')
    await store.startRecord()
    expect(mockApi.voiceStartRecord).toHaveBeenCalledTimes(1) // 未再开新会话
    expect(fake.start).toHaveBeenCalledTimes(1)
  })

  // —— consent（D-P16） ——

  it('consent 拦截：未同意 → consentPending + pendingAction，不执行录音', async () => {
    useSettingsStore().voice.consentBackendStt = false
    const store = useVoiceStore()
    await store.startRecord()
    expect(store.consentPending).toBe(true)
    expect(store.pendingAction).not.toBeNull()
    expect(mockApi.voiceStartRecord).not.toHaveBeenCalled()
    expect(fake.start).not.toHaveBeenCalled()
    expect(store.mode).toBe('idle')
  })

  it('confirmConsent：置位「不再提示」+ 重发挂起动作 → 录音真正开始', async () => {
    useSettingsStore().voice.consentBackendStt = false
    const store = useVoiceStore()
    await store.startRecord()
    expect(store.consentPending).toBe(true)
    await store.confirmConsent()
    expect(useSettingsStore().voice.consentBackendStt).toBe(true)
    expect(store.consentPending).toBe(false)
    expect(store.pendingAction).toBeNull()
    expect(store.confirmDispatching).toBe(false) // settle 后复位
    expect(mockApi.voiceStartRecord).toHaveBeenCalledWith({ recordingId: expect.stringMatching(/^rec_/) })
    expect(fake.start).toHaveBeenCalled()
    expect(store.mode).toBe('recording')
  })

  it('confirmConsent：动作在途期间 confirmDispatching=true，settle 后 false（评审轮3 在途信号）', async () => {
    useSettingsStore().voice.consentBackendStt = false
    const store = useVoiceStore()
    await store.startRecord()
    expect(store.consentPending).toBe(true)
    // capture.start 挂起（模拟 getUserMedia 权限提示慢）：confirm 重发动作在途时 confirmDispatching 保持 true
    let release: () => void = () => {}
    fake.start.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    const confirmPromise = store.confirmConsent()
    await vi.waitFor(() => expect(store.confirmDispatching).toBe(true))
    expect(store.consentPending).toBe(false)
    expect(store.mode).toBe('idle') // 动作未定型：不误判成功
    release()
    await confirmPromise
    expect(store.confirmDispatching).toBe(false)
    expect(store.mode).toBe('recording')
  })

  it('dismissConsent：清 pending，不执行动作', async () => {
    useSettingsStore().voice.consentBackendStt = false
    const store = useVoiceStore()
    await store.startDictation()
    expect(store.consentPending).toBe(true)
    store.dismissConsent()
    expect(store.consentPending).toBe(false)
    expect(store.pendingAction).toBeNull()
    expect(store.confirmDispatching).toBe(false) // 取消不进入重发
    expect(mockApi.voiceStartDictation).not.toHaveBeenCalled()
    expect(store.mode).toBe('idle')
  })

  // —— 普通录音 ——

  it('record：D-P19 控制帧先于采集（voiceStartRecord 在 capture.start 前）', async () => {
    const store = useVoiceStore()
    await store.startRecord()
    expect(mockApi.voiceStartRecord).toHaveBeenCalledTimes(1)
    expect(fake.start).toHaveBeenCalledTimes(1)
    expect(mockApi.voiceStartRecord.mock.invocationCallOrder[0]).toBeLessThan(fake.start.mock.invocationCallOrder[0])
    // capture.start 收到 onChunk/onStop/deviceId
    const opts = fake.start.mock.calls[0][0] as PcmCaptureOptions
    expect(typeof opts.onChunk).toBe('function')
    expect(typeof opts.onStop).toBe('function')
    expect(opts.deviceId).toBeUndefined() // 缺省 micDeviceId
    expect(store.mode).toBe('recording')
    expect(store.captureReady).toBe(true)
    expect(store.record.elapsedMs).toBe(0)
  })

  it('record：start→stop→transcript→commit → sendVoiceCommit(recordingId, transcript) + 清态', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.mode).toBe('record_pending')
    expect(mockApi.voiceStopRecord).toHaveBeenCalledWith({ recordingId: expect.stringMatching(/^rec_/) })
    const handler = subscribe(store)
    handler(ev({ event: 'voice.transcript', recordingId: lastRecordingId(), text: '你好世界' }))
    expect(store.record.transcript).toBe('你好世界')
    expect(store.caption).toBe('你好世界')
    const ok = await store.commitRecord()
    expect(ok).toBe(true)
    expect(mockApi.voiceCommit).toHaveBeenCalledWith(expect.objectContaining({ recordingId: expect.stringMatching(/^rec_/), text: '你好世界' }))
    expect(store.mode).toBe('idle') // 成功清态
    expect(store.record.transcript).toBeUndefined()
    expect(store.caption).toBe('')
  })

  it('record：无 transcript → commitRecord 门禁 false（仅丢弃/重录）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    const ok = await store.commitRecord()
    expect(ok).toBe(false)
    expect(mockApi.voiceCommit).not.toHaveBeenCalled()
    expect(store.mode).toBe('record_pending')
  })

  it('record：45s 无 transcript/error → 兜底判「未识别」+ commit 门禁 false', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.record.awaitingTranscript).toBe(true) // P1-02：stop 后进入等待态
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS)
    expect(store.caption).toBe('')
    expect(store.record.transcript).toBeUndefined()
    expect(store.record.awaitingTranscript).toBe(false) // P1-02：45s 到时翻转「未识别」
    const ok = await store.commitRecord()
    expect(ok).toBe(false)
  })

  it('record：transcript 到达清除 45s 等待定时器（计时不再触发未识别）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    const handler = subscribe(store)
    handler(ev({ event: 'voice.transcript', recordingId: lastRecordingId(), text: '文本' }))
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS)
    expect(store.record.transcript).toBe('文本') // 未被 45s 兜底清掉
  })

  it('record：discard → voiceDiscard + 清态回 idle', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    await store.discardRecord()
    expect(mockApi.voiceDiscard).toHaveBeenCalledWith({ recordingId: expect.stringMatching(/^rec_/) })
    expect(store.mode).toBe('idle')
    expect(store.record.elapsedMs).toBe(0)
    expect(store.caption).toBe('')
  })

  // —— P1-02 record 等待态 + R-S4-06 voice.error 门控 ——

  it('record：P1-02 stop 后 awaitingTranscript=true；45s 到时翻转 false（未识别）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    expect(store.record.awaitingTranscript).toBe(false) // 录音中非等待态
    await store.stopRecord()
    expect(store.mode).toBe('record_pending')
    expect(store.record.awaitingTranscript).toBe(true)
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS - 1)
    expect(store.record.awaitingTranscript).toBe(true) // 0~44.999s 不翻转
    await vi.advanceTimersByTimeAsync(1)
    expect(store.record.awaitingTranscript).toBe(false) // 45s 到时翻转
    expect(store.caption).toBe('')
  })

  it('record：P1-02 慢字幕第 30s 到达 → transcript 置位 + awaiting 清 + timer 清除（45s 不被清空）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.record.awaitingTranscript).toBe(true)
    const handler = subscribe(store)
    await vi.advanceTimersByTimeAsync(30000)
    handler(ev({ event: 'voice.transcript', recordingId: lastRecordingId(), text: '慢字幕' }))
    expect(store.record.transcript).toBe('慢字幕')
    expect(store.record.awaitingTranscript).toBe(false)
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS) // 原 45s timer 已清
    expect(store.record.transcript).toBe('慢字幕') // 未被兜底清空
    expect(store.record.awaitingTranscript).toBe(false)
  })

  it('record：P1-02 等待中收到 STT voice.error → error 置位 + awaiting 清 + timer 清除', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.record.awaitingTranscript).toBe(true)
    const handler = subscribe(store)
    handler(ev({ event: 'voice.error', code: 'STT_UNAVAILABLE', message: 'STT 服务不可用' }))
    expect(store.error?.code).toBe('STT_UNAVAILABLE')
    expect(store.record.awaitingTranscript).toBe(false)
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS) // timer 已清，不再触发
    expect(store.record.transcript).toBeUndefined()
    expect(store.record.awaitingTranscript).toBe(false)
  })

  it('record：R-S4-06 recording 态 voice.error 丢弃；record_pending 消费', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord() // mode = recording，未 stop
    expect(store.mode).toBe('recording')
    const handler = subscribe(store)
    handler(ev({ event: 'voice.error', code: 'VOICE_RECORDING_NOT_FOUND', message: '旧会话迟到错误' }))
    expect(store.error).toBeUndefined() // recording 态丢弃（R-S4-06）
    await store.stopRecord()
    expect(store.record.awaitingTranscript).toBe(true)
    handler(ev({ event: 'voice.error', code: 'STT_UNAVAILABLE', message: 'STT 服务不可用' }))
    expect(store.error?.code).toBe('STT_UNAVAILABLE') // record_pending 消费
    expect(store.record.awaitingTranscript).toBe(false)
  })

  it('record：P1-02 等待中 discard → clearRecordState（awaiting 复位 + timer 清）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.record.awaitingTranscript).toBe(true)
    await store.discardRecord()
    expect(store.record.awaitingTranscript).toBe(false)
    expect(store.mode).toBe('idle')
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS) // timer 已清
    expect(store.record.transcript).toBeUndefined()
  })

  it('record：P1-02 等待中 reset → awaiting 复位 + timer 清', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.record.awaitingTranscript).toBe(true)
    await store.reset()
    expect(store.record.awaitingTranscript).toBe(false)
    expect(store.mode).toBe('idle')
  })

  it('record：300s 接近上限 toast 提示一次（继续录音）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await vi.advanceTimersByTimeAsync(RECORD_WARN_MS)
    expect(store.notice).toBe('录音即将达到 10 分钟上限')
    expect(store.mode).toBe('recording') // 不自动停
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.notice).toBe('录音即将达到 10 分钟上限') // 不重复提示
  })

  it('record：600s 硬上限 → 自动停止 + toast + voiceStopRecord', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await vi.advanceTimersByTimeAsync(RECORD_HARD_CAP_MS)
    expect(store.mode).toBe('record_pending')
    expect(mockApi.voiceStopRecord).toHaveBeenCalled()
    expect(store.notice).toBe('录音已达 10 分钟上限，已自动停止')
  })

  it('record：micError——capture.start 拒绝 → micError + 模式回 idle + 取消后端会话(discard)', async () => {
    fake.start.mockRejectedValue(new Error('[NOT_ALLOWED] 麦克风权限被拒绝'))
    const store = useVoiceStore()
    await store.startRecord()
    expect(store.micError?.code).toBe('NOT_ALLOWED')
    expect(store.micError?.message).toContain('麦克风权限被拒绝')
    expect(store.mode).toBe('idle')
    expect(store.captureReady).toBe(false)
    expect(mockApi.voiceDiscard).toHaveBeenCalledWith({ recordingId: expect.stringMatching(/^rec_/) })
  })

  it('review-Important：成功重试清除陈旧 micError（修复权限后重录不残留旧错误）', async () => {
    fake.start.mockRejectedValueOnce(new Error('[NOT_ALLOWED] 麦克风权限被拒绝'))
    const store = useVoiceStore()
    await store.startRecord()
    expect(store.micError?.code).toBe('NOT_ALLOWED')
    expect(store.mode).toBe('idle')
    await store.startRecord() // 修复后重试成功
    expect(store.micError).toBeUndefined()
    expect(store.error).toBeUndefined()
    expect(store.mode).toBe('recording')
  })

  it('review-Important：新 start 清除陈旧 error（voice.error 后重试）', async () => {
    const store = useVoiceStore()
    const handler = subscribe(store)
    handler(ev({ event: 'voice.error', code: 'STT_UNAVAILABLE', message: 'x' }))
    expect(store.error?.code).toBe('STT_UNAVAILABLE')
    await store.startDictation()
    expect(store.error).toBeUndefined()
    expect(store.mode).toBe('dictating')
  })

  it('review-Minor：新 start 清除 notice（录音上限提示后重录不残留）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await vi.advanceTimersByTimeAsync(RECORD_WARN_MS)
    expect(store.notice).not.toBeNull()
    await store.stopRecord()
    await store.discardRecord()
    await store.startRecord()
    expect(store.notice).toBeNull()
    expect(store.mode).toBe('recording')
  })

  it('review-Minor：控制帧拒绝 → error 置位 + 模式 idle（不抛未处理拒绝，record）', async () => {
    mockApi.voiceStartRecord.mockRejectedValue(new Error('[VOICE_SESSION_CONFLICT] 已有语音会话'))
    const store = useVoiceStore()
    await store.startRecord()
    expect(store.error?.code).toBe('VOICE_SESSION_CONFLICT')
    expect(store.mode).toBe('idle')
    expect(fake.start).not.toHaveBeenCalled()
    expect(store.captureReady).toBe(false)
  })

  it('review-Minor：控制帧拒绝 → error 置位 + 模式 idle（realtime/dictation）', async () => {
    mockApi.voiceStartRealtime.mockRejectedValue(new Error('[VOICE_SESSION_CONFLICT] 已有实时会话'))
    const store = useVoiceStore()
    await store.startRealtime()
    expect(store.error?.code).toBe('VOICE_SESSION_CONFLICT')
    expect(store.realtime.sessionId).toBeUndefined()
    expect(store.mode).toBe('idle')
    expect(fake.start).not.toHaveBeenCalled()
    mockApi.voiceStartDictation.mockRejectedValue(new Error('[DICTATION_NOT_FOUND] 转写会话不存在'))
    await store.startDictation()
    expect(store.error?.code).toBe('DICTATION_NOT_FOUND')
    expect(store.mode).toBe('idle')
    expect(fake.start).not.toHaveBeenCalled()
  })

  it('review-Minor：voice.transcript recordingId 不匹配（discard 后迟到字幕）→ 忽略', async () => {
    const store = useVoiceStore()
    const handler = subscribe(store)
    await store.startRecord()
    await store.stopRecord()
    const oldId = lastRecordingId()
    await store.discardRecord()
    handler(ev({ event: 'voice.transcript', recordingId: oldId, text: '迟到字幕' }))
    expect(store.record.transcript).toBeUndefined()
    expect(store.mode).toBe('idle')
  })

  it('record：replayRecord——audioBuffer 存在 → AudioContext BufferSource 播放（不走 blob URL）', () => {
    const srcMock = { buffer: null, connect: vi.fn(), start: vi.fn() }
    const ctxMock = { createBufferSource: vi.fn(() => srcMock), destination: {} }
    vi.stubGlobal('AudioContext', vi.fn(function () { return ctxMock }))
    const store = useVoiceStore()
    store.record.audioBuffer = {} as unknown as AudioBuffer
    store.replayRecord()
    expect(ctxMock.createBufferSource).toHaveBeenCalled()
    expect(srcMock.buffer).toBeDefined()
    expect(srcMock.connect).toHaveBeenCalled()
    expect(srcMock.start).toHaveBeenCalled()
  })

  it('record：replayRecord——无 audioBuffer → 不播放（no-op）', () => {
    const store = useVoiceStore()
    expect(() => store.replayRecord()).not.toThrow()
  })

  // —— 实时会话 ——

  it('realtime：start → voiceStartRealtime(带 conversationId) + 采集', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    expect(mockApi.voiceStartRealtime).toHaveBeenCalledWith({ sessionId: expect.stringMatching(/^vs_/), conversationId: 'conv-1' })
    expect(fake.start).toHaveBeenCalled()
    expect(store.mode).toBe('realtime')
    expect(store.captureReady).toBe(true)
  })

  it('realtime：started/partial/turn 事件更新状态（turn 只计数不插入消息）', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    const handler = subscribe(store)
    handler(ev({ event: 'voice_session.started', sessionId: 'vs_1', conversationId: 'conv-1' }))
    expect(store.mode).toBe('realtime')
    expect(store.realtime.sessionId).toBe('vs_1')
    handler(ev({ event: 'voice_session.partial', sessionId: 'vs_1', turnId: 1, segmentIndex: 0, text: '你好' }))
    expect(store.realtime.caption).toBe('你好')
    handler(ev({ event: 'voice_session.turn', sessionId: 'vs_1', turnId: 1, messageId: 'msg-1', conversationId: 'conv-1', text: '你好' }))
    expect(store.realtime.turnCount).toBe(1)
  })

  it('realtime：背压窗口边界——unacked-lastAcked 恰 200 仍运行、201 暂停、ack 恢复（Minor 21）', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    for (let i = 0; i < MAX_UNACKED_FRAMES; i++) onChunk(new Uint8Array(640))
    expect(store.realtime.unacked).toBe(MAX_UNACKED_FRAMES)
    expect(fake.pause).not.toHaveBeenCalled() // 200 未超窗
    onChunk(new Uint8Array(640)) // 201 → 超窗
    expect(store.realtime.unacked).toBe(MAX_UNACKED_FRAMES + 1)
    expect(fake.pause).toHaveBeenCalledTimes(1)
    const handler = subscribe(store)
    handler(ev({ event: 'voice_session.ack', sessionId: 'vs_1', seq: MAX_UNACKED_FRAMES + 1 }))
    expect(store.realtime.lastAckedSeq).toBe(MAX_UNACKED_FRAMES + 1)
    expect(fake.resume).toHaveBeenCalledTimes(1) // 窗口恢复
  })

  it('realtime：5s ack-stall 定时器——无 ack 时 capture.resume() 兜底', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRealtime()
    expect(fake.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(ACK_STALL_MS)
    expect(fake.resume).toHaveBeenCalledTimes(1)
  })

  it('realtime：每次 ack 重臂 ack-stall（ack 清原定时器 + 窗口内 resume，重臂后到点才触发）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRealtime()
    const handler = subscribe(store)
    await vi.advanceTimersByTimeAsync(2000)
    handler(ev({ event: 'voice_session.ack', sessionId: 'vs_1', seq: 1 })) // ack：窗口内 resume + 清 T1 + 重臂 T2@7000
    expect(fake.resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000) // t=5000：原 T1 已被清，不应触发
    expect(fake.resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000) // t=7000：T2 触发（resume 兜底）
    expect(fake.resume).toHaveBeenCalledTimes(2)
  })

  it('realtime：ended → 清 realtime 态 + 停采集 + mode idle', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    const handler = subscribe(store)
    handler(ev({ event: 'voice_session.ended', sessionId: 'vs_1', reason: 'stopped' }))
    expect(fake.stop).toHaveBeenCalled()
    expect(store.realtime.sessionId).toBeUndefined()
    expect(store.realtime.unacked).toBe(0)
    expect(store.mode).toBe('idle')
    expect(store.captureReady).toBe(false)
  })

  it('realtime：stopRealtime → capture.stop + voiceStopRealtime；ended 事件清态', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    await store.stopRealtime()
    expect(fake.stop).toHaveBeenCalled()
    expect(mockApi.voiceStopRealtime).toHaveBeenCalledWith({ sessionId: expect.stringMatching(/^vs_/) })
    expect(store.mode).toBe('realtime') // 清态由 ended 事件完成
    const handler = subscribe(store)
    handler(ev({ event: 'voice_session.ended', sessionId: 'vs_1', reason: 'stopped' }))
    expect(store.mode).toBe('idle')
  })

  it('realtime：cancelRealtime → voiceCancelRealtime', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    await store.cancelRealtime()
    expect(mockApi.voiceCancelRealtime).toHaveBeenCalledWith({ sessionId: expect.stringMatching(/^vs_/) })
  })

  it('realtime：micError——capture.start 拒绝 → micError + 模式回 idle + voiceCancelRealtime', async () => {
    fake.start.mockRejectedValue(new Error('[DEVICE_IN_USE] 设备被占用'))
    const store = useVoiceStore()
    await store.startRealtime()
    expect(store.micError?.code).toBe('DEVICE_IN_USE')
    expect(store.mode).toBe('idle')
    expect(store.captureReady).toBe(false)
    expect(mockApi.voiceCancelRealtime).toHaveBeenCalledWith({ sessionId: expect.stringMatching(/^vs_/) })
  })

  // —— 输入法转写 ——

  it('dictation：sttProfileId 透传（start 载荷含 sttProfileId）', async () => {
    useSettingsStore().dictation.sttProfileId = 'stt/p1'
    const store = useVoiceStore()
    await store.startDictation()
    expect(mockApi.voiceStartDictation).toHaveBeenCalledWith({ clientRequestId: expect.stringMatching(/^req_/), sttProfileId: 'stt/p1' })
    expect(fake.start).toHaveBeenCalled()
    expect(store.mode).toBe('dictating')
  })

  it('dictation：无 sttProfileId → 载荷不带该键（缺省全局活动 STT，M-4）', async () => {
    useSettingsStore().dictation.sttProfileId = undefined
    const store = useVoiceStore()
    await store.startDictation()
    expect(mockApi.voiceStartDictation).toHaveBeenCalledWith({ clientRequestId: expect.stringMatching(/^req_/) })
    expect(mockApi.voiceStartDictation.mock.calls[0][0]).not.toHaveProperty('sttProfileId')
  })

  it('dictation：partial → caption；final → finalText 置位（不直接插入）+ clearDictationFinal 清态', async () => {
    const store = useVoiceStore()
    await store.startDictation()
    const handler = subscribe(store)
    handler(ev({ event: 'dictation.partial', text: '部分' }))
    expect(store.dictation.caption).toBe('部分')
    expect(store.dictation.finalText).toBeUndefined()
    handler(ev({ event: 'dictation.final', clientRequestId: 'req_1', text: '完整文本' }))
    expect(store.dictation.finalText).toBe('完整文本')
    expect(store.dictation.caption).toBe('完整文本')
    expect(store.mode).toBe('dictating') // 组件消费后 clearDictationFinal 才回 idle
    store.clearDictationFinal()
    expect(store.dictation.finalText).toBeUndefined()
    expect(store.dictation.caption).toBe('')
    expect(store.mode).toBe('idle')
  })

  it('dictation：cancelDictation → voiceCancelDictation；cancelled 事件清态回 idle', async () => {
    const store = useVoiceStore()
    await store.startDictation()
    await store.cancelDictation()
    expect(fake.stop).toHaveBeenCalled()
    expect(mockApi.voiceCancelDictation).toHaveBeenCalledWith({ clientRequestId: expect.stringMatching(/^req_/) })
    const handler = subscribe(store)
    handler(ev({ event: 'dictation.cancelled', clientRequestId: 'req_1' }))
    expect(store.dictation.caption).toBe('')
    expect(store.mode).toBe('idle')
  })

  it('dictation：stopDictation → voiceStopDictation', async () => {
    const store = useVoiceStore()
    await store.startDictation()
    await store.stopDictation()
    expect(mockApi.voiceStopDictation).toHaveBeenCalledWith({ clientRequestId: expect.stringMatching(/^req_/) })
  })

  it('dictation：micError——capture.start 拒绝 → micError + 模式回 idle + voiceCancelDictation', async () => {
    fake.start.mockRejectedValue(new Error('[IPC_ERROR] 无可用麦克风'))
    const store = useVoiceStore()
    await store.startDictation()
    expect(store.micError?.message).toContain('无可用麦克风')
    expect(store.mode).toBe('idle')
    expect(mockApi.voiceCancelDictation).toHaveBeenCalledWith({ clientRequestId: expect.stringMatching(/^req_/) })
  })

  // —— TTS ——

  it('tts：autoReadReply on → audio.session.ready 置 playing/url（触发播放）', () => {
    const store = useVoiceStore()
    const handler = subscribe(store)
    handler(ev({ event: 'audio.session.started', streamId: 1, format: 'wav' }))
    expect(store.tts.playingStreamId).toBe(1)
    expect(store.tts.playing).toBe(false) // ready 前不播
    handler(ev({ event: 'audio.session.ready', streamId: 1, url: 'cyrene://renderer/__cyrene-media/tts-live/1.wav', durationMs: 1200 }))
    expect(store.tts.playing).toBe(true)
    expect(store.tts.url).toContain('tts-live')
    expect(store.tts.durationMs).toBe(1200)
  })

  it('tts：autoReadReply off → ready 忽略（不播、不置 playing）', () => {
    useSettingsStore().voice.autoReadReply = false
    const store = useVoiceStore()
    const handler = subscribe(store)
    handler(ev({ event: 'audio.session.ready', streamId: 1, url: 'u' }))
    expect(store.tts.playing).toBe(false)
    expect(store.tts.url).toBeUndefined()
  })

  it('tts：新句 started 打断旧播放（playing 且 streamId 不同 → 清态 + 记新 streamId）', () => {
    const store = useVoiceStore()
    const handler = subscribe(store)
    handler(ev({ event: 'audio.session.started', streamId: 1 }))
    handler(ev({ event: 'audio.session.ready', streamId: 1, url: 'u1' }))
    expect(store.tts.playing).toBe(true)
    handler(ev({ event: 'audio.session.started', streamId: 2 }))
    expect(store.tts.playing).toBe(false)
    expect(store.tts.url).toBeUndefined()
    expect(store.tts.playingStreamId).toBe(2)
  })

  it('tts：cancelled / onerror / onended 清态', () => {
    const store = useVoiceStore()
    const handler = subscribe(store)
    handler(ev({ event: 'audio.session.started', streamId: 1 }))
    handler(ev({ event: 'audio.session.ready', streamId: 1, url: 'u1' }))
    handler(ev({ event: 'audio.session.cancelled', streamId: 1 }))
    expect(store.tts.playing).toBe(false)
    expect(store.tts.playingStreamId).toBeUndefined()
    // onerror
    handler(ev({ event: 'audio.session.started', streamId: 2 }))
    handler(ev({ event: 'audio.session.ready', streamId: 2, url: 'u2' }))
    store.onTtsPlaybackError()
    expect(store.tts.playing).toBe(false)
    expect(store.tts.url).toBeUndefined()
    // onended
    handler(ev({ event: 'audio.session.started', streamId: 3 }))
    handler(ev({ event: 'audio.session.ready', streamId: 3, url: 'u3' }))
    store.onTtsPlaybackEnded()
    expect(store.tts.playing).toBe(false)
  })

  it('tts：stopTtsPlayback → audioCancel({streamId}) + 清态', async () => {
    const store = useVoiceStore()
    const handler = subscribe(store)
    handler(ev({ event: 'audio.session.started', streamId: 7 }))
    handler(ev({ event: 'audio.session.ready', streamId: 7, url: 'u' }))
    await store.stopTtsPlayback()
    expect(mockApi.audioCancel).toHaveBeenCalledWith({ streamId: 7 })
    expect(store.tts.playing).toBe(false)
    expect(store.tts.playingStreamId).toBeUndefined()
  })

  // —— voice.error ——

  it('voice.error → error 结构化（STT_UNAVAILABLE）+ record_pending 等待态清除', async () => {
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.record.awaitingTranscript).toBe(true) // P1-02：record_pending 等待中
    const handler = subscribe(store)
    handler(ev({ event: 'voice.error', code: 'STT_UNAVAILABLE', message: 'STT 服务不可用' }))
    expect(store.error?.code).toBe('STT_UNAVAILABLE')
    expect(store.error?.message).toBe('STT 服务不可用')
    expect(store.record.awaitingTranscript).toBe(false) // R-S4-06：error 终态清除等待
  })

  it('voice.error PLAYBACK_NOT_FOUND → 良性忽略', () => {
    const store = useVoiceStore()
    const handler = subscribe(store)
    handler(ev({ event: 'voice.error', code: 'STT_UNAVAILABLE', message: 'x' }))
    expect(store.error).toBeDefined()
    handler(ev({ event: 'voice.error', code: 'PLAYBACK_NOT_FOUND' }))
    expect(store.error?.code).toBe('STT_UNAVAILABLE') // 未被覆盖
  })

  // —— reset ——

  it('reset：realtime 活跃 → 停采集 + 清所有语音态 + 停 TTS + consent 清 pending', async () => {
    const store = useVoiceStore()
    useSettingsStore().voice.consentBackendStt = false
    await store.startDictation() // 挂起 consent
    expect(store.consentPending).toBe(true)
    useSettingsStore().voice.consentBackendStt = true
    await store.startRealtime()
    store.$patch({ tts: { playingStreamId: 9, url: 'u', playing: true } })
    await store.reset()
    expect(fake.stop).toHaveBeenCalled()
    expect(store.mode).toBe('idle')
    expect(store.realtime.sessionId).toBeUndefined()
    expect(store.tts.playing).toBe(false)
    expect(store.tts.playingStreamId).toBeUndefined()
    expect(store.micError).toBeUndefined()
    expect(store.error).toBeUndefined()
    expect(store.consentPending).toBe(false)
    expect(store.pendingAction).toBeNull()
    expect(store.confirmDispatching).toBe(false) // reset 复位在途信号
    expect(store.notice).toBeNull()
  })

  it('init：订阅 onChatEvent 返回退订函数', () => {
    const store = useVoiceStore()
    const unsub = store.init()
    expect(mockApi.onChatEvent).toHaveBeenCalledTimes(1)
    expect(typeof unsub).toBe('function')
  })
})
