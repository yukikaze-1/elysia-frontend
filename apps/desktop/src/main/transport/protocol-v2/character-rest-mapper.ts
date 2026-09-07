// —— 多角色 FE-A（character-contract-v1）：角色域 raw REST → 领域映射（设计 §5/§6.2）——
// 归一化规则：后端 null 在领域层统一归 undefined（§5.4 冻结约定，表单草稿再以空串显示）；
// raw 分页 {items,has_more,cursor?} → Page<T>{items,hasMore,nextCursor?}；characterRevision 原样透传。
// 本文件不发起网络请求；FE-B 的 CharacterBackendPort 实现负责调用与错误归一。
import type { Page } from '@shared/contracts/conversation'
import type {
  BackendFeatureFlags,
  CharacterArchiveResult,
  CharacterBindingSnapshot,
  CharacterDetail,
  CharacterDraft,
  CharacterGenerationRef,
  CharacterListQuery,
  CharacterMutationResult,
  CharacterPresentation,
  CharacterPublicState,
  CharacterRevisionContent,
  CharacterRevisionQuery,
  CharacterRevisionSummary,
  CharacterSummary,
  CharacterValidationResult,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterStateImpact,
  CloneCharacterCommand,
  CreateCharacterCommand,
  ResetCharacterEvolutionResult,
  ResetCharacterEvolutionCommand,
  RollbackCharacterCommand,
  UpdateCharacterCommand,
  UpdateUserIdentityCommand,
  UserIdentityProfile
} from '@shared/contracts/character'
import type { CreateConversationInput } from '@shared/contracts/conversation'
import type {
  RestCharacterArchiveResult,
  RestCharacterBindingSnapshot,
  RestCharacterDraft,
  RestCharacterDetail,
  RestCharacterListQuery,
  RestCharacterListResponse,
  RestCharacterMutationResult,
  RestCharacterPresentation,
  RestCharacterPublicState,
  RestCharacterRevisionQuery,
  RestCharacterRevisionsResponse,
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
import type { RestCreateSessionBody } from './rest-types'

/** wire character_profiles/character_state_stream === true 才映射 true；缺省/字符串/数字/其他形状一律 false（§5.2） */
export function parseBackendFeatureFlags(features: Record<string, unknown> | undefined): BackendFeatureFlags {
  return {
    characterProfiles: features?.character_profiles === true,
    characterStateStream: features?.character_state_stream === true
  }
}

/** POST /api/sessions 请求体：领域的可选 characterId 原样保留，legacy 仍可省略。 */
export function toRestCreateSessionBody(input: CreateConversationInput): RestCreateSessionBody {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.characterId !== undefined ? { characterId: input.characterId } : {})
  }
}

/** PUT /api/me 请求体：领域命令的可选字段省略即按后端约定清空/回默认，不把 undefined 序列化成 null。 */
export function toRestUpdateMeBody(input: UpdateUserIdentityCommand): RestUpdateMeBody {
  return {
    expectedRevision: input.expectedRevision,
    displayName: input.displayName,
    ...(input.preferredAddress !== undefined ? { preferredAddress: input.preferredAddress } : {}),
    ...(input.pronouns !== undefined ? { pronouns: input.pronouns } : {}),
    locale: input.locale,
    timezone: input.timezone,
    ...(input.defaultCharacterId !== undefined ? { defaultCharacterId: input.defaultCharacterId } : {})
  }
}

/** Presentation domain → REST raw；只在 adapter 边界做显式字段复制。 */
export function toRestPresentation(input: CharacterPresentation): RestCharacterPresentation {
  return {
    ...(input.avatarAssetId !== undefined ? { avatarAssetId: input.avatarAssetId } : {}),
    ...(input.live2dModelId !== undefined ? { live2dModelId: input.live2dModelId } : {}),
    ...(input.themeColor !== undefined ? { themeColor: input.themeColor } : {})
  }
}

export function toRestCharacterDraft(input: CharacterDraft): RestCharacterDraft {
  return {
    displayName: input.displayName,
    description: input.description,
    aliases: [...input.aliases],
    promptProfile: {
      corePersonality: input.promptProfile.corePersonality,
      relationshipStyle: input.promptProfile.relationshipStyle,
      emotionStyle: input.promptProfile.emotionStyle,
      speakingStyle: input.promptProfile.speakingStyle,
      conversationInitiative: input.promptProfile.conversationInitiative,
      examples: input.promptProfile.examples.map((example) => ({ user: example.user, assistant: example.assistant }))
    },
    runtimeDefaults: {
      voice: {
        ...(input.runtimeDefaults.voice.providerId !== undefined ? { providerId: input.runtimeDefaults.voice.providerId } : {}),
        ...(input.runtimeDefaults.voice.voiceId !== undefined ? { voiceId: input.runtimeDefaults.voice.voiceId } : {})
      },
      emotion: { idleExpressions: [...input.runtimeDefaults.emotion.idleExpressions] },
      wakeWords: [...input.runtimeDefaults.wakeWords],
      proactive: {
        enabled: input.runtimeDefaults.proactive.enabled,
        intervalSeconds: input.runtimeDefaults.proactive.intervalSeconds,
        triggers: [...input.runtimeDefaults.proactive.triggers]
      }
    },
    presentation: toRestPresentation(input.presentation),
    ...(input.openingMessage !== undefined ? { openingMessage: input.openingMessage } : {})
  }
}

/** POST /api/characters：draft 在 wire 顶层，不额外包一层 draft。 */
export function toRestCreateCharacterBody(input: CreateCharacterCommand): RestCreateCharacterBody {
  return toRestCharacterDraft(input.draft)
}

/** PUT /api/characters/{id}：expectedRevision/statePolicy 与完整 draft 同层。 */
export function toRestUpdateCharacterBody(input: UpdateCharacterCommand): RestUpdateCharacterBody {
  return {
    ...toRestCharacterDraft(input.draft),
    expectedRevision: input.expectedRevision,
    statePolicy: input.statePolicy
  }
}

export function toRestCloneCharacterBody(input: CloneCharacterCommand): RestCloneCharacterBody {
  return input.displayName === undefined ? {} : { displayName: input.displayName }
}

export function toRestRollbackCharacterBody(input: RollbackCharacterCommand): RestRollbackCharacterBody {
  return {
    targetRevision: input.targetRevision,
    expectedRevision: input.expectedRevision,
    statePolicy: input.statePolicy
  }
}

/** POST /api/characters/validate：与 create 相同的顶层 draft。 */
export function toRestValidateCharacterBody(input: CharacterDraft): RestValidateCharacterBody {
  return toRestCharacterDraft(input)
}

/** POST /api/characters/preview：只有 preview 保留 {draft,userMessage} 包装。 */
export function toRestPreviewCharacterBody(input: CharacterPreviewCommand): RestPreviewCharacterBody {
  return { draft: toRestCharacterDraft(input.draft), userMessage: input.userMessage }
}

export function toRestResetEvolutionBody(input: ResetCharacterEvolutionCommand): RestResetEvolutionBody {
  return { expectedStateVersion: input.expectedStateVersion }
}

/** GET /api/characters 查询：仅保留 raw query 白名单字段。 */
export function toRestCharacterListQuery(input: CharacterListQuery): RestCharacterListQuery {
  return {
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.search !== undefined ? { search: input.search } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {})
  }
}

/** GET /api/characters/{id}/revisions 查询：characterId 用 URL path，不重复进入 query。 */
export function toRestCharacterRevisionQuery(input: CharacterRevisionQuery): RestCharacterRevisionQuery {
  return {
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {})
  }
}

const un = (v: string | null | undefined): string | undefined => (v === null || v === undefined ? undefined : v)

export function toDomainProfile(raw: RestUserIdentityProfile): UserIdentityProfile {
  return {
    userId: raw.userId,
    displayName: raw.displayName,
    ...(un(raw.preferredAddress) !== undefined ? { preferredAddress: un(raw.preferredAddress) } : {}),
    ...(un(raw.pronouns) !== undefined ? { pronouns: un(raw.pronouns) } : {}),
    locale: raw.locale,
    timezone: raw.timezone,
    initialized: raw.initialized,
    ...(un(raw.defaultCharacterId) !== undefined ? { defaultCharacterId: un(raw.defaultCharacterId) } : {}),
    revision: raw.revision,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  }
}

function toDomainPresentation(raw: RestCharacterPresentation): CharacterPresentation {
  return {
    ...(un(raw.avatarAssetId) !== undefined ? { avatarAssetId: un(raw.avatarAssetId) } : {}),
    ...(un(raw.live2dModelId) !== undefined ? { live2dModelId: un(raw.live2dModelId) } : {}),
    ...(un(raw.themeColor) !== undefined ? { themeColor: un(raw.themeColor) } : {})
  }
}

export function toDomainSummary(raw: RestCharacterSummary): CharacterSummary {
  return {
    characterId: raw.characterId,
    source: raw.source,
    mutable: raw.mutable,
    status: raw.status,
    currentRevision: raw.currentRevision,
    displayName: raw.displayName,
    description: raw.description,
    aliases: raw.aliases,
    presentation: toDomainPresentation(raw.presentation),
    updatedAt: raw.updatedAt
  }
}

export function toDomainRevisionContent(raw: RestCharacterDetail['current']): CharacterRevisionContent {
  return {
    characterId: raw.characterId,
    revision: raw.revision,
    schemaVersion: raw.schemaVersion,
    displayName: raw.displayName,
    description: raw.description,
    aliases: raw.aliases,
    promptProfile: {
      corePersonality: raw.promptProfile.corePersonality,
      relationshipStyle: raw.promptProfile.relationshipStyle,
      emotionStyle: raw.promptProfile.emotionStyle,
      speakingStyle: raw.promptProfile.speakingStyle,
      conversationInitiative: raw.promptProfile.conversationInitiative,
      examples: raw.promptProfile.examples.map((e) => ({ user: e.user, assistant: e.assistant }))
    },
    runtimeDefaults: {
      voice: {
        ...(un(raw.runtimeDefaults.voice.providerId) !== undefined ? { providerId: un(raw.runtimeDefaults.voice.providerId) } : {}),
        ...(un(raw.runtimeDefaults.voice.voiceId) !== undefined ? { voiceId: un(raw.runtimeDefaults.voice.voiceId) } : {})
      },
      emotion: { idleExpressions: raw.runtimeDefaults.emotion.idleExpressions },
      wakeWords: raw.runtimeDefaults.wakeWords,
      proactive: {
        enabled: raw.runtimeDefaults.proactive.enabled,
        intervalSeconds: raw.runtimeDefaults.proactive.intervalSeconds,
        triggers: raw.runtimeDefaults.proactive.triggers
      }
    },
    presentation: toDomainPresentation(raw.presentation),
    ...(un(raw.openingMessage) !== undefined ? { openingMessage: un(raw.openingMessage) } : {}),
    checksum: raw.checksum,
    compilerVersion: raw.compilerVersion,
    createdBy: raw.createdBy,
    createdAt: raw.createdAt
  }
}

export function toDomainDetail(raw: RestCharacterDetail): CharacterDetail {
  return { summary: toDomainSummary(raw.summary), current: toDomainRevisionContent(raw.current) }
}

export function toDomainRevisionSummary(raw: RestCharacterRevisionSummary): CharacterRevisionSummary {
  return { revision: raw.revision, checksum: raw.checksum, createdBy: raw.createdBy, createdAt: raw.createdAt }
}

/** raw 分页 → 领域 Page<T>（has_more/cursor 只在本层出现，§5.1） */
export function toDomainPage<R, T>(raw: { items: R[]; has_more: boolean; cursor?: string }, mapItem: (r: R) => T): Page<T> {
  return {
    items: raw.items.map(mapItem),
    hasMore: raw.has_more,
    ...(raw.cursor !== undefined ? { nextCursor: raw.cursor } : {})
  }
}

export function toDomainCharacterList(raw: RestCharacterListResponse): Page<CharacterSummary> {
  return toDomainPage(raw, toDomainSummary)
}
export function toDomainRevisionList(raw: RestCharacterRevisionsResponse): Page<CharacterRevisionSummary> {
  return toDomainPage(raw, toDomainRevisionSummary)
}

export function toDomainMutationResult(raw: RestCharacterMutationResult): CharacterMutationResult {
  const stateImpact: CharacterStateImpact = {
    statePolicy: raw.stateImpact.statePolicy,
    affectedInstances: raw.stateImpact.affectedInstances,
    pendingInstances: raw.stateImpact.pendingInstances,
    resetFields: raw.stateImpact.resetFields
  }
  return { character: toDomainDetail(raw.character), stateImpact }
}

export function toDomainArchiveResult(raw: RestCharacterArchiveResult): CharacterArchiveResult {
  return {
    character: toDomainSummary(raw.character),
    ...(raw.userProfile !== undefined ? { userProfile: toDomainProfile(raw.userProfile) } : {})
  }
}

export function toDomainValidationResult(raw: RestCharacterValidationResult): CharacterValidationResult {
  return {
    valid: raw.valid,
    issues: raw.issues.map((i) => ({ severity: i.severity, code: i.code, path: i.path, message: i.message })),
    ...(raw.estimatedPromptChars !== undefined ? { estimatedPromptChars: raw.estimatedPromptChars } : {})
  }
}

export function toDomainPreviewResult(raw: RestCharacterPreviewResult): CharacterPreviewResult {
  return {
    ephemeral: true,
    reply: raw.reply,
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.usage !== undefined
      ? { usage: {
          ...(raw.usage.input !== undefined ? { input: raw.usage.input } : {}),
          ...(raw.usage.output !== undefined ? { output: raw.usage.output } : {}),
          ...(raw.usage.total !== undefined ? { total: raw.usage.total } : {})
        } }
      : {})
  }
}

/** 绑定快照（session summary/message 内嵌 → 领域；CHAR-FE-06/07） */
export function toDomainBindingSnapshot(raw: RestCharacterBindingSnapshot): CharacterBindingSnapshot {
  return {
    characterId: raw.characterId,
    characterInstanceId: raw.characterInstanceId,
    characterRevision: raw.characterRevision,
    displayName: raw.displayName,
    presentation: toDomainPresentation(raw.presentation)
  }
}

/** 消息角色审计快照（wire 与绑定快照同形 → 领域 CharacterGenerationRef，CHAR-FE-07） */
export function toDomainGenerationRef(raw: RestCharacterBindingSnapshot): CharacterGenerationRef {
  return toDomainBindingSnapshot(raw)
}

export function toDomainPublicState(raw: RestCharacterPublicState): CharacterPublicState {
  const state = raw.state
  return {
    ...(state.mood ? { mood: { label: state.mood.label, intensity: state.mood.intensity, updatedAt: state.mood.updatedAt } } : {}),
    ...(un(state.currentActivity) !== undefined ? { currentActivity: un(state.currentActivity) } : {}),
    ...(un(state.lastInteractionAt) !== undefined ? { lastInteractionAt: un(state.lastInteractionAt) } : {}),
    proactiveEnabled: state.proactiveEnabled,
    updatedAt: state.updatedAt,
    characterId: raw.characterId,
    characterInstanceId: raw.characterInstanceId,
    characterRevision: raw.characterRevision,
    stateVersion: raw.stateVersion
  }
}

export function toDomainResetResult(raw: RestResetEvolutionResult): ResetCharacterEvolutionResult {
  return { state: toDomainPublicState(raw.state), resetFields: raw.resetFields }
}
