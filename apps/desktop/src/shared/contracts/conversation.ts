import type { CharacterBindingSnapshot, CharacterId } from './character'

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
  /** 多角色 FE-A：会话角色绑定摘要（§5.9；legacy 会话/旧后端缺省，缺失即 legacy，不从 title/Live2D 猜） */
  character?: CharacterBindingSnapshot
}

export interface CreateConversationInput {
  title?: string
  /** 多角色 FE-A：新建会话显式选角（§5.9；旧后端兼容模式省略）；已有会话不换角色 */
  characterId?: CharacterId
}

/** 每会话草稿 */
export interface ConversationDraft {
  conversationId: string
  text: string
  attachmentLocalIds: string[]
  updatedAt: string
}
