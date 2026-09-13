import { z } from 'zod'
import { ConversationSchema, MessageSchema } from './ipc-response'

/** 草稿文件条目（drafts-v1.json entries 值；attachmentLocalIds 契约保留为空，G3 接入） */
export const ConversationDraftSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string(),
  attachmentLocalIds: z.array(z.string()),
  updatedAt: z.string()
})

export const ScrollAnchorSchema = z.object({
  messageId: z.string().min(1),
  offset: z.number().finite().nonnegative()
})

export const PersistSessionInputSchema = z.object({
  conversationId: z.string().min(1),
  draft: z.object({ text: z.string().max(100_000), updatedAt: z.string() }),
  scrollAnchor: ScrollAnchorSchema.nullable()
})

export const PersistSessionResultSchema = z.object({
  evictedConversationIds: z.array(z.string().min(1)).optional()
})

export const CacheMessagesInputSchema = z.object({
  conversationId: z.string().min(1),
  messages: z.array(MessageSchema),
  updatedAt: z.string()
})

export const OpenExternalInputSchema = z.object({ url: z.string() })

/**
 * 降级态投影（H-11b renderer 半边，2026-09-13）：`file` 为**基名**（`z.string().min(1)` 已是硬约束，
 * 但基名不含分隔符这一条由 Main 保证），`reason` 来自封闭取值集合，二者都不含绝对路径。
 * 上限刻意写得比真实值宽（文件名/标签都远小于此），只用于挡住畸形输入而非限长。
 */
export const PersistenceDegradedNoticeSchema = z.object({
  file: z.string().min(1).max(260),
  reason: z.string().min(1).max(200)
})

export const SessionPersistenceStateSchema = z.object({
  drafts: z.array(ConversationDraftSchema),
  scrollAnchors: z.record(z.string(), ScrollAnchorSchema),
  lastActiveConversationId: z.string().optional(),
  conversations: z.array(ConversationSchema),
  messageSnapshots: z.record(z.string(), z.array(MessageSchema)),
  persistenceDegraded: PersistenceDegradedNoticeSchema.optional()
})
