import type { ToolCallRecord } from './tool'
import type { CharacterGenerationRef } from './character'

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
  stickerId?: string             // 阶段 3 G4：sticker 分段身份（wire sticker 消息渲染专用，D8）
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
  /** 阶段 6 批次 A（F-6-20）：归档/回放重建的工具调用记录（配对产物，卡片数据源；实时 toolStore 为批次 B） */
  toolCalls?: ToolCallRecord[]
  /** 附件内嵌消息（spec 阶段 3 G3，D2）；upload 响应/媒体 ContentPart 映射而来 */
  attachments?: MessageAttachment[]
  /** 阶段 3 G4：用户贴图消息 wire 表示（§7 开放项按可选字段落地，联调对齐后端） */
  stickerId?: string
  /** 多角色 FE-A：消息角色审计快照（§5.10；assistant 保存实际生成时快照，user/tool 通常省略；
   *  replay/REST 优先用消息自身快照，缺失不硬编码 Cyrene/Elysia） */
  character?: CharacterGenerationRef
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
  /** 桌面工具桥调用 ID（仅从受信的归档工具附件路径派生；不透出后端 URL） */
  desktopCallId?: string
  /** 归档工具结果中可恢复的附件数量 */
  attachmentCount?: number
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
  /**
   * C10（2026-09-15 契约评审）：**客户端本地消息 ID**——`clientRequestId` 管"这一次请求"（幂等/ACK 关联），
   * 本字段管"这一条用户消息"（重发时请求 id 可能变化/复用，而本地乐观气泡始终是同一条）。
   *
   * 取证（X99 `66557628`）：后端 `V2TextMessage` 接受可选 `clientMessageId`
   * （`frontend_contract/ws_message/chat.py:199`），并在接受/拒绝 ACK 里回显（`_types.py:323,342`）。
   * **但 REST 归档不带该字段（`rest.py` 0 命中）、WS 回放条目也不带** ⇒ 前端**无法**据此把
   * 「ACK 超时后置 failed 的本地气泡」与「回放/REST 带回的同一条消息」合并。
   * 故本字段当前的作用是**给后端一个稳定的客户端身份**，不是前端对账；对账那一半属后端改造（记 doc 18）。
   */
  clientMessageId?: string
  /** 已上传附件引用（wire AttachmentRef 提示值；服务端以记录为准） */
  attachments?: MessageAttachmentRef[]
  /** 阶段 3 G4：贴图消息发送（text 可空；wire stickerId 透传，D8） */
  stickerId?: string
}

/** 发送确认引用(clientRequestId 幂等) */
export interface ClientRequestRef {
  clientRequestId: string
  serverMessageId?: string
}
