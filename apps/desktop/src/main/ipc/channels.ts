import { z } from 'zod'
import { isKeyAllowed, type CredentialStatus } from '@shared/contracts'
import { EndpointResponseSchema, RuntimeInfoSchema, CacheMessagesInputSchema, OpenExternalInputSchema, PersistSessionInputSchema, PersistSessionResultSchema, SessionPersistenceStateSchema } from '@shared/schemas'

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string()
})

export const credentialStatusSchema: z.ZodType<{ status: CredentialStatus; key: string }> = z.object({
  status: z.enum(['unavailable', 'locked', 'empty', 'available']),
  key: z.string().refine(isKeyAllowed)
})
export const credentialsSetSchema = z.object({
  key: z.string().refine(isKeyAllowed),
  value: z.string().min(1).max(4096)
})
export const credentialsClearSchema = z.object({
  key: z.string().refine(isKeyAllowed)
})

// —— chat 命令 request schema(P0 精确字段;响应校验用 z.unknown() 信封,阶段 7 细化)——
export const chatConnectSchema = z.undefined()   // 无参:endpoint/token 由 connection-config 持有,connect 不再传 URL
export const chatSetEndpointSchema = z.object({ serverUrl: z.string().min(1).max(4096) })
export const chatGetEndpointSchema = z.undefined()
export const chatGetRuntimeInfoSchema = z.undefined()
// 响应 schema:共享定义在 shared/schemas/ipc-response,此处别名保持 chat-handlers 引用兼容(M3)
export const endpointResponseSchema = EndpointResponseSchema
export const runtimeInfoResponseSchema = RuntimeInfoSchema
export const chatSendSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string(),
  clientRequestId: z.string().min(1),
  attachments: z.array(z.object({
    attachmentId: z.string().min(1),
    kind: z.enum(['image', 'video', 'audio', 'file', 'link']),
    mime: z.string().min(1)
  })).optional()
})
export const chatGetMessagesSchema = z.object({
  conversationId: z.string().min(1),
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().positive().optional()
})
export const chatRenameSchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().min(1)
})
export const chatActivateSchema = z.object({
  conversationId: z.string().min(1)
})
export const chatListConversationsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional()
})
export const chatCreateSchema = z.object({
  title: z.string().optional()
})
export const chatCancelSchema = z.object({
  generationId: z.string().min(1)
})
export const chatDeleteSchema = z.object({
  conversationId: z.string().min(1)
})
export const chatGetStateSchema = z.undefined()

// —— 阶段 3 G2 持久化四通道 request schema（响应 schema 别名引用共享定义，与既有 chat* 模式一致）——
export const chatHydratePersistenceSchema = z.undefined()
export const chatPersistSessionSchema = PersistSessionInputSchema
export const chatCacheMessagesSchema = CacheMessagesInputSchema
export const chatOpenExternalSchema = OpenExternalInputSchema
// 响应 schema：共享定义在 shared/schemas/ipc-response，别名保持引用兼容
export const sessionPersistenceStateResponseSchema = SessionPersistenceStateSchema
export const persistSessionResultResponseSchema = PersistSessionResultSchema

// —— attachments 命令 request schema（spec §4.2/§4.5；响应 schema 在 shared/schemas/ipc-response）——
export const UploadFileDescriptorSchema = z.object({
  localId: z.string().min(1),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  source: z.enum(['picker', 'drag_drop', 'paste']),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']).optional(),
  path: z.string().optional(),
  bytes: z.instanceof(Uint8Array).optional()
}).refine((d) => (d.path !== undefined) !== (d.bytes !== undefined), { message: 'path/bytes 二选一' })

export const attachmentsValidateSchema = z.object({ files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
export const attachmentsUploadSchema = z.object({ uploadId: z.string().min(1), files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
export const attachmentsCancelSchema = z.object({ uploadId: z.string().min(1) })
export const attachmentsCheckSchema = z.object({ attachmentId: z.string().min(1) })
