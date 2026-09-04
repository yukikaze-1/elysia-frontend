import { z } from 'zod'
import type { RestCreateSessionBody, RestMessage, RestMessageContextResponse, RestMessagesPageResponse, RestPendingQueryResponse, RestSearchMessagesResponse, RestSessionDetail, RestSessionListResult, RestSessionActivateResult, RestStickerListResponse } from './rest-types'

// —— 多角色 FE-A：会话/消息内嵌角色绑定快照 wire schema——
// check:contract 以 Node ESM 直接加载本文件（DesktopCallStatusSchema 同款约束）→ 运行时值导入只允许 zod，
// isSafeRegistryId/isSafeThemeColor 在此自包含一份镜像副本，与 shared/schemas/character.ts、
// character-rest-schemas.ts、raw-schemas.ts 四处同形（任意一处修改需同步）。
function isSafeRegistryId(v: string): boolean {
  if (v.trim().length === 0 || v.length > 200) return false
  if (v.startsWith('/') || v.startsWith('\\')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) return false
  if (v.includes('..')) return false
  return true
}

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
export const RestCharacterPresentationSchema = z.object({
  avatarAssetId: z.string().refine(isSafeRegistryId, '注册表 ID 不得为路径/URL').nullable().optional(),
  live2dModelId: z.string().refine(isSafeRegistryId, '注册表 ID 不得为路径/URL').nullable().optional(),
  themeColor: z.string().refine(isSafeThemeColor, '颜色仅支持 hex/rgb(a)/hsl(a)/命名色').nullable().optional()
}).strict()
export const RestCharacterBindingSnapshotSchema = z.object({
  characterId: z.string().min(1).refine((v) => v.trim().length > 0),
  characterInstanceId: z.string().min(1).refine((v) => v.trim().length > 0),
  characterRevision: z.number().int().min(1),
  displayName: z.string().min(1).max(64).refine((v) => v.trim().length > 0),
  presentation: RestCharacterPresentationSchema
}).strict()

/** POST /api/sessions 请求体：legacy 允许省略 characterId；角色能力开启后的必填门留给运行时。 */
export const RestCreateSessionBodySchema: z.ZodType<RestCreateSessionBody> = z.object({
  title: z.string().optional(),
  characterId: z.string().min(1).refine((v) => v.trim().length > 0).optional()
}).strict()
export function parseRestCreateSessionBody(input: unknown): { success: true; data: RestCreateSessionBody } | { success: false; error: z.ZodError } {
  return RestCreateSessionBodySchema.safeParse(input)
}

export const RestSessionSummarySchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  active: z.boolean(),
  character: RestCharacterBindingSnapshotSchema.optional()   // 多角色 FE-A：CHAR-FE-06（legacy 缺省）
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
  duration_ms: z.number().nullable().optional(),   // P0-02：wire 边界接受 null，映射层归一化（不扩散到领域/IPC）
  truncated: z.boolean().optional(),
  character: RestCharacterBindingSnapshotSchema.optional()   // 多角色 FE-A：CHAR-FE-07（assistant 与 summary 同形）
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

// —— 阶段 3 G3 附件上传/签发响应 schema（请求不建 zod；multipart 由 RealBackend 构造）——
export const RestAttachmentUploadResponseSchema = z.object({
  attachments: z.array(z.object({
    attachmentId: z.string().min(1),
    kind: z.string().min(1),
    mime: z.string().min(1),
    size: z.number().int().nonnegative(),
    url: z.string().min(1),
    signedUrl: z.string().optional(),
    filename: z.string()
  }))
}).strict()
export const RestAttachmentSignResponseSchema = z.object({
  attachmentId: z.string().min(1),
  url: z.string().min(1),
  expiresAt: z.string().min(1)
}).strict()
export function parseAttachmentUploadResponse(input: unknown): { success: true; data: z.infer<typeof RestAttachmentUploadResponseSchema> } | { success: false; error: z.ZodError } {
  return RestAttachmentUploadResponseSchema.safeParse(input)
}
export function parseAttachmentSignResponse(input: unknown): { success: true; data: z.infer<typeof RestAttachmentSignResponseSchema> } | { success: false; error: z.ZodError } {
  return RestAttachmentSignResponseSchema.safeParse(input)
}

// —— 阶段 3 G4 历史搜索/上下文/表情清单 响应 schema（P0-1/P0-2：camelCase、无 kind/url；严格镜像契约）——
// 已知限制（P2-3）：真实后端 search item 无 kind/url，表情分类在查看器内为纯文本行、无贴图缩略图——
// 待后端 SearchMessageItem 增 kind/url 或 queryResources 通道后再富化；不伪造实现（P0-1 缺口，不为此绕契约）。
export const RestSearchMessageItemSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  timestamp: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool', 'system']).optional(),
  snippet: z.string().optional(),
  responseId: z.string().optional(),
  segmentId: z.string().optional()
}).strict()
export const RestSearchMessagesResponseSchema = z.object({
  items: z.array(RestSearchMessageItemSchema),
  has_more: z.boolean(),
  cursor: z.string().optional()
}).strict()
export const RestMessageContextResponseSchema = z.object({
  anchor: RestMessageSchema,
  before: z.array(RestMessageSchema),
  after: z.array(RestMessageSchema),
  conversationId: z.string().min(1)
}).strict()
export const RestStickerItemSchema = z.object({
  stickerId: z.string().min(1),
  src: z.string().min(1)
}).strict()
export const RestStickerListResponseSchema = z.object({ stickers: z.array(RestStickerItemSchema) }).strict()

export function parseRestSearchMessages(input: unknown): { success: true; data: RestSearchMessagesResponse } | { success: false; error: z.ZodError } {
  return RestSearchMessagesResponseSchema.safeParse(input)
}
export function parseRestMessageContext(input: unknown): { success: true; data: RestMessageContextResponse } | { success: false; error: z.ZodError } {
  return RestMessageContextResponseSchema.safeParse(input)
}
export function parseRestStickerList(input: unknown): { success: true; data: RestStickerListResponse } | { success: false; error: z.ZodError } {
  return RestStickerListResponseSchema.safeParse(input)
}

// —— 阶段 4 批次A:providers/tts wire 解析（镜像 rest.py；Provider 名动态 key 用 z.record；字段 camelCase 对齐契约）——
export const ProviderEntryWireSchema = z.object({
  models: z.array(z.string()), credentialConfigured: z.boolean().default(false),
  runtime: z.enum(['backend', 'desktop', 'local_worker']).default('backend'),
  capabilities: z.record(z.string(), z.unknown()).default({})
})
export const CustomProviderWireSchema = z.object({
  name: z.string(), base_url: z.string().optional(), api_key_env: z.string().optional(),
  models: z.array(z.string()).optional(), runtime: z.enum(['backend', 'desktop', 'local_worker']).default('backend'),
  credentialConfigured: z.boolean().default(false), capabilities: z.record(z.string(), z.unknown()).default({})
})
export const ProvidersResponseWireSchema = z.object({
  llm: z.record(z.string(), ProviderEntryWireSchema), stt: z.record(z.string(), ProviderEntryWireSchema),
  tts: z.record(z.string(), ProviderEntryWireSchema), custom: z.record(z.string(), z.array(CustomProviderWireSchema)).default({}),
  unconfigured: z.record(z.string(), z.array(z.object({ name: z.string(), env_vars: z.array(z.string()) }))).optional()
})
export const ProviderTestResultWireSchema = z.object({
  ok: z.boolean(), latency_ms: z.number().optional(), error: z.string().optional(), detail: z.string().optional()
})
export const TtsVoiceEntryWireSchema = z.object({
  id: z.string(), name: z.string().optional(), languages: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.unknown()).default({})   // rest.py:219 dict（能力描述），非数组；缺省 {} 恒上 wire
})
export const TtsVoicesResponseWireSchema = z.object({
  voices: z.array(TtsVoiceEntryWireSchema), current: z.string().optional(), source: z.enum(['static', 'api']).default('static'), error: z.string().optional()
})
export const TtsPreviewResultWireSchema = z.object({
  ok: z.boolean(), mime: z.string().optional(), audio_base64: z.string().optional(), duration_ms: z.number().optional(), error: z.string().optional()
})

export function parseRestProviders(input: unknown): { success: true; data: z.infer<typeof ProvidersResponseWireSchema> } | { success: false } {
  return ProvidersResponseWireSchema.safeParse(input)
}
export function parseRestProviderTest(input: unknown): { success: true; data: z.infer<typeof ProviderTestResultWireSchema> } | { success: false } {
  return ProviderTestResultWireSchema.safeParse(input)
}
export function parseRestTtsVoices(input: unknown): { success: true; data: z.infer<typeof TtsVoicesResponseWireSchema> } | { success: false } {
  return TtsVoicesResponseWireSchema.safeParse(input)
}
export function parseRestTtsPreview(input: unknown): { success: true; data: z.infer<typeof TtsPreviewResultWireSchema> } | { success: false } {
  return TtsPreviewResultWireSchema.safeParse(input)
}

// —— 阶段 6 批次 C（D6C-11/BE-043，V-12）：GET /api/tools/calls/{callId} 响应 wire schema——
// check:contract REST 段以 Node ESM（--experimental-strip-types）直接 import 本文件，mod[path[0]]
// 解析目标必须是本模块自包含定义：shared/schemas/ipc-response.ts 含别名/无扩展名相对导入，
// Node 加载器不可解析 → 不能值复导出，按 rest-schemas.ts 惯例（Rest*WireSchema）在此定义镜像副本，
// 与 ipc-response.ts 的 DesktopCallStatusSchema 同形（严格镜像 frontend_contract/contract.raw.ts:1586-1610，
// 两处修改需同步）。repo 9 值枚举，非 ToolWireStatus 六态（result→succeeded、error→failed 为后端固定翻译）。
export const DesktopCallStatusSchema = z.object({
  callId: z.string(), toolName: z.string(), toolVersion: z.string(), runtime: z.string(), paramHash: z.string(),
  status: z.enum(['pending', 'accepted', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired', 'offline']),
  createdAt: z.string(), expiresAt: z.string(),
  result: z.record(z.string(), z.unknown()).optional(), error: z.record(z.string(), z.unknown()).optional(),
}).strict()
