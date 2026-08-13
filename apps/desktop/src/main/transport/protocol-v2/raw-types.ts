/** 后端 WS v2 raw wire 类型(保留后端原始命名;与领域层禁止混用) */

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
  message_id?: string
  timestamp?: string
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
  duration_ms?: number
  truncated?: boolean
  token_usage?: RawTokenUsage
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
export interface RawExpression {
  type: 'expression'
  expression: string
  intensity?: number
}
/** FSM 状态变更（FE-INT-P1-01：契约识别 + 有意忽略，renderer 暂不消费） */
export interface RawState { type: 'state'; state: string }
/** 输入状态变更（同上） */
export interface RawTyping { type: 'typing'; typing: boolean }

/** generation 文本聊天帧 */
export interface RawGenerationStarted {
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
export interface RawGenerationCompleted {
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
export interface RawGenerationFailed {
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
export type RawFrame =
  | RawSessionMessage | RawServerInfo | RawExpression | RawState | RawTyping
  | RawGenerationStarted | RawGenerationSegmentStarted | RawGenerationDelta
  | RawGenerationSegmentCompleted | RawGenerationCompleted | RawGenerationFailed
  | RawUserAck | RawErrorMessage
