// renderer/src/voice/session.ts
// 语音会话的纯状态模型（无 Vue / 无 Pinia / 无 `api`）。
//
// 为什么单独存在：语音 store 同时挂着三套会话（普通录音 / 实时会话 / 输入法转写）与 TTS 播放态，
// 原先「当前处于哪个模式」「该清哪几块状态」「这条迟到事件还算不算本会话的」这三类判据散在
// 十几个 `if` 与四张 `clear*State` 里，只有整棵 store 集成用例能到达。下沉后：
//   · 模式迁移表可以被穷举（含拒绝路径）；
//   · 栅栏判据可以逐条对抗（迟到字幕 / 迟到终态 / 跨 session 的 ack 与 ended）；
//   · 「哪条事件属于哪个会话」的缺失栅栏会作为**参数**显形，而不是以缺席的形式藏在分支里。
//
// 本模块**不做** IPC 编排（D-P19「控制帧先于采集」是 store 的职责）、不持有时钟、不碰采集句柄。
import type { BackendEvent } from '@shared/contracts'

/** 三套语音会话 + 空闲，共五个模式（与 store 的 `mode` 一一对应）。 */
export type VoiceMode = 'idle' | 'recording' | 'record_pending' | 'realtime' | 'dictating'

/**
 * 模式迁移表。
 *
 * `to` 是唯一合法的目标；任何未列出的 (from, event) 组合都**拒绝**（返回 `undefined`），
 * 调用方据此不改状态。拒绝是承重的：例如实时会话未结束时不得进入转写模式——
 * 采集句柄是一个单例，两条流同时持有它就等于「有一条永远没人能停」。
 */
export type VoiceModeEvent =
  | 'record-start-accepted'
  | 'record-start-rejected'
  | 'record-stopped'
  | 'record-cleared'
  | 'realtime-started'
  | 'realtime-start-rejected'
  | 'realtime-ended'
  | 'dictation-start-accepted'
  | 'dictation-start-rejected'
  | 'dictation-cancelled'
  | 'dictation-consumed'

const MODE_TRANSITIONS: Record<VoiceMode, Partial<Record<VoiceModeEvent, VoiceMode>>> = {
  idle: {
    'record-start-accepted': 'recording',
    'realtime-started': 'realtime',
    'dictation-start-accepted': 'dictating'
  },
  recording: {
    'record-stopped': 'record_pending',
    'record-cleared': 'idle'
  },
  record_pending: {
    'record-cleared': 'idle'
  },
  realtime: {
    'realtime-ended': 'idle'
  },
  dictating: {
    'dictation-cancelled': 'idle',
    'dictation-consumed': 'idle'
  }
}

/** 迁移后的模式；该迁移不被允许时返回 `undefined`（调用方保持原模式）。 */
export function nextVoiceMode(from: VoiceMode, event: VoiceModeEvent): VoiceMode | undefined {
  return MODE_TRANSITIONS[from][event]
}

/** 迁移是否被允许。 */
export function canTransitionVoiceMode(from: VoiceMode, event: VoiceModeEvent): boolean {
  return nextVoiceMode(from, event) !== undefined
}

/**
 * 「本次开始被拒绝」时要落的模式。
 *
 * 三个 start 入口都只可能从空闲进入（`guardStart` 要求 `mode === 'idle'`），故拒绝即回空闲。
 * **必须是常量而不是「按迁移表推导」**：早期写法用 `nextVoiceMode(from, '*-start-rejected')`，
 * 而迁移表里没有任何一条拒绝事件的目标（拒绝字形本就不是迁移），于是它退化成 `?? from` ——
 * 一个名字像收口、实际什么都不做的空操作，把基线里那层「cross-event 竞态时强制回空闲」的安全网
 * 悄悄拆掉了（对抗复核 W1/W2 实测）。这里宁可写死：拒绝路径的语义就是「不进入任何会话」。
 */
export const MODE_AFTER_START_REJECTED: VoiceMode = 'idle'

export function modeAfterStartRejected(): VoiceMode {
  return MODE_AFTER_START_REJECTED
}

/**
 * 语音是否有在途会话（非空闲）。
 *
 * 三个消费者共用这一个判据：输入区的文本发送门（spec §5.12）、会话切换守卫
 * （conversation.store 禁止在语音活跃时切换/新建）、以及离开聊天区时的采集收敛。
 * 此前它被写成三处 `mode !== 'idle'` 字面量比较。
 */
export function voiceSessionActive(mode: VoiceMode): boolean {
  return mode !== 'idle'
}

/**
 * 离开聊天区时该做哪种收敛。
 *
 *   · 录音与「等待字幕」按**取消**语义收尾：停止会把录音留在"待确认"态，而确认 UI 在被卸载的
 *     聊天区里——那是一个没有出口的状态。离开页面 = 放弃这次采集。
 *   · 实时会话按取消收尾（它没有"待确认"态）。
 *   · 空闲无事可做；转写（松手/失焦即收敛）与 TTS 播放（播放器常驻在聊天区之外）**不碰**。
 */
export type VoiceConvergence = 'none' | 'discard-record' | 'cancel-realtime'

export function convergenceForViewChange(mode: VoiceMode): VoiceConvergence {
  if (mode === 'recording' || mode === 'record_pending') return 'discard-record'
  if (mode === 'realtime') return 'cancel-realtime'
  return 'none'
}

/**
 * 实时会话的背压窗口。
 *
 * 同一个窗口在原先的实现里被写了两次、方向相反（暂停用 `>`，恢复用 `<=`），
 * 两处一旦不同步就会出现「暂停了永不再恢复」或「背压形同不存在」。此处只留一个判据。
 */
export const MAX_UNACKED_FRAMES = 200

/** 未确认帧数是否已越过背压窗口（越窗 ⇒ 暂停采集）。 */
export function shouldPauseCapture(unacked: number, lastAckedSeq: number): boolean {
  return unacked - lastAckedSeq > MAX_UNACKED_FRAMES
}

/** ack 是否已把未确认帧数收回窗口内（⇒ 恢复采集）。 */
export function shouldResumeCapture(unacked: number, lastAckedSeq: number): boolean {
  return !shouldPauseCapture(unacked, lastAckedSeq)
}

// ─────────────────────────────────────────────────────────────────────────────
// 会话栅栏：判定「这条迟到事件还算不算当前会话的」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 普通录音的字幕是否属于当前录音。
 *
 * `activeRecordingId` 只在控制帧成功之后记入、并随每一次清态置空，故 discard/commit 之后
 * 迟到的旧字幕（含 STT 终态）一律不匹配 ⇒ 丢弃。
 */
export function transcriptBelongsToRecording(recordingId: string, activeRecordingId: string | undefined): boolean {
  return activeRecordingId !== undefined && recordingId === activeRecordingId
}

/**
 * 输入法转写事件（final / cancelled）是否属于**当前这次**转写会话。
 *
 * 两种终态共用同一条「谁是当前会话」判据：`final` 写入 `finalText`（`CyChatInput` 的 watch 会把它
 * 插进**当前会话**的草稿），`cancelled` 清态并强制回空闲。被外来/迟到事件命中都造成同一类破坏
 * （前者污染草稿，后者让仍在跑的采集失去标识、`stopDictation` 从此早退）。
 *
 * 判据取「本次会话仍有归属」＋ id 相符：
 *   · 本次会话 id 已释放（消费完 / 已取消 / 断线 reset）→ 拒；
 *   · id 不符 → 拒（外来或别的会话的事件）；
 *   · 相符 → 接受。
 *
 * 注意「已取消但取消帧尚未确认」这一窗口：`cancelDictation()` 有意**保留** id（与
 * `stopDictation()` 一致），故此时后端回来的 `cancelled` 仍能通过栅栏完成清态；否则用户点了取消
 * 就会永久停在 `dictating`（采集已停、模式未收、下一次 start 被 `guardStart` 挡住）。
 */
export function dictationEventBelongsToSession(
  clientRequestId: string,
  sessionClientRequestId: string | undefined
): boolean {
  return sessionClientRequestId !== undefined && clientRequestId === sessionClientRequestId
}

/**
 * 实时会话事件是否属于**当前已建立**的实时会话。
 *
 * `VoiceSession*Event` 全部带 `sessionId`（契约既有字段，本批未改 IPC），故栅栏不需要契约变更。
 * 此前 `voice_session.*` 只按模式判断：会话结束之后到达的 `ended`/`ack` 仍会作用到**下一次**会话上
 * ——`ended` 会停掉当前采集并把界面打回空闲，`ack` 会清掉当前背压兜底定时器并可能 resume 采集。
 *
 * `acceptedSessionId` 是**后端确认过的**标识（`voice_session.started` 带回；后端原样回显前端上行的
 * `vs_<uuid>`——`transport/real-backend.ts` 的 `voice_session.start` 与 `frame-mapper.ts` 都直接透传
 * `frame.sessionId`）。三种情形：
 *   · 已确认 → 只接受同 id 的事件，异 id 一律丢弃（这正是本栅栏要挡的跨会话污染）；
 *   · 尚未确认但会话**已开始**（控制帧已被接受、正等 `started`）→ 放行，让 `started` 完成确认。
 *     这一条必须存在：`started` 常早于 `capture.start()`（getUserMedia）几秒到达，若此时一律拒绝，
 *     `started` 永远进不来，本栅栏就变成永久 fail-open（等于没加）；
 *   · 已无实时会话（`sessionActive === false`）→ 一律拒绝，否则上次会话结束后到达的 `ack`/`ended`
 *     会重新落到「无会话」状态上，等效于没有栅栏。
 */
export function voiceSessionEventBelongsToSession(
  sessionId: string,
  acceptedSessionId: string | undefined,
  sessionActive: boolean
): boolean {
  if (!sessionActive) return false
  return acceptedSessionId === undefined || sessionId === acceptedSessionId
}

/** 需要按 sessionId 栅栏的实时会话事件。 */
export function voiceSessionEventId(event: BackendEvent): string | undefined {
  switch (event.event) {
    case 'voice_session.started':
    case 'voice_session.partial':
    case 'voice_session.turn':
    case 'voice_session.ack':
    case 'voice_session.ended':
      return event.sessionId
    default:
      return undefined
  }
}

/**
 * TTS 事件是否属于当前会话/当前角色。
 *
 * 能力未开启（legacy 后端）时**fail-open**：旧后端不带角色身份，按身份拒会把全部播放静默掉。
 * 能力开启后按四元组精确匹配，且缺少会话绑定即拒——音频可能在切换会话后才由 Main 组装完成，
 * 只按 streamId 路由会让旧角色的 started/ready/cancelled 污染新会话，甚至触发自动播放。
 */
export interface CharacterEventTarget {
  conversationId?: string
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
}

export interface ActiveCharacterBinding {
  characterId: string
  characterInstanceId: string
  characterRevision: number
}

export function ttsEventBelongsToActiveCharacter(
  event: CharacterEventTarget,
  options: {
    profilesEnabled: boolean
    conversationId: string | undefined
    binding: ActiveCharacterBinding | undefined
  }
): boolean {
  if (!options.profilesEnabled) return true
  const binding = options.binding
  return binding !== undefined
    && event.conversationId === options.conversationId
    && event.characterId === binding.characterId
    && event.characterInstanceId === binding.characterInstanceId
    && event.characterRevision === binding.characterRevision
}

// ─────────────────────────────────────────────────────────────────────────────
// TTS 播放流：同一时刻只认一条流
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 收到 `audio.session.started` 后该对本地播放态做什么。
 *
 *   · 没有正在播的流（或就是同一条）→ 只记 id；
 *   · 有一条**不同的**流在播 → 新句打断旧播放：后端已 supersede 旧流，本地只需清播放态。
 */
export type TtsStreamDecision = 'record' | 'supersede'

export function ttsStreamDecisionForStarted(
  incomingStreamId: number,
  current: { playing: boolean; playingStreamId?: number | undefined }
): TtsStreamDecision {
  if (current.playing && current.playingStreamId !== undefined && current.playingStreamId !== incomingStreamId) {
    return 'supersede'
  }
  return 'record'
}

/**
 * `ready` / `cancelled` 是否属于当前已接受的流。
 *
 * `ready` 必须属于最近一次 accepted `started`（拒绝同一角色旧 stream 的迟到完成事件）；
 * `cancelled` 同理，否则旧 stream 的迟到取消会清掉当前 stream 的播放状态。
 */
export function ttsStreamIsCurrent(incomingStreamId: number, playingStreamId: number | undefined): boolean {
  return playingStreamId !== undefined && playingStreamId === incomingStreamId
}
