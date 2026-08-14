// 阶段 3 G2 持久化契约（spec §4.2）：草稿+滚动锚点 / 会话列表缓存 / 消息快照缓存 / 外部链接。
// 信任边界：Main 是持久化边界，Renderer 只持内存态；这些类型经 IPC 流转，Render 端经 schema 校验。
import type { Conversation, ConversationDraft } from './conversation'
import type { Message } from './message'

/** 可视锚点：视口顶 → 锚点消息顶的偏移（D5） */
export interface ScrollAnchor {
  messageId: string
  offset: number
}

/** 草稿+滚动锚点 upsert（防抖/切会话 flush；draft.text 空串=清除） */
export interface PersistSessionInput {
  conversationId: string
  draft: { text: string; updatedAt: string }
  scrollAnchor: ScrollAnchor | null
}

/** persistSession 响应：本次写入触发 50 会话上限淘汰时，返回被淘汰条目的 conversationId（P2-1，淘汰不静默） */
export interface PersistSessionResult {
  evictedConversationIds?: string[]
}

/** 已确认消息快照增量推送（Renderer 装配后推送；Main 按 messageId 去重合并） */
export interface CacheMessagesInput {
  conversationId: string
  messages: Message[]
  updatedAt: string
}

/** Markdown 外部链接（http/https 白名单，Main shell.openExternal） */
export interface OpenExternalInput {
  url: string
}

/** 启动水合响应：草稿+锚点+上次活动会话+最近 20 会话列表+消息快照 */
export interface SessionPersistenceState {
  drafts: ConversationDraft[]
  scrollAnchors: Record<string, ScrollAnchor>
  lastActiveConversationId?: string
  conversations: Conversation[]
  messageSnapshots: Record<string, Message[]>
}
