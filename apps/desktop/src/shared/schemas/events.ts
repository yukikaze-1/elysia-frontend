import { z } from 'zod'
import type { BackendEvent } from '../contracts'

export const SegmentChannelSchema = z.enum(['inner_voice', 'public_reply'])
export const SegmentKindSchema = z.enum([
  'text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link'
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

export const GenerationSegmentStartedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.segment.started'),
  generationId: z.string().min(1),
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: SegmentChannelSchema,
  kind: SegmentKindSchema
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
  channel: SegmentChannelSchema,
  kind: SegmentKindSchema,
  content: z.string().optional()
})

export const TokenUsageRoundSchema = z.object({
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  roundNum: z.number().int().nonnegative()   // 后端 TokenRound.round_num 为 int(无下限,测试用 0);契约对齐
})

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  source: z.enum(['provider_reported', 'server_aggregate', 'client_sum']),
  rounds: z.array(TokenUsageRoundSchema).optional()
})

export const ConversationUsageSchema = z.object({
  total: z.number().int().nonnegative(),
  byModel: z.record(z.string(), z.number().int().nonnegative()),
  source: z.literal('server_aggregate')
})

export const GenerationCompletedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.completed'),
  generationId: z.string().min(1),
  messageId: z.string().optional(),
  responseId: z.string().min(1),
  usage: TokenUsageSchema.optional(),
  conversationUsage: ConversationUsageSchema.optional(),
  model: z.string().optional(),
  emotion: z.string().optional(),
  finishReason: z.string().optional()
})

export const GenerationFailedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.failed'),
  generationId: z.string().min(1),
  messageId: z.string().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean().optional(),
    details: z.unknown().optional()
  })
})

/** 模型 Profile 激活结果（switch_model.result；判别字段 event 对齐 BackendEvent 契约；沿用既有成员写法，不注 z.ZodType 以免判别联合丢失形状信息） */
export const SwitchModelResultEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('switch_model.result'), service: z.enum(['llm', 'stt', 'tts']), model: z.string(),
  ok: z.boolean(), error: z.string().optional()
})
/** TTS 声音切换结果（set_tts_voice.result；同用 event 判别字段） */
export const SetTtsVoiceResultEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('set_tts_voice.result'), ok: z.boolean(), error: z.string().optional(), voice: z.string().optional()
})

export const BackendEventSchema = z.discriminatedUnion('event', [
  GenerationStartedEventSchema,
  GenerationSegmentStartedEventSchema,
  GenerationDeltaEventSchema,
  SegmentCompletedEventSchema,
  GenerationCompletedEventSchema,
  GenerationFailedEventSchema,
  SwitchModelResultEventSchema,
  SetTtsVoiceResultEventSchema
])

export function parseBackendEvent(input: unknown): {
  success: true
  data: BackendEvent
} | {
  success: false
  error: z.ZodError
} {
  return BackendEventSchema.safeParse(input)
}
