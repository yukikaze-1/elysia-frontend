// src/renderer/src/stores/voice.store.ts
// 阶段 4 批次 B（spec §5.9 / design doc）：voiceStore——三模式语音会话编排。
// - 普通录音 / 实时会话 / 输入法转写三 start 统一守卫（D-P11：mode==='idle' && connected）+ consent（D-P16）；
// - D-P19：控制帧先于采集——各 start 先 await api.voiceStartXxx 成功，再 PcmCapture.start；
// - 背压（D-P3/D-P12）：realtime unacked-lastAckedSeq > MAX_UNACKED_FRAMES → pause，ack 恢复；
//   5s 无 ack 兜底 resume（Important-10：ack-stall 定时器每次 ack/ended 重臂/清）；
// - TTS 播放门（D-P8）：audio.session.ready 仅在 autoReadReply 时置 playing（Task 14 CyTtsPlayer 消费）；
// - 独立订阅 onChatEvent（D-P10）：messageStore 处理 voice_session.turn 消息归属 + sendVoiceCommit，
//   本 store 不重复插入消息、不重复提交。
// - 采集可注入（PcmCaptureLike）：setCaptureFactory 供单测注入 fake（D-P19 断言控制帧先于采集）。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { BackendEvent } from '@shared/contracts'
import { api } from './desktop-api'
import { useConnectionStore } from './connection.store'
import { getActiveCharacterBinding, getCurrentConversationId } from './session'
import { useSettingsStore } from './settings.store'
import { useMessageStore } from './message.store'
import { PcmCapture, type PcmCaptureLike } from '../voice/voice-capture'
import { parsePublicError, type PublicError } from '../utils/public-error'

/** 背压窗口：unacked - lastAckedSeq 超窗暂停采集（≈4s @50帧/s，含 1s ack 周期余量） */
export const MAX_UNACKED_FRAMES = 200
/** 无 ack 兜底恢复延迟（D-P12）：宁可继续发，不永久暂停 */
export const ACK_STALL_MS = 5000
/** 录音转写 45s 兜底：无 transcript/error → 判「未识别」（D-P17），仅丢弃/重录 */
export const TRANSCRIPT_WAIT_MS = 45000
/** 录音硬上限（与后端一致）：≥600s 自动停止 + toast */
export const RECORD_HARD_CAP_MS = 600000
/** 录音接近上限提示阈值：≥300s toast 提示 */
export const RECORD_WARN_MS = 300000

/** 采集工厂（可注入）：测试 setCaptureFactory 注入 fake PcmCapture；生产用真实 PcmCapture */
let captureFactory: () => PcmCaptureLike = () => new PcmCapture()
export function setCaptureFactory(fn: () => PcmCaptureLike): void {
  captureFactory = fn
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useVoiceStore = defineStore('voice', () => {
  // —— spec §5.9 state ——
  const mode = ref<'idle' | 'recording' | 'record_pending' | 'realtime' | 'dictating'>('idle')
  const caption = ref('')
  const record = ref<{ elapsedMs: number; audioBuffer: AudioBuffer | null; transcript?: string; awaitingTranscript: boolean }>({ elapsedMs: 0, audioBuffer: null, awaitingTranscript: false })
  const realtime = ref<{ sessionId?: string; caption: string; turnCount: number; unacked: number; lastAckedSeq: number }>({ caption: '', turnCount: 0, unacked: 0, lastAckedSeq: 0 })
  const dictation = ref<{ caption: string; finalText?: string }>({ caption: '' })
  const tts = ref<{ playingStreamId?: number; url?: string; playing: boolean; durationMs?: number }>({ playing: false })
  /** C1（批次 C）：TTS <audio> 宿主元素引用（CyTtsPlayer onMounted 赋值 / onUnmounted 清空）。
   *
   *  多套 UI 基础（2026-09-10）：改为**非响应式**持有。此前是 `ref<HTMLAudioElement|null>`，因为
   *  live2dStore 要 watch 它来 attach 口部数据源——那既让功能层伸手取 UI 的 DOM 宿主，又对 DOM 节点
   *  建了 Vue 响应式代理（深代理 DOM 既是性能负担也无意义）。
   *  现口部接线改由 UI 直接告知 live2dStore（CyTtsPlayer 调 setTtsAudioElement），本字段退化为
   *  「本机是否已挂载 TTS 宿主」的诊断句柄，故用普通变量承载。 */
  let ttsAudioEl: HTMLAudioElement | null = null
  function setTtsAudioEl(el: HTMLAudioElement | null): void { ttsAudioEl = el }
  function getTtsAudioEl(): HTMLAudioElement | null { return ttsAudioEl }
  /** C1 集成诊断（2026-08-19）：`audio.session.ready` 是否**曾到达** renderer（在 autoReadReply 门**前**置位，
   *  clearTtsState 不清）。供集成失败转储区分「ready 未到达 / 门控忽略 / 播放后回落」——cancelled 后 tts.url
   *  已清空，单看现值无法确认 ready 是否发生过。 */
  const ttsReadySeen = ref(false)
  const micError = ref<PublicError>()
  const error = ref<PublicError>()
  const captureReady = ref(false)
  const consentPending = ref(false)
  /** confirm 重发中的在途信号（Task 14 轮 3）：confirmConsent 已开始执行挂起动作（true）→
   *  UI 据此刻不判失败——重发的 startRecord 可能因 getUserMedia 权限提示 >3s 才进 recording；
   *  动作 settle（成功/失败）/取消/复位 → false。 */
  const confirmDispatching = ref(false)
  const pendingAction = ref<(() => Promise<void>) | null>(null)
  /** store 级瞬时提示（录音 300s/600s toast；Task 14 消费），同 layout.store.notice 机制 */
  const notice = ref<string | null>(null)

  // —— 非响应式会话标识与句柄（spec state 不含，组件不消费） ——
  let activeRecordingId: string | undefined
  let dictationClientRequestId: string | undefined
  let capture: PcmCaptureLike | null = null

  // —— 定时器句柄 ——
  let recordTimer: ReturnType<typeof setInterval> | undefined
  let recordWarnShown = false
  let transcriptTimer: ReturnType<typeof setTimeout> | undefined
  let ackStallTimer: ReturnType<typeof setTimeout> | undefined

  function setNotice(text: string): void { notice.value = text }
  function clearNotice(): void { notice.value = null }

  function clearTranscriptTimer(): void {
    if (transcriptTimer !== undefined) clearTimeout(transcriptTimer)
    transcriptTimer = undefined
  }

  function clearAckStallTimer(): void {
    if (ackStallTimer !== undefined) clearTimeout(ackStallTimer)
    ackStallTimer = undefined
  }

  /** Important-10：ack-stall 定时器——无 ack 时 capture.resume() 兜底；每次 ack/ended 重臂/清 */
  function armAckStallTimer(): void {
    clearAckStallTimer()
    ackStallTimer = setTimeout(() => {
      void capture?.resume()
    }, ACK_STALL_MS)
  }

  function clearRecordState(): void {
    if (recordTimer !== undefined) { clearInterval(recordTimer); recordTimer = undefined }
    clearTranscriptTimer()
    activeRecordingId = undefined
    record.value = { elapsedMs: 0, audioBuffer: null, awaitingTranscript: false }
    caption.value = ''
    mode.value = 'idle'
  }

  function clearRealtimeState(): void {
    clearAckStallTimer()
    realtime.value = { caption: '', turnCount: 0, unacked: 0, lastAckedSeq: 0 }
  }

  function clearDictationState(): void {
    dictationClientRequestId = undefined
    dictation.value = { caption: '' }
  }

  function clearTtsState(): void {
    tts.value = { playing: false }
  }

  /**
   * 多角色能力开启后，TTS 生命周期事件只允许作用于当前会话的当前角色快照。
   *
   * 音频可能在切换会话后才由 Main 组装完成；只按 streamId 路由会让旧角色的
   * started/ready/cancelled 污染新会话，甚至触发自动播放。旧后端没有角色身份，
   * 因此仅在 characterProfiles=true 时启用 fail-closed 门禁。
   */
  function belongsToActiveCharacter(e: {
    conversationId?: string
    characterId?: string
    characterInstanceId?: string
    characterRevision?: number
  }): boolean {
    if (useConnectionStore().state.features?.characterProfiles !== true) return true

    const binding = getActiveCharacterBinding()
    return binding !== undefined
      && e.conversationId === getCurrentConversationId()
      && e.characterId === binding.characterId
      && e.characterInstanceId === binding.characterInstanceId
      && e.characterRevision === binding.characterRevision
  }

  // —— 事件路由（D-P10：独立订阅 onChatEvent，voice_store.spec 经 mockApi.onChatEvent handler 驱动） ——

  function handleEvent(e: BackendEvent): void {
    switch (e.event) {
      case 'voice.transcript': {
        // review-Minor：recordingId 不匹配（discard/commit 后迟到的旧录音字幕）→ 忽略
        if (e.recordingId !== activeRecordingId) return
        clearTranscriptTimer()
        record.value.transcript = e.text
        record.value.awaitingTranscript = false // P1-02：字幕终态到达，等待结束
        caption.value = e.text // 字幕只展示，不写草稿；mode 保持 record_pending
        return
      }
      case 'voice_session.started': {
        realtime.value.sessionId = e.sessionId
        mode.value = 'realtime'
        return
      }
      case 'voice_session.partial': {
        realtime.value.caption = e.text
        return
      }
      case 'voice_session.turn': {
        // 消息插入由 messageStore 处理，本 store 只计数轮次
        realtime.value.turnCount++
        return
      }
      case 'voice_session.ack': {
        realtime.value.lastAckedSeq = e.seq
        if (realtime.value.unacked - e.seq <= MAX_UNACKED_FRAMES) void capture?.resume()
        armAckStallTimer() // 每次 ack 重臂
        return
      }
      case 'voice_session.ended': {
        clearAckStallTimer()
        void capture?.stop()
        capture = null
        captureReady.value = false
        clearRealtimeState()
        mode.value = 'idle'
        return
      }
      case 'dictation.partial': {
        dictation.value.caption = e.text
        return
      }
      case 'dictation.final': {
        // 不直接插入——选区在组件，Task 14 消费后调 clearDictationFinal()
        dictation.value.caption = e.text
        dictation.value.finalText = e.text
        return
      }
      case 'dictation.cancelled': {
        clearDictationState()
        mode.value = 'idle'
        return
      }
      case 'audio.session.started': {
        if (!belongsToActiveCharacter(e)) return
        // 新句打断旧播放（若有且不同 streamId；后端已 supersede 旧流，本处只清本地播放态）
        if (tts.value.playing && tts.value.playingStreamId !== undefined && tts.value.playingStreamId !== e.streamId) {
          clearTtsState()
        }
        tts.value.playingStreamId = e.streamId
        return
      }
      case 'audio.session.ready': {
        if (!belongsToActiveCharacter(e)) return
        // ready 必须属于最近一次 accepted started；拒绝同一角色旧 stream 的迟到完成事件。
        if (tts.value.playingStreamId !== e.streamId) return
        // C1 诊断：ready 曾到达（无论 autoReadReply 是否放行；放行与否都记，供失败转储区分断点）
        ttsReadySeen.value = true
        // D-P8 播放门：autoReadReply 为真才置 playing（触发 CyTtsPlayer）；为假忽略（不播、不置 playing）
        if (!useSettingsStore().voice.autoReadReply) return
        tts.value.playingStreamId = e.streamId
        tts.value.url = e.url
        tts.value.durationMs = e.durationMs
        tts.value.playing = true
        return
      }
      case 'audio.session.cancelled': {
        if (!belongsToActiveCharacter(e)) return
        // 旧 stream 的迟到取消不得清掉当前 stream 的播放状态。
        if (tts.value.playingStreamId !== e.streamId) return
        clearTtsState()
        return
      }
      case 'voice.error': {
        // PLAYBACK_NOT_FOUND（audio.cancel 竞态）良性忽略
        if (e.code === 'PLAYBACK_NOT_FOUND') return
        if (mode.value === 'recording') return // R-S4-06：recording 态丢弃（无 UI 消费者 + 防旧会话迟到错误污染 record_pending 展示）
        error.value = parsePublicError(`[${e.code}] ${e.message ?? ''}`)
        if (mode.value === 'record_pending') { clearTranscriptTimer(); record.value.awaitingTranscript = false } // STT 失败终态，45s 等待终止
        return
      }
      default:
        return
    }
  }

  /** bootstrap 调用：独立订阅 onChatEvent（D-P10），返回退订 */
  function init(): () => void {
    return api.onChatEvent((e) => handleEvent(e))
  }

  // —— 统一守卫（D-P11）+ consent（D-P16） ——

  function guardStart(): boolean {
    return mode.value === 'idle' && useConnectionStore().state.status === 'connected'
  }

  /**
   * consent（D-P16）：consentBackendStt 为 true → 返回 true（调用方直接执行主体）；
   * false → consentPending=true + pendingAction=action + 返回 false（挂起待 UI 确认）。
   * 返回 boolean 而非「直接执行 action」：避免未同意分支的自递归（confirmConsent 再派发同一 start 入口）。
   */
  function requireConsent(action: () => Promise<void>): boolean {
    if (useSettingsStore().voice.consentBackendStt) return true
    consentPending.value = true
    pendingAction.value = action
    return false
  }

  /** Task 14 对话框同意回调：持久化「不再提示」+ 清 pending + 重发挂起的动作。
   *  confirmDispatching 在动作执行期间为 true（try/finally 保证失败也复位）——UI 据此避免把
   *  「confirm 已开始但动作尚未定型」判成失败（getUserMedia 权限提示可能 >3s）。 */
  async function confirmConsent(): Promise<void> {
    // P1-11：`setVoice` 是**同步**函数（settings.store.ts:111 `function setVoice(...): void`），
    // 此处 await 是空操作，已移除——await 一个非 thenable 只会让读者误以为存在异步持久化屏障。
    useSettingsStore().setVoice({ consentBackendStt: true })
    const action = pendingAction.value
    consentPending.value = false
    pendingAction.value = null
    if (!action) return
    confirmDispatching.value = true
    try {
      await action()
    } finally {
      confirmDispatching.value = false
    }
  }

  /** 拒绝 → 中止（清 pending，不执行） */
  function dismissConsent(): void {
    consentPending.value = false
    pendingAction.value = null
    confirmDispatching.value = false
  }

  // —— 普通录音 ——

  async function startRecord(): Promise<void> {
    if (!guardStart()) return
    if (!useSettingsStore().voice.enabled) return
    // review-Important：新操作开始即清陈旧错误（micError/error/notice），防成功重试后残留旧错误展示
    micError.value = undefined
    error.value = undefined
    notice.value = null
    if (!requireConsent(() => startRecord())) return
    const recordingId = `rec_${crypto.randomUUID()}`
    // D-P19：控制帧先于采集——await 成功才开麦克风；拒绝 → error 置位 + 回 idle（不抛未处理拒绝）
    try {
      await api.voiceStartRecord({ recordingId })
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
      mode.value = 'idle'
      return
    }
    activeRecordingId = recordingId // 控制帧成功后才记入（失败不残留可被 stop/discard 误引用的 id）
    capture = captureFactory()
    try {
      await capture.start({
        onChunk: (b) => api.voiceSendAudio(b),
        onStop: (ab) => { record.value.audioBuffer = ab },
        deviceId: useSettingsStore().voice.micDeviceId
      })
    } catch (e) {
      // Important-3 / P0-01：getUserMedia/AudioContext 拒绝 → micError + 停采集 + await discardRecord()
      // 取消后端会话（不提前清 activeRecordingId/mode——recordingId 由 helper 保留至取消帧发送完成）
      micError.value = parsePublicError(messageOf(e))
      capture = null
      captureReady.value = false
      await discardRecord()
      return
    }
    captureReady.value = true
    mode.value = 'recording'
    record.value.elapsedMs = 0
    recordWarnShown = false
    recordTimer = setInterval(() => {
      record.value.elapsedMs += 1000
      if (record.value.elapsedMs >= RECORD_HARD_CAP_MS) {
        setNotice('录音已达 10 分钟上限，已自动停止')
        void stopRecord()
      } else if (record.value.elapsedMs >= RECORD_WARN_MS && !recordWarnShown) {
        recordWarnShown = true
        setNotice('录音即将达到 10 分钟上限')
      }
    }, 1000)
  }

  async function stopRecord(): Promise<void> {
    if (!activeRecordingId) return
    if (recordTimer !== undefined) { clearInterval(recordTimer); recordTimer = undefined }
    await capture?.stop()
    capture = null
    captureReady.value = false
    await api.voiceStopRecord({ recordingId: activeRecordingId })
    mode.value = 'record_pending'
    record.value.awaitingTranscript = true // P1-02：等待 STT 终态（transcript/error/45s timeout 清）
    // 45s 兜底判「未识别」（D-P17）：到时无 transcript/error → 仅丢弃/重录
    clearTranscriptTimer()
    transcriptTimer = setTimeout(() => {
      caption.value = ''
      record.value.awaitingTranscript = false // 唯一可观察翻转——transcript 本就 undefined，不再重复赋空
    }, TRANSCRIPT_WAIT_MS)
  }

  /** 本地试听（AudioContext + BufferSource，不走 blob URL） */
  function replayRecord(): void {
    const ab = record.value.audioBuffer
    if (!ab) return
    const AudioContextCtor = globalThis.AudioContext
    if (typeof AudioContextCtor !== 'function') return
    const ctx = new AudioContextCtor()
    const src = ctx.createBufferSource()
    src.buffer = ab
    src.connect(ctx.destination)
    void src.start()
  }

  /** 录音取消收敛 helper（R-S4-01 / P0-01）：唯一取消原语——停采集 → await discard 发送 → 清态。
   *  幂等、可重复调用；recordingId 保留至发送 resolve/reject（本地态只在取消帧发送完成后清理，不丢唯一关联 ID）。 */
  async function discardRecord(): Promise<void> {
    if (!activeRecordingId) return
    await capture?.stop() // 防御：recording 态卸载/收尾时停止采集（idempotent）
    capture = null
    captureReady.value = false
    try {
      await api.voiceDiscard({ recordingId: activeRecordingId }) // id 保留至发送 resolve/reject
    } catch (e) {
      // R-S4-01：发送失败（断线）→ 后端会话随连接关闭清理；本地清态收敛于连接 reset；不静默——留痕
      console.warn('[voice] discard 发送失败，本地录音态已清理（连接 reset 收口）', e)
    }
    clearRecordState() // 清 record/caption/mode/timers/activeRecordingId（awaitingTranscript 由 Task 1 复位）
  }

  /** 瞬时错误清理（卸载契约消费）：清 micError/error/notice 三错误字段，不触采集/录音态 */
  function clearTransientErrors(): void {
    micError.value = undefined
    error.value = undefined
    notice.value = null
  }

  /** 确认发送：transcript 非空才发；sendVoiceCommit 成功 → 清态 */
  async function commitRecord(): Promise<boolean> {
    const text = record.value.transcript?.trim()
    if (!text || !activeRecordingId) return false
    const ok = await useMessageStore().sendVoiceCommit(activeRecordingId, record.value.transcript ?? '')
    if (ok) clearRecordState()
    return ok
  }

  // —— 实时会话 ——

  async function startRealtime(): Promise<void> {
    if (!guardStart()) return
    if (!useSettingsStore().voice.realtimeEnabled) return
    // review-Important：新操作开始即清陈旧错误
    micError.value = undefined
    error.value = undefined
    notice.value = null
    if (!requireConsent(() => startRealtime())) return
    const current = getCurrentConversationId()
    const sessionId = `vs_${crypto.randomUUID()}`
    // D-P19：控制帧先于采集——await 成功才开麦克风 + 才记 sessionId；拒绝 → error 置位 + 回 idle
    try {
      await api.voiceStartRealtime({ sessionId, ...(current ? { conversationId: current } : {}) })
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
      realtime.value.sessionId = undefined
      mode.value = 'idle'
      return
    }
    realtime.value.sessionId = sessionId
    capture = captureFactory()
    try {
      await capture.start({
        onChunk: (b) => {
          api.voiceSendAudio(b)
          realtime.value.unacked++
          if (realtime.value.unacked - realtime.value.lastAckedSeq > MAX_UNACKED_FRAMES) void capture?.pause()
        }
      })
    } catch (e) {
      micError.value = parsePublicError(messageOf(e))
      capture = null
      captureReady.value = false
      realtime.value.sessionId = undefined
      mode.value = 'idle'
      try { await api.voiceCancelRealtime({ sessionId }) } catch { /* 后端取消失败不阻塞 */ }
      return
    }
    captureReady.value = true
    mode.value = 'realtime'
    // Important-10：ack-stall 定时器——无 ack 时 capture.resume()（兜底）；ack/ended 重臂/清
    armAckStallTimer()
  }

  async function stopRealtime(): Promise<void> {
    const sessionId = realtime.value.sessionId
    if (!sessionId) return
    clearAckStallTimer()
    await capture?.stop()
    capture = null
    captureReady.value = false
    try { await api.voiceStopRealtime({ sessionId }) } catch { /* ended 事件清态 */ }
  }

  async function cancelRealtime(): Promise<void> {
    const sessionId = realtime.value.sessionId
    if (!sessionId) return
    clearAckStallTimer()
    await capture?.stop()
    capture = null
    captureReady.value = false
    try { await api.voiceCancelRealtime({ sessionId }) } catch { /* ended 事件清态 */ }
  }

  // —— 输入法转写 ——

  async function startDictation(): Promise<void> {
    if (!guardStart()) return
    if (!useSettingsStore().voice.enabled) return
    // review-Important：新操作开始即清陈旧错误
    micError.value = undefined
    error.value = undefined
    notice.value = null
    if (!requireConsent(() => startDictation())) return
    const clientRequestId = `req_${crypto.randomUUID()}`
    const sttProfileId = useSettingsStore().dictation.sttProfileId
    // D-P19：控制帧先于采集——await 成功才开麦克风 + 才记 clientRequestId；拒绝 → error 置位 + 回 idle
    try {
      await api.voiceStartDictation({ clientRequestId, ...(sttProfileId ? { sttProfileId } : {}) })
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
      dictationClientRequestId = undefined
      mode.value = 'idle'
      return
    }
    dictationClientRequestId = clientRequestId
    capture = captureFactory()
    try {
      await capture.start({ onChunk: (b) => api.voiceSendAudio(b) })
    } catch (e) {
      micError.value = parsePublicError(messageOf(e))
      capture = null
      captureReady.value = false
      dictationClientRequestId = undefined
      mode.value = 'idle'
      try { await api.voiceCancelDictation({ clientRequestId }) } catch { /* 后端取消失败不阻塞 */ }
      return
    }
    captureReady.value = true
    dictation.value.caption = ''
    mode.value = 'dictating'
  }

  async function stopDictation(): Promise<void> {
    const id = dictationClientRequestId
    if (!id) return
    await capture?.stop()
    capture = null
    captureReady.value = false
    try { await api.voiceStopDictation({ clientRequestId: id }) } catch { /* final 事件清态 */ }
  }

  async function cancelDictation(): Promise<void> {
    const id = dictationClientRequestId
    if (!id) return
    await capture?.stop()
    capture = null
    captureReady.value = false
    try { await api.voiceCancelDictation({ clientRequestId: id }) } catch { /* cancelled 事件清态 */ }
  }

  /** Task 14 组件插入 final 后调用：finalText 清位 + 清态（mode 回 idle，允许下一次转写） */
  function clearDictationFinal(): void {
    clearDictationState()
    mode.value = 'idle'
  }

  // —— TTS 播放控制（Task 14 CyTtsPlayer 回调） ——

  function onTtsPlaybackEnded(): void { clearTtsState() }
  function onTtsPlaybackError(): void { clearTtsState() }

  async function stopTtsPlayback(): Promise<void> {
    if (tts.value.playingStreamId !== undefined) {
      try { await api.audioCancel({ streamId: tts.value.playingStreamId }) } catch { /* 后端取消失败不阻塞 */ }
    }
    clearTtsState()
  }

  // —— reset（断线/会话切换，Task 13 bootstrap handleConnectionStateChange 接线） ——

  async function reset(): Promise<void> {
    if (recordTimer !== undefined) { clearInterval(recordTimer); recordTimer = undefined }
    clearAckStallTimer()
    await capture?.stop()
    capture = null
    captureReady.value = false
    clearRecordState()      // 清 record 态 + caption + transcript 等待 timer + mode='idle'
    clearRealtimeState()    // 清 realtime 态 + ack-stall timer
    clearDictationState()
    clearTtsState()
    micError.value = undefined
    error.value = undefined
    consentPending.value = false
    pendingAction.value = null
    confirmDispatching.value = false
    notice.value = null
  }

  return {
    mode, caption, record, realtime, dictation, tts, ttsReadySeen, micError, error, captureReady,
    consentPending, confirmDispatching, pendingAction, notice,
    init, handleEvent, guardStart, requireConsent, confirmConsent, dismissConsent,
    startRecord, stopRecord, replayRecord, discardRecord, commitRecord,
    startRealtime, stopRealtime, cancelRealtime,
    startDictation, stopDictation, cancelDictation, clearDictationFinal,
    onTtsPlaybackEnded, onTtsPlaybackError, stopTtsPlayback,
    setTtsAudioEl, getTtsAudioEl,   // 多套 UI 基础：宿主元素非响应式，经存取器维护
    setNotice, clearNotice, clearTransientErrors,
    reset
  }
})
