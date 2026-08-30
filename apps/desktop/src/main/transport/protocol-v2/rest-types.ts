/** REST wire 类型(保留后端混合命名:message_id/_id/tool_call_id snake + camel) */
import type { RestCharacterBindingSnapshot } from './character-rest-types'

export interface RestSessionSummary {
  conversationId: string
  title?: string
  messageCount: number
  updatedAt: string
  active: boolean
  /** 多角色 FE-A：会话角色绑定快照（CHAR-FE-06；camelCase 嵌套，legacy 缺省） */
  character?: RestCharacterBindingSnapshot
}
export interface RestSessionListResult { sessions: RestSessionSummary[]; has_more: boolean; cursor?: string }
export interface RestSessionDetail { session: RestSessionSummary; messages: RestMessage[]; active: boolean }
export interface RestMessage {
  role: 'user' | 'assistant' | 'tool'
  parts?: { content: string }[]
  content?: unknown
  content_type?: Record<string, number[]>
  inner_voice?: string
  tool_calls?: unknown[]
  token_usage?: unknown
  message_id: string
  timestamp: string
  session_id?: string
  metadata?: Record<string, unknown>
  _id?: string
  tool_call_id?: string
  tool_name?: string
  success?: boolean
  error?: string
  error_type?: string
  duration_ms?: number | null   // P0-02：JSON 可为 null（wire 类型诚实反映）
  truncated?: boolean
  /** 多角色 FE-A：消息角色审计快照（CHAR-FE-07；assistant 与 summary 同形，user/tool 可省略） */
  character?: RestCharacterBindingSnapshot
}
export interface RestMessagesPageResponse { messages: RestMessage[]; has_more: boolean; total: number; cursor?: string }
export interface RestSessionActivateResult { activeConversationId: string }
export interface RestPendingQueryResponse {
  pendingMessages: { messageId: string; snippet: string; createdAt: string }[]
  pendingApprovals: unknown[]
}

/** 历史搜索 item（P0-1：对齐 frontend_contract/rest.py SearchMessageItem——camelCase，无 kind/url/sticker_id） */
export interface RestSearchMessageItem {
  conversationId: string
  messageId: string
  timestamp: string
  role?: 'user' | 'assistant' | 'tool' | 'system'
  snippet?: string
  responseId?: string
  segmentId?: string
}
export interface RestSearchMessagesResponse { items: RestSearchMessageItem[]; has_more: boolean; cursor?: string }
export interface RestMessageContextResponse { anchor: RestMessage; before: RestMessage[]; after: RestMessage[]; conversationId: string }
/** P0-2：对齐契约 StickerEntry{stickerId, src} / StickerListResponse{stickers} */
export interface RestStickerItem { stickerId: string; src: string }
export interface RestStickerListResponse { stickers: RestStickerItem[] }
