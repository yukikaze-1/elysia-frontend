import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { RawFrame, RawClientFrame } from './raw-types'

/** 后端 WS v2 raw frame zod schema(判别 type + .strict();字段精确对齐后端契约) */

export const RawSegmentChannelSchema = z.enum(['inner_voice', 'public_reply', 'status'])
export const RawSegmentKindSchema = z.enum([
  'text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link'
])

// —— 多角色 FE-A：会话/消息内嵌角色绑定快照 wire schema（CHAR-FE-06/07）——
// raw-schemas 被裸 Node ESM 加载（check:contract），运行时导入只允许 zod/node 内建 →
// isSafeRegistryId/isSafeThemeColor 自包含镜像副本，与 shared/schemas/character.ts、
// character-rest-schemas.ts、rest-schemas.ts 四处同形（任意一处修改需同步）。
function isSafeRegistryId(v: string): boolean {
  if (v.trim().length === 0 || v.length > 200) return false
  if (v.startsWith('/') || v.startsWith('\\')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) return false
  if (v.includes('..')) return false
  return true
}

/** character-contract-v1 时间：仅接受 UTC ISO-8601 的 Z / +00:00 形式。 */
function isUtcIsoTimestamp(v: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|\+00:00)$/.exec(v)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const milliseconds = Number(`${(match[7] ?? '').slice(1)}000`.slice(0, 3)) || 0
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false

  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, milliseconds)
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === milliseconds
}

const utcIsoTimestamp = () => z.string().refine(isUtcIsoTimestamp, '时间必须是 UTC ISO-8601（Z 或 +00:00）')
const nonBlankText = (max?: number) => {
  const base = max === undefined ? z.string().min(1) : z.string().min(1).max(max)
  return base.refine((v) => v.trim().length > 0, '文本不能全为空白')
}
const rawCharacterEventIdentityFields = {
  conversationId: nonBlankText().optional(),
  generationId: nonBlankText().optional(),
  characterId: nonBlankText().optional(),
  characterInstanceId: nonBlankText().optional(),
  characterRevision: z.number().int().min(1).optional()
}

/**
 * The backend keeps the character identity fields optional during rollout,
 * but its wire validator rejects a partial identity tuple.  Keep the same
 * invariant at the raw boundary so a malformed frame cannot reach a mapper
 * with an attribution that is impossible to complete later.
 */
const hasCompleteCharacterIdentity = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return true
  const record = value as Record<string, unknown>
  const present = [
    record.characterId !== undefined,
    record.characterInstanceId !== undefined,
    record.characterRevision !== undefined
  ]
  return !present.some(Boolean) || present.every(Boolean)
}

const completeCharacterIdentityMessage =
  'characterId、characterInstanceId、characterRevision 必须同时提供'

const SAFE_CSS_NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond',
  'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue',
  'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgrey', 'darkgreen',
  'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon',
  'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia',
  'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'grey', 'green', 'greenyellow', 'honeydew', 'hotpink',
  'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue',
  'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgrey', 'lightgreen', 'lightpink',
  'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
  'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
  'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise',
  'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna',
  'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal',
  'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen', 'transparent'
])
function isSafeThemeColor(v: string): boolean {
  if (v.length === 0 || v.length > 64) return false
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true
  if (/^(rgba?|hsla?)\(\s*[\d.,%\s]+\s*\)$/.test(v)) return true
  return SAFE_CSS_NAMED_COLORS.has(v.toLowerCase())
}
const RawCharacterPresentationSchema = z.object({
  avatarAssetId: z.string().refine(isSafeRegistryId, '注册表 ID 不得为路径/URL').nullable().optional(),
  live2dModelId: z.string().refine(isSafeRegistryId, '注册表 ID 不得为路径/URL').nullable().optional(),
  themeColor: z.string().refine(isSafeThemeColor, '颜色仅支持 hex/rgb(a)/hsl(a)/命名色').nullable().optional()
}).strict()
const RawCharacterBindingSnapshotSchema = z.object({
  characterId: nonBlankText(),
  characterInstanceId: nonBlankText(),
  characterRevision: z.number().int().min(1),
  displayName: nonBlankText(64),
  presentation: RawCharacterPresentationSchema
}).strict()

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
}).strict()
const RawTokenUsageSchema = z.object({ rounds: z.array(RawTokenRoundSchema), turn_total: z.number().int().nonnegative() }).strict()
const RawTokenStatsSchema = z.object({ total: z.number().int().nonnegative(), byModel: z.record(z.string(), z.number().int().nonnegative()) }).strict()
const RawConversationUsageSchema = z.object({ total: z.number().int().nonnegative(), byModel: z.record(z.string(), z.number().int().nonnegative()) }).strict()
const RawTokenTurnStatsSchema = z.object({
  rounds: z.array(RawTokenRoundSchema).optional(),
  turn_total: z.number().int().nonnegative().optional()
}).strict()

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
  token_usage: RawTokenUsageSchema.optional(),
  // 多角色 FE-A：WS 回放消息内嵌角色快照（CHAR-FE-07；schema 镜像 rest-schemas.ts 同名子 schema——
  // raw-schemas 被裸 Node 加载，运行时导入只允许 zod，故自包含一份；三处同形修改需同步）
  character: RawCharacterBindingSnapshotSchema.optional()
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
  intensity: z.number().optional(),
  ...rawCharacterEventIdentityFields
}).strict().refine(hasCompleteCharacterIdentity, completeCharacterIdentityMessage)

const RawGenerationStartedSchema = z.object({
  type: z.literal('generation.started'),
  generationId: z.string().min(1),
  messageId: z.string().min(1),
  conversationId: z.string().optional(),
  requestId: z.string().optional(),
  model: z.string().optional(),
  // 多角色 FE-A：generation 角色身份（CHAR-FE-08；迁移期 optional）
  characterId: nonBlankText().optional(),
  characterInstanceId: nonBlankText().optional(),
  characterRevision: z.number().int().min(1).optional()
}).strict().refine(hasCompleteCharacterIdentity, completeCharacterIdentityMessage)

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
  conversationUsage: RawConversationUsageSchema.optional(),
  characterId: nonBlankText().optional(),
  characterInstanceId: nonBlankText().optional(),
  characterRevision: z.number().int().min(1).optional()
}).strict().refine(hasCompleteCharacterIdentity, completeCharacterIdentityMessage)

const RawGenerationFailedSchema = z.object({
  type: z.literal('generation.failed'),
  generationId: z.string().min(1),
  messageId: z.string().optional(),
  model: z.string().optional(),
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
  conversationId: z.string().optional(),
  characterId: nonBlankText().optional(),
  characterInstanceId: nonBlankText().optional(),
  characterRevision: z.number().int().min(1).optional()
}).strict().refine(hasCompleteCharacterIdentity, completeCharacterIdentityMessage)

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

/** v1 输出旁路仍可能广播到 v2 连接的兼容帧：严格识别，连接层显式忽略。 */
const RawDeltaMessageSchema = z.object({
  type: z.literal('delta'),
  content: z.string(),
  stream_id: z.number().int().optional()
}).strict()
const RawMessageMessageSchema = z.object({
  type: z.literal('message'),
  role: z.string().optional(),
  content: z.string().optional(),
  mood: z.string().optional()
}).strict()
const RawTokenUsageMessageSchema = z.object({
  type: z.literal('token_usage'),
  turn: RawTokenTurnStatsSchema.optional(),
  session: RawTokenStatsSchema.optional()
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

// —— 阶段 4 批次 B：三种语音（BE-060/061/062）+ TTS 播放控制（BE-063）——
// 字段逐字对齐 ws_message.py；turnId/segmentIndex/seq/stream_id 为裸 int（后端无下限约束）；
// audio_start.format 必填（后端非 Optional），audio_end.format 可选（后端 Optional，缺省 wav）。

/** 普通录音预转写字幕（voice.transcript） */
const RawVoiceTranscriptSchema = z.object({
  type: z.literal('voice.transcript'),
  recordingId: z.string().min(1),
  text: z.string(),
  emotion: z.string().optional()
}).strict()
/** 实时语音会话已开始（voice_session.started） */
const RawVoiceSessionStartedSchema = z.object({
  type: z.literal('voice_session.started'),
  sessionId: z.string().min(1),
  conversationId: z.string().optional()
}).strict()
/** 实时语音轮次字幕（voice_session.partial） */
const RawVoiceSessionPartialSchema = z.object({
  type: z.literal('voice_session.partial'),
  sessionId: z.string().min(1),
  turnId: z.number().int(),
  segmentIndex: z.number().int(),
  text: z.string()
}).strict()
/** 实时语音轮次已提交（voice_session.turn；自动触发 generation） */
const RawVoiceSessionTurnSchema = z.object({
  type: z.literal('voice_session.turn'),
  sessionId: z.string().min(1),
  turnId: z.number().int(),
  messageId: z.string().min(1),
  conversationId: z.string().optional(),
  text: z.string()
}).strict()
/** 实时语音背压进度通知（voice_session.ack；seq = 服务端已接收 BINARY 帧序数） */
const RawVoiceSessionAckSchema = z.object({
  type: z.literal('voice_session.ack'),
  sessionId: z.string().min(1),
  seq: z.number().int()
}).strict()
/** 实时语音会话结束（voice_session.ended；reason 四值） */
const RawVoiceSessionEndedSchema = z.object({
  type: z.literal('voice_session.ended'),
  sessionId: z.string().min(1),
  reason: z.enum(['stopped', 'cancelled', 'timeout', 'stt_disabled'])
}).strict()
/** 输入法转写中间字幕（dictation.partial） */
const RawDictationPartialSchema = z.object({
  type: z.literal('dictation.partial'),
  text: z.string()
}).strict()
/** 输入法转写最终结果（dictation.final；只回文字，零消息副作用） */
const RawDictationFinalSchema = z.object({
  type: z.literal('dictation.final'),
  clientRequestId: z.string().min(1),
  text: z.string()
}).strict()
/** 输入法转写已取消（dictation.cancelled） */
const RawDictationCancelledSchema = z.object({
  type: z.literal('dictation.cancelled'),
  clientRequestId: z.string().min(1)
}).strict()
/** 音频流开始（audio_start；stream_id = playback ID；format 非 Optional 后端恒发） */
const RawAudioStartSchema = z.object({
  type: z.literal('audio_start'),
  stream_id: z.number().int(),
  format: z.enum(['wav', 'mp3']),
  sampleRate: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  ...rawCharacterEventIdentityFields
}).strict().refine(hasCompleteCharacterIdentity, completeCharacterIdentityMessage)
/** 音频流 chunk（audio；data 为 base64 字符串） */
const RawAudioChunkSchema = z.object({
  type: z.literal('audio'),
  stream_id: z.number().int(),
  seq: z.number().int(),
  data: z.string(),
  is_final: z.boolean()
}).strict()
/** 音频流结束标记（audio_end；format 可缺省、缺省 wav） */
const RawAudioEndSchema = z.object({
  type: z.literal('audio_end'),
  stream_id: z.number().int(),
  format: z.enum(['wav', 'mp3']).optional()
}).strict()
/** 音频流被取消（audio_cancelled；前端清理孤儿 chunk） */
const RawAudioCancelledSchema = z.object({
  type: z.literal('audio_cancelled'),
  stream_id: z.number().int()
}).strict()

/** 后端 Live2D 表现指令建议（live2d.directive；C3 契约冻结，对齐 doc 02 §12 形状）。
 * state 七值（剔除 error——D5C-07）；priority ∈ [0,3]（字面量联合，输出类型精确 0|1|2|3，匹配 RawLive2DDirective）；
 * durationMs ∈ [0,30_000]；`.strict()` 未知字段整帧拒（fail-closed）。 */
const RawLive2DDirectiveSchema = z.object({
  type: z.literal('live2d.directive'),
  expression: z.string().optional(),
  motion: z.string().optional(),
  state: z.enum(['idle', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'surprised']).optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  durationMs: z.number().int().min(0).max(30000).optional(),
  ...rawCharacterEventIdentityFields
}).strict().refine(hasCompleteCharacterIdentity, completeCharacterIdentityMessage)

// —— 阶段 6 批次 A（F-6-02）：工具双轨 wire schema（镜像 frontend_contract/contract.raw.ts；.strict() 未知字段整帧拒）——

const RawToolRuntimeSchema = z.enum(['backend', 'desktop', 'local_worker'])

const RawToolRequestSchema = z.object({
  type: z.literal('tool.request'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  toolVersion: z.string().min(1),
  runtime: RawToolRuntimeSchema,
  sourceCallId: z.string().min(1),              // 必填（后端契约 B-6 已强制；缺省整帧拒）
  arguments: z.record(z.string(), z.unknown()),
  reason: z.string().optional(),
  riskLevel: z.string(),                        // 契约 str；后端恒发
  permissionRequired: z.boolean(),              // 契约必填
  approvalAuthority: z.string().min(1),         // 契约必填
  paramHash: z.string().min(1),                 // 契约必填
  expiresAt: z.string().min(1),                 // 契约必填
  requestId: z.string().optional()
}).strict()

const RawToolStartedSchema = z.object({
  type: z.literal('tool.started'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  runtime: RawToolRuntimeSchema,
  inputSummary: z.string().optional(),
  generationId: z.string().optional(),
  conversationId: z.string().optional()
}).strict()

const RawToolCompletedSchema = z.object({
  type: z.literal('tool.completed'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  runtime: RawToolRuntimeSchema,
  success: z.boolean(),                         // 契约必填
  outputSummary: z.string().optional(),
  error: z.record(z.string(), z.unknown()).optional(),   // 内层不冻结（契约 Record），mapper 提取 code/message
  errorType: z.string().optional(),
  durationMs: z.number().optional(),            // 可为小数
  truncated: z.boolean().optional(),
  generationId: z.string().optional(),
  conversationId: z.string().optional()
}).strict()

const RawActionSchema = z.object({
  type: z.literal('action'),
  action: z.string(),                           // 契约 Literal|str → str 全收
  params: z.record(z.string(), z.unknown()).optional()
}).strict()

const RawToolAttachmentSchema = z.object({ url: z.string().min(1), mimeType: z.string().min(1), label: z.string().optional() }).strict()
const RawToolStatusSchema = z.object({
  type: z.literal('tool.status'),
  callId: z.string().min(1),
  status: z.enum(['accepted', 'rejected', 'running', 'result', 'error', 'cancelled']),
  toolName: z.string().min(1),
  toolVersion: z.string().min(1),
  runtime: z.string(),                          // D-status-runtime：保持 str
  paramHash: z.string().min(1),
  output: z.string().optional(),
  error: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(RawToolAttachmentSchema).optional(),
  executionSummary: z.string().optional()
}).strict()

// —— 多角色 FE-A（§7.1）：角色状态/目录变更帧 schema（strict 未知字段整帧拒；state 为完整公开视图）——
const RawCharacterStateViewSchema = z.object({
  mood: z.object({
    label: nonBlankText(100),
    intensity: z.number().min(0).max(1),
    updatedAt: utcIsoTimestamp()
  }).strict(),
  currentActivity: z.string().max(200).nullable().optional(),
  lastInteractionAt: utcIsoTimestamp().nullable().optional(),
  proactiveEnabled: z.boolean(),
  updatedAt: utcIsoTimestamp()
}).strict()

const RawCharacterStateChangedSchema = z.object({
  type: z.literal('character.state.changed'),
  conversationId: nonBlankText(),
  characterId: nonBlankText(),
  characterInstanceId: nonBlankText(),
  characterRevision: z.number().int().min(1),
  stateVersion: z.number().int().min(1),
  state: RawCharacterStateViewSchema
}).strict()

const RawCharacterCatalogChangedSchema = z.object({
  type: z.literal('character.catalog.changed'),
  characterId: nonBlankText(),
  currentRevision: z.number().int().min(1),
  status: z.enum(['active', 'archived']),
  updatedAt: utcIsoTimestamp()
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
  RawDeltaMessageSchema,
  RawMessageMessageSchema,
  RawTokenUsageMessageSchema,
  RawErrorMessageSchema,
  RawSwitchModelResultSchema,
  RawSetTtsVoiceResultSchema,
  RawVoiceTranscriptSchema,
  RawVoiceSessionStartedSchema,
  RawVoiceSessionPartialSchema,
  RawVoiceSessionTurnSchema,
  RawVoiceSessionAckSchema,
  RawVoiceSessionEndedSchema,
  RawDictationPartialSchema,
  RawDictationFinalSchema,
  RawDictationCancelledSchema,
  RawAudioStartSchema,
  RawAudioChunkSchema,
  RawAudioEndSchema,
  RawAudioCancelledSchema,
  RawLive2DDirectiveSchema,
  // 阶段 6 批次 A（F-6-02）：工具双轨帧 + 过渡期 action 兼容帧
  RawToolRequestSchema,
  RawToolStartedSchema,
  RawToolCompletedSchema,
  RawActionSchema,
  // 多角色 FE-A：角色状态/目录变更帧
  RawCharacterStateChangedSchema,
  RawCharacterCatalogChangedSchema
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

// —— 客户端→服务器语音控制帧 schema（对齐 ws_message.py ClientMessage 各成员；不进 RawFrameSchema/RAW_FRAME_TYPES，Task 4 构造发送用）——
const RawVoiceRecordStartSchema = z.object({ type: z.literal('voice.record.start'), recordingId: z.string().min(1) }).strict()
const RawVoiceRecordStopSchema = z.object({ type: z.literal('voice.record.stop'), recordingId: z.string().min(1) }).strict()
const RawVoiceCommitSchema = z.object({
  type: z.literal('voice.commit'),
  recordingId: z.string().min(1),
  text: z.string(),
  clientRequestId: z.string().min(1),
  clientMessageId: z.string().optional(),
  conversationId: z.string().optional()
}).strict()
const RawVoiceDiscardSchema = z.object({ type: z.literal('voice.discard'), recordingId: z.string().min(1) }).strict()
const RawVoiceSessionStartSchema = z.object({
  type: z.literal('voice_session.start'),
  sessionId: z.string().min(1),
  conversationId: z.string().optional()
}).strict()
const RawVoiceSessionStopSchema = z.object({ type: z.literal('voice_session.stop'), sessionId: z.string().min(1) }).strict()
const RawVoiceSessionCancelSchema = z.object({ type: z.literal('voice_session.cancel'), sessionId: z.string().min(1) }).strict()
const RawDictationStartSchema = z.object({
  type: z.literal('dictation.start'),
  clientRequestId: z.string().min(1),
  sttProfileId: z.string().optional()
}).strict()
const RawDictationStopSchema = z.object({ type: z.literal('dictation.stop'), clientRequestId: z.string().min(1) }).strict()
const RawDictationCancelSchema = z.object({ type: z.literal('dictation.cancel'), clientRequestId: z.string().min(1) }).strict()
const RawAudioCancelSchema = z.object({ type: z.literal('audio.cancel'), stream_id: z.number().int() }).strict()

export const RawClientFrameSchema = z.discriminatedUnion('type', [
  RawVoiceRecordStartSchema,
  RawVoiceRecordStopSchema,
  RawVoiceCommitSchema,
  RawVoiceDiscardSchema,
  RawVoiceSessionStartSchema,
  RawVoiceSessionStopSchema,
  RawVoiceSessionCancelSchema,
  RawDictationStartSchema,
  RawDictationStopSchema,
  RawDictationCancelSchema,
  RawAudioCancelSchema,
  RawToolStatusSchema
])

export function parseRawClientFrame(input: unknown): {
  success: true
  data: RawClientFrame
} | {
  success: false
  error: z.ZodError
} {
  return RawClientFrameSchema.safeParse(input)
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

/** zod 字面量的取值 → 指纹文本。标量沿用 `String()` 的口径（指纹锚点不可变），对象显式序列化；
 *  逐支显式处理是 `no-base-to-string` 的要求：`String(可能含对象的值)` 会产出 '[object Object]'。 */
function literalText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'object') return JSON.stringify(value) ?? ''
  return ''
}

/** 单字段签名: `k:_def.type:枚举成员(entries 排序):字面量值(_def.values/value)`;zod v4 判别 API(_def.type 小写、_def.entries、_def.values) */
const fieldSig = ([k, s]: [string, unknown]): string => {
  const d = s as { _def?: { type?: string; entries?: Record<string, unknown>; values?: unknown[]; value?: unknown } }
  const vals = d._def?.entries ? Object.keys(d._def.entries).sort().join(',') : (d._def?.values ?? []).join(',')
  // 指纹的**取值口径保持不变**（这是被 `check:contract` 比对的锚点）：标量仍按 `String()` 的口径渲染；
  // 只有对象字面量从 '[object Object]' 改为显式序列化（`no-base-to-string`，2026-09-13 type-aware 全集）。
  const rawValue = d._def?.value
  const lit = literalText(rawValue)
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
