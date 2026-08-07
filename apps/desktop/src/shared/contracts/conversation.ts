/** 会话分页查询(游标分页,后端为事实来源) */
export interface PageQuery {
  cursor?: string
  limit?: number
}

/** 分页结果 */
export interface Page<T> {
  items: T[]
  nextCursor?: string
  hasMore: boolean
}

/** 会话实体(前端领域模型,由 BackendAdapter 归一化) */
export interface Conversation {
  id: string
  title: string
  updatedAt: string
  preview?: string
}

export interface CreateConversationInput {
  title?: string
}

/** 每会话草稿 */
export interface ConversationDraft {
  conversationId: string
  text: string
  attachmentLocalIds: string[]
  updatedAt: string
}
