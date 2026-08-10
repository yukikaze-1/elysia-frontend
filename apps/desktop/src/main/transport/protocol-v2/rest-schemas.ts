import { z } from 'zod'
import type { RestMessage, RestMessagesPageResponse, RestPendingQueryResponse, RestSessionDetail, RestSessionListResult, RestSessionActivateResult } from './rest-types'

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
  duration_ms: z.number().optional(),
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
