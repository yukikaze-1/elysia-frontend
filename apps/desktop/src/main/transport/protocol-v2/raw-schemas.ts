import { createHash } from 'node:crypto'
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
  message_id: z.string().min(1),  // D2:持久化消息要求非空身份(§5.4 #1)
  timestamp: z.string().min(1),
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
  duration_ms: z.number().nullable().optional(),   // P0-02：WS replay wire 边界同款（三条恢复路径一致，否则 replay tool null 整段拒）
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

const RawAckErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryAfterMs: z.number().int().optional()
}).strict()

const RawAcceptedUserAckSchema = z.object({
  type: z.literal('user_message.ack'),
  messageId: z.string().min(1),
  clientRequestId: z.string().min(1),
  clientMessageId: z.string().optional(),
  conversationId: z.string().optional(),
  receivedAt: z.string().min(1),
  status: z.literal('accepted')
}).strict()

const RawRejectedUserAckSchema = z.object({
  type: z.literal('user_message.ack'),
  messageId: z.literal(''),
  clientRequestId: z.string(), // 缺 clientRequestId 的契约拒绝回显空串
  clientMessageId: z.string().optional(),
  conversationId: z.string().optional(),
  receivedAt: z.string().min(1),
  status: z.literal('rejected'),
  error: RawAckErrorSchema
}).strict()

/** 与后端 UserAckMessage 一致：status 判别联合，两分支的 messageId/error 不变量由 schema 直接表达。 */
const RawUserAckSchema = z.discriminatedUnion('status', [
  RawAcceptedUserAckSchema,
  RawRejectedUserAckSchema
])

/** 契约识别 + 有意忽略：FSM 状态变更（renderer 暂不消费，勿误删——FE-INT-P1-01） */
const RawStateSchema = z.object({
  type: z.literal('state'),
  state: z.string() // 契约原样：后端 StateMessage.state 是裸 str、无 min 约束（空串契约合法）；strict 仍拒未知键
}).strict()
/** 契约识别 + 有意忽略：输入状态变更 */
const RawTypingSchema = z.object({
  type: z.literal('typing'),
  typing: z.boolean()
}).strict()

const RawErrorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string().min(1),
  code: z.string().optional(),
  requestId: z.string().optional(),
  clientRequestId: z.string().optional(),
  retryable: z.boolean().optional(),
  retryAfterMs: z.number().int().optional(),
  details: z.record(z.string(), z.unknown()).optional()
}).strict()

/** 模型 Profile 激活结果帧（对齐 ws_message.py SwitchModelResultMessage；ok 必填） */
const RawSwitchModelResultSchema = z.object({
  type: z.literal('switch_model_result'),
  service: z.enum(['llm', 'stt', 'tts']),
  model: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
}).strict()
/** TTS 声音切换结果帧（对齐 ws_message.py SetTtsVoiceResultMessage；ok 必填，voice/error 可选） */
const RawSetTtsVoiceResultSchema = z.object({
  type: z.literal('set_tts_voice_result'),
  ok: z.boolean(),
  error: z.string().optional(),
  voice: z.string().optional()
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
  RawGenerationFailedSchema,
  RawUserAckSchema,
  RawStateSchema,
  RawTypingSchema,
  RawErrorMessageSchema,
  RawSwitchModelResultSchema,
  RawSetTtsVoiceResultSchema
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

/** 递归展平 zod union：ACK 在外层按 type、内层按 status 判别。 */
const objectOptions = (schema: unknown): Array<{ shape: Record<string, unknown> }> => {
  const candidate = schema as {
    shape?: Record<string, unknown>
    _def?: { options?: ReadonlyArray<unknown>; discriminator?: string }
  }
  if (candidate.shape !== undefined) return [{ shape: candidate.shape }]
  return (candidate._def?.options ?? []).flatMap(objectOptions)
}

/** 各帧判别 type（递归从 RawFrameSchema 推导，重复 ACK type 去重） */
export const RAW_FRAME_TYPES: readonly string[] = [...new Set(
  objectOptions(RawFrameSchema).map((o) => String((o.shape.type as { value: unknown }).value))
)]

/** 单字段签名: `k:_def.type:枚举成员(entries 排序):字面量值(_def.values/value)`;zod v4 判别 API(_def.type 小写、_def.entries、_def.values) */
const fieldSig = ([k, s]: [string, unknown]): string => {
  const d = s as { _def?: { type?: string; entries?: Record<string, unknown>; values?: unknown[]; value?: unknown } }
  const vals = d._def?.entries ? Object.keys(d._def.entries).sort().join(',') : (d._def?.values ?? []).join(',')
  const lit = d._def?.value !== undefined ? String(d._def.value) : ''
  return `${k}:${d._def?.type}:${vals}:${lit}`
}

/** 指纹计算所需的 discriminatedUnion 最小结构(zod v4 `_def.options` + `_def.discriminator`) */
/** 对任意（可嵌套）union 计算 sha256 指纹;同 schema 恒等,结构/枚举/字面量变化即变 */
export function rawSchemasFingerprintFor(schema: unknown): string {
  // zod v4 discriminatedUnion `_def` 运行时含 discriminator(zod 类型 $ZodUnionDef 未暴露该字段,故按名取)
  const disc = (schema as { _def?: { discriminator?: string } })._def?.discriminator ?? 'type'
  const options = objectOptions(schema)
  const fields = options.map((o) => ({
    type: (o.shape[disc] as { value: unknown }).value,
    fields: Object.entries(o.shape).map(fieldSig).sort()
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const types = [...new Set(options.map((o) => (o.shape[disc] as { value: unknown }).value))].sort()
  return createHash('sha256').update(JSON.stringify({ types, fields })).digest('hex')
}

/** RawFrameSchema 的 schemaHash 指纹(manifest 门禁用) */
export function rawSchemasFingerprint(): string {
  return rawSchemasFingerprintFor(RawFrameSchema)
}
