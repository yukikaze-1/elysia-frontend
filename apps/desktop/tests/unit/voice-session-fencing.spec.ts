// tests/unit/voice-session-fencing.spec.ts
// 语音会话栅栏的 **store 级回归测试**：两处本批修掉的真实缺陷。
//
// 这两条都是「迟到事件写到新会话上」的同型缺陷，且**此前没有任何用例覆盖**：
//   ① `dictation.final` 不比对 clientRequestId/会话 → 已取消会话的终态写入 finalText，
//      经 `CyChatInput` 的 watch 插进**当前会话**的草稿（跨会话污染草稿）；
//   ② 录音 / 实时会话的 start **没有在途门** → 连点两次会覆盖 capture 句柄，
//      第一次建立的采集再没有任何入口能停（麦克风持续打开）。
//
// env=node：store 经 stores/desktop-api 注入 mock api + setCaptureFactory 注入 fake capture。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { BackendEvent } from '../../src/shared/contracts'
import { setCaptureFactory, useVoiceStore } from '../../src/renderer/src/stores/voice.store'
import type { PcmCaptureLike, PcmCaptureOptions } from '../../src/renderer/src/voice/voice-capture'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useSettingsStore } from '../../src/renderer/src/stores/settings.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'

const mockApi = createDesktopApiMock()

interface FakeCapture extends PcmCaptureLike {
  start: ReturnType<typeof vi.fn<(opts: PcmCaptureOptions) => Promise<void>>>
  pause: ReturnType<typeof vi.fn<() => Promise<void>>>
  resume: ReturnType<typeof vi.fn<() => Promise<void>>>
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
}

/** 每个实例独立：只有这样才能观察到「句柄被覆盖 ⇒ 旧实例永不 stop」这类缺陷。 */
function makeFakeCapture(): FakeCapture {
  return {
    start: vi.fn(async (_opts: PcmCaptureOptions) => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
}

/** 采集工厂记录每一次创建的实例（默认同一实例会掩盖句柄覆盖缺陷）。 */
let captures: FakeCapture[] = []

function ev<T extends { event: string }>(partial: T): BackendEvent {
  return { eventId: 'e1', sequence: 1, ...partial } as unknown as BackendEvent
}

function subscribe(store: ReturnType<typeof useVoiceStore>): (e: BackendEvent) => void {
  store.init()
  return mockApi.onChatEvent.mock.calls.at(-1)?.[0] as unknown as (e: BackendEvent) => void
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function lastDictationRequestId(): string {
  return mockApi.voiceStartDictation.mock.calls.at(-1)![0].clientRequestId
}

describe('语音会话栅栏（Prompt 4 批次修复）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.clearAllMocks()
    captures = []
    setCaptureFactory(() => {
      const capture = makeFakeCapture()
      captures.push(capture)
      return capture
    })
    mockApi.voiceStartRecord.mockResolvedValue({ recordingId: 'rec_1' })
    mockApi.voiceStopRecord.mockResolvedValue(undefined)
    mockApi.voiceDiscard.mockResolvedValue(undefined)
    mockApi.voiceStartRealtime.mockResolvedValue({ sessionId: 'vs_1' })
    mockApi.voiceStopRealtime.mockResolvedValue(undefined)
    mockApi.voiceCancelRealtime.mockResolvedValue(undefined)
    mockApi.voiceStartDictation.mockResolvedValue({ clientRequestId: 'req_1' })
    mockApi.voiceStopDictation.mockResolvedValue(undefined)
    mockApi.voiceCancelDictation.mockResolvedValue(undefined)
    useConnectionStore().state = { status: 'connected', connectionId: 'cid-1' }
    useConversationStore().$patch({ currentId: 'conv-1' })
    const settings = useSettingsStore()
    settings.voice.consentBackendStt = true
    settings.voice.realtimeEnabled = true
  })

  describe('① dictation.final 归属栅栏（跨会话草稿污染）', () => {
    it('已取消会话的迟到 final 不得写入 finalText（否则会被组件插进当前会话草稿）', async () => {
      const store = useVoiceStore()
      await store.startDictation()
      const staleRequestId = lastDictationRequestId()
      const handler = subscribe(store)

      await store.cancelDictation()
      handler(ev({ event: 'dictation.cancelled', clientRequestId: staleRequestId }))
      expect(store.mode).toBe('idle')

      // 后端在取消之后才把已经算完的终态推回来
      handler(ev({ event: 'dictation.final', clientRequestId: staleRequestId, text: '被取消会话的文本' }))
      expect(store.dictation.finalText, '已取消会话的终态不得落地').toBeUndefined()
      expect(store.dictation.caption).toBe('')
    })

    it('会话 A 的迟到 final 在会话 B 期间到达 → 不得写入 B（异 id 一律拒）', async () => {
      const store = useVoiceStore()
      const handler = subscribe(store)

      await store.startDictation()
      const firstRequestId = lastDictationRequestId()
      handler(ev({ event: 'dictation.final', clientRequestId: firstRequestId, text: 'A 的文本' }))
      store.clearDictationFinal()
      expect(store.mode).toBe('idle')

      await store.startDictation()
      const secondRequestId = lastDictationRequestId()
      expect(secondRequestId).not.toBe(firstRequestId)

      // A 的重复终态（后端重发/双通道投递）在 B 期间到达
      handler(ev({ event: 'dictation.final', clientRequestId: firstRequestId, text: 'A 的文本（重发）' }))
      expect(store.dictation.finalText, 'A 的文本不得进入 B').toBeUndefined()

      // 对照：属于 B 的终态正常落地
      handler(ev({ event: 'dictation.final', clientRequestId: secondRequestId, text: 'B 的文本' }))
      expect(store.dictation.finalText).toBe('B 的文本')
    })

    it('空转写会话（从未 start）时的 final 一律拒（无 id 可归属）', () => {
      const store = useVoiceStore()
      const handler = subscribe(store)
      handler(ev({ event: 'dictation.final', clientRequestId: 'req_x', text: '凭空文本' }))
      expect(store.dictation.finalText).toBeUndefined()
    })

    it('断线 reset 之后到达的 final 不得写入（会话已随连接收口）', async () => {
      const store = useVoiceStore()
      await store.startDictation()
      const staleRequestId = lastDictationRequestId()
      const handler = subscribe(store)
      await store.reset()
      handler(ev({ event: 'dictation.final', clientRequestId: staleRequestId, text: '断线前的文本' }))
      expect(store.dictation.finalText).toBeUndefined()
      expect(store.mode).toBe('idle')
    })
  })

  describe('② start 在途门（麦克风句柄被覆盖）', () => {
    it('录音：在途期间的第二次 start 被拒——只发一条控制帧、只建一个采集', async () => {
      const store = useVoiceStore()
      let release!: () => void
      captures = []
      setCaptureFactory(() => {
        const capture = makeFakeCapture()
        capture.start.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve() }))
        captures.push(capture)
        return capture
      })

      const first = store.startRecord()
      await flush()   // 控制帧已成功、正挂起在采集启动（模拟 getUserMedia / 权限等待）

      await store.startRecord()   // 连点第二下：此刻 mode 仍是 idle
      expect(mockApi.voiceStartRecord, '第二次不得再发控制帧').toHaveBeenCalledTimes(1)
      expect(captures, '不得创建第二个采集实例').toHaveLength(1)

      release()
      await first
      expect(store.mode).toBe('recording')

      // 唯一那个采集仍可被正常停止（句柄没有被覆盖）
      await store.stopRecord()
      expect(captures[0].stop).toHaveBeenCalled()
      expect(store.mode).toBe('record_pending')
    })

    it('实时会话：在途期间的第二次 start 被拒——只发一条控制帧、只建一个采集', async () => {
      const store = useVoiceStore()
      let release!: () => void
      setCaptureFactory(() => {
        const capture = makeFakeCapture()
        capture.start.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve() }))
        captures.push(capture)
        return capture
      })

      const first = store.startRealtime()
      await flush()
      await store.startRealtime()
      expect(mockApi.voiceStartRealtime, '第二次不得再发控制帧').toHaveBeenCalledTimes(1)
      expect(captures).toHaveLength(1)

      release()
      await first
      expect(store.mode).toBe('realtime')
      await store.cancelRealtime()
      expect(captures[0].stop).toHaveBeenCalled()
    })

    it('在途门不粘滞：失败一轮之后仍能重新开始（拒绝路径不会留下永久门）', async () => {
      const store = useVoiceStore()
      mockApi.voiceStartRecord.mockRejectedValueOnce(new Error('[VOICE_SESSION_CONFLICT] 已有语音会话'))
      await store.startRecord()
      expect(store.mode).toBe('idle')
      expect(store.error?.code).toBe('VOICE_SESSION_CONFLICT')

      mockApi.voiceStartRecord.mockResolvedValue({ recordingId: 'rec_2' })
      await store.startRecord()
      expect(store.mode).toBe('recording')
      expect(mockApi.voiceStartRecord).toHaveBeenCalledTimes(2)
    })

    it('录音与实时互斥：录音在途期间不得起实时会话（同一个采集句柄）', async () => {
      const store = useVoiceStore()
      let release!: () => void
      setCaptureFactory(() => {
        const capture = makeFakeCapture()
        capture.start.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve() }))
        captures.push(capture)
        return capture
      })

      const record = store.startRecord()
      await flush()
      await store.startRealtime()
      expect(mockApi.voiceStartRealtime).not.toHaveBeenCalled()

      release()
      await record
      expect(store.mode).toBe('recording')
    })
  })

  describe('③ 实时会话事件的 sessionId 栅栏', () => {
    it('另一次实时会话的 ended 不得停掉当前采集', async () => {
      const store = useVoiceStore()
      await store.startRealtime()
      const handler = subscribe(store)
      handler(ev({ event: 'voice_session.started', sessionId: 'vs_current', conversationId: 'conv-1' }))
      expect(store.realtime.sessionId).toBe('vs_current')

      const capture = captures[0]
      handler(ev({ event: 'voice_session.ended', sessionId: 'vs_stale', reason: 'stopped' }))
      expect(capture.stop, '异会话的 ended 不得停当前采集').not.toHaveBeenCalled()
      expect(store.mode).toBe('realtime')
      expect(store.realtime.sessionId).toBe('vs_current')

      // 对照：本会话的 ended 正常收敛
      handler(ev({ event: 'voice_session.ended', sessionId: 'vs_current', reason: 'stopped' }))
      expect(capture.stop).toHaveBeenCalled()
      expect(store.mode).toBe('idle')
    })

    it('另一次实时会话的 ack 不得改写当前会话的背压读数', async () => {
      const store = useVoiceStore()
      await store.startRealtime()
      const handler = subscribe(store)
      handler(ev({ event: 'voice_session.started', sessionId: 'vs_current', conversationId: 'conv-1' }))
      handler(ev({ event: 'voice_session.ack', sessionId: 'vs_stale', seq: 42 }))
      expect(store.realtime.lastAckedSeq).toBe(0)
      handler(ev({ event: 'voice_session.ack', sessionId: 'vs_current', seq: 7 }))
      expect(store.realtime.lastAckedSeq).toBe(7)
    })

    it('会话结束后到达的旧会话事件不再生效（确认被清）', async () => {
      const store = useVoiceStore()
      await store.startRealtime()
      const handler = subscribe(store)
      handler(ev({ event: 'voice_session.started', sessionId: 'vs_current', conversationId: 'conv-1' }))
      handler(ev({ event: 'voice_session.ended', sessionId: 'vs_current', reason: 'stopped' }))
      expect(store.mode).toBe('idle')

      const staleAck = ev({ event: 'voice_session.ack', sessionId: 'vs_current', seq: 99 })
      handler(staleAck)
      // 确认已清 ⇒ 下一次会话前无「当前会话」可归属；此处断言的是不产生跨会话残留。
      expect(store.realtime.lastAckedSeq).toBe(0)
    })

    it('`started` 在 capture.start 之前到达也必须被接受（建立会话的事件不得被自己的栅栏丢掉）', async () => {
      // 对抗复核实测的回归：栅栏若以 `mode === 'realtime'` 为活跃判据，就会丢掉这条事件——
      // mode 要等 `await capture.start()`（getUserMedia）之后才置位，而 started 紧随控制帧到达。
      // 后果：后端确认的标识永远落不下来（stop/cancel 发错 id），且栅栏在整个会话里 fail-open。
      const store = useVoiceStore()
      let release!: () => void
      setCaptureFactory(() => {
        const capture = makeFakeCapture()
        capture.start.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve() }))
        captures.push(capture)
        return capture
      })

      const started = store.startRealtime()
      await flush()   // 控制帧已成功、正挂起在 getUserMedia 窗口内（此刻 mode 仍是 idle）
      expect(store.mode).toBe('idle')

      const handler = subscribe(store)
      handler(ev({ event: 'voice_session.started', sessionId: 'vs_backend', conversationId: 'conv-1' }))
      expect(store.realtime.sessionId, '后端确认的标识必须落地').toBe('vs_backend')

      release()
      await started
      expect(store.realtime.sessionId).toBe('vs_backend')
      // stop/cancel 必须用后端确认值（控制帧上行的是本地生成的 vs_<uuid>）
      await store.cancelRealtime()
      expect(mockApi.voiceCancelRealtime).toHaveBeenCalledWith({ sessionId: 'vs_backend' })
    })

    it('`started` 之后异会话的 ended 被挡（栅栏在正常时序下也真的生效）', async () => {
      const store = useVoiceStore()
      let release!: () => void
      setCaptureFactory(() => {
        const capture = makeFakeCapture()
        capture.start.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve() }))
        captures.push(capture)
        return capture
      })
      const started = store.startRealtime()
      await flush()
      const handler = subscribe(store)
      handler(ev({ event: 'voice_session.started', sessionId: 'vs_mine', conversationId: 'conv-1' }))
      release()
      await started
      expect(store.mode).toBe('realtime')

      const capture = captures[0]
      handler(ev({ event: 'voice_session.ended', sessionId: 'vs_foreign', reason: 'stopped' }))
      expect(capture.stop, '异会话 ended 不得停当前采集').not.toHaveBeenCalled()
      expect(store.mode).toBe('realtime')
    })

    it('stopRealtime 之后 ended 仍能进来（会话在栅栏意义上保持活跃直到 ended）', async () => {
      const store = useVoiceStore()
      await store.startRealtime()
      const handler = subscribe(store)
      handler(ev({ event: 'voice_session.started', sessionId: 'vs_1', conversationId: 'conv-1' }))
      await store.stopRealtime()
      expect(store.mode).toBe('realtime')   // 清态由 ended 完成
      handler(ev({ event: 'voice_session.ended', sessionId: 'vs_1', reason: 'stopped' }))
      expect(store.mode).toBe('idle')
    })
  })

  describe('④ dictation.cancelled 归属栅栏（与 final 同一条判据）', () => {
    it('外来 cancelled 不得清掉当前转写会话（否则采集失联、stopDictation 早退）', async () => {
      const store = useVoiceStore()
      await store.startDictation()
      const requestId = lastDictationRequestId()
      const handler = subscribe(store)
      const capture = captures[captures.length - 1]

      handler(ev({ event: 'dictation.cancelled', clientRequestId: 'req_foreign' }))
      expect(store.mode, '外来 cancelled 不得把模式打回空闲').toBe('dictating')

      // 采集仍在跑 ⇒ 本次会话的停止入口必须仍然有效
      await store.stopDictation()
      expect(capture.stop).toHaveBeenCalled()
      expect(mockApi.voiceStopDictation).toHaveBeenCalledWith({ clientRequestId: requestId })
    })

    it('本次会话的 cancelled 正常清态回空闲', async () => {
      const store = useVoiceStore()
      await store.startDictation()
      const requestId = lastDictationRequestId()
      const handler = subscribe(store)
      handler(ev({ event: 'dictation.cancelled', clientRequestId: requestId }))
      expect(store.mode).toBe('idle')
      expect(store.dictation.caption).toBe('')
    })
  })

  /**
   * ⑤ `sessionStartGeneration` 跨 `reset()` 的世代栅栏。
   *
   * 缺陷：断线/会话切换时 `reset()` 已停采集并把 `capture` 置 null，但一个正挂起在
   * `await api.voiceStartXxx()` 或 `await capture.start()` 的 start 会在它**之后**才恢复——
   * 它会重新赋值 `capture`、把 `mode` 翻回 recording/realtime。界面上没有任何停止入口
   * （reset 已经跑完），麦克风就此失联。
   *
   * 与在途门（`sessionStartInFlight`）是两件事：在途门只挡「同一时刻的第二次进入」，
   * 挡不住「一次进入跨越了 reset」。故这两组用例必须覆盖**每一个** await 边界。
   */
  describe('⑤ 在途 start 跨越 reset()：世代栅栏', () => {
    /** 让 `capture.start()` 挂起，返回一个手动放行的控制器。 */
    function deferCaptureStart(): { owned: () => FakeCapture; release: () => void } {
      let owned: FakeCapture | undefined
      let release!: () => void
      setCaptureFactory(() => {
        const capture = makeFakeCapture()
        capture.start.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve() }))
        captures.push(capture)
        owned = capture
        return capture
      })
      return { owned: () => owned!, release: () => release() }
    }

    // —— 录音 ——

    it('录音：控制帧在途时 reset() → 旧 start 不建采集、不写回 mode、新建会话状态不被覆盖', async () => {
      const store = useVoiceStore()
      let ackControlFrame!: () => void
      mockApi.voiceStartRecord.mockImplementationOnce(() => new Promise((resolve) => {
        ackControlFrame = () => resolve({ recordingId: 'rec_1' })
      }))

      const abandoned = store.startRecord()
      await flush()   // 控制帧尚未 resolve
      expect(store.mode).toBe('idle')

      await store.reset()
      expect(mockApi.voiceStartRecord, '控制帧已发出（无法撤回）').toHaveBeenCalledTimes(1)

      ackControlFrame()   // 旧 start 在 reset 之后才恢复
      await abandoned

      expect(store.mode, 'reset 之后不得重新进入 recording').toBe('idle')
      expect(store.captureReady).toBe(false)
      expect(captures, 'reset 之后不得再建采集').toHaveLength(0)
      expect(store.record.awaitingTranscript).toBe(false)
    })

    it('录音：采集启动在途时 reset() → 旧采集被 abandon（stop 被调、句柄不被当成当前采集）', async () => {
      const store = useVoiceStore()
      const deferred = deferCaptureStart()

      const abandoned = store.startRecord()
      await flush()   // 控制帧已成功、正挂起在 capture.start()
      expect(store.mode, '此刻 mode 仍是 idle（成功后才置位）').toBe('idle')

      await store.reset()
      expect(deferred.owned().stop, 'reset 停的是它自己看到的句柄').toHaveBeenCalledTimes(1)

      deferred.release()
      await abandoned

      expect(store.mode, 'reset 之后不得重新进入 recording').toBe('idle')
      expect(store.captureReady).toBe(false)
      expect(deferred.owned().stop, '被作废的采集必须真的被停掉（否则麦克风失联）').toHaveBeenCalledTimes(2)
      expect(captures).toHaveLength(1)
    })

    it('被作废的 start 不影响其后开始的新会话（旧 start 先收尾 → 新 start 正常建立，两者互不破坏）', async () => {
      const store = useVoiceStore()
      const abandonedDeferred = deferCaptureStart()

      const abandoned = store.startRecord()
      await flush()   // 控制帧已成功、挂起在 capture.start()
      await store.reset()

      // 旧 start 先完成自己的收尾（在途门随之复位）
      abandonedDeferred.release()
      await abandoned
      expect(store.mode).toBe('idle')

      // 其后用户重新开始一次录音（新世代）
      const freshCapture = makeFakeCapture()
      captures.push(freshCapture)
      setCaptureFactory(() => freshCapture)
      await store.startRecord()
      expect(store.mode).toBe('recording')
      expect(store.captureReady).toBe(true)
      expect(freshCapture.stop, '新会话的采集不得被旧 start 收尾').not.toHaveBeenCalled()

      // 新会话仍是可停止的：句柄指向自己那一个
      await store.stopRecord()
      expect(freshCapture.stop).toHaveBeenCalledTimes(1)
      expect(mockApi.voiceStopRecord).toHaveBeenCalledTimes(1)
    })

    it('在途门与世代门是两道门：旧 start 尚在途时新 start 被拒，旧 start 收尾后即可开始', async () => {
      // 这一条有意固化两道门的**分工**：在途门负责「同一时刻只有一次 start」，
      // 世代门负责「跨越 reset 的那次必须作废」。旧 start 仍挂起 ⇒ 门仍关着（不是缺陷，是串行化）。
      const store = useVoiceStore()
      let ackControlFrame!: () => void
      mockApi.voiceStartRecord.mockImplementationOnce(() => new Promise((resolve) => {
        ackControlFrame = () => resolve({ recordingId: 'rec_old' })
      }))

      const abandoned = store.startRecord()
      await flush()
      await store.reset()

      await store.startRecord()
      expect(mockApi.voiceStartRecord, '旧 start 在途 ⇒ 新 start 被在途门拒').toHaveBeenCalledTimes(1)

      ackControlFrame()
      await abandoned
      expect(store.mode).toBe('idle')

      await store.startRecord()
      expect(mockApi.voiceStartRecord).toHaveBeenCalledTimes(2)
      expect(store.mode).toBe('recording')
    })

    // —— 实时会话（与录音的**关键差异**：它还会写 `realtimeSessionActive` / `realtime.sessionId`） ——

    it('实时：控制帧在途时 reset() → 不登记会话、不建采集、mode 不回 realtime', async () => {
      const store = useVoiceStore()
      let ackControlFrame!: () => void
      mockApi.voiceStartRealtime.mockImplementationOnce(() => new Promise((resolve) => {
        ackControlFrame = () => resolve({ sessionId: 'vs_1' })
      }))

      const abandoned = store.startRealtime()
      await flush()

      await store.reset()
      ackControlFrame()
      await abandoned

      expect(store.mode).toBe('idle')
      expect(store.captureReady).toBe(false)
      expect(captures).toHaveLength(0)
      expect(store.realtime.sessionId, 'reset 之后不得登记会话标识').toBeUndefined()
    })

    it('实时：采集启动在途时 reset() → 旧采集被 abandon，且会话活跃标志必须被清', async () => {
      const store = useVoiceStore()
      const deferred = deferCaptureStart()

      const abandoned = store.startRealtime()
      await flush()   // 控制帧已被接受 ⇒ realtimeSessionActive 已置位、realtime.sessionId 已写入

      await store.reset()
      expect(deferred.owned().stop).toHaveBeenCalledTimes(1)

      deferred.release()
      await abandoned

      expect(store.mode, 'reset 之后不得重新进入 realtime').toBe('idle')
      expect(store.captureReady).toBe(false)
      expect(deferred.owned().stop, '被作废的采集必须真的被停掉').toHaveBeenCalledTimes(2)
      // 关键：活跃标志未清的话，下一次会话期间一条异会话事件就能通过栅栏（fail-open）。
      // reset 已清它，故此刻任何 voice_session.* 都不再被接受。
      const handler = subscribe(store)
      const capture = deferred.owned()
      handler(ev({ event: 'voice_session.ended', sessionId: 'vs_1', reason: 'stopped' }))
      expect(store.mode).toBe('idle')
      expect(capture.stop).toHaveBeenCalledTimes(2)   // 第三条 ended 不再叠加一次 stop
    })

    // —— 转写（第三个入口共用同一栅栏；其自身 owner 判据已由 P1-6 用例覆盖） ——

    it('转写：采集启动在途时 reset() → 旧采集被 abandon、不进入 dictating、会话标识不残留', async () => {
      const store = useVoiceStore()
      const deferred = deferCaptureStart()

      const abandoned = store.startDictation()
      await flush()

      await store.reset()
      deferred.release()
      await abandoned

      expect(store.mode).toBe('idle')
      expect(store.captureReady).toBe(false)
      expect(store.dictation.finalText).toBeUndefined()
      expect(deferred.owned().stop, '被作废的采集必须真的被停掉').toHaveBeenCalled()
      // 旧 session 的终态在 reset 之后到达：id 已释放 ⇒ 被归属栅栏拒
      const handler = subscribe(store)
      handler(ev({ event: 'dictation.final', clientRequestId: lastDictationRequestId(), text: '不该落地的文本' }))
      expect(store.dictation.finalText).toBeUndefined()
    })

    it('世代栅栏不误伤：reset() 之后开始的新 start 不受影响（门与世代都已复位）', async () => {
      const store = useVoiceStore()
      await store.reset()
      await store.startRecord()
      expect(store.mode).toBe('recording')
      expect(store.captureReady).toBe(true)
      await store.discardRecord()
      expect(store.mode).toBe('idle')
    })
  })
})
