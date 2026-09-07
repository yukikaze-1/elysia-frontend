/** 后端 WS v2 raw wire 类型(保留后端原始命名;与领域层禁止混用) */
import type { RestCharacterBindingSnapshot } from './character-rest-types'

export type RawSegmentChannel = 'inner_voice' | 'public_reply' | 'status'
export type RawSegmentKind = 'text' | 'markdown' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'link'

export interface RawTokenRound {
  model?: string
  session_id?: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cached_tokens?: number
  reasoning_tokens?: number
  round_num: number
  timestamp?: string
}
export interface RawTokenUsage { rounds: RawTokenRound[]; turn_total: number }
export interface RawTokenStats { total: number; byModel: Record<string, number> }
export interface RawConversationUsage { total: number; byModel: Record<string, number> }
export interface RawTokenTurnStats { rounds?: RawTokenRound[]; turn_total?: number }

/** 建连帧(ws_handler:session → server_info → expression) */
export interface RawSessionMessage {
  type: 'session'
  conversationId?: string
  messages: RawSessionMessageItem[]
  token_stats?: RawTokenStats
}
export interface RawSessionMessageItem {
  // 2A 只做结构校验;parts/content/tool_calls 用 unknown 是有意放宽(精确类型在 2B 回放归一化时建)
  role: string
  message_id: string // D2:持久化消息要求非空身份
  timestamp: string
  parts?: unknown[]
  content?: unknown
  content_type?: Record<string, number[]>
  mood?: string
  tool_calls?: unknown[]
  inner_voice?: string
  tool_call_id?: string
  name?: string
  success?: boolean
  error?: string
  error_type?: string
  duration_ms?: number | null // P0-02：WS replay wire 类型同步（raw-schemas duration_ms 已 nullable，诚实反映 wire）
  truncated?: boolean
  token_usage?: RawTokenUsage
  /** 多角色 FE-A：WS 回放消息内嵌角色快照（CHAR-FE-07；与 REST 同形 camelCase，legacy 缺省） */
  character?: RestCharacterBindingSnapshot
}
export interface RawServerInfo {
  type: 'server_info'
  protocol_version: string
  server_version: string
  features: Record<string, unknown>
  services: Record<string, unknown>
  connectionId?: string
  build_sha?: string
}
/** 表现/TTS raw 帧的角色归属；迁移期 optional，character_profiles=true 的必填门在运行时守卫处理。 */
interface RawCharacterEventIdentity {
  conversationId?: string
  generationId?: string
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
}
export interface RawExpression extends RawCharacterEventIdentity {
  type: 'expression'
  expression: string
  intensity?: number
}
/** FSM 状态变更（FE-INT-P1-01：契约识别 + 有意忽略，renderer 暂不消费） */
export interface RawState { type: 'state'; state: string }
/** 输入状态变更（同上） */
export interface RawTyping { type: 'typing'; typing: boolean }
/** 后端部分旧输出路径仍会向 v2 连接广播的兼容帧；v2 领域链路有权威 generation/session 帧，故只识别不消费。 */
export interface RawDeltaMessage { type: 'delta'; content: string; stream_id?: number }
export interface RawMessageMessage { type: 'message'; role?: string; content?: string; mood?: string }
export interface RawTokenUsageMessage { type: 'token_usage'; turn?: RawTokenTurnStats; session?: RawTokenStats }

/** generation 文本聊天帧 */
/** generation 角色身份（多角色 FE-A，CHAR-FE-08；三条 started/completed/failed 均可携带，迁移期 optional） */
interface RawGenerationCharacterIdentity {
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
}

export interface RawGenerationStarted extends RawGenerationCharacterIdentity {
  type: 'generation.started'
  generationId: string
  messageId: string
  conversationId?: string
  requestId?: string
  model?: string
}
export interface RawGenerationSegmentStarted {
  type: 'generation.segment.started'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: RawSegmentChannel
  kind: RawSegmentKind
  conversationId?: string
}
export interface RawGenerationDelta {
  type: 'generation.delta'
  generationId: string
  segmentId: string
  segmentIndex: number
  deltaSequence: number
  delta: string
  conversationId?: string
}
export interface RawGenerationSegmentCompleted {
  type: 'generation.segment.completed'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: RawSegmentChannel
  kind: RawSegmentKind
  content?: string
  conversationId?: string
}
export interface RawGenerationCompleted extends RawGenerationCharacterIdentity {
  type: 'generation.completed'
  generationId: string
  messageId: string
  channel: 'public_reply'
  finishReason: 'stop' | 'tool_calls'
  usage: RawTokenUsage
  model: string
  mood?: string
  completeness?: string
  conversationId?: string
  conversationUsage?: RawConversationUsage
}
export interface RawGenerationFailed extends RawGenerationCharacterIdentity {
  type: 'generation.failed'
  generationId: string
  messageId?: string
  model?: string
  code: string
  message: string
  retryable: boolean
  details: Record<string, unknown>
  conversationId?: string
}

export interface RawAckError {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
  retryAfterMs?: number
}
interface RawUserAckBase {
  type: 'user_message.ack'
  clientMessageId?: string
  conversationId?: string
  receivedAt: string
}
export interface RawAcceptedUserAck extends RawUserAckBase {
  messageId: string
  clientRequestId: string
  status: 'accepted'
}
export interface RawRejectedUserAck extends RawUserAckBase {
  messageId: ''
  clientRequestId: string
  status: 'rejected'
  error: RawAckError
}
export type RawUserAck = RawAcceptedUserAck | RawRejectedUserAck
export interface RawErrorMessage {
  type: 'error'
  message: string
  code?: string
  requestId?: string
  clientRequestId?: string
  retryable?: boolean
  retryAfterMs?: number
  details?: Record<string, unknown>
}

/** 模型 Profile 激活结果帧（对齐 ws_message.py SwitchModelResultMessage） */
export interface RawSwitchModelResult {
  type: 'switch_model_result'
  service: 'llm' | 'stt' | 'tts'
  model: string
  ok: boolean
  error?: string
}
/** TTS 声音切换结果帧（对齐 ws_message.py SetTtsVoiceResultMessage） */
export interface RawSetTtsVoiceResult {
  type: 'set_tts_voice_result'
  ok: boolean
  error?: string
  voice?: string
}

/** 普通录音预转写字幕（对齐 ws_message.py VoiceTranscriptMessage；stop 后、commit 前） */
export interface RawVoiceTranscript {
  type: 'voice.transcript'
  recordingId: string
  text: string
  emotion?: string
}
/** 实时语音会话已开始（对齐 ws_message.py VoiceSessionStartedMessage；conversationId = 解析后实际目标会话） */
export interface RawVoiceSessionStarted {
  type: 'voice_session.started'
  sessionId: string
  conversationId?: string
}
/** 实时语音轮次字幕（对齐 ws_message.py VoiceSessionPartialMessage；每段一条 = 该轮 final 文本，仅显示） */
export interface RawVoiceSessionPartial {
  type: 'voice_session.partial'
  sessionId: string
  turnId: number
  segmentIndex: number
  text: string
}
/** 实时语音轮次已提交（对齐 ws_message.py VoiceSessionTurnMessage；自动触发 generation） */
export interface RawVoiceSessionTurn {
  type: 'voice_session.turn'
  sessionId: string
  turnId: number
  messageId: string
  conversationId?: string
  text: string
}
/** 实时语音背压进度通知（对齐 ws_message.py VoiceSessionAckMessage；seq = 服务端已接收 BINARY 帧序数） */
export interface RawVoiceSessionAck {
  type: 'voice_session.ack'
  sessionId: string
  seq: number
}
/** 实时语音会话结束（对齐 ws_message.py VoiceSessionEndedMessage；reason 四值） */
export interface RawVoiceSessionEnded {
  type: 'voice_session.ended'
  sessionId: string
  reason: 'stopped' | 'cancelled' | 'timeout' | 'stt_disabled'
}
/** 输入法转写中间字幕（对齐 ws_message.py DictationPartialMessage；累积文本，仅显示） */
export interface RawDictationPartial {
  type: 'dictation.partial'
  text: string
}
/** 输入法转写最终结果（对齐 ws_message.py DictationFinalMessage；只回文字，零消息副作用） */
export interface RawDictationFinal {
  type: 'dictation.final'
  clientRequestId: string
  text: string
}
/** 输入法转写已取消（对齐 ws_message.py DictationCancelledMessage） */
export interface RawDictationCancelled {
  type: 'dictation.cancelled'
  clientRequestId: string
}
/** 音频流开始（对齐 ws_message.py AudioStartMessage；stream_id = playback ID；Phase 2 放行后、首 chunk 前） */
export interface RawAudioStart extends RawCharacterEventIdentity {
  type: 'audio_start'
  stream_id: number
  format: 'wav' | 'mp3'
  sampleRate?: number
  durationMs?: number
}
/** 音频流 chunk（对齐 ws_message.py AudioMessage；data 为 base64 字符串；is_final 恒 false，终止由 audio_end 判定） */
export interface RawAudioChunk {
  type: 'audio'
  stream_id: number
  seq: number
  data: string
  is_final: boolean
}
/** 音频流结束标记（对齐 ws_message.py AudioEndMessage；format 契约可缺省、缺省 wav） */
export interface RawAudioEnd {
  type: 'audio_end'
  stream_id: number
  format?: 'wav' | 'mp3'
}
/** 音频流被取消（对齐 ws_message.py AudioCancelledMessage；audio.cancel / TTS 中断时发，前端清理孤儿 chunk） */
export interface RawAudioCancelled {
  type: 'audio_cancelled'
  stream_id: number
}

/** 后端 Live2D 表现指令建议状态（七值；剔除 error——error=3 必须 client 驱动，D5C-07） */
export type DirectiveState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'sad' | 'surprised'

/** 后端 Live2D 表现指令建议帧（对齐 doc 02 §12；扁平 wire，C3 契约冻结；后端当前不发，桩化开发） */
export interface RawLive2DDirective extends RawCharacterEventIdentity {
  type: 'live2d.directive'
  expression?: string
  motion?: string
  state?: DirectiveState
  priority?: 0 | 1 | 2 | 3
  durationMs?: number
}

// —— 阶段 6 批次 A（F-6-01）：工具双轨 wire 帧（镜像 frontend_contract/contract.raw.ts，保留后端原始命名）——

/** 工具 Runtime（对齐契约 ToolRuntime StrEnum；raw 层自包含，不与领域层混用） */
export type RawToolRuntime = 'backend' | 'desktop' | 'local_worker'

/** 桌面工具执行请求（Server→Client 定向投递；sourceCallId 必填 = LLM tool_call_id 权威键，D6-03/D6-07） */
export interface RawToolRequest {
  type: 'tool.request'
  callId: string                    // 桥 callId（call_ 前缀；执行协议关联）
  toolName: string
  toolVersion: string
  runtime: RawToolRuntime
  sourceCallId: string              // LLM tool_call_id（必填，缺省即整帧拒）
  arguments: Record<string, unknown>
  reason?: string
  riskLevel: string                 // 契约为 str（safe/medium/high）；本地风险重算归批次 B
  permissionRequired: boolean
  approvalAuthority: string         // desktop → client
  paramHash: string                 // 规范化 arguments SHA-256（篡改拒绝权威依据，批次 B 消费）
  expiresAt: string                 // UTC ISO（桥 request_timeout 绝对过期）
  requestId?: string
}

/** Backend 工具开始（v2 展示生命周期；callId = LLM tool_call_id，与 started/completed/归档同值） */
export interface RawToolStarted {
  type: 'tool.started'
  callId: string
  toolName: string
  runtime: RawToolRuntime
  inputSummary?: string             // 服务端 _safe_arg_summary
  generationId?: string
  conversationId?: string
}

/** Backend 工具完成（v2 展示生命周期；outputSummary ≤2000 截断带 truncated） */
export interface RawToolCompleted {
  type: 'tool.completed'
  callId: string
  toolName: string
  runtime: RawToolRuntime
  success: boolean
  outputSummary?: string
  error?: Record<string, unknown>   // {code,message}；契约未冻结内层 → 按 record 收，mapper 提取已知键
  errorType?: string
  durationMs?: number               // 可为小数（契约 float）
  truncated?: boolean
  generationId?: string
  conversationId?: string
}

// —— 多角色 FE-A（设计 §7.1/§7.3/§7.6）：角色状态/目录变更 raw 帧 ——
// state 为完整公开视图（不是 patch）；顺序判断只看 stateVersion。raw 与领域同名字段（camelCase）。

/** 角色公开状态变化帧（character.state.changed） */
export interface RawCharacterStateChanged {
  type: 'character.state.changed'
  conversationId: string
  characterId: string
  characterInstanceId: string
  characterRevision: number
  stateVersion: number
  state: RawCharacterStateView
}

/** 完整公开状态 view（mood 由后端默认填充且必填非 null；其余 optional null 由 mapper 归一） */
export interface RawCharacterStateView {
  mood: { label: string; intensity: number; updatedAt: string }
  currentActivity?: string | null
  lastInteractionAt?: string | null
  proactiveEnabled: boolean
  updatedAt: string
}

/** 角色目录失效通知帧（character.catalog.changed；不携带完整 Prompt） */
export interface RawCharacterCatalogChanged {
  type: 'character.catalog.changed'
  characterId: string
  currentRevision: number
  status: 'active' | 'archived'
  updatedAt: string
}

/** 旧后端泛型动作帧（v2 已停发、v1 不变；契约识别 + 有意忽略，不告警不作工具状态源，D6A-03） */
export interface RawAction {
  type: 'action'
  action: string                    // 'tool_executing' | 'tool_done' | 其它（契约 Literal|str）
  params?: Record<string, unknown>
}

/** 桌面工具状态回传（Client→Server 六态；runtime 保持 str——D-status-runtime 不扩大回传契约 churn） */
export interface RawToolStatus {
  type: 'tool.status'
  callId: string
  status: 'accepted' | 'rejected' | 'running' | 'result' | 'error' | 'cancelled'
  toolName: string
  toolVersion: string
  runtime: string
  paramHash: string
  output?: string
  error?: Record<string, unknown>   // {code,message} 同 tool.completed 收法
  attachments?: RawToolAttachment[]
  executionSummary?: string
}

/** 桌面工具结果附件引用（后端托管 URL；批次 B 上传后回填） */
export interface RawToolAttachment {
  url: string
  mimeType: string
  label?: string
}

/** 客户端→服务器语音控制帧（对齐 ws_message.py ClientMessage 各成员；不进 RawFrameSchema/RAW_FRAME_TYPES，Task 4 构造发送用） */
export interface RawVoiceRecordStart {
  type: 'voice.record.start'
  recordingId: string
}
export interface RawVoiceRecordStop {
  type: 'voice.record.stop'
  recordingId: string
}
export interface RawVoiceCommit {
  type: 'voice.commit'
  recordingId: string
  text: string
  clientRequestId: string
  clientMessageId?: string
  conversationId?: string
}
export interface RawVoiceDiscard {
  type: 'voice.discard'
  recordingId: string
}
export interface RawVoiceSessionStart {
  type: 'voice_session.start'
  sessionId: string
  conversationId?: string
}
export interface RawVoiceSessionStop {
  type: 'voice_session.stop'
  sessionId: string
}
export interface RawVoiceSessionCancel {
  type: 'voice_session.cancel'
  sessionId: string
}
export interface RawDictationStart {
  type: 'dictation.start'
  clientRequestId: string
  sttProfileId?: string
}
export interface RawDictationStop {
  type: 'dictation.stop'
  clientRequestId: string
}
export interface RawDictationCancel {
  type: 'dictation.cancel'
  clientRequestId: string
}
export interface RawAudioCancel {
  type: 'audio.cancel'
  stream_id: number
}

/** 客户端→服务器帧判别联合（11 型语音控制帧 + tool.status；只作发送契约，不参与 RAW_FRAME_TYPES 计数） */
export type RawClientFrame =
  | RawVoiceRecordStart | RawVoiceRecordStop | RawVoiceCommit | RawVoiceDiscard
  | RawVoiceSessionStart | RawVoiceSessionStop | RawVoiceSessionCancel
  | RawDictationStart | RawDictationStop | RawDictationCancel
  | RawAudioCancel
  | RawToolStatus                       // 新增（客户端→服务器，不进 RawFrameSchema/RAW_FRAME_TYPES 计数）

export type RawFrame =
  | RawSessionMessage | RawServerInfo | RawExpression | RawState | RawTyping
  | RawDeltaMessage | RawMessageMessage | RawTokenUsageMessage
  | RawGenerationStarted | RawGenerationSegmentStarted | RawGenerationDelta
  | RawGenerationSegmentCompleted | RawGenerationCompleted | RawGenerationFailed
  | RawUserAck | RawErrorMessage
  | RawSwitchModelResult | RawSetTtsVoiceResult
  // 阶段 4 批次 B：三种语音（BE-060/061/062）+ TTS 播放控制（BE-063）
  | RawVoiceTranscript | RawVoiceSessionStarted | RawVoiceSessionPartial | RawVoiceSessionTurn
  | RawVoiceSessionAck | RawVoiceSessionEnded
  | RawDictationPartial | RawDictationFinal | RawDictationCancelled
  | RawAudioStart | RawAudioChunk | RawAudioEnd | RawAudioCancelled
  // 阶段 5 批次 C：后端 Live2D 表现指令建议（C3 契约冻结）
  | RawLive2DDirective
  // 阶段 6 批次 A（F-6-01）：工具双轨帧 + action 兼容帧
  | RawToolRequest | RawToolStarted | RawToolCompleted | RawAction
  // 多角色 FE-A：角色状态/目录变更帧
  | RawCharacterStateChanged | RawCharacterCatalogChanged
