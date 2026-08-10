/** REST wire 类型(保留后端混合命名:message_id/_id/tool_call_id snake + camel) */

export interface RestSessionSummary {
  conversationId: string
  title?: string
  messageCount: number
  updatedAt: string
  active: boolean
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
  duration_ms?: number
  truncated?: boolean
}
export interface RestMessagesPageResponse { messages: RestMessage[]; has_more: boolean; total: number; cursor?: string }
export interface RestSessionActivateResult { activeConversationId: string }
export interface RestPendingQueryResponse {
  pendingMessages: { messageId: string; snippet: string; createdAt: string }[]
  pendingApprovals: unknown[]
}
