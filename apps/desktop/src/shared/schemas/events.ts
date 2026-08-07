import { z } from 'zod'
import type { BackendEvent } from '../contracts'

/**
 * 后端事件的运行时 Schema。
 * 外部输入必须经过 Schema 校验(DoD);未知可选字段兼容,非法输入显式报错。
 */

export const SegmentChannelSchema = z.enum(['inner_voice', 'public_reply'])
export const SegmentKindSchema = z.enum([
  'text',
  'markdown',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'link'
])

export const BackendEventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().optional()
})

export const GenerationStartedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.started'),
  generationId: z.string().min(1),
  messageId: z.string().min(1),
  responseId: z.string().min(1),
  conversationId: z.string().min(1),
  model: z.string().optional()
})

export const GenerationDeltaEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.delta'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: SegmentChannelSchema,
  kind: SegmentKindSchema,
  deltaSequence: z.number().int().nonnegative(),
  text: z.string()
})

export const SegmentCompletedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.segment.completed'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: SegmentChannelSchema
})

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  source: z.enum(['provider_reported', 'server_aggregate', 'client_sum'])
})

export const ConversationUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
})

export const GenerationCompletedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.completed'),
  generationId: z.string().min(1),
  responseId: z.string().min(1),
  usage: TokenUsageSchema.optional(),
  conversationUsage: ConversationUsageSchema.optional(),
  model: z.string().optional(),
  emotion: z.string().optional()
})

export const GenerationFailedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.failed'),
  generationId: z.string().min(1),
  error: z.object({
    code: z.string().min(1),
    message: z.string()
  })
})

export const BackendEventSchema = z.discriminatedUnion('event', [
  GenerationStartedEventSchema,
  GenerationDeltaEventSchema,
  SegmentCompletedEventSchema,
  GenerationCompletedEventSchema,
  GenerationFailedEventSchema
])

/** 解析并校验单个后端事件;成功时返回领域事件 */
export function parseBackendEvent(input: unknown): {
  success: true
  data: BackendEvent
} | {
  success: false
  error: z.ZodError
} {
  return BackendEventSchema.safeParse(input)
}
