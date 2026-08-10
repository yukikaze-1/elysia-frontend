/** 双展示通道:Inner Voice 与 Public Reply 属于同一条 AI 回复消息 */
export type SegmentChannel = 'inner_voice' | 'public_reply'

/** 分段内容类型(P0 Inner Voice 仅 text/markdown) */
export type SegmentKind =
  | 'text'
  | 'markdown'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'sticker'
  | 'link'

/** 一条 AI 回复内的有序分段(全局顺序由 segmentIndex 决定) */
export interface AssistantSegment {
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  text?: string
  completed: boolean
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export type MessageStatus =
  | 'pending'
  | 'acknowledged'
  | 'streaming'
  | 'completing'
  | 'completed'
  | 'interrupted'
  | 'failed'

/**
 * 消息实体。
 * - assistant 可见正文的单一事实来源是 `assistantSegments`,不得复制到 `content`;
 * - `content` 只用于 user/system/tool 消息,由 Adapter 入 Store 前归一化。
 */
export interface Message {
  messageId: string
  conversationId: string
  role: MessageRole
  content?: string
  assistantSegments?: AssistantSegment[]
  status: MessageStatus
  clientMessageId?: string
  createdAt: string
  /** 回复级元数据,在父回复完成时写入 */
  usage?: TokenUsage
  model?: string
  emotion?: string
  /** tool 消息元数据(docs/18 §14:不得按普通文本丢弃) */
  tool?: MessageToolInfo
}

/** tool 消息元数据(docs/18 §14:不得按普通文本丢弃) */
export interface MessageToolInfo {
  callId?: string
  name?: string
  success?: boolean
  error?: string
  errorType?: string
  durationMs?: number
  truncated?: boolean
}

/** 单轮 token 消耗(映射自后端 raw TokenRound;session_id/timestamp 有意丢弃) */
export interface TokenUsageRound {
  model?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  roundNum: number
}

/** Token 用量(区分单次回复 vs 服务端累计;禁止用字符数冒充) */
export interface TokenUsage {
  input: number
  output: number
  total: number
  source: 'provider_reported' | 'server_aggregate' | 'client_sum'
  /** 保留模型/缓存/推理拆分(设置页/诊断页后续需要) */
  rounds?: TokenUsageRound[]
}

/** 会话累计 token(后端只提供 total+byModel,禁止虚构 input/output) */
export interface ConversationTokenUsage {
  total: number
  byModel: Record<string, number>
  source: 'server_aggregate'
}

/** 发送用户消息 */
export interface SendMessageInput {
  conversationId: string
  text: string
  clientRequestId: string
}

/** 发送确认引用(clientRequestId 幂等) */
export interface ClientRequestRef {
  clientRequestId: string
  serverMessageId?: string
}
