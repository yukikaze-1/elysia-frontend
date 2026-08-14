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
  clientRequestId: z.string().min(1)
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
