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

/** 附件类别（链接为资源级类别，不参与上传 kind） */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file' | 'link'

/** 已发送消息携带的附件（上传响应/媒体分段映射而来）；name/size/尺寸：上传响应与历史/回放 ContentPart 均提供，字段仍 optional 兜底 */
export interface MessageAttachment {
  attachmentId: string            // att_ 前缀（后端权威）
  kind: AttachmentKind
  mediaType: string               // MIME
  name?: string
  size?: number
  width?: number
  height?: number
  durationMs?: number
  /** 来源消息跳转锚点（历史查看器复用；本批消息内嵌不另存 ConversationResource） */
  messageId?: string
}

/** 发送消息携带的附件引用（wire AttachmentRef 提示值；服务端以记录为准） */
export interface MessageAttachmentRef {
  attachmentId: string
  kind: AttachmentKind
  mime: string
}

/** 一条 AI 回复内的有序分段(全局顺序由 segmentIndex 决定) */
export interface AssistantSegment {
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind              // 含 image/video/audio/file/link
  text?: string
  completed: boolean
  attachmentId?: string          // 媒体分段：附件 ID（ContentPart.attachment_id 优先，src 兜底解析）
  url?: string                   // 稳定路径 /api/attachments/{id}（展示兜底；attachment_id 缺失时解析）
  mediaType?: string
  name?: string
  size?: number
  width?: number
  height?: number
  durationMs?: number
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
  /** 附件内嵌消息（spec 阶段 3 G3，D2）；upload 响应/媒体 ContentPart 映射而来 */
  attachments?: MessageAttachment[]
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
  /** 已上传附件引用（wire AttachmentRef 提示值；服务端以记录为准） */
  attachments?: MessageAttachmentRef[]
}

/** 发送确认引用(clientRequestId 幂等) */
export interface ClientRequestRef {
  clientRequestId: string
  serverMessageId?: string
}
