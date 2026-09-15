import type { SegmentChannel, SegmentKind, TokenUsage, ConversationTokenUsage } from './message'
import type { ToolRuntime } from './tool'
import type { CharacterPublicStateView, CharacterStatus } from './character'

/** 事件外壳:所有后端事件共有的标识字段 */
export interface BackendEventEnvelope {
  eventId: string
  sequence: number
  timestamp?: string
}

/** 表现/TTS 事件的角色归属；迁移期字段 optional，能力开启后的必填与当前 binding 校验留给运行时。 */
export interface CharacterEventIdentity {
  conversationId?: string
  generationId?: string
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
}

/** 一次 AI 回复开始 */
export interface GenerationStartedEvent extends BackendEventEnvelope {
  event: 'generation.started'
  generationId: string
  messageId: string
  responseId: string
  conversationId: string
  model?: string
  /** 多角色 FE-A：generation 角色身份（CHAR-FE-08；迁移期 optional，character_profiles=true 后三条终态路径必填且与 started 一致） */
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
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
  /** 多角色 FE-A：同 started 的角色身份（一致性与迟到事件守卫在 FE-E 消费） */
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
}

export interface GenerationFailedEvent extends BackendEventEnvelope {
  event: 'generation.failed'
  generationId: string
  messageId?: string
  error: { code: string; message: string; retryable?: boolean; details?: unknown }
  /** 多角色 FE-A：同 started 的角色身份 */
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
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
export interface AudioSessionStartedEvent extends BackendEventEnvelope, CharacterEventIdentity {
  event: 'audio.session.started'
  streamId: number
  format?: 'wav' | 'mp3'
}
/** TTS 整段就绪（audio.session.ready；Main 缓冲收齐后经 MediaService 出 URL） */
export interface AudioSessionReadyEvent extends BackendEventEnvelope, CharacterEventIdentity {
  event: 'audio.session.ready'
  streamId: number
  url: string
  durationMs?: number
  format?: 'wav' | 'mp3'
}
/** TTS 播放取消/中断（audio.session.cancelled；audio.cancel / TTS 中断时发，前端清理孤儿 chunk） */
export interface AudioSessionCancelledEvent extends BackendEventEnvelope, CharacterEventIdentity {
  event: 'audio.session.cancelled'
  streamId: number
}
/** 语音族错误（voice.error；D-P15：real-backend 对语音族错误码额外 emit，connectionStore 横幅抑制） */
export interface VoiceErrorEvent extends BackendEventEnvelope { event: 'voice.error'; code: string; message?: string }

// —— 阶段 5 批次 C（C3）：后端 Live2D 表现指令建议（live2d.directive）——
// 扁平 wire 帧（对齐 doc 02 §4 v2 扁平 + §12 形状）；与 events.ts 全部成员扁平惯例一致，无 payload 包装。
// state 七值（剔除 error——error=3 必须 client 驱动，D5C-07）；priority ∈ [0,3]（客户端消费时 clamp ≤1 为建议强度）。
export type DirectiveState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'sad' | 'surprised'

/** 后端 Live2D 表现指令建议（live2d.directive；显式指令 > emotion 自动映射，消费在 live2dStore.handleDirective） */
export interface Live2DDirectiveEvent extends BackendEventEnvelope {
  event: 'live2d.directive'
  /** 多角色 FE-A：表现指令身份（迁移期 optional；运行时守卫负责能力开启后的必填）。 */
  conversationId?: string
  generationId?: string
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
  expression?: string
  motion?: string
  state?: DirectiveState
  priority?: 0 | 1 | 2 | 3
  durationMs?: number
}

/** 后端 expression 表现帧归一后的领域事件；不再在 Main mapper 中静默丢失身份。 */
export interface ExpressionEvent extends BackendEventEnvelope, CharacterEventIdentity {
  event: 'expression'
  expression: string
  intensity?: number
}

// —— 阶段 6 批次 A（F-6）：工具双轨领域事件（D6-01~08）——
// wire 双轨（Desktop tool.request / Backend tool.started+completed）→ 领域单轨事件；
// 原始 arguments 永不进 Renderer（D6-07，tool.request 事件只含脱敏 inputSummary）。

/** 桌面工具执行请求（脱敏公开事件；原始 arguments 不含，权限/幂等/执行归批次 B） */
export interface ToolRequestEvent extends BackendEventEnvelope {
  event: 'tool.request'
  callId: string            // 桥 callId（call_ 前缀；执行协议关联，D6-03）
  sourceCallId: string      // 权威键（LLM tool_call_id）
  toolName: string
  toolVersion: string       // wire 必填直映（非安全元数据，review C1 修正）
  runtime: ToolRuntime
  reason?: string
  inputSummary?: string     // 本地脱敏摘要（redactToolArguments；原始 arguments 永不进 Renderer）
  expiresAt: string         // wire 必填（桥 request_timeout 绝对过期；批次 B 权限窗超时兜底，review C2 修正）
  requestId?: string
  // —— D4-1（2026-09-15 裁决「补代码」）：wire 风险元数据直映 ——
  // **仅 Main 消费**（real-backend 显式读它们并交给 tool-service 重算/审计）；本事件不经 `tool:event`
  // 下发 Renderer——D6-07 的公开事件是 `PublicToolEvent`，两者是不同通道，勿混用。
  riskLevel?: string        // wire 为 str（safe/medium/high）；非枚举值在重算中按 high 处理
  permissionRequired?: boolean
  approvalAuthority?: string   // 记录用：授权判定权威仍在本地注册表（doc 04 §7.4），该字段不参与判定
}

/** Backend 工具开始（展示生命周期；callId = sourceCallId 同值） */
export interface ToolStartedEvent extends BackendEventEnvelope {
  event: 'tool.started'
  callId: string
  toolName: string
  runtime: ToolRuntime
  inputSummary?: string
  generationId?: string
  conversationId?: string
}

/** Backend 工具完成（success 区分 completed/failed；outputSummary ≤2000 + truncated 直映） */
export interface ToolCompletedEvent extends BackendEventEnvelope {
  event: 'tool.completed'
  callId: string
  toolName: string
  runtime: ToolRuntime
  success: boolean
  outputSummary?: string
  error?: { code?: string; message?: string }   // 从 wire record 提取已知键；缺省 undefined
  errorType?: string
  durationMs?: number
  truncated?: boolean
  generationId?: string
  conversationId?: string
}

// —— 多角色 FE-A（设计 §7.1/§7.3/§7.6）：角色公开状态与目录变更事件 ——
// state 是完整 CharacterPublicStateView（不是 patch）；顺序判断只看 stateVersion，updatedAt 仅展示/诊断。
// catalog.changed 只作失效通知：不携带完整 Prompt，Renderer 收到后经 Main 重新 GET。

/** 角色公开状态变化（character.state.changed；完整 view 整体替换该 instance 公开视图） */
export interface CharacterStateChangedEvent extends BackendEventEnvelope {
  event: 'character.state.changed'
  /** Desktop-local source fence; never comes from the backend wire payload. */
  connectionScopeId?: string
  conversationId: string
  characterId: string
  characterInstanceId: string
  characterRevision: number
  stateVersion: number
  state: CharacterPublicStateView
}

/** 角色目录失效通知（character.catalog.changed；revision 较旧的事件不回退缓存） */
export interface CharacterCatalogChangedEvent extends BackendEventEnvelope {
  event: 'character.catalog.changed'
  /** Desktop-local source fence; never comes from the backend wire payload. */
  connectionScopeId?: string
  characterId: string
  currentRevision: number
  status: CharacterStatus
  updatedAt: string
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
  | ExpressionEvent
  | Live2DDirectiveEvent
  // —— 阶段 6 批次 A（F-6-03）——
  | ToolRequestEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  // —— 多角色 FE-A（§7.1）：角色状态与目录事件 ——
  | CharacterStateChangedEvent
  | CharacterCatalogChangedEvent
