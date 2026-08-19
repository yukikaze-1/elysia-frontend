import { z } from 'zod'
import { TokenUsageSchema } from './events'
import type { ActiveModelSelection, Live2DModelSummary, Live2DSettings, ModelProfile, ModelProfileTestResult, PerformanceMode, SettingsPatch, SettingsState, TtsPreviewOutcome, TtsVoice, TtsVoiceListResult } from '@shared/contracts'

/**
 * 共享领域响应 Schema —— 严格镜像 `shared/contracts` 类型(C1)。
 * Main handler responseSchema 与 Preload 防御性解析共用;
 * 字段可丢即表示契约形状漂移,禁止为「宽松」而放宽必填项。
 */

export const ConnectionStateSchema = z.object({
  status: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'error']),
  serverUrl: z.string().optional(),
  protocolVersion: z.string().optional(),
  serverVersion: z.string().optional(),
  connectionId: z.string().optional(),
  activeConversationId: z.string().optional(),
  lastError: z.string().optional()
})

export const BackendSessionSchema = z.object({
  sessionId: z.string().min(1),
  protocolVersion: z.string().min(1),
  serverUrl: z.string().min(1)
})

export const ClientRequestRefSchema = z.object({
  clientRequestId: z.string().min(1),
  serverMessageId: z.string().optional()
})

export const ActivateConversationResultSchema = z.object({
  conversationId: z.string().min(1)
})

export const RuntimeInfoSchema = z.object({
  mode: z.enum(['real', 'mock']),
  packaged: z.boolean(),
  mockMouthLevel: z.enum(['step', 'sine']).optional() // 批次 C（C1）：mock 合成包络源选择（仅 mock 模式填充）
})

export const EndpointResponseSchema = z.object({
  endpoint: z.string().optional()
})

export const MessageAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']),
  mediaType: z.string().min(1),
  name: z.string().optional(),
  size: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  messageId: z.string().optional()
})

export const AssistantSegmentSchema = z.object({
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: z.enum(['inner_voice', 'public_reply']),
  kind: z.enum(['text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link']),
  text: z.string().optional(),
  completed: z.boolean(),
  attachmentId: z.string().optional(),
  url: z.string().optional(),
  mediaType: z.string().optional(),
  name: z.string().optional(),
  size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number().optional(),
  stickerId: z.string().optional()   // 阶段 3 G4：sticker 分段身份（D8）
})

/** 镜像 contracts/message.ts `MessageToolInfo`（全 optional；rest-mapper assemble 产出同形对象） */
export const MessageToolInfoSchema = z.object({
  callId: z.string().optional(),
  name: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  errorType: z.string().optional(),
  durationMs: z.number().optional(),
  truncated: z.boolean().optional()
})

// —— 阶段 6 批次 B：工具 schema（镜像 ToolCallRecord/PublicToolEvent；ToolCallRecordSchema 需在 MessageSchema 定义之前，D6B-10）——
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  runtime: z.enum(['backend', 'desktop', 'local_worker']),
  status: z.enum(['requested', 'awaiting_permission', 'running', 'completed', 'failed', 'rejected', 'cancelled', 'timeout']),
  desktopCallId: z.string().optional(),
  generationId: z.string().optional(),
  conversationId: z.string().optional(),
  reason: z.string().optional(),
  inputSummary: z.string().optional(),
  outputSummary: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  errorType: z.string().optional(),
  truncated: z.boolean().optional(),
  durationMs: z.number().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  attachmentCount: z.number().int().nonnegative().optional(),
}).strict()

const DiffLineSchema = z.object({ kind: z.enum(['added', 'removed', 'unchanged']), text: z.string() }).strict()
const ToolDiffSchema = z.object({
  lines: z.array(DiffLineSchema), added: z.number(), removed: z.number(),
  truncated: z.boolean(), totalLines: z.number(), formatNote: z.string(), isNewFile: z.boolean(),   // totalLines=A-20（「共 X 行」）
}).strict()
const CaptureSourceSchema = z.object({ sourceId: z.string(), sourceName: z.string(), thumbnailDataUrl: z.string() }).strict()
const CapturePreviewSchema = z.object({ sourceId: z.string(), previewDataUrl: z.string() }).strict()

export const PublicToolEventSchema = z.object({
  id: z.string(), desktopCallId: z.string().optional(), toolName: z.string(), title: z.string(),
  runtime: z.literal('desktop'), status: z.enum(['requested', 'awaiting_permission', 'running', 'completed', 'failed', 'rejected', 'cancelled', 'timeout']),
  reason: z.string().optional(), inputSummary: z.string().optional(), pathSummary: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  truncated: z.boolean().optional(), durationMs: z.number().optional(),
  startedAt: z.string().optional(), finishedAt: z.string().optional(),
  attachmentCount: z.number().int().nonnegative().optional(),
  dataFlowNote: z.string().optional(),
  diff: ToolDiffSchema.optional(),
  captureSources: z.array(CaptureSourceSchema).optional(),
  capturePreview: CapturePreviewSchema.optional(),
  occurredAt: z.string(),
}).strict()

// IPC 请求 schema（D6B-10「zod 双端」——Renderer 与 Main 共用；A-10）
export const PermissionDecisionSchema = z.object({ callId: z.string(), decision: z.enum(['allow_once', 'deny']) }).strict()
export const ToolCancelSchema = z.object({ callId: z.string() }).strict()
export const ToolPickSourceSchema = z.object({ callId: z.string(), sourceId: z.string() }).strict()
export const ToolConfirmUploadSchema = z.object({ callId: z.string() }).strict()
export const ToolListResponseSchema = z.array(PublicToolEventSchema)

export const MessageSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().optional(),
  status: z.enum(['pending', 'acknowledged', 'streaming', 'completing', 'completed', 'failed', 'interrupted']),
  createdAt: z.string(),
  clientMessageId: z.string().optional(),
  assistantSegments: z.array(AssistantSegmentSchema).optional(),
  tool: MessageToolInfoSchema.optional(),   // 严格镜像 MessageToolInfo(rest-mapper assemble 产出;M4:输出须可赋值回 Message)
  attachments: z.array(MessageAttachmentSchema).optional(),   // 附件内嵌消息（阶段 3 G3，D2）
  toolCalls: z.array(ToolCallRecordSchema).optional(),   // 阶段 6 批次 B：归档工具调用（修复 preload safeParse 剥字段缺陷，D6B-10）
  usage: TokenUsageSchema.optional(),
  model: z.string().optional(),
  emotion: z.string().optional(),
  stickerId: z.string().optional()   // 阶段 3 G4：用户贴图消息 wire 表示（可选字段，D8）
})

export const ConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  updatedAt: z.string(),
  preview: z.string().optional()
})

export const PageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({ items: z.array(itemSchema), hasMore: z.boolean(), nextCursor: z.string().optional() })

export const MessagePageSchema = PageSchema(MessageSchema)

export const ConversationResourceSchema = z.object({
  messageId: z.string().min(1),
  timestamp: z.string(),
  kind: z.enum(['image', 'link', 'video', 'audio', 'file', 'sticker']),
  url: z.string().min(1),
  stickerId: z.string().optional()
})

export const ChatHistoryItemSchema: z.ZodType<import('@shared/contracts').ChatHistoryItem> = z.object({
  hitId: z.string().min(1),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  responseId: z.string().optional(),
  segmentId: z.string().optional(),
  senderLabel: z.string().min(1),
  snippet: z.string().optional(),
  resource: ConversationResourceSchema.optional(),
  createdAt: z.string(),
  sortKey: z.string().min(1)
})

export const ChatHistoryPageSchema: z.ZodType<import('@shared/contracts').ChatHistoryPage> =
  PageSchema(ChatHistoryItemSchema).extend({ snapshotId: z.string().optional() })

export const StickerItemSchema = z.object({
  stickerId: z.string().min(1),          // P0-2：对齐契约 StickerEntry{stickerId, src}
  src: z.string().min(1)
})
export const StickerManifestSchema = z.object({ stickers: z.array(StickerItemSchema) })   // 对齐 StickerListResponse{stickers}

export const FileValidationResultSchema = z.object({
  localId: z.string().min(1),
  ok: z.boolean(),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']).optional(),
  reason: z.string().optional(),
  message: z.string().optional()
})
export const AttachmentsUploadResponseSchema = z.object({
  uploadId: z.string().min(1),
  attachments: z.array(MessageAttachmentSchema)
})
export const AttachmentCheckResultSchema = z.object({
  status: z.enum(['ok', 'expired', 'not_found', 'revoked', 'error']),
  reason: z.string().optional()
})

export const ReplayPayloadSchema = z.object({
  conversationId: z.string().min(1),
  messages: z.array(MessageSchema)
})

// —— 阶段 4 批次 A：模型服务 / TTS 出参 schema（严格镜像 shared/contracts/model.ts，C1）——
export const ModelProfileSchema: z.ZodType<ModelProfile> = z.object({
  id: z.string(), type: z.enum(['llm', 'stt', 'tts']), displayName: z.string(),
  source: z.enum(['built_in', 'custom']), provider: z.string(), model: z.string(),
  models: z.array(z.string()), executionLocation: z.enum(['backend', 'desktop', 'local_worker']),
  credentialStatus: z.enum(['missing', 'configured', 'expired']), enabled: z.boolean(),
  capabilities: z.array(z.string()), endpointLabel: z.string().optional(), baseUrl: z.string().optional(), builtIn: z.boolean()
})
export const ModelProfilesSchema = z.array(ModelProfileSchema)
export const TtsVoiceSchema: z.ZodType<TtsVoice> = z.object({
  id: z.string(), name: z.string().optional(), languages: z.array(z.string()), capabilities: z.array(z.string())
})
export const TtsVoiceListResultSchema: z.ZodType<TtsVoiceListResult> = z.object({
  voices: z.array(TtsVoiceSchema), current: z.string().optional(), source: z.enum(['static', 'api']), error: z.string().optional()
})
export const TtsPreviewOutcomeSchema: z.ZodType<TtsPreviewOutcome> = z.object({
  ok: z.boolean(), audioUrl: z.string().optional(), durationMs: z.number().optional(), error: z.string().optional()
})
export const ModelProfileTestResultSchema: z.ZodType<ModelProfileTestResult> = z.object({
  profileId: z.string(), service: z.enum(['llm', 'stt', 'tts']), level: z.enum(['connectivity', 'usable']),
  ok: z.boolean(), latencyMs: z.number().optional(), error: z.string().optional(), detail: z.string().optional()
})
export const ActiveModelSelectionSchema: z.ZodType<ActiveModelSelection> = z.object({
  llmProfileId: z.string().optional(), voiceSttProfileId: z.string().optional(),
  ttsProfileId: z.string().optional(), dictationSttProfileId: z.string().optional()
})

// —— 阶段 4 批次 B：语音/设置出参 schema（严格镜像 contracts/voice.ts，C1）——
// 子 schema 不注 z.ZodType（保持 ZodObject 具体类型以保留 .partial()，供 SettingsPatchSchema 使用）；
// 顶层 SettingsStateSchema/SettingsPatchSchema 注 z.ZodType 强制镜像契约形状。
export const VoiceSettingsSchema = z.object({
  enabled: z.boolean(), realtimeEnabled: z.boolean(), autoReadReply: z.boolean(),
  showCaptions: z.boolean(), consentBackendStt: z.boolean(), micDeviceId: z.string().optional()
})
export const DictationSettingsSchema = z.object({
  sttProfileId: z.string().optional(), insertMode: z.enum(['append', 'replace_selection'])
})
/** 阶段 5 批次 A（D5A-10，A6）/ 批次 B（B5，D5B-06/D5B-08）：Live2D 本地设置子 schema——镜像
 * contracts/live2d.ts `Live2DSettings`（10 字段）。子 schema 不注 z.ZodType（保留 .partial()；SettingsStateSchema
 * 该字段带 .default(DEFAULT_LIVE2D)——老 settings.json 无 live2d 段或新字段都能通过 parse（input 可缺省），
 * 不得做成必填（否则老文件走 corrupt+全量重置，清掉 voice/dictation）。
 * performanceMode 用 z.preprocess 归一（I-3）：真实链路 Main settings-service 先 SettingsStateSchema.safeParse，
 * 裸 z.enum 会让含旧值 'high'/'low' 的文件直接 corrupt+全量重置；preprocess 使 load/save 两路都归一到四值。 */
export const Live2DSettingsSchema = z.object({
  enabled: z.boolean(),
  modelId: z.string().nullable(),
  scale: z.number().min(0.5).max(3).default(1),
  offsetX: z.number().min(-2).max(2).default(0),
  offsetY: z.number().min(-2).max(2).default(0),
  mouseTracking: z.boolean().default(true),
  autoMotions: z.boolean().default(true),
  lipSync: z.boolean().default(true),
  performanceMode: z
    .preprocess((v) => normalizePerformanceMode(String(v)), z.enum(['auto', 'quality', 'balanced', 'low_power']))
    .default('auto'),
  reduceMotion: z.boolean().default(false)
})

/** SettingsPatch.live2d 专用子 schema（IP-1，批次 B 审查）：全字段 .optional() 且**不带 .default()**。
 *  zod .partial() 只把字段变 optional，不会去掉字段上的 .default()——若用 Live2DSettingsSchema.partial()，
 *  单字段 patch（如 {enabled:false}）会为其余已默认字段注入默认值（scale:1、lipSync:true 等），经
 *  settings-service save() 的 { ...state.live2d, ...patch.live2d } merge 会静默重置用户已设的
 *  scale/lipSync/offsetX 等（违背「未提交字段保持现值」语义，Task 5 单字段 patch 会触发）。
 *  performanceMode 仍包 z.preprocess 归一：.optional() 缺省时短路为 undefined（不注入 'auto'），
 *  仅当 patch 显式带 'high'/'low' 时归一四值（patch 保存路径仍归一）。 */
export const Live2DSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  modelId: z.string().nullable().optional(),
  scale: z.number().min(0.5).max(3).optional(),
  offsetX: z.number().min(-2).max(2).optional(),
  offsetY: z.number().min(-2).max(2).optional(),
  mouseTracking: z.boolean().optional(),
  autoMotions: z.boolean().optional(),
  lipSync: z.boolean().optional(),
  performanceMode: z
    .preprocess((v) => normalizePerformanceMode(String(v)), z.enum(['auto', 'quality', 'balanced', 'low_power']))
    .optional(),
  reduceMotion: z.boolean().optional()
})

/** 性能模式归一（D5B-06，I-3）：批次 A 三值 'high'/'low' → 四值 'quality'/'low_power'；四值原样；未知 → 兜底 'auto'。
 *  在 schema 解析期经 z.preprocess 调用，load/save 两路统一四值。 */
export function normalizePerformanceMode(v: string): PerformanceMode {
  if (v === 'high') return 'quality'
  if (v === 'low') return 'low_power'
  return (['auto', 'quality', 'balanced', 'low_power'] as const).includes(v as PerformanceMode) ? (v as PerformanceMode) : 'auto'
}

/** 默认 Live2D 设置（D5A-10/D5B-08）：缺省启用 + 未选择模型（null → 默认首个可用）+ 全量默认 10 字段 */
export const DEFAULT_LIVE2D: Live2DSettings = {
  enabled: true, modelId: null, scale: 1, offsetX: 0, offsetY: 0,
  mouseTracking: true, autoMotions: true, lipSync: true,
  performanceMode: 'auto', reduceMotion: false
}
export const SettingsStateSchema: z.ZodType<SettingsState> = z.object({
  version: z.literal(1), voice: VoiceSettingsSchema, dictation: DictationSettingsSchema,
  live2d: Live2DSettingsSchema.default(DEFAULT_LIVE2D)
})
/** 局部更新（settings:save 入参；patch 后 merge 才落盘，未提交字段保持现值） */
export const SettingsPatchSchema: z.ZodType<SettingsPatch> = z.object({
  voice: VoiceSettingsSchema.partial().optional(),
  dictation: DictationSettingsSchema.partial().optional(),
  live2d: Live2DSettingsPatchSchema.optional() // IP-1：patch 路径用无默认子 schema，防单字段 patch clobber 已持久化非默认字段
})

/** 默认设置（M-7 修复）：enabled/realtimeEnabled/autoReadReply/showCaptions/consentBackendStt/insertMode；micDeviceId/sttProfileId 缺省 undefined；
 *  阶段 5 批次 A：live2d 引用 DEFAULT_LIVE2D（enabled:true/modelId:null） */
export const DEFAULT_SETTINGS: SettingsState = {
  version: 1,
  voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false },
  dictation: { insertMode: 'append' },
  live2d: DEFAULT_LIVE2D
}

// —— 阶段 5 批次 A：Live2D 模型摘要出参 schema（严格镜像 contracts/live2d.ts，D5A-07；preload 与 Main handler 共用）——
// M4（批次 C 收口）：reason 闭合枚举同步（z.enum(...).optional()）——非三码字符串被 schema 拒（fail-closed 防串注入）。
export const Live2DModelSummarySchema: z.ZodType<Live2DModelSummary> = z.object({
  id: z.string(),
  displayName: z.string(),
  preview: z.string().nullable(),
  version: z.string(),
  available: z.boolean(),
  reason: z.enum(['missing_file', 'size_mismatch', 'hash_mismatch']).optional(),
  licenseRef: z.string(),
  integrityState: z.enum(['unverified', 'verified', 'failed'])
})
export const Live2DListResponseSchema = z.array(Live2DModelSummarySchema)
