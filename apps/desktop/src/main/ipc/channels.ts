import { z } from 'zod'
import { isKeyAllowed, type CredentialStatus } from '@shared/contracts'

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
export const endpointResponseSchema = z.object({ endpoint: z.string().optional() })
export const runtimeInfoResponseSchema = z.object({ mode: z.enum(['real', 'mock']), packaged: z.boolean() })
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
