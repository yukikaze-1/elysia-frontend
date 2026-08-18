import type { SegmentChannel, SegmentKind, TokenUsage, ConversationTokenUsage } from './message'

/** 事件外壳:所有后端事件共有的标识字段 */
export interface BackendEventEnvelope {
  eventId: string
  sequence: number
  timestamp?: string
}

/** 一次 AI 回复开始 */
export interface GenerationStartedEvent extends BackendEventEnvelope {
  event: 'generation.started'
  generationId: string
  messageId: string
  responseId: string
  conversationId: string
  model?: string
}

/** 分段开始:领域层创建 segment 元数据(方案 A,docs/18 §8.2) */
export interface GenerationSegmentStartedEvent extends BackendEventEnvelope {
  event: 'generation.segment.started'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
}

/** 分段增量:仅在 segment 内累计,乱序/重复由 StreamAccumulator 处理 */
export interface GenerationDeltaEvent extends BackendEventEnvelope {
  event: 'generation.delta'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  deltaSequence: number
  text: string
}

/** 一个分段完成(不结束父回复);content 为权威完整文本(可缺省,缺省保留 delta 拼接) */
export interface SegmentCompletedEvent extends BackendEventEnvelope {
  event: 'generation.segment.completed'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  content?: string
}

/** 父回复完成:唯一结束父回复的事件,统一写入 Token/模型/心情 */
export interface GenerationCompletedEvent extends BackendEventEnvelope {
  event: 'generation.completed'
  generationId: string
  messageId?: string
  responseId: string
  usage?: TokenUsage
  conversationUsage?: ConversationTokenUsage
  model?: string
  emotion?: string
  finishReason?: string
}

export interface GenerationFailedEvent extends BackendEventEnvelope {
  event: 'generation.failed'
  generationId: string
  messageId?: string
  error: { code: string; message: string; retryable?: boolean; details?: unknown }
}

/** 模型 Profile 激活结果（switch_model.result；判别字段用 event，配合 schemas/events.ts 的 z.discriminatedUnion('event', ...)） */
export interface SwitchModelResultEvent extends BackendEventEnvelope {
  event: 'switch_model.result'
  service: 'llm' | 'stt' | 'tts'
  model: string
  ok: boolean
  error?: string
}

/** TTS 声音切换结果（set_tts_voice.result；同用 event 判别字段） */
export interface SetTtsVoiceResultEvent extends BackendEventEnvelope {
  event: 'set_tts_voice.result'
  ok: boolean
  error?: string
  voice?: string
}

// —— 阶段 4 批次 B（P4-B）：语音族事件（spec 5.2 逐字）——
// audio / audio_end 原始帧不进 BackendEvent（Main 内解码缓冲，D-P9）；
// voice_session.ack 进事件流（voiceStore 背压消费）；voice.error 承载语音族错误（D-P15）。

/** 普通录音转写字幕（voice.transcript；PENDING 字幕，终态确认文本在 commit 由用户确认） */
export interface VoiceTranscriptEvent extends BackendEventEnvelope { event: 'voice.transcript'; recordingId: string; text: string; emotion?: string }
/** 实时会话已建立（voice_session.started） */
export interface VoiceSessionStartedEvent extends BackendEventEnvelope { event: 'voice_session.started'; sessionId: string; conversationId?: string }
/** 实时会话字幕增量（voice_session.partial；后端 VAD 分段） */
export interface VoiceSessionPartialEvent extends BackendEventEnvelope { event: 'voice_session.partial'; sessionId: string; turnId: number; segmentIndex: number; text: string }
/** 实时会话轮次自动提交（voice_session.turn；后端预分配 messageId，触发 generation） */
export interface VoiceSessionTurnEvent extends BackendEventEnvelope { event: 'voice_session.turn'; sessionId: string; turnId: number; messageId: string; conversationId?: string; text: string }
/** 实时会话背压确认（voice_session.ack；seq=服务端已收 BINARY 帧序数，~1s 周期） */
export interface VoiceSessionAckEvent extends BackendEventEnvelope { event: 'voice_session.ack'; sessionId: string; seq: number }
/** 实时会话结束（voice_session.ended；reason 四值） */
export interface VoiceSessionEndedEvent extends BackendEventEnvelope { event: 'voice_session.ended'; sessionId: string; reason: 'stopped' | 'cancelled' | 'timeout' | 'stt_disabled' }
/** 输入法转写字幕累积（dictation.partial；只回文字，零消息副作用） */
export interface DictationPartialEvent extends BackendEventEnvelope { event: 'dictation.partial'; text: string }
/** 输入法转写终态（dictation.final；前端写草稿，不创建消息、不自动发送） */
export interface DictationFinalEvent extends BackendEventEnvelope { event: 'dictation.final'; clientRequestId: string; text: string }
/** 输入法转写取消（dictation.cancelled） */
export interface DictationCancelledEvent extends BackendEventEnvelope { event: 'dictation.cancelled'; clientRequestId: string }
/** TTS 句开始（audio.session.started；Phase 2 放行后、首 chunk 前） */
export interface AudioSessionStartedEvent extends BackendEventEnvelope { event: 'audio.session.started'; streamId: number; format?: 'wav' | 'mp3' }
/** TTS 整段就绪（audio.session.ready；Main 缓冲收齐后经 MediaService 出 URL） */
export interface AudioSessionReadyEvent extends BackendEventEnvelope { event: 'audio.session.ready'; streamId: number; url: string; durationMs?: number; format?: 'wav' | 'mp3' }
/** TTS 播放取消/中断（audio.session.cancelled；audio.cancel / TTS 中断时发，前端清理孤儿 chunk） */
export interface AudioSessionCancelledEvent extends BackendEventEnvelope { event: 'audio.session.cancelled'; streamId: number }
/** 语音族错误（voice.error；D-P15：real-backend 对语音族错误码额外 emit，connectionStore 横幅抑制） */
export interface VoiceErrorEvent extends BackendEventEnvelope { event: 'voice.error'; code: string; message?: string }

// —— 阶段 5 批次 C（C3）：后端 Live2D 表现指令建议（live2d.directive）——
// 扁平 wire 帧（对齐 doc 02 §4 v2 扁平 + §12 形状）；与 events.ts 全部成员扁平惯例一致，无 payload 包装。
// state 七值（剔除 error——error=3 必须 client 驱动，D5C-07）；priority ∈ [0,3]（客户端消费时 clamp ≤1 为建议强度）。
export type DirectiveState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'sad' | 'surprised'

/** 后端 Live2D 表现指令建议（live2d.directive；显式指令 > emotion 自动映射，消费在 live2dStore.handleDirective） */
export interface Live2DDirectiveEvent extends BackendEventEnvelope {
  event: 'live2d.directive'
  expression?: string
  motion?: string
  state?: DirectiveState
  priority?: 0 | 1 | 2 | 3
  durationMs?: number
}

/** 后端事件判别联合 */
export type BackendEvent =
  | GenerationStartedEvent
  | GenerationSegmentStartedEvent
  | GenerationDeltaEvent
  | SegmentCompletedEvent
  | GenerationCompletedEvent
  | GenerationFailedEvent
  | SwitchModelResultEvent
  | SetTtsVoiceResultEvent
  | VoiceTranscriptEvent
  | VoiceSessionStartedEvent
  | VoiceSessionPartialEvent
  | VoiceSessionTurnEvent
  | VoiceSessionAckEvent
  | VoiceSessionEndedEvent
  | DictationPartialEvent
  | DictationFinalEvent
  | DictationCancelledEvent
  | AudioSessionStartedEvent
  | AudioSessionReadyEvent
  | AudioSessionCancelledEvent
  | VoiceErrorEvent
  | Live2DDirectiveEvent
