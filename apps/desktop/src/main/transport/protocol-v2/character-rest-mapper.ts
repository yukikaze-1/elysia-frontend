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
  CharacterGenerationRef,
  CharacterMutationResult,
  CharacterPresentation,
  CharacterPublicState,
  CharacterRevisionContent,
  CharacterRevisionSummary,
  CharacterSummary,
  CharacterValidationResult,
  CharacterPreviewResult,
  CharacterStateImpact,
  ResetCharacterEvolutionResult,
  UserIdentityProfile
} from '@shared/contracts/character'
import type {
  RestCharacterArchiveResult,
  RestCharacterBindingSnapshot,
  RestCharacterDetail,
  RestCharacterListResponse,
  RestCharacterMutationResult,
  RestCharacterPresentation,
  RestCharacterPublicState,
  RestCharacterRevisionsResponse,
  RestCharacterRevisionSummary,
  RestCharacterSummary,
  RestCharacterValidationResult,
  RestCharacterPreviewResult,
  RestResetEvolutionResult,
  RestUserIdentityProfile
} from './character-rest-types'

/** wire character_profiles/character_state_stream === true 才映射 true；缺省/字符串/数字/其他形状一律 false（§5.2） */
export function parseBackendFeatureFlags(features: Record<string, unknown> | undefined): BackendFeatureFlags {
  return {
    characterProfiles: features?.character_profiles === true,
    characterStateStream: features?.character_state_stream === true
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
    ...(raw.userProfile ? { userProfile: toDomainProfile(raw.userProfile) } : {})
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
  return {
    ...(raw.mood ? { mood: { label: raw.mood.label, intensity: raw.mood.intensity, updatedAt: raw.mood.updatedAt } } : {}),
    ...(un(raw.currentActivity) !== undefined ? { currentActivity: un(raw.currentActivity) } : {}),
    ...(un(raw.lastInteractionAt) !== undefined ? { lastInteractionAt: un(raw.lastInteractionAt) } : {}),
    proactiveEnabled: raw.proactiveEnabled,
    updatedAt: raw.updatedAt,
    characterId: raw.characterId,
    characterInstanceId: raw.characterInstanceId,
    characterRevision: raw.characterRevision,
    stateVersion: raw.stateVersion
  }
}

export function toDomainResetResult(raw: RestResetEvolutionResult): ResetCharacterEvolutionResult {
  return { state: toDomainPublicState(raw.state), resetFields: raw.resetFields }
}
