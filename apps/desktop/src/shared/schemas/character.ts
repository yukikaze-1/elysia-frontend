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
  CharacterValidationIssue,
  CharacterValidationResult,
  CloneCharacterCommand,
  CreateCharacterCommand,
  ResetCharacterEvolutionCommand,
  RollbackCharacterCommand,
  UpdateCharacterCommand,
  UpdateUserIdentityCommand,
  UserIdentityProfile
} from '../contracts/character'

// —— 暂定上限（对拍前不得再放宽；编辑器表单 maxLength 直接复用）——
export const CHARACTER_LIMITS = {
  displayName: 100,
  description: 2000,
  aliasCount: 32,
  aliasLength: 64,
  exampleCount: 50,
  exampleField: 8000,
  promptField: 20000,
  openingMessage: 2000,
  wakeWordCount: 16,
  wakeWordLength: 32,
  triggerCount: 16,
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
  currentActivity: 200
} as const

/** 注册表 ID（avatarAssetId/live2dModelId/characterId 等）：拒绝绝对路径、盘符、URL 与相对路径逃逸（fail-closed） */
export function isSafeRegistryId(v: string): boolean {
  if (v.length === 0 || v.length > CHARACTER_LIMITS.registryId) return false
  if (v.startsWith('/') || v.startsWith('\\')) return false
  if (v.includes('://') || v.includes(':\\')) return false
  if (v.includes('..')) return false
  return true
}

/** themeColor 只接受后端已校验的颜色值并限制到 CSS 安全格式：hex(3-8) / rgb(a)/hsl(a) 函数 / CSS 命名色 */
export function isSafeThemeColor(v: string): boolean {
  if (v.length === 0 || v.length > CHARACTER_LIMITS.themeColor) return false
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true
  if (/^(rgba?|hsla?)\(\s*[\d.,%\s]+\s*\)$/.test(v)) return true
  return /^[a-z]+$/i.test(v)
}

const safeRegistryId = () => z.string().refine(isSafeRegistryId, '注册表 ID 不得为路径/URL')
const safeThemeColor = () => z.string().refine(isSafeThemeColor, '颜色仅支持 hex/rgb(a)/hsl(a)/命名色')

// —— 基础枚举与查询（§5.1）——
export const CharacterSourceSchema = z.enum(['builtin', 'custom'])
export const CharacterStatusSchema = z.enum(['active', 'archived'])
/** 冻结边界：只取 preserve | reset_evolution（缩写 reset 等一律拒绝，§18.1） */
export const CharacterStatePolicySchema = z.enum(['preserve', 'reset_evolution'])

export const CharacterListQuerySchema: z.ZodType<CharacterListQuery> = z.object({
  source: CharacterSourceSchema.optional(),
  status: CharacterStatusSchema.optional(),
  search: z.string().max(CHARACTER_LIMITS.search).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(CHARACTER_LIMITS.queryLimit).optional()
}).strict()

export const CharacterRevisionQuerySchema: z.ZodType<CharacterRevisionQuery> = z.object({
  characterId: z.string().min(1),
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
})

// —— 用户身份（§5.3）——
export const UserIdentityProfileSchema: z.ZodType<UserIdentityProfile> = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1).max(CHARACTER_LIMITS.displayName),
  preferredAddress: z.string().max(CHARACTER_LIMITS.preferredAddress).optional(),
  pronouns: z.string().max(CHARACTER_LIMITS.pronouns).optional(),
  locale: z.string().min(1).max(CHARACTER_LIMITS.locale),
  timezone: z.string().min(1).max(CHARACTER_LIMITS.timezone),
  initialized: z.boolean(),
  defaultCharacterId: z.string().min(1).optional(),
  revision: z.number().int().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
})

export const UpdateUserIdentityCommandSchema: z.ZodType<UpdateUserIdentityCommand> = z.object({
  expectedRevision: z.number().int().min(1),
  displayName: z.string().min(1).max(CHARACTER_LIMITS.displayName),
  preferredAddress: z.string().max(CHARACTER_LIMITS.preferredAddress).optional(),
  pronouns: z.string().max(CHARACTER_LIMITS.pronouns).optional(),
  locale: z.string().min(1).max(CHARACTER_LIMITS.locale),
  timezone: z.string().min(1).max(CHARACTER_LIMITS.timezone),
  defaultCharacterId: z.string().min(1).optional()
}).strict()

// —— 表现与运行默认值（§5.4）——
export const CharacterPresentationSchema: z.ZodType<CharacterPresentation> = z.object({
  avatarAssetId: safeRegistryId().optional(),
  live2dModelId: safeRegistryId().optional(),
  themeColor: safeThemeColor().optional()
}).strict()

export const CharacterRuntimeDefaultsSchema: z.ZodType<CharacterRuntimeDefaults> = z.object({
  voice: z.object({
    providerId: z.string().min(1).max(CHARACTER_LIMITS.registryId).optional(),
    voiceId: z.string().min(1).max(CHARACTER_LIMITS.registryId).optional()
  }).strict(),
  emotion: z.object({
    idleExpressions: z.array(z.string().min(1).max(CHARACTER_LIMITS.idleExpressionLength)).max(CHARACTER_LIMITS.idleExpressionCount)
  }).strict(),
  wakeWords: z.array(z.string().min(1).max(CHARACTER_LIMITS.wakeWordLength)).max(CHARACTER_LIMITS.wakeWordCount),
  proactive: z.object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int().min(0).max(2_592_000),
    triggers: z.array(z.string().min(1).max(CHARACTER_LIMITS.triggerLength)).max(CHARACTER_LIMITS.triggerCount)
  }).strict()
}).strict()

// —— Prompt 档案与示例（§5.5）——
export const CharacterExampleSchema: z.ZodType<CharacterExample> = z.object({
  user: z.string().min(1).max(CHARACTER_LIMITS.exampleField),
  assistant: z.string().min(1).max(CHARACTER_LIMITS.exampleField)
}).strict()

export const CharacterPromptProfileSchema: z.ZodType<CharacterPromptProfile> = z.object({
  corePersonality: z.string().min(1).max(CHARACTER_LIMITS.promptField),
  relationshipStyle: z.string().min(1).max(CHARACTER_LIMITS.promptField),
  emotionStyle: z.string().min(1).max(CHARACTER_LIMITS.promptField),
  speakingStyle: z.string().min(1).max(CHARACTER_LIMITS.promptField),
  conversationInitiative: z.string().min(1).max(CHARACTER_LIMITS.promptField),
  examples: z.array(CharacterExampleSchema).max(CHARACTER_LIMITS.exampleCount)
}).strict()

// —— 摘要 / 版本 / 详情（§5.6）——
export const CharacterSummarySchema: z.ZodType<CharacterSummary> = z.object({
  characterId: z.string().min(1),
  source: CharacterSourceSchema,
  mutable: z.boolean(),
  status: CharacterStatusSchema,
  currentRevision: z.number().int().min(1),
  displayName: z.string().min(1).max(CHARACTER_LIMITS.displayName),
  description: z.string().max(CHARACTER_LIMITS.description),
  aliases: z.array(z.string().min(1).max(CHARACTER_LIMITS.aliasLength)).max(CHARACTER_LIMITS.aliasCount),
  presentation: CharacterPresentationSchema,
  updatedAt: z.string().min(1)
}).strict()

export const CharacterRevisionContentSchema: z.ZodType<CharacterRevisionContent> = z.object({
  characterId: z.string().min(1),
  revision: z.number().int().min(1),
  schemaVersion: z.number().int().min(1),
  displayName: z.string().min(1).max(CHARACTER_LIMITS.displayName),
  description: z.string().max(CHARACTER_LIMITS.description),
  aliases: z.array(z.string().min(1).max(CHARACTER_LIMITS.aliasLength)).max(CHARACTER_LIMITS.aliasCount),
  promptProfile: CharacterPromptProfileSchema,
  runtimeDefaults: CharacterRuntimeDefaultsSchema,
  presentation: CharacterPresentationSchema,
  openingMessage: z.string().max(CHARACTER_LIMITS.openingMessage).optional(),
  checksum: z.string().min(1),
  compilerVersion: z.number().int().min(1),
  createdBy: z.enum(['system', 'user', 'migration']),
  createdAt: z.string().min(1)
}).strict()

export const CharacterDetailSchema: z.ZodType<CharacterDetail> = z.object({
  summary: CharacterSummarySchema,
  current: CharacterRevisionContentSchema
}).strict()

export const CharacterRevisionSummarySchema: z.ZodType<CharacterRevisionSummary> = z.object({
  revision: z.number().int().min(1),
  checksum: z.string().min(1),
  createdBy: z.enum(['system', 'user', 'migration']),
  createdAt: z.string().min(1)
}).strict()

// —— 草稿与命令（§5.7）——
export const CharacterDraftSchema: z.ZodType<CharacterDraft> = z.object({
  displayName: z.string().min(1).max(CHARACTER_LIMITS.displayName),
  description: z.string().max(CHARACTER_LIMITS.description),
  aliases: z.array(z.string().min(1).max(CHARACTER_LIMITS.aliasLength)).max(CHARACTER_LIMITS.aliasCount),
  promptProfile: CharacterPromptProfileSchema,
  runtimeDefaults: CharacterRuntimeDefaultsSchema,
  presentation: CharacterPresentationSchema,
  openingMessage: z.string().max(CHARACTER_LIMITS.openingMessage).optional()
}).strict()

export const CreateCharacterCommandSchema: z.ZodType<CreateCharacterCommand> = z.object({
  draft: CharacterDraftSchema
}).strict()

export const UpdateCharacterCommandSchema: z.ZodType<UpdateCharacterCommand> = z.object({
  characterId: z.string().min(1),
  expectedRevision: z.number().int().min(1),
  statePolicy: CharacterStatePolicySchema,
  draft: CharacterDraftSchema
}).strict()

export const CloneCharacterCommandSchema: z.ZodType<CloneCharacterCommand> = z.object({
  characterId: z.string().min(1),
  displayName: z.string().min(1).max(CHARACTER_LIMITS.displayName).optional()
}).strict()

export const RollbackCharacterCommandSchema: z.ZodType<RollbackCharacterCommand> = z.object({
  characterId: z.string().min(1),
  targetRevision: z.number().int().min(1),
  expectedRevision: z.number().int().min(1),
  statePolicy: CharacterStatePolicySchema
}).strict()

export const ResetFieldSchema = z.enum(['self_l2', 'state_l3', 'speaking_style_c6', 'reflector', 'mood'])

export const CharacterStateImpactSchema: z.ZodType<CharacterStateImpact> = z.object({
  statePolicy: CharacterStatePolicySchema,
  affectedInstances: z.number().int().min(0),
  pendingInstances: z.number().int().min(0),
  resetFields: z.array(ResetFieldSchema)
}).strict()

// —— 校验与预览（§5.8）——
export const CharacterValidationIssueSchema: z.ZodType<CharacterValidationIssue> = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string().min(1),
  path: z.string().min(1).startsWith('/'),   // JSON Pointer
  message: z.string().min(1)
}).strict()

export const CharacterValidationResultSchema: z.ZodType<CharacterValidationResult> = z.object({
  valid: z.boolean(),
  issues: z.array(CharacterValidationIssueSchema),
  estimatedPromptChars: z.number().int().min(0).optional()
}).strict()

// —— 绑定快照 / generation ref（§5.9/§5.10）——
export const CharacterBindingSnapshotSchema: z.ZodType<CharacterBindingSnapshot> = z.object({
  characterId: z.string().min(1),
  characterInstanceId: z.string().min(1),
  characterRevision: z.number().int().min(1),
  displayName: z.string().min(1).max(CHARACTER_LIMITS.displayName),
  presentation: CharacterPresentationSchema
}).strict()

export const CharacterGenerationRefSchema: z.ZodType<CharacterGenerationRef> = z.object({
  characterId: z.string().min(1),
  characterInstanceId: z.string().min(1),
  characterRevision: z.number().int().min(1),
  displayName: z.string().min(1).max(CHARACTER_LIMITS.displayName).optional(),
  presentation: CharacterPresentationSchema.optional()
}).strict()

// —— 公开状态（§5.11）——
export const CharacterMoodSchema: z.ZodType<CharacterMood> = z.object({
  label: z.string().min(1).max(CHARACTER_LIMITS.moodLabel),
  intensity: z.number().min(0).max(1),
  updatedAt: z.string().min(1)
}).strict()

// 子 schema 不注 z.ZodType（保留 .extend() 具体类型，ipc-response.ts 同款纪律）；仅在派生处注
export const CharacterPublicStateViewSchema = z.object({
  mood: CharacterMoodSchema.optional(),
  currentActivity: z.string().max(CHARACTER_LIMITS.currentActivity).optional(),
  lastInteractionAt: z.string().min(1).optional(),
  proactiveEnabled: z.boolean(),
  updatedAt: z.string().min(1)
}).strict()

export const CharacterPublicStateSchema: z.ZodType<CharacterPublicState> = CharacterPublicStateViewSchema.extend({
  characterId: z.string().min(1),
  characterInstanceId: z.string().min(1),
  characterRevision: z.number().int().min(1),
  stateVersion: z.number().int().min(1)
}).strict()

export const ResetCharacterEvolutionCommandSchema: z.ZodType<ResetCharacterEvolutionCommand> = z.object({
  characterInstanceId: z.string().min(1),
  expectedStateVersion: z.number().int().min(1)
}).strict()
