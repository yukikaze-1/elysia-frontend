import { z } from 'zod'
import type { RestMessage, RestMessageContextResponse, RestMessagesPageResponse, RestPendingQueryResponse, RestSearchMessagesResponse, RestSessionDetail, RestSessionListResult, RestSessionActivateResult, RestStickerListResponse } from './rest-types'

export const RestSessionSummarySchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  active: z.boolean()
}).strict()

export const RestSessionListResultSchema = z.object({
  sessions: z.array(RestSessionSummarySchema),
  has_more: z.boolean(),
  cursor: z.string().optional()
}).strict()

export const RestMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  parts: z.array(z.object({ content: z.string() })).optional(),
  content: z.unknown().optional(),
  content_type: z.record(z.string(), z.array(z.number().int().nonnegative())).optional(),
  inner_voice: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  token_usage: z.unknown().optional(),
  message_id: z.string().min(1),
  timestamp: z.string().min(1),
  session_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  _id: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  error_type: z.string().optional(),
  duration_ms: z.number().nullable().optional(),   // P0-02：wire 边界接受 null，映射层归一化（不扩散到领域/IPC）
  truncated: z.boolean().optional()
}).strict()

export const RestMessagesPageResponseSchema = z.object({
  messages: z.array(RestMessageSchema),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
  cursor: z.string().optional()
}).strict()

export const RestSessionDetailSchema = z.object({
  session: RestSessionSummarySchema,
  messages: z.array(RestMessageSchema),
  active: z.boolean()
}).strict()

export const RestSessionActivateResultSchema = z.object({
  activeConversationId: z.string().min(1)
}).strict()

export const RestPendingQueryResponseSchema = z.object({
  pendingMessages: z.array(z.object({
    messageId: z.string().min(1), snippet: z.string(), createdAt: z.string().min(1)
  })),
  pendingApprovals: z.array(z.unknown())
}).strict()

// parse 助手(返回判别结果,调用方处理失败)
export function parseRestMessage(input: unknown): { success: true; data: RestMessage } | { success: false; error: z.ZodError } {
  return RestMessageSchema.safeParse(input)
}
export function parseRestSessions(input: unknown): { success: true; data: RestSessionListResult } | { success: false; error: z.ZodError } {
  return RestSessionListResultSchema.safeParse(input)
}
export function parseRestMessagesPage(input: unknown): { success: true; data: RestMessagesPageResponse } | { success: false; error: z.ZodError } {
  return RestMessagesPageResponseSchema.safeParse(input)
}
export function parseRestSessionDetail(input: unknown): { success: true; data: RestSessionDetail } | { success: false; error: z.ZodError } {
  return RestSessionDetailSchema.safeParse(input)
}
export function parseRestActivateResult(input: unknown): { success: true; data: RestSessionActivateResult } | { success: false; error: z.ZodError } {
  return RestSessionActivateResultSchema.safeParse(input)
}
export function parseRestPendingQuery(input: unknown): { success: true; data: RestPendingQueryResponse } | { success: false; error: z.ZodError } {
  return RestPendingQueryResponseSchema.safeParse(input)
}

// —— 阶段 3 G3 附件上传/签发响应 schema（请求不建 zod；multipart 由 RealBackend 构造）——
export const RestAttachmentUploadResponseSchema = z.object({
  attachments: z.array(z.object({
    attachmentId: z.string().min(1),
    kind: z.string().min(1),
    mime: z.string().min(1),
    size: z.number().int().nonnegative(),
    url: z.string().min(1),
    signedUrl: z.string().optional(),
    filename: z.string()
  }))
}).strict()
export const RestAttachmentSignResponseSchema = z.object({
  attachmentId: z.string().min(1),
  url: z.string().min(1),
  expiresAt: z.string().min(1)
}).strict()
export function parseAttachmentUploadResponse(input: unknown): { success: true; data: z.infer<typeof RestAttachmentUploadResponseSchema> } | { success: false; error: z.ZodError } {
  return RestAttachmentUploadResponseSchema.safeParse(input)
}
export function parseAttachmentSignResponse(input: unknown): { success: true; data: z.infer<typeof RestAttachmentSignResponseSchema> } | { success: false; error: z.ZodError } {
  return RestAttachmentSignResponseSchema.safeParse(input)
}

// —— 阶段 3 G4 历史搜索/上下文/表情清单 响应 schema（P0-1/P0-2：camelCase、无 kind/url；严格镜像契约）——
// 已知限制（P2-3）：真实后端 search item 无 kind/url，表情分类在查看器内为纯文本行、无贴图缩略图——
// 待后端 SearchMessageItem 增 kind/url 或 queryResources 通道后再富化；不伪造实现（P0-1 缺口，不为此绕契约）。
export const RestSearchMessageItemSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  timestamp: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool', 'system']).optional(),
  snippet: z.string().optional(),
  responseId: z.string().optional(),
  segmentId: z.string().optional()
}).strict()
export const RestSearchMessagesResponseSchema = z.object({
  items: z.array(RestSearchMessageItemSchema),
  has_more: z.boolean(),
  cursor: z.string().optional()
}).strict()
export const RestMessageContextResponseSchema = z.object({
  anchor: RestMessageSchema,
  before: z.array(RestMessageSchema),
  after: z.array(RestMessageSchema),
  conversationId: z.string().min(1)
}).strict()
export const RestStickerItemSchema = z.object({
  stickerId: z.string().min(1),
  src: z.string().min(1)
}).strict()
export const RestStickerListResponseSchema = z.object({ stickers: z.array(RestStickerItemSchema) }).strict()

export function parseRestSearchMessages(input: unknown): { success: true; data: RestSearchMessagesResponse } | { success: false; error: z.ZodError } {
  return RestSearchMessagesResponseSchema.safeParse(input)
}
export function parseRestMessageContext(input: unknown): { success: true; data: RestMessageContextResponse } | { success: false; error: z.ZodError } {
  return RestMessageContextResponseSchema.safeParse(input)
}
export function parseRestStickerList(input: unknown): { success: true; data: RestStickerListResponse } | { success: false; error: z.ZodError } {
  return RestStickerListResponseSchema.safeParse(input)
}

// —— 阶段 4 批次A:providers/tts wire 解析（镜像 rest.py；Provider 名动态 key 用 z.record；字段 camelCase 对齐契约）——
export const ProviderEntryWireSchema = z.object({
  models: z.array(z.string()), credentialConfigured: z.boolean().default(false),
  runtime: z.enum(['backend', 'desktop', 'local_worker']).default('backend'),
  capabilities: z.record(z.string(), z.unknown()).default({})
})
export const CustomProviderWireSchema = z.object({
  name: z.string(), base_url: z.string().optional(), api_key_env: z.string().optional(),
  models: z.array(z.string()).optional(), runtime: z.enum(['backend', 'desktop', 'local_worker']).default('backend'),
  credentialConfigured: z.boolean().default(false), capabilities: z.record(z.string(), z.unknown()).default({})
})
export const ProvidersResponseWireSchema = z.object({
  llm: z.record(z.string(), ProviderEntryWireSchema), stt: z.record(z.string(), ProviderEntryWireSchema),
  tts: z.record(z.string(), ProviderEntryWireSchema), custom: z.record(z.string(), z.array(CustomProviderWireSchema)).default({}),
  unconfigured: z.record(z.string(), z.array(z.object({ name: z.string(), env_vars: z.array(z.string()) }))).optional()
})
export const ProviderTestResultWireSchema = z.object({
  ok: z.boolean(), latency_ms: z.number().optional(), error: z.string().optional(), detail: z.string().optional()
})
export const TtsVoiceEntryWireSchema = z.object({
  id: z.string(), name: z.string().optional(), languages: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.unknown()).default({})   // rest.py:219 dict（能力描述），非数组；缺省 {} 恒上 wire
})
export const TtsVoicesResponseWireSchema = z.object({
  voices: z.array(TtsVoiceEntryWireSchema), current: z.string().optional(), source: z.enum(['static', 'api']).default('static'), error: z.string().optional()
})
export const TtsPreviewResultWireSchema = z.object({
  ok: z.boolean(), mime: z.string().optional(), audio_base64: z.string().optional(), duration_ms: z.number().optional(), error: z.string().optional()
})

export function parseRestProviders(input: unknown): { success: true; data: z.infer<typeof ProvidersResponseWireSchema> } | { success: false } {
  return ProvidersResponseWireSchema.safeParse(input)
}
export function parseRestProviderTest(input: unknown): { success: true; data: z.infer<typeof ProviderTestResultWireSchema> } | { success: false } {
  return ProviderTestResultWireSchema.safeParse(input)
}
export function parseRestTtsVoices(input: unknown): { success: true; data: z.infer<typeof TtsVoicesResponseWireSchema> } | { success: false } {
  return TtsVoicesResponseWireSchema.safeParse(input)
}
export function parseRestTtsPreview(input: unknown): { success: true; data: z.infer<typeof TtsPreviewResultWireSchema> } | { success: false } {
  return TtsPreviewResultWireSchema.safeParse(input)
}
