// —— 多角色 FE-A（character-contract-v1）：角色域 raw REST wire schema（设计 §6.2/§6.4）——
// 全部 .strict()（未知字段 fail-closed）；与 character-rest-types.ts 一一对应。
// 注意：本文件被 check:contract 以 Node ESM 直接加载（DesktopCallStatusSchema 同款约束），
// 运行时值导入只允许 zod/node 内建 → isSafeRegistryId/isSafeThemeColor 在此自包含一份镜像副本，
// 与 shared/schemas/character.ts 同形（两处修改需同步）。
import { z } from 'zod'
import type {
  RestCharacterArchiveResult,
  RestCharacterDetail,
  RestCharacterListResponse,
  RestCharacterMutationResult,
  RestCharacterPublicState,
  RestCharacterRevisionsResponse,
  RestCharacterRevisionContent,
  RestCharacterRevisionSummary,
  RestCharacterSummary,
  RestCharacterValidationResult,
  RestCharacterPreviewResult,
  RestResetEvolutionResult,
  RestUserIdentityProfile
} from './character-rest-types'

// —— 镜像副本起点（与 shared/schemas/character.ts 同形，两处修改需同步）——
/** 注册表 ID：拒绝绝对路径、盘符、URL 与相对路径逃逸 */
function isSafeRegistryId(v: string): boolean {
  if (v.length === 0 || v.length > 200) return false
  if (v.startsWith('/') || v.startsWith('\\')) return false
  if (v.includes('://') || v.includes(':\\')) return false
  if (v.includes('..')) return false
  return true
}
/** CSS 安全颜色：hex(3-8) / rgb(a)/hsl(a) / 命名色 */
function isSafeThemeColor(v: string): boolean {
  if (v.length === 0 || v.length > 64) return false
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true
  if (/^(rgba?|hsla?)\(\s*[\d.,%\s]+\s*\)$/.test(v)) return true
  return /^[a-z]+$/i.test(v)
}
// —— 镜像副本终点 ——

const revisionInt = () => z.number().int().min(1)
const registryId = () => z.string().refine(isSafeRegistryId, '注册表 ID 不得为路径/URL')
const themeColor = () => z.string().refine(isSafeThemeColor, '颜色仅支持 hex/rgb(a)/hsl(a)/命名色')

export const RestCharacterPresentationSchema = z.object({
  avatarAssetId: registryId().nullable().optional(),
  live2dModelId: registryId().nullable().optional(),
  themeColor: themeColor().nullable().optional()
}).strict()

/** 绑定快照（session summary/message 内嵌；characterRevision 冻结——无顶层 revision） */
export const RestCharacterBindingSnapshotSchema = z.object({
  characterId: z.string().min(1),
  characterInstanceId: z.string().min(1),
  characterRevision: revisionInt(),
  displayName: z.string().min(1),
  presentation: RestCharacterPresentationSchema
}).strict()

export const RestUserIdentityProfileSchema: z.ZodType<RestUserIdentityProfile> = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
  preferredAddress: z.string().nullable().optional(),
  pronouns: z.string().nullable().optional(),
  locale: z.string().min(1),
  timezone: z.string().min(1),
  initialized: z.boolean(),
  defaultCharacterId: z.string().min(1).nullable().optional(),
  revision: revisionInt(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict()

const RestCharacterSummarySchema: z.ZodType<RestCharacterSummary> = z.object({
  characterId: z.string().min(1),
  source: z.enum(['builtin', 'custom']),
  mutable: z.boolean(),
  status: z.enum(['active', 'archived']),
  currentRevision: revisionInt(),
  displayName: z.string().min(1),
  description: z.string(),
  aliases: z.array(z.string().min(1)),
  presentation: RestCharacterPresentationSchema,
  updatedAt: z.string().min(1)
}).strict()

const RestCharacterRevisionContentSchema: z.ZodType<RestCharacterRevisionContent> = z.object({
  characterId: z.string().min(1),
  revision: revisionInt(),
  schemaVersion: revisionInt(),
  displayName: z.string().min(1),
  description: z.string(),
  aliases: z.array(z.string().min(1)),
  promptProfile: z.object({
    corePersonality: z.string().min(1),
    relationshipStyle: z.string().min(1),
    emotionStyle: z.string().min(1),
    speakingStyle: z.string().min(1),
    conversationInitiative: z.string().min(1),
    examples: z.array(z.object({ user: z.string().min(1), assistant: z.string().min(1) }).strict())
  }).strict(),
  runtimeDefaults: z.object({
    voice: z.object({
      providerId: z.string().min(1).nullable().optional(),
      voiceId: z.string().min(1).nullable().optional()
    }).strict(),
    emotion: z.object({ idleExpressions: z.array(z.string().min(1)) }).strict(),
    wakeWords: z.array(z.string().min(1)),
    proactive: z.object({
      enabled: z.boolean(),
      intervalSeconds: z.number().int().min(0),
      triggers: z.array(z.string().min(1))
    }).strict()
  }).strict(),
  presentation: RestCharacterPresentationSchema,
  openingMessage: z.string().nullable().optional(),
  checksum: z.string().min(1),
  compilerVersion: revisionInt(),
  createdBy: z.enum(['system', 'user', 'migration']),
  createdAt: z.string().min(1)
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
  checksum: z.string().min(1),
  createdBy: z.enum(['system', 'user', 'migration']),
  createdAt: z.string().min(1)
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
  resetFields: z.array(z.enum(['self_l2', 'state_l3', 'speaking_style_c6', 'reflector', 'mood']))
}).strict()

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
    code: z.string().min(1),
    path: z.string().min(1).startsWith('/'),
    message: z.string().min(1)
  }).strict()),
  estimatedPromptChars: z.number().int().min(0).optional()
}).strict()

export const RestCharacterPreviewResultSchema: z.ZodType<RestCharacterPreviewResult> = z.object({
  ephemeral: z.literal(true),
  reply: z.string(),
  model: z.string().optional(),
  usage: z.object({
    input: z.number().int().min(0).optional(),
    output: z.number().int().min(0).optional(),
    total: z.number().int().min(0).optional()
  }).strict().optional()
}).strict()

const RestCharacterMoodSchema = z.object({
  label: z.string().min(1),
  intensity: z.number().min(0).max(1),
  updatedAt: z.string().min(1)
}).strict()

export const RestCharacterPublicStateSchema: z.ZodType<RestCharacterPublicState> = z.object({
  characterId: z.string().min(1),
  characterInstanceId: z.string().min(1),
  characterRevision: revisionInt(),
  stateVersion: revisionInt(),
  mood: RestCharacterMoodSchema.nullable().optional(),
  currentActivity: z.string().nullable().optional(),
  lastInteractionAt: z.string().min(1).nullable().optional(),
  proactiveEnabled: z.boolean(),
  updatedAt: z.string().min(1)
}).strict()

export const RestResetEvolutionResultSchema: z.ZodType<RestResetEvolutionResult> = z.object({
  state: RestCharacterPublicStateSchema,
  resetFields: z.array(z.enum(['self_l2', 'state_l3', 'speaking_style_c6', 'reflector', 'mood']))
}).strict()

export const RestCharacterProtocolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  requestId: z.string().min(1),
  error: z.string(),
  details: z.record(z.string(), z.unknown()),
  retryAfterMs: z.number().int().min(0).optional()
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
