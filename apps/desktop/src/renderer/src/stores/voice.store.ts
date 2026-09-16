// src/renderer/src/stores/voice.store.ts
// 阶段 4 批次 B（spec §5.9 / design doc）：voiceStore——三模式语音会话编排。
//
// 本 store 是**Renderer facade**：持有响应式状态与 IPC 编排，会话判据交给
// `src/renderer/src/voice/session.ts`（纯 TS，无 Vue / 无 Pinia / 无 api）：
//   · 模式迁移表与「拒绝后落哪」；清态时需要收敛哪一块
//   · 会话栅栏：录音字幕归属、转写终态归属、实时会话事件归属、TTS 角色归属与流归属
//   · 背压窗口（暂停/恢复同一判据）
//
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
import {
  convergenceForViewChange,
  dictationEventBelongsToSession,
  modeAfterStartRejected,
  nextVoiceMode,
  shouldPauseCapture,
  shouldResumeCapture,
  transcriptBelongsToRecording,
  ttsEventBelongsToActiveCharacter,
  ttsStreamDecisionForStarted,
  ttsStreamIsCurrent,
  voiceSessionEventId,
  voiceSessionEventBelongsToSession,
  type VoiceMode,
  type VoiceModeEvent
} from '../voice/session'

export { MAX_UNACKED_FRAMES } from '../voice/session'
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
  const mode = ref<VoiceMode>('idle')
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

  /** 按迁移表改模式（未列出的组合保持原模式——拒绝路径不静默改变会话）。 */
  function applyModeEvent(event: VoiceModeEvent): void {
    mode.value = nextVoiceMode(mode.value, event) ?? mode.value
  }

  // —— 非响应式会话标识与句柄（spec state 不含，组件不消费） ——
  let activeRecordingId: string | undefined
  let dictationClientRequestId: string | undefined
  let capture: PcmCaptureLike | null = null
  /**
   * 实时会话标识（`undefined` = 当前没有已建立的实时会话）。
   *
   * 后端在控制帧成功之后即推 `voice_session.started`，其 `sessionId` 是**原样回显**本 store 上行的
   * `vs_<uuid>`（`transport/real-backend.ts` 与 `frame-mapper.ts` 都直接透传 `frame.sessionId`），
   * 故这里在后端确认时写入后端给的值（与「谁生成的」无关），它同时是 `voice_session.*` 事件的
   * 会话栅栏依据（异 id 的迟到事件一律丢弃）。
   */
  let acceptedRealtimeSessionId: string | undefined
  /**
   * 「有实时会话正在进行」——**独立于 mode**。
   *
   * `mode` 在 `await capture.start()`（getUserMedia，可能几秒）之后才置位，而后端的
   * `voice_session.started` 紧随控制帧到达。若栅栏以 `mode === 'realtime'` 为活跃判据，那条
   * **建立会话本身的**事件会在窗口内被丢掉：后端标识永远落不下来（`stopRealtime` 随后发错 id），
   * 且栅栏在整个会话里处于 fail-open。故此标志在控制帧被接受时即置位、在 ended/reset/失败时清除。
   */
  let realtimeSessionActive = false

  // ─────────────────────────────────────────────────────────────────────────────
  // 2026-09-16 审计 P1-6：dictation 的共享单例态需要 owner 判据。
  //
  // 缺陷（对抗复核保留的那条路径）：`startDictation` 的**失败分支按「我这次失败」清理共享状态**。
  // 用户「按住 → 松开 → 立刻再按」即可命中：第一次 start 的 id 是 `await` 之后才记入的，
  // 松开时 `stopDictation` 因 id 还是空而早退；再按一次时 `guardStart()` 看 mode 仍是 idle
  // → 第二次 start 进入并被 Main 的互斥门拒绝 → 它的 catch 清掉**共享的** dictationClientRequestId
  // 与 capture ⇒ 第一次随后成功建立采集并置 mode='dictating'，但 id 已被清空、capture 已置 null
  // ⇒ `stopDictation` 早退、`capture?.stop()` 无处可调：**麦克风持续采集且 UI 无停止入口**，
  // 只能断线或重启。dictationClientRequestId 全仓没有任何事件回写它，故不可自愈。
  //
  // 修法两层（根因 + 防御）：
  //   ① 在途门 `sessionStartInFlight`（2026-09-17 起三个 start 入口共用）：整个 start 序列
  //      （控制帧 + getUserMedia）期间不得有第二次进入，且第二次进入**不做任何清理**；
  //   ② dictationOwner 世代号：所有 await 之后对共享态的写入都必须仍持有本世代；
  //      已被接管/取消的 start 走 abandonDictationStart 收尾（停采集 + 取消后端会话），
  //      绝不留下「在采集但无人能停」的状态。
  // ─────────────────────────────────────────────────────────────────────────────
  let dictationOwner = 0

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
    acceptedRealtimeSessionId = undefined
    realtimeSessionActive = false
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
   * 判据在 `voice/session.ts`（fail-open / fail-closed 两种口径写在同一处），本处只取事实。
   */
  function belongsToActiveCharacter(e: {
    conversationId?: string
    characterId?: string
    characterInstanceId?: string
    characterRevision?: number
  }): boolean {
    return ttsEventBelongsToActiveCharacter(e, {
      profilesEnabled: useConnectionStore().state.features?.characterProfiles === true,
      conversationId: getCurrentConversationId(),
      binding: getActiveCharacterBinding()
    })
  }

  // —— 事件路由（D-P10：独立订阅 onChatEvent，voice_store.spec 经 mockApi.onChatEvent handler 驱动） ——

  function handleEvent(e: BackendEvent): void {
    // 实时会话事件先过 sessionId 栅栏：已结束会话的迟到 `ended` 会停掉**下一次**会话的采集并把界面
    // 打回空闲，迟到的 `ack` 会清掉当前背压兜底定时器。message.store 的 voice_session.turn 早已按
    // 会话归属栅栏，本 store 此前只按模式判断——这里是补齐，未改动任何 IPC/契约形状。
    const eventSessionId = voiceSessionEventId(e)
    if (eventSessionId !== undefined && !voiceSessionEventBelongsToSession(eventSessionId, acceptedRealtimeSessionId, realtimeSessionActive)) return

    switch (e.event) {
      case 'voice.transcript': {
        // review-Minor：recordingId 不匹配（discard/commit 后迟到的旧录音字幕）→ 忽略
        if (!transcriptBelongsToRecording(e.recordingId, activeRecordingId)) return
        clearTranscriptTimer()
        record.value.transcript = e.text
        record.value.awaitingTranscript = false // P1-02：字幕终态到达，等待结束
        caption.value = e.text // 字幕只展示，不写草稿；mode 保持 record_pending
        return
      }
      case 'voice_session.started': {
        acceptedRealtimeSessionId = e.sessionId
        realtime.value.sessionId = e.sessionId
        applyModeEvent('realtime-started')
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
        if (shouldResumeCapture(realtime.value.unacked, e.seq)) void capture?.resume()
        armAckStallTimer() // 每次 ack 重臂
        return
      }
      case 'voice_session.ended': {
        clearAckStallTimer()
        void capture?.stop()
        capture = null
        captureReady.value = false
        clearRealtimeState()
        applyModeEvent('realtime-ended')
        return
      }
      case 'dictation.partial': {
        dictation.value.caption = e.text
        return
      }
      case 'dictation.final': {
        // 归属栅栏：只有**当前打开的**转写会话的终态才可落地。此前既不比对 clientRequestId
        // 也不看会话，于是一条属于已取消/已放弃会话的终态会经 CyChatInput 的 watch 插入
        // **当前会话**的草稿（跨会话污染草稿）。判据见 voice/session.ts。
        if (!dictationEventBelongsToSession(e.clientRequestId, dictationClientRequestId)) return
        // 不直接插入——选区在组件，Task 14 消费后调 clearDictationFinal()
        dictation.value.caption = e.text
        dictation.value.finalText = e.text
        return
      }
      case 'dictation.cancelled': {
        // 与 final 同一条栅栏（此前 cancelled 无归属判据）：一条外来/迟到的 cancelled 会清掉
        // dictationClientRequestId 并强制空闲，而采集仍在跑——此后 `stopDictation` 因 id 为空早退，
        // 麦克风再没有任何停止入口（P1-6 同型后果）。
        if (!dictationEventBelongsToSession(e.clientRequestId, dictationClientRequestId)) return
        clearDictationState()
        applyModeEvent('dictation-cancelled')
        return
      }
      case 'audio.session.started': {
        if (!belongsToActiveCharacter(e)) return
        // 新句打断旧播放（若有且不同 streamId；后端已 supersede 旧流，本处只清本地播放态）
        if (ttsStreamDecisionForStarted(e.streamId, tts.value) === 'supersede') clearTtsState()
        tts.value.playingStreamId = e.streamId
        return
      }
      case 'audio.session.ready': {
        if (!belongsToActiveCharacter(e)) return
        // ready 必须属于最近一次 accepted started；拒绝同一角色旧 stream 的迟到完成事件。
        if (!ttsStreamIsCurrent(e.streamId, tts.value.playingStreamId)) return
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
        if (!ttsStreamIsCurrent(e.streamId, tts.value.playingStreamId)) return
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
   * 「一次 start 序列正在进行」的门（2026-09-17 审计：录音与实时会话此前**没有**这道门）。
   *
   * 缺陷：`mode` 是**成功之后**才置位的，而 `CyChatInput` 的录音/实时按钮在 `mode === 'idle'`
   * 期间保持可点 ⇒ 双击（或点一下再点一下）会让两次 start 都通过 `guardStart`：
   *   · 两条控制帧、两次 `captureFactory()`；
   *   · 后一次的赋值覆盖 `capture` 句柄，**第一次建立的采集从此没有任何入口能停**
   *     （`capture = null` 只清掉新句柄），麦克风保持打开且界面无停止按钮。
   *
   * 这与 P1-6 对 dictation 修掉的缺陷同类（那次是「失败分支清共享态」，这次是「句柄被覆盖」），
   * 故共用一条判据。in-flight 期间第二次 start 直接返回且**不做任何清理**——清理共享态正是
   * P1-6 缺陷的形态。
   */
  let sessionStartInFlight = false

  /**
   * 会话世代：`reset()`（断线 / 会话切换）自增，使**在途 start 的每次 await 之后都作废**。
   *
   * 为什么与在途门是两件事：在途门只挡「同一时刻的第二次进入」，挡不住「一次进入跨越了 reset」。
   * 断线时 `reset()` 会停采集并把 `capture` 置 null，但一个正挂起在 `await api.voiceStartRecord()`
   * 或 `await capture.start()` 的 start 在它**之后**才恢复：它会重新赋值 `capture`、把 `mode` 翻回
   * `recording` —— 界面回到一个已断开的连接上、且**没有任何停止入口**（`reset` 已经跑完）。
   * 这与 live2d 的 `lifecycleGeneration`、character-editor 的 `editorGeneration` 是同一手法。
   */
  let sessionStartGeneration = 0

  /** 录音 / 实时 / 转写三入口共用的在途门（放在 `guardStart` 之外：后者被三个入口共用，语义不能为它改变）。 */
  function sessionStartBlocked(): boolean {
    return sessionStartInFlight
  }

  /**
   * 放弃一次已被 `reset()` 作废的 start（fail-closed）。
   *
   * 只停**本次 start 自己建立的**那个采集句柄（按身份比对，不无条件 `capture = null`——
   * 否则会清掉接管者刚建立的句柄，正是 P1-6 的同型后果）。后端会话无需再取消：这条路径的唯一
   * 成因是连接世代已经变了，后端会话随连接关闭清理。不写任何响应式状态——界面已由 reset 收敛。
   */
  async function abandonStartedSession(ownedCapture: PcmCaptureLike | null, ownedRecordingId?: string): Promise<void> {
    try { await ownedCapture?.stop() } catch { /* 采集尚未起来时 stop 可能抛：忽略，状态照清 */ }
    if (capture === ownedCapture) { capture = null; captureReady.value = false }
    if (ownedRecordingId !== undefined && activeRecordingId === ownedRecordingId) activeRecordingId = undefined
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
    if (sessionStartBlocked()) return
    if (!useSettingsStore().voice.enabled) return
    // review-Important：新操作开始即清陈旧错误（micError/error/notice），防成功重试后残留旧错误展示
    micError.value = undefined
    error.value = undefined
    notice.value = null
    if (!requireConsent(() => startRecord())) return
    const gen = ++sessionStartGeneration
    /** 本次 start 是否仍是当前世代（`reset()` 会让它作废）。 */
    const stale = (): boolean => gen !== sessionStartGeneration
    sessionStartInFlight = true
    try {
      const recordingId = `rec_${crypto.randomUUID()}`
      // D-P19：控制帧先于采集——await 成功才开麦克风；拒绝 → error 置位 + 回 idle（不抛未处理拒绝）
      try {
        await api.voiceStartRecord({ recordingId })
      } catch (e) {
        if (stale()) return   // reset 已收口：不得按「我这次失败」写错误态
        error.value = parsePublicError(messageOf(e))
        mode.value = modeAfterStartRejected()
        return
      }
      if (stale()) return   // 控制帧成功但世代已作废：不开采集
      activeRecordingId = recordingId // 控制帧成功后才记入（失败不残留可被 stop/discard 误引用的 id）
      capture = captureFactory()
      const ownedCapture = capture
      const voiceSettings = useSettingsStore().voice
      try {
        await capture.start({
          onChunk: (b) => api.voiceSendAudio(b),
          onStop: (ab) => { record.value.audioBuffer = ab },
          deviceId: voiceSettings.micDeviceId,
          // 语音活动检测 / 静音结束（doc 11 §3.3，2026-09-13）：默认关闭；开启后连续静音达设定时长即自动结束，
          // 走的是与手动停止完全相同的路径（同一个 stopRecord），并给用户一条可见提示（不做静默行为变更）。
          ...(voiceSettings.silenceAutoStop
            ? {
                silence: {
                  durationMs: voiceSettings.silenceStopMs,
                  onSilence: () => {
                    setNotice('检测到持续静音，已自动结束录音')
                    void stopRecord()
                  }
                }
              }
            : {})
        })
      } catch (e) {
        // Important-3 / P0-01：getUserMedia/AudioContext 拒绝 → micError + 停采集 + await discardRecord()
        // 取消后端会话（不提前清 activeRecordingId/mode——recordingId 由 helper 保留至取消帧发送完成）
        if (stale()) return abandonStartedSession(ownedCapture, recordingId)
        micError.value = parsePublicError(messageOf(e))
        capture = null
        captureReady.value = false
        await discardRecord()
        return
      }
      // 采集真的起来了、但期间已被 reset 收口：必须停掉它，否则就是「在采集却无人能停」。
      if (stale()) return abandonStartedSession(ownedCapture, recordingId)
      captureReady.value = true
      applyModeEvent('record-start-accepted')
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
    } finally {
      // 被 stop/discard/reset 接管时也必须复位，否则下一次 start 会被永久挡住。
      sessionStartInFlight = false
    }
  }

  async function stopRecord(): Promise<void> {
    if (!activeRecordingId) return
    if (recordTimer !== undefined) { clearInterval(recordTimer); recordTimer = undefined }
    await capture?.stop()
    capture = null
    captureReady.value = false
    await api.voiceStopRecord({ recordingId: activeRecordingId })
    applyModeEvent('record-stopped')
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
    // 2026-09-16 审计 P2：此前既不监听播放结束、也从不 `close()`——每次"试听"泄漏一个 AudioContext。
    // Chromium 每进程的 AudioContext 数量有硬上限（约 6），而入口（设置页语音区）每次点击都新建一个
    // ⇒ 试听几次之后新建会失败（试听静默失效）。播放自然结束即关闭；`close()` 失败无补救价值（忽略）。
    src.onended = () => { void ctx.close().catch(() => { /* 已关闭/已失效：忽略 */ }) }
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
    if (sessionStartBlocked()) return
    if (!useSettingsStore().voice.realtimeEnabled) return
    // review-Important：新操作开始即清陈旧错误
    micError.value = undefined
    error.value = undefined
    notice.value = null
    if (!requireConsent(() => startRealtime())) return
    const gen = ++sessionStartGeneration
    const stale = (): boolean => gen !== sessionStartGeneration
    sessionStartInFlight = true
    try {
      const current = getCurrentConversationId()
      const sessionId = `vs_${crypto.randomUUID()}`
      // D-P19：控制帧先于采集——await 成功才开麦克风 + 才记 sessionId；拒绝 → error 置位 + 回 idle
      try {
        await api.voiceStartRealtime({ sessionId, ...(current ? { conversationId: current } : {}) })
      } catch (e) {
        if (stale()) return   // reset 已收口：不得写错误态
        error.value = parsePublicError(messageOf(e))
        realtime.value.sessionId = undefined
        mode.value = modeAfterStartRejected()
        return
      }
      if (stale()) return   // 控制帧成功但世代已作废：不开采集、也不登记会话
      // 控制帧已被接受 ⇒ 后端即将推 started，会话在栅栏意义上**已经开始**（此刻 mode 仍是 idle）。
      realtimeSessionActive = true
      realtime.value.sessionId = sessionId
      capture = captureFactory()
      const ownedCapture = capture
      try {
        await capture.start({
          onChunk: (b) => {
            api.voiceSendAudio(b)
            realtime.value.unacked++
            if (shouldPauseCapture(realtime.value.unacked, realtime.value.lastAckedSeq)) void capture?.pause()
          }
        })
      } catch (e) {
        if (stale()) return abandonStartedSession(ownedCapture)
        micError.value = parsePublicError(messageOf(e))
        capture = null
        captureReady.value = false
        realtime.value.sessionId = undefined
        realtimeSessionActive = false
        mode.value = modeAfterStartRejected()
        try { await api.voiceCancelRealtime({ sessionId }) } catch { /* 后端取消失败不阻塞 */ }
        return
      }
      if (stale()) return abandonStartedSession(ownedCapture)
      captureReady.value = true
      applyModeEvent('realtime-started')
      // Important-10：ack-stall 定时器——无 ack 时 capture.resume()（兜底）；ack/ended 重臂/清
      armAckStallTimer()
    } finally {
      sessionStartInFlight = false
    }
  }

  async function stopRealtime(): Promise<void> {
    const sessionId = realtime.value.sessionId
    if (!sessionId) return
    clearAckStallTimer()
    await capture?.stop()
    capture = null
    captureReady.value = false
    // stop/cancel 之后 mode 仍停在 realtime（清态由 ended 事件完成），故会话在这里**保持活跃**：
    // 那条 ended 必须能通过栅栏进来。活跃标志只由 ended / reset / 失败路径清除。
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
    if (sessionStartBlocked()) return
    if (!useSettingsStore().voice.enabled) return
    // review-Important：新操作开始即清陈旧错误
    micError.value = undefined
    error.value = undefined
    notice.value = null
    if (!requireConsent(() => startDictation())) return
    const owner = ++dictationOwner      // P1-6②：本次 start 的世代（后续所有共享态写入都要持有它）
    const gen = ++sessionStartGeneration
    const stale = (): boolean => gen !== sessionStartGeneration
    const clientRequestId = `req_${crypto.randomUUID()}`
    const sttProfileId = useSettingsStore().dictation.sttProfileId
    sessionStartInFlight = true
    try {
      // D-P19：控制帧先于采集——await 成功才开麦克风 + 才记 clientRequestId；拒绝 → error 置位 + 回 idle
      try {
        await api.voiceStartDictation({ clientRequestId, ...(sttProfileId ? { sttProfileId } : {}) })
      } catch (e) {
        // 已被取消/接管/reset：不得按「我这次失败」清共享态
        if (dictationOwner !== owner || stale()) return
        error.value = parsePublicError(messageOf(e))
        dictationClientRequestId = undefined
        mode.value = modeAfterStartRejected()
        return
      }
      if (dictationOwner !== owner || stale()) return abandonDictationStart(clientRequestId)
      dictationClientRequestId = clientRequestId
      capture = captureFactory()
      try {
        await capture.start({ onChunk: (b) => api.voiceSendAudio(b) })
      } catch (e) {
        if (dictationOwner !== owner || stale()) return abandonDictationStart(clientRequestId)
        micError.value = parsePublicError(messageOf(e))
        capture = null
        captureReady.value = false
        dictationClientRequestId = undefined
        mode.value = modeAfterStartRejected()
        try { await api.voiceCancelDictation({ clientRequestId }) } catch { /* 后端取消失败不阻塞 */ }
        return
      }
      // 起点成功但期间已被取消/接管/reset：必须把**已经起来的采集**停掉，否则就是「在采集却无人能停」
      if (dictationOwner !== owner || stale()) return abandonDictationStart(clientRequestId)
      captureReady.value = true
      dictation.value.caption = ''
      applyModeEvent('dictation-start-accepted')
    } finally {
      sessionStartInFlight = false
    }
  }

  /**
   * P1-6：放弃一个已被取消/接管的 dictation start——停掉可能已经起来的采集、清掉只属于本世代的
   * 会话标识、取消后端会话。任何一步失败都不得遗留「采集中」状态（fail-closed）。
   *
   * **本函数自己也是「await 之后写共享态」，故每一处写入都按*写入时刻*的值再判定一次**：
   * 调用方在 `startDictation` 的 `finally` 里会立刻复位在途门，于是
   * `await ownedCapture.stop()` 期间完全可能已有新 start 接管 `capture`/`dictationClientRequestId`。
   * 若无条件 `capture = null`，这次迟到收尾就会把接管者刚建立的句柄清掉——正是本缺陷的同型后果。
   */
  async function abandonDictationStart(requestId: string): Promise<void> {
    const ownedCapture = capture   // 同步取：此刻它仍是这次 start 建立的句柄
    try { await ownedCapture?.stop() } catch { /* 采集尚未起来时 stop 可能抛：忽略，状态照清 */ }
    if (capture === ownedCapture) { capture = null; captureReady.value = false }
    if (dictationClientRequestId === requestId) dictationClientRequestId = undefined
    try { await api.voiceCancelDictation({ clientRequestId: requestId }) } catch { /* 后端取消失败不阻塞 */ }
  }

  async function stopDictation(): Promise<void> {
    // P1-6②：停止即接管——使任何在途 start 失效（它会在自己的 owner 判定处收尾并停掉采集）
    dictationOwner++
    const id = dictationClientRequestId
    if (!id) return
    await capture?.stop()
    capture = null
    captureReady.value = false
    try { await api.voiceStopDictation({ clientRequestId: id }) } catch { /* final 事件清态 */ }
  }

  async function cancelDictation(): Promise<void> {
    dictationOwner++   // P1-6②：同上
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
    applyModeEvent('dictation-consumed')
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

  // —— 视图切换收敛（2026-09-16 审计 P2） ——

  /**
   * 离开聊天区时收敛在途语音采集。
   *
   * 缺口：录音与实时语音的**停止入口都在聊天区内**（`CyChatInput` 的按钮、`CyRealtimeBar`），而
   * chat 视图是 `v-if`（切到设置/任务会真卸载）⇒ 用户离开聊天页后麦克风继续采集，而界面上已经
   * 没有任何停止入口；录音只有 600s 硬上限兜底，实时语音连上限都没有。收敛点此前绑在**组件存活性**上
   * （`CyChatInput` 的 onBeforeUnmount 对语音零动作），属审计 S-3「收敛点建在错误的主体上」。
   *
   * 现在由 `App.vue` 在 `currentView` 离开 chat 时调用：录音与实时语音**按取消语义收尾**
   * （停采集 + 通知后端 + 清态）。
   *   · 用「取消」而不是「停止」：停止会把录音留在"等待字幕/待确认"态，而确认 UI 在被卸载的聊天区里，
   *     用户既看不到也点不到 ⇒ 那是一个没有出口的状态。离开页面 = 放弃这次采集。
   *   · 不碰 dictation（它在松手/失焦时就已收敛）与 TTS 播放（播放器常驻在聊天区之外，
   *     不该因为切视图被打断）。
   *   · 刻意**不复用 `reset()`**：那是"断线/会话切换"的语义（连错误字段一起清），用它会把一次视图切换
   *     变成静默的全局重置。本函数只做"停止在途采集"，且幂等（无在途采集时纯 no-op）。
   */
  async function convergeForViewChange(): Promise<void> {
    // 收敛种类由 voice/session.ts 的迁移邻域判据给出（与「该清哪块态」同处定义）。
    const convergence = convergenceForViewChange(mode.value)
    if (convergence === 'discard-record') await discardRecord()
    else if (convergence === 'cancel-realtime') await cancelRealtime()
  }

  // —— reset（断线/会话切换，Task 13 bootstrap handleConnectionStateChange 接线） ——

  async function reset(): Promise<void> {
    // 世代自增：在途 start 的每个 await 边界都会自查并放弃（否则它会在 reset 之后重新开麦、
    // 把 mode 翻回 recording，而界面上已经没有停止入口）。与 live2d 的 lifecycleGeneration 同手法。
    sessionStartGeneration++
    if (recordTimer !== undefined) { clearInterval(recordTimer); recordTimer = undefined }
    clearAckStallTimer()
    await capture?.stop()
    capture = null
    captureReady.value = false
    clearRecordState()      // 清 record 态 + caption + transcript 等待 timer（顺手把录音/待确认模式收回）
    clearRealtimeState()    // 清 realtime 态 + ack-stall timer
    clearDictationState()
    clearTtsState()
    // 断线/会话切换是「无条件收敛」：采集已停、四块状态已清，故模式必须回到空闲，
    // 而不是依赖上面某一条清态顺带改到它（录音/实时/转写三者的模式迁移邻域互不相同，
    // 逐块清态之后仍可能停在 realtime——那会让界面留下一个没有会话可管的状态）。
    mode.value = 'idle'
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
    convergeForViewChange,
    reset
  }
})
