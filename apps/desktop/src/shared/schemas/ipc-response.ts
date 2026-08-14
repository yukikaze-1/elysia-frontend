import { z } from 'zod'
import { TokenUsageSchema } from './events'

/**
 * 共享领域响应 Schema —— 严格镜像 `shared/contracts` 类型(C1)。
 * Main handler responseSchema 与 Preload 防御性解析共用;
 * 字段可丢即表示契约形状漂移,禁止为「宽松」而放宽必填项。
 */

export const ConnectionStateSchema = z.object({
  status: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'error']),
  serverUrl: z.string().optional(),
  protocolVersion: z.string().optional(),
  serverVersion: z.string().optional(),
  connectionId: z.string().optional(),
  activeConversationId: z.string().optional(),
  lastError: z.string().optional()
})

export const BackendSessionSchema = z.object({
  sessionId: z.string().min(1),
  protocolVersion: z.string().min(1),
  serverUrl: z.string().min(1)
})

export const ClientRequestRefSchema = z.object({
  clientRequestId: z.string().min(1),
  serverMessageId: z.string().optional()
})

export const ActivateConversationResultSchema = z.object({
  conversationId: z.string().min(1)
})

export const RuntimeInfoSchema = z.object({
  mode: z.enum(['real', 'mock']),
  packaged: z.boolean()
})

export const EndpointResponseSchema = z.object({
  endpoint: z.string().optional()
})

export const MessageAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']),
  mediaType: z.string().min(1),
  name: z.string().optional(),
  size: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  messageId: z.string().optional()
})

export const AssistantSegmentSchema = z.object({
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: z.enum(['inner_voice', 'public_reply']),
  kind: z.enum(['text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link']),
  text: z.string().optional(),
  completed: z.boolean(),
  attachmentId: z.string().optional(),
  url: z.string().optional(),
  mediaType: z.string().optional(),
  name: z.string().optional(),
  size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number().optional()
})

/** 镜像 contracts/message.ts `MessageToolInfo`（全 optional；rest-mapper assemble 产出同形对象） */
export const MessageToolInfoSchema = z.object({
  callId: z.string().optional(),
  name: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  errorType: z.string().optional(),
  durationMs: z.number().optional(),
  truncated: z.boolean().optional()
})

export const MessageSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().optional(),
  status: z.enum(['pending', 'acknowledged', 'streaming', 'completing', 'completed', 'failed', 'interrupted']),
  createdAt: z.string(),
  clientMessageId: z.string().optional(),
  assistantSegments: z.array(AssistantSegmentSchema).optional(),
  tool: MessageToolInfoSchema.optional(),   // 严格镜像 MessageToolInfo(rest-mapper assemble 产出;M4:输出须可赋值回 Message)
  attachments: z.array(MessageAttachmentSchema).optional(),   // 附件内嵌消息（阶段 3 G3，D2）
  usage: TokenUsageSchema.optional(),
  model: z.string().optional(),
  emotion: z.string().optional()
})

export const ConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  updatedAt: z.string(),
  preview: z.string().optional()
})

export const PageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({ items: z.array(itemSchema), hasMore: z.boolean(), nextCursor: z.string().optional() })

export const MessagePageSchema = PageSchema(MessageSchema)

export const FileValidationResultSchema = z.object({
  localId: z.string().min(1),
  ok: z.boolean(),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']).optional(),
  reason: z.string().optional(),
  message: z.string().optional()
})
export const AttachmentsUploadResponseSchema = z.object({
  uploadId: z.string().min(1),
  attachments: z.array(MessageAttachmentSchema)
})
export const AttachmentCheckResultSchema = z.object({
  status: z.enum(['ok', 'expired', 'not_found', 'revoked', 'error']),
  reason: z.string().optional()
})

export const ReplayPayloadSchema = z.object({
  conversationId: z.string().min(1),
  messages: z.array(MessageSchema)
})
