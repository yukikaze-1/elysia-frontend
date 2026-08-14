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

export const SessionPersistenceStateSchema = z.object({
  drafts: z.array(ConversationDraftSchema),
  scrollAnchors: z.record(z.string(), ScrollAnchorSchema),
  lastActiveConversationId: z.string().optional(),
  conversations: z.array(ConversationSchema),
  messageSnapshots: z.record(z.string(), z.array(MessageSchema))
})
