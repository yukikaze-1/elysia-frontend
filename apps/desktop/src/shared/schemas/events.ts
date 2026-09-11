import { z } from 'zod'
import type { BackendEvent } from '../contracts'
import { CharacterPublicStateViewSchema, UtcIsoTimestampSchema } from './character'

export const SegmentChannelSchema = z.enum(['inner_voice', 'public_reply'])
export const SegmentKindSchema = z.enum([
  'text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link'
])
/** 工具 Runtime（三值；与 contracts/tool.ts ToolRuntime 对齐；ModelExecutionLocation 是另一概念） */
export const ToolRuntimeSchema = z.enum(['backend', 'desktop', 'local_worker'])

/**
 * 事件信封（所有后端事件 `.extend()` 的基座）。
 *
 * H-05（2026-09-11）：**在这里加 `.strict()` 而不是逐个成员加**——zod 4 的 `.extend()` 会把
 * 基座的 catchall（strictness）继承下去（本机实测：strict 基座派生出的 schema 拒绝未知键，
 * 松散基座派生出的不拒绝），故一处即可覆盖全部 28 个成员。
 *
 * 这样做的真正价值不是"少改 15 处"，而是**让新成员无法忘记**：此前 28 个成员里 13 个写了 `.strict()`、
 * 15 个没写，全靠作者记性——契约字段漂移因此是默认结果而不是意外。现在新增事件 schema 只要照惯例
 * `.extend()` 就自动严格；万一有人不走基座，`tests/unit/event-schema-mirror.spec.ts` 会点名报错。
 *
 * 方向性说明：严格化使「携带未声明字段的事件」从**静默剥离**变为**显式拒绝**，与 CLAUDE.md 的
 * 「未知或畸形外部输入必须显式失败，不得用宽松 schema 掩盖漂移」一致。本仓库 raw 帧 schema 早已全部
 * `.strict()`，且 frame-mapper 逐字段重建领域事件，故未知键到不了这一层（全套门禁为证）。
 */
export const BackendEventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().optional()
}).strict()

/** 表现/TTS 事件的角色归属（迁移期 optional；能力开启后的必填由运行时 gate 校验）。 */
const eventIdentityText = () => z.string().min(1).refine((v) => v.trim().length > 0, '身份字段不能全为空白')
const CharacterEventIdentitySchemaFields = {
  conversationId: eventIdentityText().optional(),
  generationId: eventIdentityText().optional(),
  characterId: eventIdentityText().optional(),
  characterInstanceId: eventIdentityText().optional(),
  characterRevision: z.number().int().min(1).optional()
}

export const GenerationStartedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.started'),
  generationId: z.string().min(1),
  messageId: z.string().min(1),
  responseId: z.string().min(1),
  conversationId: eventIdentityText(),
  model: z.string().optional(),
  // 多角色 FE-A：generation 角色身份（CHAR-FE-08；迁移期 optional，flag=true 后必填）
  characterId: eventIdentityText().optional(),
  characterInstanceId: eventIdentityText().optional(),
  characterRevision: z.number().int().min(1).optional()
}).strict()

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
  finishReason: z.string().optional(),
  characterId: eventIdentityText().optional(),
  characterInstanceId: eventIdentityText().optional(),
  characterRevision: z.number().int().min(1).optional()
}).strict()

export const GenerationFailedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('generation.failed'),
  generationId: z.string().min(1),
  messageId: z.string().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean().optional(),
    details: z.unknown().optional()
  }),
  characterId: eventIdentityText().optional(),
  characterInstanceId: eventIdentityText().optional(),
  characterRevision: z.number().int().min(1).optional()
}).strict()

/** 模型 Profile 激活结果（switch_model.result；判别字段 event 对齐 BackendEvent 契约；沿用既有成员写法，不注 z.ZodType 以免判别联合丢失形状信息） */
export const SwitchModelResultEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('switch_model.result'), service: z.enum(['llm', 'stt', 'tts']), model: z.string(),
  ok: z.boolean(), error: z.string().optional()
})
/** TTS 声音切换结果（set_tts_voice.result；同用 event 判别字段） */
export const SetTtsVoiceResultEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('set_tts_voice.result'), ok: z.boolean(), error: z.string().optional(), voice: z.string().optional()
})

// —— 阶段 4 批次 B（P4-B）：语音族事件 schema 镜像（spec 5.2；F-2 修复：未镜像 → preload parseBackendEvent 丢弃 → 语音功能静默失效）——
// 每成员均经 BackendEventEnvelopeSchema.extend，eventId/sequence 必填（Minor 15）。

/** 普通录音转写字幕（voice.transcript；PENDING 字幕） */
export const VoiceTranscriptEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('voice.transcript'), recordingId: z.string().min(1), text: z.string(), emotion: z.string().optional()
})
/** 实时会话已建立（voice_session.started） */
export const VoiceSessionStartedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('voice_session.started'), sessionId: z.string().min(1), conversationId: z.string().optional()
})
/** 实时会话字幕增量（voice_session.partial） */
export const VoiceSessionPartialEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('voice_session.partial'), sessionId: z.string().min(1),
  turnId: z.number().int().nonnegative(), segmentIndex: z.number().int().nonnegative(), text: z.string()
})
/** 实时会话轮次自动提交（voice_session.turn；后端预分配 messageId） */
export const VoiceSessionTurnEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('voice_session.turn'), sessionId: z.string().min(1), turnId: z.number().int().nonnegative(),
  messageId: z.string().min(1), conversationId: z.string().optional(), text: z.string()
})
/** 实时会话背压确认（voice_session.ack；seq=服务端已收 BINARY 帧序数） */
export const VoiceSessionAckEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('voice_session.ack'), sessionId: z.string().min(1), seq: z.number().int().nonnegative()
})
/** 实时会话结束（voice_session.ended；reason 枚举四值） */
export const VoiceSessionEndedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('voice_session.ended'), sessionId: z.string().min(1),
  reason: z.enum(['stopped', 'cancelled', 'timeout', 'stt_disabled'])
})
/** 输入法转写字幕累积（dictation.partial） */
export const DictationPartialEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('dictation.partial'), text: z.string()
})
/** 输入法转写终态（dictation.final；clientRequestId 必填） */
export const DictationFinalEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('dictation.final'), clientRequestId: z.string().min(1), text: z.string()
})
/** 输入法转写取消（dictation.cancelled；clientRequestId 必填） */
export const DictationCancelledEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('dictation.cancelled'), clientRequestId: z.string().min(1)
})
/** TTS 句开始（audio.session.started） */
export const AudioSessionStartedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('audio.session.started'), streamId: z.number().int().nonnegative(),
  format: z.enum(['wav', 'mp3']).optional(),
  ...CharacterEventIdentitySchemaFields
}).strict()
/** TTS 整段就绪（audio.session.ready；format 枚举 wav|mp3 可选） */
export const AudioSessionReadyEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('audio.session.ready'), streamId: z.number().int().nonnegative(), url: z.string().min(1),
  durationMs: z.number().nonnegative().optional(), format: z.enum(['wav', 'mp3']).optional(),
  ...CharacterEventIdentitySchemaFields
}).strict()
/** TTS 播放取消/中断（audio.session.cancelled） */
export const AudioSessionCancelledEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('audio.session.cancelled'), streamId: z.number().int().nonnegative(),
  ...CharacterEventIdentitySchemaFields
}).strict()
/** 语音族错误（voice.error；D-P15） */
export const VoiceErrorEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('voice.error'), code: z.string().min(1), message: z.string().optional()
})

/** 后端 expression 表现帧归一后的领域事件；角色身份在迁移期可选，但未知字段仍 fail-closed。 */
export const ExpressionEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('expression'),
  expression: z.string().min(1),
  intensity: z.number().optional(),
  ...CharacterEventIdentitySchemaFields
}).strict()

// —— 阶段 5 批次 C（C3）：后端 Live2D 表现指令建议 schema 镜像（缺镜像 → preload parseBackendEvent 丢弃，P4-B 先例）——
/** 后端 Live2D 表现指令建议（live2d.directive；state 七值，priority ∈ [0,3] 字面量联合，durationMs ∈ [0,30_000]；`.strict()` fail-closed 拒未知字段） */
export const Live2DDirectiveEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('live2d.directive'),
  expression: z.string().optional(),
  motion: z.string().optional(),
  state: z.enum(['idle', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'surprised']).optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  durationMs: z.number().int().min(0).max(30000).optional(),
  ...CharacterEventIdentitySchemaFields
}).strict()

// —— 阶段 6 批次 A（F-6-03）：工具双轨领域事件 schema 镜像（spec §3.3；缺镜像 → preload parseBackendEvent 丢弃，P4-B 先例）——
// 事件判别字段 event 与 wire 帧名一致；tool.request 无安全元数据字段（arguments/riskLevel/... 不在事件模型，strict 整帧拒，D6-07）。

/** 桌面工具执行请求（脱敏公开事件；toolVersion/expiresAt wire 必填直映） */
export const ToolRequestEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('tool.request'),
  callId: z.string().min(1),
  sourceCallId: z.string().min(1),
  toolName: z.string().min(1),
  toolVersion: z.string().min(1),
  runtime: ToolRuntimeSchema,
  reason: z.string().optional(),
  inputSummary: z.string().optional(),
  expiresAt: z.string().min(1),
  requestId: z.string().optional()
}).strict()
/** Backend 工具开始（callId = sourceCallId 同值） */
export const ToolStartedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('tool.started'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  runtime: ToolRuntimeSchema,
  inputSummary: z.string().optional(),
  generationId: z.string().optional(),
  conversationId: z.string().optional()
}).strict()
/** Backend 工具完成（success 区分 completed/failed；error 从 wire record 提取已知键） */
export const ToolCompletedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('tool.completed'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  runtime: ToolRuntimeSchema,
  success: z.boolean(),
  outputSummary: z.string().optional(),
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional()
  }).optional(),
  errorType: z.string().optional(),
  durationMs: z.number().optional(),
  truncated: z.boolean().optional(),
  generationId: z.string().optional(),
  conversationId: z.string().optional()
}).strict()

// —— 多角色 FE-A（§7.1）：角色状态/目录事件 schema 镜像（缺镜像 → preload parseBackendEvent 丢弃，P4-B 先例）——
// state 为完整公开视图（不是 patch）；strict 未知字段整帧拒。CharacterPublicStateViewSchema 复用 character.ts 镜像。

/** 角色公开状态变化（character.state.changed；完整 view 整体替换） */
export const CharacterStateChangedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('character.state.changed'),
  // Added by Main after raw-wire mapping; RawCharacterStateChangedSchema
  // intentionally does not accept this desktop-local field.
  connectionScopeId: z.string().min(1).optional(),
  conversationId: z.string().min(1).refine((v) => v.trim().length > 0),
  characterId: z.string().min(1).refine((v) => v.trim().length > 0),
  characterInstanceId: z.string().min(1).refine((v) => v.trim().length > 0),
  characterRevision: z.number().int().min(1),
  stateVersion: z.number().int().min(1),
  state: CharacterPublicStateViewSchema
}).strict()

/** 角色目录失效通知（character.catalog.changed；不携带完整 Prompt） */
export const CharacterCatalogChangedEventSchema = BackendEventEnvelopeSchema.extend({
  event: z.literal('character.catalog.changed'),
  // Added by Main after raw-wire mapping; RawCharacterCatalogChangedSchema
  // intentionally does not accept this desktop-local field.
  connectionScopeId: z.string().min(1).optional(),
  characterId: z.string().min(1).refine((v) => v.trim().length > 0),
  currentRevision: z.number().int().min(1),
  status: z.enum(['active', 'archived']),
  updatedAt: UtcIsoTimestampSchema
}).strict()

export const BackendEventSchema = z.discriminatedUnion('event', [
  GenerationStartedEventSchema,
  GenerationSegmentStartedEventSchema,
  GenerationDeltaEventSchema,
  SegmentCompletedEventSchema,
  GenerationCompletedEventSchema,
  GenerationFailedEventSchema,
  SwitchModelResultEventSchema,
  SetTtsVoiceResultEventSchema,
  VoiceTranscriptEventSchema,
  VoiceSessionStartedEventSchema,
  VoiceSessionPartialEventSchema,
  VoiceSessionTurnEventSchema,
  VoiceSessionAckEventSchema,
  VoiceSessionEndedEventSchema,
  DictationPartialEventSchema,
  DictationFinalEventSchema,
  DictationCancelledEventSchema,
  AudioSessionStartedEventSchema,
  AudioSessionReadyEventSchema,
  AudioSessionCancelledEventSchema,
  VoiceErrorEventSchema,
  ExpressionEventSchema,
  Live2DDirectiveEventSchema,
  ToolRequestEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  CharacterStateChangedEventSchema,
  CharacterCatalogChangedEventSchema
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
