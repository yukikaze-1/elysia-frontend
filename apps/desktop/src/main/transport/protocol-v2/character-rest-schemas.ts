// —— 多角色 FE-A（character-contract-v1）：角色域 raw REST wire schema（设计 §6.2/§6.4）——
// 全部 .strict()（未知字段 fail-closed）；与 character-rest-types.ts 一一对应。
// 注意：本文件被 check:contract 以 Node ESM 直接加载（DesktopCallStatusSchema 同款约束），
// 运行时值导入只允许 zod/node 内建 → isSafeRegistryId/isSafeThemeColor 在此自包含一份镜像副本，
// 与 shared/schemas/character.ts、protocol-v2/rest-schemas.ts、protocol-v2/raw-schemas.ts 同形（四处修改需同步）。
import { z } from 'zod'
import type {
  RestCharacterArchiveResult,
  RestCharacterDraft,
  RestCharacterDetail,
  RestCharacterListQuery,
  RestCharacterListResponse,
  RestCharacterMutationResult,
  RestCharacterPromptProfile,
  RestCharacterRuntimeDefaults,
  RestCharacterPublicState,
  RestCharacterRevisionsResponse,
  RestCharacterRevisionQuery,
  RestCharacterRevisionContent,
  RestCharacterRevisionSummary,
  RestCharacterSummary,
  RestCharacterValidationResult,
  RestCharacterPreviewResult,
  RestCloneCharacterBody,
  RestCreateCharacterBody,
  RestPreviewCharacterBody,
  RestResetEvolutionBody,
  RestRollbackCharacterBody,
  RestUpdateCharacterBody,
  RestUpdateMeBody,
  RestValidateCharacterBody,
  RestResetEvolutionResult,
  RestUserIdentityProfile
} from './character-rest-types'

// —— 镜像副本起点（与 shared/schemas/character.ts、rest-schemas.ts、raw-schemas.ts 同形，四处修改需同步）——
/** 注册表 ID：拒绝绝对路径、盘符、URL 与相对路径逃逸 */
function isSafeRegistryId(v: string): boolean {
  if (v.trim().length === 0 || v.length > 200) return false
  if (v.startsWith('/') || v.startsWith('\\')) return false
  // Registered resource IDs are opaque names, never URI schemes (including
  // data:/javascript:) or Windows drive paths such as C:/models/....
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
/** CSS 安全颜色：hex(3-8) / rgb(a)/hsl(a) / 命名色 */
function isSafeThemeColor(v: string): boolean {
  if (v.length === 0 || v.length > 64) return false
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true
  if (/^(rgba?|hsla?)\(\s*[\d.,%\s]+\s*\)$/.test(v)) return true
  return SAFE_CSS_NAMED_COLORS.has(v.toLowerCase())
}
// —— 镜像副本终点 ——

const revisionInt = () => z.number().int().min(1)
const registryId = () => z.string().refine(isSafeRegistryId, '注册表 ID 不得为路径/URL')
const themeColor = () => z.string().refine(isSafeThemeColor, '颜色仅支持 hex/rgb(a)/hsl(a)/命名色')
const utcIsoTimestamp = () => z.string().refine(isUtcIsoTimestamp, '时间必须是 UTC ISO-8601（Z 或 +00:00）')
const requiredText = (max?: number) => {
  const base = max === undefined ? z.string().min(1) : z.string().min(1).max(max)
  return base.refine((v) => v.trim().length > 0, '文本不能全为空白')
}
const emptyOrText = (max: number) => z.string().max(max).refine((v) => v === '' || v.trim().length > 0, '文本不能全为空白')
const resetFields = () => z.array(z.enum(['self_l2', 'state_l3', 'speaking_style_c6', 'reflector', 'mood'])).max(5)

export const RestCharacterPresentationSchema = z.object({
  avatarAssetId: registryId().nullable().optional(),
  live2dModelId: registryId().nullable().optional(),
  themeColor: themeColor().nullable().optional()
}).strict()

/** 绑定快照（session summary/message 内嵌；characterRevision 冻结——无顶层 revision） */
export const RestCharacterBindingSnapshotSchema = z.object({
  characterId: requiredText(),
  characterInstanceId: requiredText(),
  characterRevision: revisionInt(),
  displayName: requiredText(64),
  presentation: RestCharacterPresentationSchema
}).strict()

/** PUT /api/me 请求体（完整最小身份替换；省略可选字段表示清空/默认）。 */
export const RestUpdateMeBodySchema: z.ZodType<RestUpdateMeBody> = z.object({
  expectedRevision: revisionInt(),
  displayName: requiredText(64),
  preferredAddress: requiredText(200).optional(),
  pronouns: requiredText(200).optional(),
  locale: requiredText(100),
  timezone: requiredText(100),
  defaultCharacterId: requiredText().optional()
}).strict()

/** GET /api/characters 查询白名单；cursor/limit 仍是 raw query 形状，未转换为 Page。 */
export const RestCharacterListQuerySchema: z.ZodType<RestCharacterListQuery> = z.object({
  source: z.enum(['builtin', 'custom']).optional(),
  status: z.enum(['active', 'archived']).optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional()
}).strict()

/** GET /api/characters/{id}/revisions 查询；characterId 由 URL path 承载。 */
export const RestCharacterRevisionQuerySchema: z.ZodType<RestCharacterRevisionQuery> = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional()
}).strict()

const RestCharacterExampleSchema = z.object({
  user: requiredText(1_000),
  assistant: requiredText(1_000)
}).strict()

export const RestCharacterPromptProfileSchema: z.ZodType<RestCharacterPromptProfile> = z.object({
  corePersonality: requiredText(12_000),
  relationshipStyle: requiredText(6_000),
  // 后端允许这两个字段为空，但字段本身仍然必须存在。
  emotionStyle: emptyOrText(5_000),
  speakingStyle: requiredText(6_000),
  conversationInitiative: emptyOrText(3_000),
  examples: z.array(RestCharacterExampleSchema).max(20)
}).strict()

export const RestCharacterRuntimeDefaultsSchema: z.ZodType<RestCharacterRuntimeDefaults> = z.object({
  voice: z.object({
    providerId: registryId().nullable().optional(),
    voiceId: registryId().nullable().optional()
  }).strict(),
  emotion: z.object({ idleExpressions: z.array(requiredText(64)).max(16) }).strict(),
  wakeWords: z.array(requiredText(32)).max(20),
  proactive: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(0),
    triggers: z.array(requiredText(64)).max(20)
  }).strict()
}).strict()

/** create/update/validate 使用的完整 draft；create/update wire 顶层展平，preview 才包装。 */
const RestCharacterDraftObjectSchema = z.object({
  displayName: requiredText(64),
  description: z.string().max(500),
  aliases: z.array(requiredText(32)).max(10),
  promptProfile: RestCharacterPromptProfileSchema,
  runtimeDefaults: RestCharacterRuntimeDefaultsSchema,
  presentation: RestCharacterPresentationSchema,
  openingMessage: emptyOrText(1_000).optional()
}).strict()
export const RestCharacterDraftSchema: z.ZodType<RestCharacterDraft> = RestCharacterDraftObjectSchema

/** POST /api/characters：顶层完整 draft，不接受 {draft: ...} 包装。 */
export const RestCreateCharacterBodySchema: z.ZodType<RestCreateCharacterBody> = RestCharacterDraftSchema

/** PUT /api/characters/{id}：expectedRevision/statePolicy 与 draft 同层。 */
export const RestUpdateCharacterBodySchema: z.ZodType<RestUpdateCharacterBody> = RestCharacterDraftObjectSchema.extend({
  expectedRevision: revisionInt(),
  statePolicy: z.enum(['preserve', 'reset_evolution'])
}).strict()

/** POST /api/characters/{id}/clone：可选的新显示名。 */
export const RestCloneCharacterBodySchema: z.ZodType<RestCloneCharacterBody> = z.object({
  displayName: requiredText(64).optional()
}).strict()

/** POST /api/characters/{id}/rollback：目标版本 + 当前版本 CAS + 状态策略。 */
export const RestRollbackCharacterBodySchema: z.ZodType<RestRollbackCharacterBody> = z.object({
  targetRevision: revisionInt(),
  expectedRevision: revisionInt(),
  statePolicy: z.enum(['preserve', 'reset_evolution'])
}).strict()

/** POST /api/characters/validate：与 create 相同的顶层 draft。 */
export const RestValidateCharacterBodySchema: z.ZodType<RestValidateCharacterBody> = RestCharacterDraftSchema

/** POST /api/characters/preview：draft 保留包装，userMessage 为本次临时输入。 */
export const RestPreviewCharacterBodySchema: z.ZodType<RestPreviewCharacterBody> = z.object({
  draft: RestCharacterDraftSchema,
  userMessage: requiredText(20_000)
}).strict()

/** POST /api/character-instances/{id}/reset-evolution：状态版本 CAS。 */
export const RestResetEvolutionBodySchema: z.ZodType<RestResetEvolutionBody> = z.object({
  expectedStateVersion: revisionInt()
}).strict()

export const RestUserIdentityProfileSchema: z.ZodType<RestUserIdentityProfile> = z.object({
  userId: requiredText(),
  displayName: requiredText(64),
  preferredAddress: requiredText(200).nullable().optional(),
  pronouns: requiredText(200).nullable().optional(),
  locale: requiredText(100),
  timezone: requiredText(100),
  initialized: z.boolean(),
  defaultCharacterId: requiredText().nullable().optional(),
  revision: revisionInt(),
  createdAt: utcIsoTimestamp(),
  updatedAt: utcIsoTimestamp()
}).strict()

const RestCharacterSummarySchema: z.ZodType<RestCharacterSummary> = z.object({
  characterId: requiredText(),
  source: z.enum(['builtin', 'custom']),
  mutable: z.boolean(),
  status: z.enum(['active', 'archived']),
  currentRevision: revisionInt(),
  displayName: requiredText(64),
  description: z.string().max(500),
  aliases: z.array(requiredText(32)).max(10),
  presentation: RestCharacterPresentationSchema,
  updatedAt: utcIsoTimestamp()
}).strict()

const RestCharacterRevisionContentSchema: z.ZodType<RestCharacterRevisionContent> = z.object({
  characterId: requiredText(),
  revision: revisionInt(),
  schemaVersion: revisionInt(),
  displayName: requiredText(64),
  description: z.string().max(500),
  aliases: z.array(requiredText(32)).max(10),
  promptProfile: z.object({
    corePersonality: requiredText(12_000),
    relationshipStyle: requiredText(6_000),
    emotionStyle: emptyOrText(5_000),
    speakingStyle: requiredText(6_000),
    conversationInitiative: emptyOrText(3_000),
    examples: z.array(z.object({ user: requiredText(1_000), assistant: requiredText(1_000) }).strict()).max(20)
  }).strict(),
  runtimeDefaults: z.object({
    voice: z.object({
      providerId: registryId().nullable().optional(),
      voiceId: registryId().nullable().optional()
    }).strict(),
    emotion: z.object({ idleExpressions: z.array(requiredText(64)).max(16) }).strict(),
    wakeWords: z.array(requiredText(32)).max(20),
    proactive: z.object({
      enabled: z.boolean(),
      intervalSeconds: z.number().int().min(0),
      triggers: z.array(requiredText(64)).max(20)
    }).strict()
  }).strict(),
  presentation: RestCharacterPresentationSchema,
  openingMessage: emptyOrText(1_000).nullable().optional(),
  checksum: requiredText(),
  compilerVersion: revisionInt(),
  createdBy: z.enum(['system', 'user', 'migration']),
  createdAt: utcIsoTimestamp()
}).strict()

export const RestCharacterDetailSchema: z.ZodType<RestCharacterDetail> = z.object({
  summary: RestCharacterSummarySchema,
  current: RestCharacterRevisionContentSchema
}).strict()

export const RestCharacterListResponseSchema: z.ZodType<RestCharacterListResponse> = z.object({
  items: z.array(RestCharacterSummarySchema),
  has_more: z.boolean(),
  cursor: z.string().min(1).optional()
}).strict()

export const RestCharacterRevisionSummarySchema: z.ZodType<RestCharacterRevisionSummary> = z.object({
  revision: revisionInt(),
  checksum: requiredText(),
  createdBy: z.enum(['system', 'user', 'migration']),
  createdAt: utcIsoTimestamp()
}).strict()

export const RestCharacterRevisionsResponseSchema: z.ZodType<RestCharacterRevisionsResponse> = z.object({
  items: z.array(RestCharacterRevisionSummarySchema),
  has_more: z.boolean(),
  cursor: z.string().min(1).optional()
}).strict()

const RestCharacterStateImpactSchema = z.object({
  statePolicy: z.enum(['preserve', 'reset_evolution']),
  affectedInstances: z.number().int().min(0),
  pendingInstances: z.number().int().min(0),
  resetFields: resetFields()
}).strict()
  .refine(
    (value) => value.pendingInstances <= value.affectedInstances,
    { path: ['pendingInstances'], message: 'pendingInstances 不能超过 affectedInstances' }
  )
  .refine(
    (value) => value.statePolicy !== 'preserve' || value.resetFields.length === 0,
    { path: ['resetFields'], message: 'statePolicy=preserve 时 resetFields 必须为空' }
  )

export const RestCharacterMutationResultSchema: z.ZodType<RestCharacterMutationResult> = z.object({
  character: RestCharacterDetailSchema,
  stateImpact: RestCharacterStateImpactSchema
}).strict()

export const RestCharacterArchiveResultSchema: z.ZodType<RestCharacterArchiveResult> = z.object({
  character: RestCharacterSummarySchema,
  userProfile: RestUserIdentityProfileSchema.optional()
}).strict()

export const RestCharacterValidationResultSchema: z.ZodType<RestCharacterValidationResult> = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({
    severity: z.enum(['error', 'warning']),
    code: requiredText(100),
    path: requiredText(512).refine((v) => v.startsWith('/'), 'path 必须是 JSON Pointer'),
    message: requiredText(2_000)
  }).strict()).max(100),
  estimatedPromptChars: z.number().int().min(0).optional()
}).strict()

export const RestCharacterPreviewResultSchema: z.ZodType<RestCharacterPreviewResult> = z.object({
  ephemeral: z.literal(true),
  reply: z.string(),
  model: requiredText().optional(),
  usage: z.object({
    input: z.number().int().min(0).optional(),
    output: z.number().int().min(0).optional(),
    total: z.number().int().min(0).optional()
  }).strict().optional()
}).strict()

const RestCharacterMoodSchema = z.object({
  label: requiredText(100),
  intensity: z.number().min(0).max(1),
  updatedAt: utcIsoTimestamp()
}).strict()

const RestCharacterPublicStateViewSchema = z.object({
  mood: RestCharacterMoodSchema,
  currentActivity: emptyOrText(200).nullable().optional(),
  lastInteractionAt: utcIsoTimestamp().nullable().optional(),
  proactiveEnabled: z.boolean(),
  updatedAt: utcIsoTimestamp()
}).strict()

export const RestCharacterPublicStateSchema: z.ZodType<RestCharacterPublicState> = z.object({
  characterId: requiredText(),
  characterInstanceId: requiredText(),
  characterRevision: revisionInt(),
  stateVersion: revisionInt(),
  state: RestCharacterPublicStateViewSchema
}).strict()

export const RestResetEvolutionResultSchema: z.ZodType<RestResetEvolutionResult> = z.object({
  state: RestCharacterPublicStateSchema,
  resetFields: resetFields()
}).strict()

// parse 助手（rest-schemas.ts 同款判别返回；FE-B 的 CharacterBackendPort 实现消费）
export function parseRestMe(input: unknown): { success: true; data: RestUserIdentityProfile } | { success: false; error: z.ZodError } {
  return RestUserIdentityProfileSchema.safeParse(input)
}
export function parseRestCharacterList(input: unknown): { success: true; data: RestCharacterListResponse } | { success: false; error: z.ZodError } {
  return RestCharacterListResponseSchema.safeParse(input)
}
export function parseRestCharacterDetail(input: unknown): { success: true; data: RestCharacterDetail } | { success: false; error: z.ZodError } {
  return RestCharacterDetailSchema.safeParse(input)
}
export function parseRestCharacterRevisions(input: unknown): { success: true; data: RestCharacterRevisionsResponse } | { success: false; error: z.ZodError } {
  return RestCharacterRevisionsResponseSchema.safeParse(input)
}
export function parseRestCharacterMutation(input: unknown): { success: true; data: RestCharacterMutationResult } | { success: false; error: z.ZodError } {
  return RestCharacterMutationResultSchema.safeParse(input)
}
export function parseRestCharacterArchive(input: unknown): { success: true; data: RestCharacterArchiveResult } | { success: false; error: z.ZodError } {
  return RestCharacterArchiveResultSchema.safeParse(input)
}
export function parseRestCharacterValidation(input: unknown): { success: true; data: RestCharacterValidationResult } | { success: false; error: z.ZodError } {
  return RestCharacterValidationResultSchema.safeParse(input)
}
export function parseRestCharacterPreview(input: unknown): { success: true; data: RestCharacterPreviewResult } | { success: false; error: z.ZodError } {
  return RestCharacterPreviewResultSchema.safeParse(input)
}
export function parseRestCharacterState(input: unknown): { success: true; data: RestCharacterPublicState } | { success: false; error: z.ZodError } {
  return RestCharacterPublicStateSchema.safeParse(input)
}
export function parseRestResetEvolution(input: unknown): { success: true; data: RestResetEvolutionResult } | { success: false; error: z.ZodError } {
  return RestResetEvolutionResultSchema.safeParse(input)
}
