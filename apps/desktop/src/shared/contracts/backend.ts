import type { Conversation, PageQuery } from './conversation'
import type { Message } from './message'

/** 建立连接后的会话标识(协议版本协商) */
export interface BackendSession {
  sessionId: string
  protocolVersion: string
  serverUrl: string
}

export interface ConnectInput {
  serverUrl: string
  token?: string
}

export interface GetConversationQuery {
  conversationId: string
}

export interface ConversationDetail extends Conversation {
  messages?: Message[]
}

export interface MessageContextQuery {
  conversationId: string
  messageId: string
  before?: number
  after?: number
}

/** 会话消息分页查询(游标为后端 _id opaque 串) */
export interface ConversationMessagesQuery {
  conversationId: string
  before?: string   // _id opaque cursor(倒序)
  after?: string    // _id opaque cursor(正序增量)
  limit?: number
}

/** 激活会话结果(后端返回的权威会话标识) */
export interface ActivateConversationResult {
  conversationId: string
}

/** 消息上下文页(历史查看器跳转来源) */
export interface MessagePage {
  items: Message[]
  nextCursor?: string
  hasMore: boolean
}

export interface CancelGenerationInput {
  generationId: string
}

export interface TestModelProfileCommand {
  profileId: string
}

export interface ModelProfileTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

export interface ActivateModelProfileCommand {
  profileId: string
}

/** 统一聊天历史查看器查询 */
export interface ChatHistoryQuery extends PageQuery {
  keyword?: string
  fromDate?: string
  toDate?: string
  category?: string
}

export interface ChatHistoryPage {
  items: Message[]
  nextCursor?: string
  hasMore: boolean
}

export interface VoiceInputSession {
  sessionId: string
}

export interface StartVoiceInputInput {
  conversationId: string
}

export interface StopVoiceInputInput {
  sessionId: string
}

export interface DictationSession {
  sessionId: string
}

export interface StartDictationInput {
  conversationId: string
  sttProfileId: string
}

export interface StopDictationInput {
  sessionId: string
}

/** 工具结果回传 */
export interface ToolResult {
  callId: string
  status: 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timeout'
  summary?: string
}
