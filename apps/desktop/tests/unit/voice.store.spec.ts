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
import { createDesktopApiMock } from './helpers/desktop-api'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`）。
const mockApi = createDesktopApiMock()

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

/** 事件外壳：BackendEvent 判别字段 + envelope 最小集 */
function ev<T extends { event: string }>(partial: T): BackendEvent {
  return { eventId: 'e1', sequence: 1, ...partial } as unknown as BackendEvent
}

/**
 * `expect.stringMatching()` 在 @vitest/expect 的公开类型里返回 `any`
 * （`node_modules/@vitest/expect/dist/index.d.ts`：`stringMatching: (expected: string | RegExp) => any`）。
 * 直接写进期望对象会让该属性退化成 `any`（no-unsafe-assignment）。运行时它返回的是 vitest 的
 * asymmetric matcher（相等引擎按 `asymmetricMatch` 特判），本 spec 里这些位置恒代表一个字符串，
 * 故在这一处（且仅此一处）把它收窄成 `string`——**期望值本身一字未改**。
 */
function stringMatching(pattern: RegExp): string {
  return expect.stringMatching(pattern) as string
}

function onChunk(bytes: Uint8Array): void {
  const opts = fake.start.mock.calls[0][0]
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
    // I-06：此处原有 `settingsSave.mockImplementation(async (patch: unknown) => …)`——窄化的 `unknown`
    // 参数在类型化 mock 下不可赋值，而它回包的合并态**没人读**（voiceStore 不读 settingsSave 返回值）。
    // 实测直接删掉：工厂默认实现返回完整的 settingsState，比这个只含 version/voice/dictation 的
    // 半截对象更贴近契约。保留 `mockApi.settingsSave` 的调用断言不受影响。
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
    expect(mockApi.voiceStartRecord).toHaveBeenCalledWith({ recordingId: stringMatching(/^rec_/) })
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
    const opts = fake.start.mock.calls[0][0]
    expect(typeof opts.onChunk).toBe('function')
    expect(typeof opts.onStop).toBe('function')
    expect(opts.deviceId).toBeUndefined() // 缺省 micDeviceId
    expect(store.mode).toBe('recording')
    expect(store.captureReady).toBe(true)
    expect(store.record.elapsedMs).toBe(0)
  })

  // —— doc 11 §3.3「语音活动检测／静音结束」（2026-09-13）：默认关闭；开启后把配置交给采集层 ——
  it('record：silenceAutoStop 默认关闭 → 不给采集层传 silence（行为与开启该设置前一致）', async () => {
    const store = useVoiceStore()
    await store.startRecord()
    const opts = fake.start.mock.calls[0][0]
    expect(opts.silence).toBeUndefined()
    expect(useSettingsStore().voice.silenceAutoStop).toBe(false)
  })

  it('record：开启后按设置传 durationMs，onSilence 触发即停止录音 + 给出可见提示', async () => {
    const settings = useSettingsStore()
    settings.setVoice({ silenceAutoStop: true, silenceStopMs: 1500 })
    const store = useVoiceStore()
    await store.startRecord()
    const opts = fake.start.mock.calls[0][0]
    expect(opts.silence?.durationMs).toBe(1500)

    // 采集层判定静音到点 → 走的是与手动停止完全相同的路径（voiceStopRecord + record_pending）
    opts.silence!.onSilence()
    await vi.waitFor(() => { expect(mockApi.voiceStopRecord).toHaveBeenCalledTimes(1) })
    expect(store.mode).toBe('record_pending')
    expect(store.notice, '自动结束要有可见提示，不做静默行为变更').toContain('静音')
  })

  it('record：start→stop→transcript→commit → sendVoiceCommit(recordingId, transcript) + 清态', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.mode).toBe('record_pending')
    expect(mockApi.voiceStopRecord).toHaveBeenCalledWith({ recordingId: stringMatching(/^rec_/) })
    const handler = subscribe(store)
    handler(ev({ event: 'voice.transcript', recordingId: lastRecordingId(), text: '你好世界' }))
    expect(store.record.transcript).toBe('你好世界')
    expect(store.caption).toBe('你好世界')
    const ok = await store.commitRecord()
    expect(ok).toBe(true)
    expect(mockApi.voiceCommit).toHaveBeenCalledWith(expect.objectContaining({ recordingId: stringMatching(/^rec_/), text: '你好世界' }))
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
    expect(mockApi.voiceDiscard).toHaveBeenCalledWith({ recordingId: stringMatching(/^rec_/) })
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
    expect(store.caption).toBe('慢字幕') // 字幕同样未被 45s 兜底清空——若 handler 未清 timer 则此断言失败
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

  it('record：micError——capture.start 拒绝 → micError + voiceDiscard 同 recordingId + discard resolve 后清态（P0-01）', async () => {
    fake.start.mockRejectedValue(new Error('[NOT_ALLOWED] 麦克风权限被拒绝'))
    let resolveDiscard!: () => void
    mockApi.voiceDiscard.mockImplementationOnce(() => new Promise<void>((r) => { resolveDiscard = r }))
    const store = useVoiceStore()
    const p = store.startRecord()
    await vi.waitFor(() => expect(mockApi.voiceDiscard).toHaveBeenCalled())
    expect(store.micError?.code).toBe('NOT_ALLOWED')
    expect(store.micError?.message).toContain('麦克风权限被拒绝')
    // 同一 recordingId：discard 保留 startRecord 生成的 id（不提前清、不丢关联）
    const startId = mockApi.voiceStartRecord.mock.calls[0][0].recordingId
    expect(mockApi.voiceDiscard).toHaveBeenCalledWith({ recordingId: startId })
    resolveDiscard()
    await p
    // order：discard resolve 后才清态（mode=idle / record / caption）
    expect(store.mode).toBe('idle')
    expect(store.captureReady).toBe(false)
    expect(store.record.elapsedMs).toBe(0)
    expect(store.record.audioBuffer).toBeNull()
    expect(store.caption).toBe('')
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

  it('record：P0-01 capture 失败 + voiceDiscard reject（断线）→ 无未处理拒绝、本地态清、micError 保留', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.start.mockRejectedValue(new Error('[NOT_ALLOWED] 麦克风权限被拒绝'))
    mockApi.voiceDiscard.mockRejectedValue(new Error('[IPC_ERROR] 连接已断开'))
    const store = useVoiceStore()
    await expect(store.startRecord()).resolves.toBeUndefined() // 不抛未处理拒绝
    expect(store.micError?.code).toBe('NOT_ALLOWED') // micError 保留（clearRecordState 不碰；composer banner 依赖）
    expect(store.mode).toBe('idle')
    expect(store.captureReady).toBe(false)
    expect(store.record.elapsedMs).toBe(0)
    expect(store.caption).toBe('')
    expect(mockApi.voiceDiscard).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled() // R-S4-01 不静默：console.warn 留痕
    warnSpy.mockRestore()
  })

  it('record：P0-01 待发送删除 + voiceDiscard reject → 清态 + 不 throw', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApi.voiceDiscard.mockRejectedValue(new Error('[IPC_ERROR] 连接已断开'))
    const store = useVoiceStore()
    await store.startRecord()
    await store.stopRecord()
    expect(store.mode).toBe('record_pending')
    await expect(store.discardRecord()).resolves.toBeUndefined() // reject 被收敛，不 throw
    expect(store.mode).toBe('idle')
    expect(store.record.elapsedMs).toBe(0)
    expect(store.record.awaitingTranscript).toBe(false)
    expect(store.caption).toBe('')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('record：P0-01 污染闭环——重录后旧会话迟到 voice.error 不污染新录音展示（R-S4-06 门控）', async () => {
    vi.useFakeTimers()
    const store = useVoiceStore()
    const handler = subscribe(store)
    // 第一轮：record → discard
    await store.startRecord()
    const oldId = lastRecordingId()
    await store.stopRecord()
    await store.discardRecord()
    expect(store.mode).toBe('idle')
    // 第二轮：新录音进入 recording（重录已清陈旧 error）
    await store.startRecord()
    const newId = lastRecordingId()
    expect(newId).not.toBe(oldId)
    expect(store.mode).toBe('recording')
    // 旧会话迟到 voice.error 在 recording 态被门控丢弃（R-S4-06）
    handler(ev({ event: 'voice.error', code: 'VOICE_RECORDING_NOT_FOUND', message: '旧会话迟到错误' }))
    expect(store.error).toBeUndefined()
    // stop → 新字幕到达 → error 仍 undefined + 待发送条显示新字幕
    await store.stopRecord()
    handler(ev({ event: 'voice.transcript', recordingId: newId, text: '新录音字幕' }))
    expect(store.error).toBeUndefined()
    expect(store.record.transcript).toBe('新录音字幕')
    expect(store.caption).toBe('新录音字幕')
    expect(store.mode).toBe('record_pending')
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
    const srcMock = { buffer: null, connect: vi.fn(), start: vi.fn(), onended: undefined as undefined | (() => void) }
    const ctxMock = { createBufferSource: vi.fn(() => srcMock), destination: {}, close: vi.fn(async () => {}) }
    vi.stubGlobal('AudioContext', vi.fn(function () { return ctxMock }))
    const store = useVoiceStore()
    store.record.audioBuffer = {} as unknown as AudioBuffer
    store.replayRecord()
    expect(ctxMock.createBufferSource).toHaveBeenCalled()
    expect(srcMock.buffer).toBeDefined()
    expect(srcMock.connect).toHaveBeenCalled()
    expect(srcMock.start).toHaveBeenCalled()
    // 2026-09-16 审计 P2：播放自然结束即关闭 AudioContext（修复前从不 close ⇒ 每次试听泄漏一个，
    // Chromium 每进程上限约 6 个，试听几次后新建即失败）
    expect(ctxMock.close).not.toHaveBeenCalled()
    srcMock.onended?.()
    expect(ctxMock.close).toHaveBeenCalledTimes(1)
  })

  it('record：replayRecord——无 audioBuffer → 不播放（no-op）', () => {
    const store = useVoiceStore()
    expect(() => store.replayRecord()).not.toThrow()
  })

  // —— 实时会话 ——

  it('realtime：start → voiceStartRealtime(带 conversationId) + 采集', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    expect(mockApi.voiceStartRealtime).toHaveBeenCalledWith({ sessionId: stringMatching(/^vs_/), conversationId: 'conv-1' })
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
    expect(mockApi.voiceStopRealtime).toHaveBeenCalledWith({ sessionId: stringMatching(/^vs_/) })
    expect(store.mode).toBe('realtime') // 清态由 ended 事件完成
    const handler = subscribe(store)
    handler(ev({ event: 'voice_session.ended', sessionId: 'vs_1', reason: 'stopped' }))
    expect(store.mode).toBe('idle')
  })

  it('realtime：cancelRealtime → voiceCancelRealtime', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    await store.cancelRealtime()
    expect(mockApi.voiceCancelRealtime).toHaveBeenCalledWith({ sessionId: stringMatching(/^vs_/) })
  })

  it('realtime：micError——capture.start 拒绝 → micError + 模式回 idle + voiceCancelRealtime', async () => {
    fake.start.mockRejectedValue(new Error('[DEVICE_IN_USE] 设备被占用'))
    const store = useVoiceStore()
    await store.startRealtime()
    expect(store.micError?.code).toBe('DEVICE_IN_USE')
    expect(store.mode).toBe('idle')
    expect(store.captureReady).toBe(false)
    expect(mockApi.voiceCancelRealtime).toHaveBeenCalledWith({ sessionId: stringMatching(/^vs_/) })
  })

  // —— 输入法转写 ——

  it('dictation：sttProfileId 透传（start 载荷含 sttProfileId）', async () => {
    useSettingsStore().dictation.sttProfileId = 'stt/p1'
    const store = useVoiceStore()
    await store.startDictation()
    expect(mockApi.voiceStartDictation).toHaveBeenCalledWith({ clientRequestId: stringMatching(/^req_/), sttProfileId: 'stt/p1' })
    expect(fake.start).toHaveBeenCalled()
    expect(store.mode).toBe('dictating')
  })

  it('dictation：无 sttProfileId → 载荷不带该键（缺省全局活动 STT，M-4）', async () => {
    useSettingsStore().dictation.sttProfileId = undefined
    const store = useVoiceStore()
    await store.startDictation()
    expect(mockApi.voiceStartDictation).toHaveBeenCalledWith({ clientRequestId: stringMatching(/^req_/) })
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
    expect(mockApi.voiceCancelDictation).toHaveBeenCalledWith({ clientRequestId: stringMatching(/^req_/) })
    const handler = subscribe(store)
    handler(ev({ event: 'dictation.cancelled', clientRequestId: 'req_1' }))
    expect(store.dictation.caption).toBe('')
    expect(store.mode).toBe('idle')
  })

  it('dictation：stopDictation → voiceStopDictation', async () => {
    const store = useVoiceStore()
    await store.startDictation()
    await store.stopDictation()
    expect(mockApi.voiceStopDictation).toHaveBeenCalledWith({ clientRequestId: stringMatching(/^req_/) })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2026-09-16 审计 P1-6：dictation 共享会话标识的竞态
  //
  // 缺陷：`startDictation` 的失败分支按「我这次失败」清理**共享单例态**。用户
  // 「按住 → 松开 → 立刻再按」即可命中：第一次 start 的 id 是 `await` 之后才记入的，
  // 松开时 `stopDictation` 因 id 为空而早退；再按时 mode 仍是 idle ⇒ 第二次 start 进入、
  // 被 Main 互斥门拒绝，其 catch 清掉共享的 dictationClientRequestId 与 capture ⇒
  // 第一次随后成功建立采集并置 dictating，但停止入口已经没了 ⇒ **麦克风持续采集且不可自愈**
  // （该标识全仓没有任何事件回写它，只能断线或重启）。
  // ───────────────────────────────────────────────────────────────────────────
  describe('P1-6 dictation 竞态：in-flight 门 + 共享标识的 owner 判据', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0))

    it('第二次 start 在 in-flight 期间被拒绝，且第一次建立的采集仍可正常停止', async () => {
      const store = useVoiceStore()
      let releaseCapture!: () => void
      fake.start.mockImplementation(() => new Promise<void>((r) => { releaseCapture = () => r() }))
      const first = store.startDictation()
      await flush()   // 控制帧已成功、标识已记入，正挂起在采集启动（模拟 getUserMedia / 权限等待）

      // 「松开立刻再按」：此刻 mode 仍是 idle，第二次 start 会一路走到 store 内部
      await store.startDictation()

      expect(mockApi.voiceStartDictation, '被 in-flight 门挡下：不得再发第二次控制帧').toHaveBeenCalledTimes(1)

      releaseCapture()
      await first

      expect(store.mode).toBe('dictating')
      await store.stopDictation()
      expect(fake.stop, '第一次建立的采集必须仍能被停止——这正是原缺陷丢掉的入口').toHaveBeenCalled()
      expect(mockApi.voiceStopDictation).toHaveBeenCalledTimes(1)
    })

    it('控制帧在途时停止（id 尚未记入）：该次 start 必须自我收尾，不得留下「在采集却无人能停」', async () => {
      const store = useVoiceStore()
      let releaseStart!: () => void
      mockApi.voiceStartDictation.mockImplementationOnce(
        () => new Promise((r) => { releaseStart = () => r({ clientRequestId: 'req_x' }) })
      )
      const running = store.startDictation()
      await flush()

      await store.stopDictation()   // id 仍为空 → 早退（正是报告描述的 t5）
      releaseStart()
      await running

      expect(fake.start, '已被接管的 start 不得再开麦克风').not.toHaveBeenCalled()
      expect(store.mode).toBe('idle')
      expect(mockApi.voiceCancelDictation, '后端会话不得悬挂').toHaveBeenCalled()
    })

    it('采集启动在途时停止：start 收尾必须停掉已经起来的采集并保持 idle', async () => {
      const store = useVoiceStore()
      let releaseCapture!: () => void
      fake.start.mockImplementation(() => new Promise<void>((r) => { releaseCapture = () => r() }))
      const running = store.startDictation()
      await flush()

      await store.stopDictation()
      releaseCapture()
      await running

      expect(store.mode, '被停止的 start 不得再进入 dictating').toBe('idle')
      expect(fake.stop).toHaveBeenCalled()
    })

    it('in-flight 门不粘滞：正常一轮结束后可以再次开始', async () => {
      const store = useVoiceStore()
      await store.startDictation()
      expect(store.mode).toBe('dictating')
      const handler = subscribe(store)
      handler(ev({ event: 'dictation.final', clientRequestId: 'req_1', text: '文本' }))
      store.clearDictationFinal()   // 组件消费后回 idle
      await store.startDictation()
      expect(mockApi.voiceStartDictation).toHaveBeenCalledTimes(2)
      expect(store.mode).toBe('dictating')
    })
  })

  it('dictation：micError——capture.start 拒绝 → micError + 模式回 idle + voiceCancelDictation', async () => {
    fake.start.mockRejectedValue(new Error('[IPC_ERROR] 无可用麦克风'))
    const store = useVoiceStore()
    await store.startDictation()
    expect(store.micError?.message).toContain('无可用麦克风')
    expect(store.mode).toBe('idle')
    expect(mockApi.voiceCancelDictation).toHaveBeenCalledWith({ clientRequestId: stringMatching(/^req_/) })
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
    handler(ev({ event: 'audio.session.started', streamId: 1 }))
    handler(ev({ event: 'audio.session.ready', streamId: 1, url: 'u' }))
    expect(store.tts.playing).toBe(false)
    expect(store.tts.url).toBeUndefined()
  })

  it('tts：多角色能力开启后仅接收当前会话的完整角色快照', () => {
    useConnectionStore().state = {
      status: 'connected',
      connectionId: 'cid-character',
      features: { characterProfiles: true, characterStateStream: true }
    }
    useConversationStore().$patch({
      currentId: 'conv-b',
      items: [{
        id: 'conv-b',
        title: 'B',
        updatedAt: '2026-09-09T00:00:00.000Z',
        character: {
          characterId: 'character-b',
          characterInstanceId: 'instance-b',
          characterRevision: 3,
          displayName: 'B',
          presentation: {}
        }
      }]
    })
    const activeIdentity = {
      conversationId: 'conv-b',
      characterId: 'character-b',
      characterInstanceId: 'instance-b',
      characterRevision: 3
    }
    const staleIdentity = {
      conversationId: 'conv-a',
      characterId: 'character-a',
      characterInstanceId: 'instance-a',
      characterRevision: 1
    }
    const store = useVoiceStore()
    const handler = subscribe(store)

    handler(ev({ event: 'audio.session.started', streamId: 9 }))
    expect(store.tts.playingStreamId).toBeUndefined()

    handler(ev({ event: 'audio.session.started', streamId: 10, ...staleIdentity }))
    handler(ev({ event: 'audio.session.ready', streamId: 10, url: 'stale', ...staleIdentity }))
    expect(store.tts.playingStreamId).toBeUndefined()
    expect(store.ttsReadySeen).toBe(false)

    handler(ev({ event: 'audio.session.started', streamId: 11, ...activeIdentity }))
    handler(ev({ event: 'audio.session.ready', streamId: 11, url: 'active', ...activeIdentity }))
    expect(store.tts).toMatchObject({ playingStreamId: 11, url: 'active', playing: true })
    expect(store.ttsReadySeen).toBe(true)
  })

  it('tts：迟到的旧 stream ready/cancelled 不覆盖当前播放', () => {
    const store = useVoiceStore()
    const handler = subscribe(store)

    handler(ev({ event: 'audio.session.started', streamId: 20 }))
    handler(ev({ event: 'audio.session.started', streamId: 21 }))
    handler(ev({ event: 'audio.session.ready', streamId: 20, url: 'stale' }))
    expect(store.tts).toMatchObject({ playingStreamId: 21, playing: false })

    handler(ev({ event: 'audio.session.ready', streamId: 21, url: 'active' }))
    handler(ev({ event: 'audio.session.cancelled', streamId: 20 }))
    expect(store.tts).toMatchObject({ playingStreamId: 21, url: 'active', playing: true })
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

  // —— 视图切换收敛（2026-09-16 审计 P2：chat 是 v-if，停止入口只在聊天区内） ——

  it('convergeForViewChange：录音中离开聊天区 → 按**取消**语义收尾（停采集 + voiceDiscard + 回 idle）', async () => {
    const store = useVoiceStore()
    await store.startRecord()
    expect(store.mode).toBe('recording')
    await store.convergeForViewChange()
    expect(fake.stop).toHaveBeenCalled()                 // 麦克风真的关掉了（修复前：一直开着且无停止入口）
    expect(mockApi.voiceDiscard).toHaveBeenCalledWith({ recordingId: stringMatching(/^rec_/) })
    expect(store.mode).toBe('idle')
  })

  it('convergeForViewChange：实时语音中离开聊天区 → cancel 语义（voiceCancelRealtime + 回 idle）', async () => {
    const store = useVoiceStore()
    await store.startRealtime()
    expect(store.mode).toBe('realtime')
    await store.convergeForViewChange()
    expect(fake.stop).toHaveBeenCalled()
    expect(mockApi.voiceCancelRealtime).toHaveBeenCalledWith({ sessionId: stringMatching(/^vs_/) })
    expect(mockApi.voiceStopRealtime).not.toHaveBeenCalled()   // 不是"正常结束"，是"放弃"
  })

  it('convergeForViewChange：无在途采集时是纯 no-op（幂等；不碰 dictation/TTS/错误字段）', async () => {
    const store = useVoiceStore()
    store.$patch({ tts: { playingStreamId: 3, url: 'u', playing: true } })
    await store.convergeForViewChange()
    expect(mockApi.voiceDiscard).not.toHaveBeenCalled()
    expect(mockApi.voiceCancelRealtime).not.toHaveBeenCalled()
    expect(mockApi.voiceCancelDictation).not.toHaveBeenCalled()
    expect(store.tts.playing).toBe(true)                 // TTS 播放不因切视图被打断
    expect(store.mode).toBe('idle')
  })

  it('init：订阅 onChatEvent 返回退订函数', () => {
    const store = useVoiceStore()
    const unsub = store.init()
    expect(mockApi.onChatEvent).toHaveBeenCalledTimes(1)
    expect(typeof unsub).toBe('function')
  })
})
