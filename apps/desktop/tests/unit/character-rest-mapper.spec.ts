// 多角色 FE-A：character-rest-mapper raw → 领域映射测试（设计 §6.2.1 冻结）。
// 覆盖：raw 分页 {items,has_more,cursor?} → Page{items,hasMore,nextCursor?}；null→undefined 归一；
// 各 mutation/archive/validation/preview/state/reset 响应映射；feature flags 提取；绑定快照/generation ref。
import { describe, expect, it } from 'vitest'
import {
  parseBackendFeatureFlags,
  toDomainArchiveResult,
  toDomainBindingSnapshot,
  toDomainCharacterList,
  toDomainDetail,
  toDomainGenerationRef,
  toDomainMutationResult,
  toDomainPreviewResult,
  toDomainProfile,
  toDomainPublicState,
  toDomainResetResult,
  toDomainRevisionList,
  toDomainValidationResult
} from '../../src/main/transport/protocol-v2/character-rest-mapper'
import { RestCharacterDetailSchema } from '../../src/main/transport/protocol-v2/character-rest-schemas'
import type { RestCharacterDetail, RestCharacterSummary, RestUserIdentityProfile } from '../../src/main/transport/protocol-v2/character-rest-types'

const rawProfile: RestUserIdentityProfile = {
  userId: 'u_1', displayName: '旅人', preferredAddress: null, pronouns: null,
  locale: 'zh-CN', timezone: 'Asia/Shanghai', initialized: false,
  defaultCharacterId: null, revision: 1,
  createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z'
}

const rawSummary: RestCharacterSummary = {
  characterId: 'ch_elysia', source: 'builtin', mutable: false, status: 'active',
  currentRevision: 2, displayName: 'Elysia', description: '默认同伴',
  aliases: [], presentation: { avatarAssetId: null, live2dModelId: null, themeColor: '#ff88aa' },
  updatedAt: '2026-08-30T00:00:00.000Z'
}

const rawDetail: RestCharacterDetail = {
  summary: rawSummary,
  current: {
    characterId: 'ch_elysia', revision: 2, schemaVersion: 1,
    displayName: 'Elysia', description: '默认同伴', aliases: [],
    promptProfile: {
      corePersonality: '温柔', relationshipStyle: '同伴', emotionStyle: '克制',
      speakingStyle: '口语', conversationInitiative: '中等', examples: []
    },
    runtimeDefaults: {
      voice: { providerId: null, voiceId: null },
      emotion: { idleExpressions: [] },
      wakeWords: [],
      proactive: { enabled: false, intervalSeconds: 0, triggers: [] }
    },
    presentation: { themeColor: null }, openingMessage: null,
    checksum: 'sha256:abc', compilerVersion: 1, createdBy: 'system',
    createdAt: '2026-08-30T00:00:00.000Z'
  }
}

describe('raw wire schema 先行校验（strict 接纳）', () => {
  it('含 null 可选字段的 raw detail 通过 strict schema', () => {
    expect(RestCharacterDetailSchema.safeParse(rawDetail).success).toBe(true)
  })
  it('presentation 混入绝对路径 → 整帧拒绝（fail-closed）', () => {
    expect(RestCharacterDetailSchema.safeParse({
      ...rawDetail,
      summary: { ...rawSummary, presentation: { live2dModelId: '/models/x.model3.json' } }
    }).success).toBe(false)
  })
})

describe('profile / detail 映射（null → undefined 归一）', () => {
  it('profile：null 归一 undefined，非空保留', () => {
    const p = toDomainProfile(rawProfile)
    expect(p).toMatchObject({ userId: 'u_1', displayName: '旅人', initialized: false, revision: 1 })
    expect('preferredAddress' in p).toBe(false)
    expect('defaultCharacterId' in p).toBe(false)
    const filled = toDomainProfile({ ...rawProfile, preferredAddress: '阿旅', defaultCharacterId: 'ch_elysia' })
    expect(filled.preferredAddress).toBe('阿旅')
    expect(filled.defaultCharacterId).toBe('ch_elysia')
  })
  it('detail：presentation null 字段归一 undefined；非空透传；checksum/createdBy 透传', () => {
    const d = toDomainDetail(rawDetail)
    expect(d.current.checksum).toBe('sha256:abc')
    expect(d.current.createdBy).toBe('system')
    expect('openingMessage' in d.current).toBe(false)
    expect('avatarAssetId' in d.summary.presentation).toBe(false)
    expect('live2dModelId' in d.summary.presentation).toBe(false)
    expect(d.summary.presentation.themeColor).toBe('#ff88aa')   // 非 null 字段保留
    expect('providerId' in d.current.runtimeDefaults.voice).toBe(false)
  })
})

describe('raw 分页 → Page（CHAR-FE-02）', () => {
  it('{items,has_more,cursor} → {items,hasMore,nextCursor}；无 cursor → nextCursor 缺省', () => {
    const page = toDomainCharacterList({ items: [rawSummary], has_more: true, cursor: 'c9' })
    expect(page).toEqual({ items: [toDomainDetail(rawDetail).summary], hasMore: true, nextCursor: 'c9' })
    const last = toDomainCharacterList({ items: [], has_more: false })
    expect(last).toEqual({ items: [], hasMore: false })
    expect('nextCursor' in last).toBe(false)
  })
  it('revision 分页映射', () => {
    const page = toDomainRevisionList({
      items: [{ revision: 1, checksum: 'sha256:a', createdBy: 'system', createdAt: 't' }],
      has_more: false
    })
    expect(page.items[0]).toMatchObject({ revision: 1, checksum: 'sha256:a' })
  })
})

describe('mutation / archive / validation / preview 映射（CHAR-FE-03/04/05）', () => {
  it('mutation result：detail + stateImpact 透传（计数器可为 0）', () => {
    const m = toDomainMutationResult({
      character: rawDetail,
      stateImpact: { statePolicy: 'reset_evolution', affectedInstances: 0, pendingInstances: 0, resetFields: ['mood'] }
    })
    expect(m.character.summary.characterId).toBe('ch_elysia')
    expect(m.stateImpact).toEqual({ statePolicy: 'reset_evolution', affectedInstances: 0, pendingInstances: 0, resetFields: ['mood'] })
  })
  it('archive result：默认角色变化时带 userProfile（可选）', () => {
    const a = toDomainArchiveResult({ character: rawSummary })
    expect('userProfile' in a).toBe(false)
    const b = toDomainArchiveResult({ character: rawSummary, userProfile: rawProfile })
    expect(b.userProfile?.userId).toBe('u_1')
  })
  it('validation result：issues 透传；estimatedPromptChars 可选', () => {
    const v = toDomainValidationResult({
      valid: false,
      issues: [{ severity: 'error', code: 'TOO_LONG', path: '/promptProfile/corePersonality', message: '超长' }]
    })
    expect(v).toEqual({
      valid: false,
      issues: [{ severity: 'error', code: 'TOO_LONG', path: '/promptProfile/corePersonality', message: '超长' }]
    })
    expect('estimatedPromptChars' in v).toBe(false)
  })
  it('preview result：ephemeral 恒 true；usage 可选', () => {
    const p = toDomainPreviewResult({ ephemeral: true, reply: '预览回复' })
    expect(p).toEqual({ ephemeral: true, reply: '预览回复' })
    const withUsage = toDomainPreviewResult({ ephemeral: true, reply: 'r', model: 'glm', usage: { total: 12 } })
    expect(withUsage.usage).toEqual({ total: 12 })
    expect('input' in (withUsage.usage ?? {})).toBe(false)
  })
})

describe('state / reset 映射（CHAR-FE-09/15）', () => {
  it('public state：mood:null 归一无键；身份字段透传', () => {
    const s = toDomainPublicState({
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2, stateVersion: 8,
      mood: null, currentActivity: null, lastInteractionAt: null,
      proactiveEnabled: false, updatedAt: '2026-08-30T00:00:00.000Z'
    })
    expect('mood' in s).toBe(false)
    expect('currentActivity' in s).toBe(false)
    expect(s).toMatchObject({ characterId: 'ch_elysia', stateVersion: 8, proactiveEnabled: false })
    const withMood = toDomainPublicState({
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2, stateVersion: 8,
      mood: { label: '开心', intensity: 0.4, updatedAt: 't' },
      proactiveEnabled: true, updatedAt: '2026-08-30T00:00:00.000Z'
    })
    expect(withMood.mood).toEqual({ label: '开心', intensity: 0.4, updatedAt: 't' })
  })
  it('reset result：resetFields 以后端返回为权威', () => {
    const r = toDomainResetResult({
      state: {
        characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2, stateVersion: 9,
        proactiveEnabled: false, updatedAt: '2026-08-30T00:00:00.000Z'
      },
      resetFields: ['self_l2', 'state_l3']
    })
    expect(r.resetFields).toEqual(['self_l2', 'state_l3'])
    expect(r.state.stateVersion).toBe(9)
  })
})

describe('绑定快照 / generation ref（CHAR-FE-06/07）', () => {
  const rawSnapshot = {
    characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2,
    displayName: 'Elysia', presentation: { themeColor: '#ff88aa' }
  }
  it('binding snapshot：字段原样映射', () => {
    expect(toDomainBindingSnapshot(rawSnapshot)).toEqual({
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2,
      displayName: 'Elysia', presentation: { themeColor: '#ff88aa' }
    })
  })
  it('generation ref 与快照同形（CHAR-FE-07 冻结）', () => {
    expect(toDomainGenerationRef(rawSnapshot)).toEqual(toDomainBindingSnapshot(rawSnapshot))
  })
})

describe('parseBackendFeatureFlags（§5.2：wire === true 才 true）', () => {
  it('true → true；缺省/字符串/数字/其他形状一律 false', () => {
    expect(parseBackendFeatureFlags({ character_profiles: true, character_state_stream: true }))
      .toEqual({ characterProfiles: true, characterStateStream: true })
    expect(parseBackendFeatureFlags({ character_profiles: 'true', character_state_stream: 1 }))
      .toEqual({ characterProfiles: false, characterStateStream: false })
    expect(parseBackendFeatureFlags({}))
      .toEqual({ characterProfiles: false, characterStateStream: false })
    expect(parseBackendFeatureFlags(undefined))
      .toEqual({ characterProfiles: false, characterStateStream: false })
  })
})
