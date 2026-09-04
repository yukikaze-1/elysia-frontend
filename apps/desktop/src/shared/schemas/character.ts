// —— 多角色 FE-A（character-contract-v1）：角色域领域/IPC schema，严格镜像 contracts/character.ts（设计 §6.4）——
// 纪律：.strict() 未知字段 fail-closed；revision/stateVersion 从 1 开始的正整数（计数器可 0）；
// intensity ∈ [0,1]；aliases/examples/wakeWords/triggers 设数量与单项长度上限；注册表 ID 拒绝绝对路径/URL，
// themeColor 只收 CSS 安全格式（hex / rgb(a)/hsl(a) / 命名色）。数量与长度上限为前端从严暂定值，
// 拿到 BE-C0 handoff bundle 交叉门禁时与后端对拍（同等或更严，§6.2.2）。
import { z } from 'zod'
import type {
  BackendFeatureFlags,
  CharacterBindingSnapshot,
  CharacterDetail,
  CharacterDraft,
  CharacterExample,
  CharacterGenerationRef,
  CharacterId,
  CharacterListQuery,
  CharacterMood,
  CharacterPresentation,
  CharacterPromptProfile,
  CharacterPublicState,
  CharacterRevisionContent,
  CharacterRevisionQuery,
  CharacterRevisionSummary,
  CharacterRuntimeDefaults,
  CharacterStateImpact,
  CharacterSummary,
  CharacterDraftSummary,
  PersistedCharacterDraft,
  CharacterValidationIssue,
  CharacterValidationResult,
  CloneCharacterCommand,
  CharacterArchiveResult,
  CharacterMutationResult,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterInstanceId,
  CreateCharacterCommand,
  ResetCharacterEvolutionCommand,
  ResetCharacterEvolutionResult,
  RollbackCharacterCommand,
  UpdateCharacterCommand,
  UpdateUserIdentityCommand,
  UserIdentityProfile
} from '../contracts/character'

// —— 暂定上限（对拍前不得再放宽；编辑器表单 maxLength 直接复用）——
export const CHARACTER_LIMITS = {
  // 与后端设计 §13.1 的首版限制一致；前端可以更严，但不能放宽。
  displayName: 64,
  description: 500,
  aliasCount: 10,
  aliasLength: 32,
  corePersonality: 12_000,
  relationshipStyle: 6_000,
  emotionStyle: 5_000,
  speakingStyle: 6_000,
  conversationInitiative: 3_000,
  // 保留旧的通用常量供外部表单引用；角色 prompt 已按字段使用上面的专用上限。
  promptField: 12_000,
  exampleCount: 20,
  exampleField: 1_000,
  openingMessage: 1_000,
  wakeWordCount: 20,
  wakeWordLength: 32,
  triggerCount: 20,
  triggerLength: 64,
  idleExpressionCount: 16,
  idleExpressionLength: 64,
  preferredAddress: 200,
  pronouns: 200,
  locale: 100,
  timezone: 100,
  registryId: 200,
  themeColor: 64,
  search: 200,
  queryLimit: 100,
  moodLabel: 100,
  currentActivity: 200,
  validationIssueCount: 100,
  validationCode: 100,
  validationPath: 512,
  validationMessage: 2_000,
  previewMessage: 20_000,
  resetFieldCount: 5
} as const

/** 注册表 ID（avatarAssetId/live2dModelId/characterId 等）：拒绝绝对路径、盘符、URL 与相对路径逃逸（fail-closed） */
export function isSafeRegistryId(v: string): boolean {
  if (v.trim().length === 0 || v.length > CHARACTER_LIMITS.registryId) return false
  if (v.startsWith('/') || v.startsWith('\\')) return false
  // Reject URI schemes (including data:, javascript: and Windows drive paths such
  // as C:/...); registered IDs are opaque names, never URLs or local paths.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) return false
  if (v.includes('..')) return false
  return true
}

/** themeColor 只接受后端已校验的颜色值并限制到 CSS 安全格式：hex(3-8) / rgb(a)/hsl(a) 函数 / CSS 命名色 */
export function isSafeThemeColor(v: string): boolean {
  if (v.length === 0 || v.length > CHARACTER_LIMITS.themeColor) return false
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true
  if (/^(rgba?|hsla?)\(\s*[\d.,%\s]+\s*\)$/.test(v)) return true
  return SAFE_CSS_NAMED_COLORS.has(v.toLowerCase())
}

/**
 * character-contract-v1 的时间值必须是带 UTC 时区的 ISO-8601 timestamp。
 * 只接受 Z / +00:00；不接受本地时间、日期字符串或 Date.parse 可“修正”的非法日期。
 */
export function isUtcIsoTimestamp(v: string): boolean {
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

  // setUTCFullYear avoids Date's special handling of years 0..99. Comparing
  // every component catches impossible calendar dates (e.g. 2026-02-30).
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

// CSS Color 4 named colors, plus transparent. Global CSS keywords
// (inherit/initial/unset/revert/currentColor) are deliberately absent:
// themeColor is a color, not a cascade instruction.
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

const safeRegistryId = () => z.string().refine(isSafeRegistryId, '注册表 ID 不得为路径/URL')
const safeThemeColor = () => z.string().refine(isSafeThemeColor, '颜色仅支持 hex/rgb(a)/hsl(a)/命名色')
export const UtcIsoTimestampSchema: z.ZodType<string> = z.string().refine(isUtcIsoTimestamp, '时间必须是 UTC ISO-8601（Z 或 +00:00）')
const characterId = () => z.string().min(1).refine((v) => v.trim().length > 0, 'ID 不能全为空白')
const characterInstanceId = () => z.string().min(1).refine((v) => v.trim().length > 0, 'ID 不能全为空白')
const positiveCounter = () => z.number().int().min(1)
const requiredText = (max?: number) => {
  const base = max === undefined ? z.string().min(1) : z.string().min(1).max(max)
  return base.refine((v) => v.trim().length > 0, '文本不能全为空白')
}
const emptyOrText = (max: number) => z.string().max(max).refine((v) => v === '' || v.trim().length > 0, '文本不能全为空白')

// 未提交草稿是表单的中间态：用户可能还没有填写必填的人格字段，甚至
// 暂时清空名称。它仍然必须保持 strict 对象、字段类型和长度/资源 ID 边界，
// 但不能复用远端保存用的 requiredText 规则，否则崩溃恢复会丢掉半成品。
const draftStorageText = (max: number) => emptyOrText(max)
const draftStorageRegistryId = () => z.string().max(CHARACTER_LIMITS.registryId).refine(
  (v) => v === '' || isSafeRegistryId(v),
  '注册表 ID 不得为路径/URL'
)
const draftStorageThemeColor = () => z.string().max(CHARACTER_LIMITS.themeColor).refine(
  (v) => v === '' || isSafeThemeColor(v),
  '颜色仅支持 hex/rgb(a)/hsl(a)/命名色'
)

// —— 基础枚举与查询（§5.1）——
export const CharacterSourceSchema = z.enum(['builtin', 'custom'])
export const CharacterStatusSchema = z.enum(['active', 'archived'])
/** 冻结边界：只取 preserve | reset_evolution（缩写 reset 等一律拒绝，§18.1） */
export const CharacterStatePolicySchema = z.enum(['preserve', 'reset_evolution'])
export const CharacterIdSchema: z.ZodType<CharacterId> = characterId()
export const CharacterInstanceIdSchema: z.ZodType<CharacterInstanceId> = characterInstanceId()
export const CharacterRevisionSchema = positiveCounter()
export const CharacterStateVersionSchema = positiveCounter()

export const CharacterListQuerySchema: z.ZodType<CharacterListQuery> = z.object({
  source: CharacterSourceSchema.optional(),
  status: CharacterStatusSchema.optional(),
  search: z.string().max(CHARACTER_LIMITS.search).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(CHARACTER_LIMITS.queryLimit).optional()
}).strict()

export const CharacterRevisionQuerySchema: z.ZodType<CharacterRevisionQuery> = z.object({
  characterId: CharacterIdSchema,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(CHARACTER_LIMITS.queryLimit).optional()
}).strict()

/** 领域分页 Page<T>（raw {items,has_more,cursor?} 已在 Main mapper 归一化；Renderer/持久化不出现 has_more） */
export const CharacterPageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({ items: z.array(itemSchema), hasMore: z.boolean(), nextCursor: z.string().min(1).optional() }).strict()

// —— 能力旗标（§5.2）——
export const BackendFeatureFlagsSchema: z.ZodType<BackendFeatureFlags> = z.object({
  characterProfiles: z.boolean(),
  characterStateStream: z.boolean()
}).strict()

// —— 用户身份（§5.3）——
export const UserIdentityProfileSchema: z.ZodType<UserIdentityProfile> = z.object({
  userId: characterId(),
  displayName: requiredText(CHARACTER_LIMITS.displayName),
  preferredAddress: requiredText(CHARACTER_LIMITS.preferredAddress).optional(),
  pronouns: requiredText(CHARACTER_LIMITS.pronouns).optional(),
  locale: requiredText(CHARACTER_LIMITS.locale),
  timezone: requiredText(CHARACTER_LIMITS.timezone),
  initialized: z.boolean(),
  defaultCharacterId: CharacterIdSchema.optional(),
  revision: CharacterRevisionSchema,
  createdAt: UtcIsoTimestampSchema,
  updatedAt: UtcIsoTimestampSchema
}).strict()

export const UpdateUserIdentityCommandSchema: z.ZodType<UpdateUserIdentityCommand> = z.object({
  expectedRevision: CharacterRevisionSchema,
  displayName: requiredText(CHARACTER_LIMITS.displayName),
  preferredAddress: requiredText(CHARACTER_LIMITS.preferredAddress).optional(),
  pronouns: requiredText(CHARACTER_LIMITS.pronouns).optional(),
  locale: requiredText(CHARACTER_LIMITS.locale),
  timezone: requiredText(CHARACTER_LIMITS.timezone),
  defaultCharacterId: CharacterIdSchema.optional()
}).strict()

// —— 表现与运行默认值（§5.4）——
export const CharacterPresentationSchema: z.ZodType<CharacterPresentation> = z.object({
  avatarAssetId: safeRegistryId().optional(),
  live2dModelId: safeRegistryId().optional(),
  themeColor: safeThemeColor().optional()
}).strict()

export const CharacterRuntimeDefaultsSchema: z.ZodType<CharacterRuntimeDefaults> = z.object({
  voice: z.object({
    providerId: safeRegistryId().optional(),
    voiceId: safeRegistryId().optional()
  }).strict(),
  emotion: z.object({
    idleExpressions: z.array(requiredText(CHARACTER_LIMITS.idleExpressionLength)).max(CHARACTER_LIMITS.idleExpressionCount)
  }).strict(),
  wakeWords: z.array(requiredText(CHARACTER_LIMITS.wakeWordLength)).max(CHARACTER_LIMITS.wakeWordCount),
  proactive: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(0).max(2_592_000),
    triggers: z.array(requiredText(CHARACTER_LIMITS.triggerLength)).max(CHARACTER_LIMITS.triggerCount)
  }).strict()
}).strict()

// —— Prompt 档案与示例（§5.5）——
export const CharacterExampleSchema: z.ZodType<CharacterExample> = z.object({
  user: requiredText(CHARACTER_LIMITS.exampleField),
  assistant: requiredText(CHARACTER_LIMITS.exampleField)
}).strict()

export const CharacterPromptProfileSchema: z.ZodType<CharacterPromptProfile> = z.object({
  corePersonality: requiredText(CHARACTER_LIMITS.corePersonality),
  relationshipStyle: requiredText(CHARACTER_LIMITS.relationshipStyle),
  // 后端允许 emotionStyle / conversationInitiative 为空；缺字段仍不允许。
  emotionStyle: emptyOrText(CHARACTER_LIMITS.emotionStyle),
  speakingStyle: requiredText(CHARACTER_LIMITS.speakingStyle),
  conversationInitiative: emptyOrText(CHARACTER_LIMITS.conversationInitiative),
  examples: z.array(CharacterExampleSchema).max(CHARACTER_LIMITS.exampleCount)
}).strict()

// —— 摘要 / 版本 / 详情（§5.6）——
export const CharacterSummarySchema: z.ZodType<CharacterSummary> = z.object({
  characterId: CharacterIdSchema,
  source: CharacterSourceSchema,
  mutable: z.boolean(),
  status: CharacterStatusSchema,
  currentRevision: CharacterRevisionSchema,
  displayName: requiredText(CHARACTER_LIMITS.displayName),
  description: z.string().max(CHARACTER_LIMITS.description),
  aliases: z.array(requiredText(CHARACTER_LIMITS.aliasLength)).max(CHARACTER_LIMITS.aliasCount),
  presentation: CharacterPresentationSchema,
  updatedAt: UtcIsoTimestampSchema
}).strict()

export const CharacterRevisionContentSchema: z.ZodType<CharacterRevisionContent> = z.object({
  characterId: CharacterIdSchema,
  revision: CharacterRevisionSchema,
  schemaVersion: CharacterRevisionSchema,
  displayName: requiredText(CHARACTER_LIMITS.displayName),
  description: z.string().max(CHARACTER_LIMITS.description),
  aliases: z.array(requiredText(CHARACTER_LIMITS.aliasLength)).max(CHARACTER_LIMITS.aliasCount),
  promptProfile: CharacterPromptProfileSchema,
  runtimeDefaults: CharacterRuntimeDefaultsSchema,
  presentation: CharacterPresentationSchema,
  openingMessage: emptyOrText(CHARACTER_LIMITS.openingMessage).optional(),
  checksum: requiredText(),
  compilerVersion: CharacterRevisionSchema,
  createdBy: z.enum(['system', 'user', 'migration']),
  createdAt: UtcIsoTimestampSchema
}).strict()

export const CharacterDetailSchema: z.ZodType<CharacterDetail> = z.object({
  summary: CharacterSummarySchema,
  current: CharacterRevisionContentSchema
}).strict()

export const CharacterRevisionSummarySchema: z.ZodType<CharacterRevisionSummary> = z.object({
  revision: CharacterRevisionSchema,
  checksum: requiredText(),
  createdBy: z.enum(['system', 'user', 'migration']),
  createdAt: UtcIsoTimestampSchema
}).strict()

// —— 草稿与命令（§5.7）——
export const CharacterDraftSchema: z.ZodType<CharacterDraft> = z.object({
  displayName: requiredText(CHARACTER_LIMITS.displayName),
  description: z.string().max(CHARACTER_LIMITS.description),
  aliases: z.array(requiredText(CHARACTER_LIMITS.aliasLength)).max(CHARACTER_LIMITS.aliasCount),
  promptProfile: CharacterPromptProfileSchema,
  runtimeDefaults: CharacterRuntimeDefaultsSchema,
  presentation: CharacterPresentationSchema,
  openingMessage: emptyOrText(CHARACTER_LIMITS.openingMessage).optional()
}).strict()

/**
 * Main app-cache 中的本地草稿 schema。
 *
 * 与 CharacterDraftSchema 的区别仅在“正在编辑”的文本允许为空；远端
 * create/update/validate/preview 仍必须使用 CharacterDraftSchema。这样既
 * 能 fail-closed 地拒绝未知字段、危险资源引用和越界 payload，又不会因为
 * 用户在长表单中途崩溃而丢失尚未完成的必填字段。
 */
export const CharacterDraftStorageSchema: z.ZodType<CharacterDraft> = z.object({
  displayName: draftStorageText(CHARACTER_LIMITS.displayName),
  description: z.string().max(CHARACTER_LIMITS.description),
  aliases: z.array(draftStorageText(CHARACTER_LIMITS.aliasLength)).max(CHARACTER_LIMITS.aliasCount),
  promptProfile: z.object({
    corePersonality: draftStorageText(CHARACTER_LIMITS.corePersonality),
    relationshipStyle: draftStorageText(CHARACTER_LIMITS.relationshipStyle),
    emotionStyle: draftStorageText(CHARACTER_LIMITS.emotionStyle),
    speakingStyle: draftStorageText(CHARACTER_LIMITS.speakingStyle),
    conversationInitiative: draftStorageText(CHARACTER_LIMITS.conversationInitiative),
    examples: z.array(z.object({
      user: draftStorageText(CHARACTER_LIMITS.exampleField),
      assistant: draftStorageText(CHARACTER_LIMITS.exampleField)
    }).strict()).max(CHARACTER_LIMITS.exampleCount)
  }).strict(),
  runtimeDefaults: z.object({
    voice: z.object({
      providerId: draftStorageRegistryId().optional(),
      voiceId: draftStorageRegistryId().optional()
    }).strict(),
    emotion: z.object({
      idleExpressions: z.array(draftStorageText(CHARACTER_LIMITS.idleExpressionLength)).max(CHARACTER_LIMITS.idleExpressionCount)
    }).strict(),
    wakeWords: z.array(draftStorageText(CHARACTER_LIMITS.wakeWordLength)).max(CHARACTER_LIMITS.wakeWordCount),
    proactive: z.object({
      enabled: z.boolean(),
      intervalSeconds: z.number().int().min(0).max(2_592_000),
      triggers: z.array(draftStorageText(CHARACTER_LIMITS.triggerLength)).max(CHARACTER_LIMITS.triggerCount)
    }).strict()
  }).strict(),
  presentation: z.object({
    avatarAssetId: draftStorageRegistryId().optional(),
    live2dModelId: draftStorageRegistryId().optional(),
    themeColor: draftStorageThemeColor().optional()
  }).strict(),
  openingMessage: draftStorageText(CHARACTER_LIMITS.openingMessage).optional()
}).strict()

export const CreateCharacterCommandSchema: z.ZodType<CreateCharacterCommand> = z.object({
  draft: CharacterDraftSchema
}).strict()

export const UpdateCharacterCommandSchema: z.ZodType<UpdateCharacterCommand> = z.object({
  characterId: CharacterIdSchema,
  expectedRevision: CharacterRevisionSchema,
  statePolicy: CharacterStatePolicySchema,
  draft: CharacterDraftSchema
}).strict()

export const CloneCharacterCommandSchema: z.ZodType<CloneCharacterCommand> = z.object({
  characterId: CharacterIdSchema,
  displayName: requiredText(CHARACTER_LIMITS.displayName).optional()
}).strict()

export const RollbackCharacterCommandSchema: z.ZodType<RollbackCharacterCommand> = z.object({
  characterId: CharacterIdSchema,
  targetRevision: CharacterRevisionSchema,
  expectedRevision: CharacterRevisionSchema,
  statePolicy: CharacterStatePolicySchema
}).strict()

export const ResetFieldSchema = z.enum(['self_l2', 'state_l3', 'speaking_style_c6', 'reflector', 'mood'])

export const CharacterStateImpactSchema: z.ZodType<CharacterStateImpact> = z.object({
  statePolicy: CharacterStatePolicySchema,
  affectedInstances: z.number().int().min(0),
  pendingInstances: z.number().int().min(0),
  resetFields: z.array(ResetFieldSchema).max(CHARACTER_LIMITS.resetFieldCount)
}).strict().refine(
  (value) => value.pendingInstances <= value.affectedInstances,
  { path: ['pendingInstances'], message: 'pendingInstances 不能超过 affectedInstances' }
).refine(
  (value) => value.statePolicy !== 'preserve' || value.resetFields.length === 0,
  { path: ['resetFields'], message: 'statePolicy=preserve 时 resetFields 必须为空' }
)

export const CharacterMutationResultSchema: z.ZodType<CharacterMutationResult> = z.object({
  character: CharacterDetailSchema,
  stateImpact: CharacterStateImpactSchema
}).strict()

export const CharacterArchiveResultSchema: z.ZodType<CharacterArchiveResult> = z.object({
  character: CharacterSummarySchema,
  userProfile: UserIdentityProfileSchema.optional()
}).strict()

// —— 校验与预览（§5.8）——
export const CharacterValidationIssueSchema: z.ZodType<CharacterValidationIssue> = z.object({
  severity: z.enum(['error', 'warning']),
  code: requiredText(CHARACTER_LIMITS.validationCode),
  path: requiredText(CHARACTER_LIMITS.validationPath).refine((v) => v.startsWith('/'), 'path 必须是 JSON Pointer'),   // JSON Pointer
  message: requiredText(CHARACTER_LIMITS.validationMessage)
}).strict()

export const CharacterValidationResultSchema: z.ZodType<CharacterValidationResult> = z.object({
  valid: z.boolean(),
  issues: z.array(CharacterValidationIssueSchema).max(CHARACTER_LIMITS.validationIssueCount),
  estimatedPromptChars: z.number().int().min(0).optional()
}).strict()

export const CharacterPreviewCommandSchema: z.ZodType<CharacterPreviewCommand> = z.object({
  draft: CharacterDraftSchema,
  userMessage: requiredText(CHARACTER_LIMITS.previewMessage)
}).strict()

export const CharacterPreviewResultSchema: z.ZodType<CharacterPreviewResult> = z.object({
  ephemeral: z.literal(true),
  reply: z.string(),
  model: requiredText().optional(),
  usage: z.object({
    input: z.number().int().min(0).optional(),
    output: z.number().int().min(0).optional(),
    total: z.number().int().min(0).optional()
  }).strict().optional()
}).strict()

// —— §12.3 未提交角色草稿持久化（完整记录只经 get 返回；list 只用摘要 schema）——
export const CharacterEditorModeSchema = z.enum(['create', 'edit', 'clone'])
export const CharacterDraftKeySchema = z.string().min(1).max(256).refine((value) => value.trim().length > 0 && !value.includes('\u0000'), '草稿 key 非法')
const CharacterDraftSummaryShape = {
  key: CharacterDraftKeySchema,
  mode: CharacterEditorModeSchema,
  characterId: CharacterIdSchema.optional(),
  baseRevision: CharacterRevisionSchema.optional(),
  // A summary may represent an in-progress form whose name is still empty;
  // callers render a neutral placeholder rather than treating it as a role.
  displayName: draftStorageText(CHARACTER_LIMITS.displayName),
  updatedAt: UtcIsoTimestampSchema
} as const
export const CharacterDraftSummarySchema: z.ZodType<CharacterDraftSummary> = z.object(CharacterDraftSummaryShape).strict()
export const PersistedCharacterDraftSchema: z.ZodType<PersistedCharacterDraft> = z.object({
  ...CharacterDraftSummaryShape,
  draft: CharacterDraftStorageSchema,
  // statePolicy is persisted only in the full record. Older local records may
  // omit it and are interpreted as preserve by the editor.
  statePolicy: CharacterStatePolicySchema.optional()
}).strict().superRefine((value, context) => {
  // A persisted record is not allowed to silently change editor semantics while
  // crossing the Main/Renderer boundary. The mode determines whether a source
  // character/revision baseline is meaningful.
  if (value.mode === 'create') {
    if (value.characterId !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['characterId'], message: 'create 草稿不得包含 characterId' })
    if (value.baseRevision !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['baseRevision'], message: 'create 草稿不得包含 baseRevision' })
  } else {
    if (value.characterId === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['characterId'], message: `${value.mode} 草稿必须包含 characterId` })
    if (value.baseRevision === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['baseRevision'], message: `${value.mode} 草稿必须包含 baseRevision` })
  }
  if (value.displayName !== value.draft.displayName) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['displayName'], message: '草稿摘要名称必须与 draft.displayName 一致' })
  }
})

// —— 绑定快照 / generation ref（§5.9/§5.10）——
export const CharacterBindingSnapshotSchema: z.ZodType<CharacterBindingSnapshot> = z.object({
  characterId: CharacterIdSchema,
  characterInstanceId: CharacterInstanceIdSchema,
  characterRevision: CharacterRevisionSchema,
  displayName: requiredText(CHARACTER_LIMITS.displayName),
  presentation: CharacterPresentationSchema
}).strict()

export const CharacterGenerationRefSchema: z.ZodType<CharacterGenerationRef> = z.object({
  characterId: CharacterIdSchema,
  characterInstanceId: CharacterInstanceIdSchema,
  characterRevision: CharacterRevisionSchema,
  displayName: requiredText(CHARACTER_LIMITS.displayName).optional(),
  presentation: CharacterPresentationSchema.optional()
}).strict()

// —— 公开状态（§5.11）——
export const CharacterMoodSchema: z.ZodType<CharacterMood> = z.object({
  label: requiredText(CHARACTER_LIMITS.moodLabel),
  intensity: z.number().min(0).max(1),
  updatedAt: UtcIsoTimestampSchema
}).strict()

// 子 schema 不注 z.ZodType（保留 .extend() 具体类型，ipc-response.ts 同款纪律）；仅在派生处注
export const CharacterPublicStateViewSchema = z.object({
  mood: CharacterMoodSchema.optional(),
  currentActivity: z.string().max(CHARACTER_LIMITS.currentActivity).optional(),
  lastInteractionAt: UtcIsoTimestampSchema.optional(),
  proactiveEnabled: z.boolean(),
  updatedAt: UtcIsoTimestampSchema
}).strict()

export const CharacterPublicStateSchema: z.ZodType<CharacterPublicState> = CharacterPublicStateViewSchema.extend({
  characterId: CharacterIdSchema,
  characterInstanceId: CharacterInstanceIdSchema,
  characterRevision: CharacterRevisionSchema,
  stateVersion: CharacterStateVersionSchema
}).strict()

export const ResetCharacterEvolutionCommandSchema: z.ZodType<ResetCharacterEvolutionCommand> = z.object({
  characterInstanceId: CharacterInstanceIdSchema,
  expectedStateVersion: CharacterStateVersionSchema
}).strict()

export const ResetCharacterEvolutionResultSchema: z.ZodType<ResetCharacterEvolutionResult> = z.object({
  state: CharacterPublicStateSchema,
  resetFields: z.array(ResetFieldSchema).max(CHARACTER_LIMITS.resetFieldCount)
}).strict()
