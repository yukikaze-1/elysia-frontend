import { z } from 'zod'
import type { RawFrame } from './raw-types'

/** 后端 WS v2 raw frame zod schema(判别 type + .strict();字段精确对齐后端契约) */

export const RawSegmentChannelSchema = z.enum(['inner_voice', 'public_reply', 'status'])
export const RawSegmentKindSchema = z.enum([
  'text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link'
])

const RawTokenRoundSchema = z.object({
  model: z.string().optional(),
  session_id: z.string().optional(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative().optional(),
  reasoning_tokens: z.number().int().nonnegative().optional(),
  round_num: z.number().int().nonnegative(),   // 后端 TokenRound.round_num 为 int(无下限,测试用 0);契约对齐
  timestamp: z.string().optional()
})
const RawTokenUsageSchema = z.object({ rounds: z.array(RawTokenRoundSchema), turn_total: z.number().int().nonnegative() })
const RawTokenStatsSchema = z.object({ total: z.number().int().nonnegative(), byModel: z.record(z.string(), z.number().int().nonnegative()) })
const RawConversationUsageSchema = z.object({ total: z.number().int().nonnegative(), byModel: z.record(z.string(), z.number().int().nonnegative()) })

const RawSessionMessageItemSchema = z.object({
  role: z.string().min(1),
  message_id: z.string().optional(),
  timestamp: z.string().optional(),
  parts: z.array(z.unknown()).optional(),
  content: z.unknown().optional(),
  content_type: z.record(z.string(), z.array(z.number().int().nonnegative())).optional(),
  mood: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  inner_voice: z.string().optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  error_type: z.string().optional(),
  duration_ms: z.number().optional(),
  truncated: z.boolean().optional(),
  token_usage: RawTokenUsageSchema.optional()
}).strict()

const RawSessionMessageSchema = z.object({
  type: z.literal('session'),
  conversationId: z.string().optional(),
  messages: z.array(RawSessionMessageItemSchema),
  token_stats: RawTokenStatsSchema.optional()
}).strict()

const RawServerInfoSchema = z.object({
  type: z.literal('server_info'),
  protocol_version: z.string().min(1),
  server_version: z.string().min(1),
  features: z.record(z.string(), z.unknown()),
  services: z.record(z.string(), z.unknown()),
  connectionId: z.string().optional(),
  build_sha: z.string().optional()
}).strict()

const RawExpressionSchema = z.object({
  type: z.literal('expression'),
  expression: z.string().min(1),
  intensity: z.number().optional()
}).strict()

const RawGenerationStartedSchema = z.object({
  type: z.literal('generation.started'),
  generationId: z.string().min(1),
  messageId: z.string().min(1),
  conversationId: z.string().optional(),
  requestId: z.string().optional(),
  model: z.string().optional()
}).strict()

const RawGenerationSegmentStartedSchema = z.object({
  type: z.literal('generation.segment.started'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: RawSegmentChannelSchema,
  kind: RawSegmentKindSchema,
  conversationId: z.string().optional()
}).strict()

const RawGenerationDeltaSchema = z.object({
  type: z.literal('generation.delta'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  deltaSequence: z.number().int().nonnegative(),
  delta: z.string(),
  conversationId: z.string().optional()
}).strict()

const RawGenerationSegmentCompletedSchema = z.object({
  type: z.literal('generation.segment.completed'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: RawSegmentChannelSchema,
  kind: RawSegmentKindSchema,
  content: z.string().optional(),
  conversationId: z.string().optional()
}).strict()

const RawGenerationCompletedSchema = z.object({
  type: z.literal('generation.completed'),
  generationId: z.string().min(1),
  messageId: z.string().min(1),
  channel: z.literal('public_reply'),
  finishReason: z.enum(['stop', 'tool_calls']),
  usage: RawTokenUsageSchema,
  model: z.string().min(1),
  mood: z.string().optional(),
  completeness: z.string().optional(),
  conversationId: z.string().optional(),
  conversationUsage: RawConversationUsageSchema.optional()
}).strict()

const RawGenerationFailedSchema = z.object({
  type: z.literal('generation.failed'),
  generationId: z.string().min(1),
  messageId: z.string().optional(),
  model: z.string().optional(),
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
  conversationId: z.string().optional()
}).strict()

export const RawFrameSchema = z.discriminatedUnion('type', [
  RawSessionMessageSchema,
  RawServerInfoSchema,
  RawExpressionSchema,
  RawGenerationStartedSchema,
  RawGenerationSegmentStartedSchema,
  RawGenerationDeltaSchema,
  RawGenerationSegmentCompletedSchema,
  RawGenerationCompletedSchema,
  RawGenerationFailedSchema
])

export function parseRawFrame(input: unknown): {
  success: true
  data: RawFrame
} | {
  success: false
  error: z.ZodError
} {
  return RawFrameSchema.safeParse(input)
}
