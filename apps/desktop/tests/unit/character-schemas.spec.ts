// 多角色 FE-A：shared 角色域 schema 严格镜像测试（设计 §18.1 shared schema 矩阵 + §6.4 strict 纪律）。
// 覆盖：全字段/缺省/非法 revision、statePolicy 缩写拒绝、aliases/examples 上限、Presentation 拒绝
// 绝对路径与危险颜色、intensity 边界、JSON Pointer path、preview 形状、strict 未知键拒绝。
import { describe, expect, it } from 'vitest'
import {
  BackendFeatureFlagsSchema,
  CharacterArchiveResultSchema,
  CharacterBindingSnapshotSchema,
  CharacterDetailSchema,
  CharacterDraftSchema,
  CharacterDraftStorageSchema,
  CharacterExampleSchema,
  CharacterGenerationRefSchema,
  CharacterMutationResultSchema,
  CharacterPreviewCommandSchema,
  CharacterPreviewResultSchema,
  CharacterListQuerySchema,
  CharacterPublicStateSchema,
  CharacterStatePolicySchema,
  CharacterSummarySchema,
  CharacterValidationIssueSchema,
  PersistedCharacterDraftSchema,
  ResetCharacterEvolutionCommandSchema,
  ResetCharacterEvolutionResultSchema,
  UpdateUserIdentityCommandSchema,
  UserIdentityProfileSchema,
  isUtcIsoTimestamp,
  isSafeRegistryId,
  isSafeThemeColor
} from '../../src/shared/schemas/character'

const validPresentation = { themeColor: '#ff88aa' }

const validProfile = {
  userId: 'u_1', displayName: '旅人', locale: 'zh-CN', timezone: 'Asia/Shanghai',
  initialized: true, revision: 3,
  createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z'
}

const validSummary = {
  characterId: 'ch_elysia', source: 'builtin', mutable: false, status: 'active',
  currentRevision: 2, displayName: 'Elysia', description: '默认同伴',
  aliases: ['小爱'], presentation: validPresentation, updatedAt: '2026-08-30T00:00:00.000Z'
}

const validPromptProfile = {
  corePersonality: '温柔', relationshipStyle: '同伴', emotionStyle: '克制',
  speakingStyle: '口语', conversationInitiative: '中等',
  examples: [{ user: '你好', assistant: '嗨，今天怎么样？' }]
}

const validRuntimeDefaults = {
  voice: { providerId: 'openai', voiceId: 'nova' },
  emotion: { idleExpressions: ['smile'] },
  wakeWords: ['小爱'],
  proactive: { enabled: false, intervalSeconds: 0, triggers: [] }
}

const validRevisionContent = {
  characterId: 'ch_elysia', revision: 2, schemaVersion: 1,
  displayName: 'Elysia', description: '默认同伴', aliases: ['小爱'],
  promptProfile: validPromptProfile, runtimeDefaults: validRuntimeDefaults,
  presentation: validPresentation, checksum: 'sha256:abc', compilerVersion: 1,
  createdBy: 'system', createdAt: '2026-08-30T00:00:00.000Z'
}

describe('UserIdentityProfile schema（§18.1）', () => {
  it('全字段通过；可选自由文本缺省通过', () => {
    const full = {
      ...validProfile, preferredAddress: '阿旅', pronouns: 'ta',
      defaultCharacterId: 'ch_elysia'
    }
    expect(UserIdentityProfileSchema.safeParse(full).success).toBe(true)
    expect(UserIdentityProfileSchema.safeParse(validProfile).success).toBe(true)
  })
  it('revision 从 1 开始：0 / 1.5 拒绝', () => {
    expect(UserIdentityProfileSchema.safeParse({ ...validProfile, revision: 0 }).success).toBe(false)
    expect(UserIdentityProfileSchema.safeParse({ ...validProfile, revision: 1.5 }).success).toBe(false)
  })
  it('profile 是 strict：未知字段拒绝', () => {
    expect(UserIdentityProfileSchema.safeParse({ ...validProfile, extra: true }).success).toBe(false)
  })
  it('缺 userId/locale/timezone/initialized 拒绝', () => {
    for (const key of ['userId', 'locale', 'timezone', 'initialized'] as const) {
      const bad: Record<string, unknown> = { ...validProfile }
      delete bad[key]
      expect(UserIdentityProfileSchema.safeParse(bad).success).toBe(false)
    }
  })
  it('身份必填文本拒绝全空白；可选文本若提供也不得全空白', () => {
    for (const key of ['displayName', 'locale', 'timezone'] as const) {
      expect(UserIdentityProfileSchema.safeParse({ ...validProfile, [key]: ' \t' }).success).toBe(false)
    }
    expect(UserIdentityProfileSchema.safeParse({ ...validProfile, preferredAddress: ' \n' }).success).toBe(false)
    expect(UpdateUserIdentityCommandSchema.safeParse({
      expectedRevision: 3, displayName: ' \t', locale: 'zh-CN', timezone: 'Asia/Shanghai'
    }).success).toBe(false)
  })
  it('更新命令缺 expectedRevision 拒绝；strict 未知键拒绝', () => {
    expect(UpdateUserIdentityCommandSchema.safeParse({
      expectedRevision: 3, displayName: '旅人', locale: 'zh-CN', timezone: 'Asia/Shanghai'
    }).success).toBe(true)
    expect(UpdateUserIdentityCommandSchema.safeParse({
      displayName: '旅人', locale: 'zh-CN', timezone: 'Asia/Shanghai'
    }).success).toBe(false)
    expect(UpdateUserIdentityCommandSchema.safeParse({
      expectedRevision: 3, displayName: '旅人', locale: 'zh-CN', timezone: 'Asia/Shanghai', nickname: 'x'
    }).success).toBe(false)
  })
})

describe('UTC ISO-8601 时间（§6.4）', () => {
  const validZ = '2026-08-30T00:00:00.000Z'
  const validOffset = '2026-08-30T00:00:00+00:00'

  it('接受合法 Z / +00:00，拒绝占位、无时区、日期-only 与非法日期', () => {
    expect(isUtcIsoTimestamp(validZ)).toBe(true)
    expect(isUtcIsoTimestamp(validOffset)).toBe(true)
    for (const value of [
      't',
      '2026-08-30T00:00:00',
      '2026-08-30',
      '2026-08-30T00:00:00+08:00',
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-08-30T24:00:00Z'
    ]) {
      expect(isUtcIsoTimestamp(value)).toBe(false)
    }
  })

  it('角色 profile/summary/revision/state 各时间字段均执行同一校验', () => {
    expect(UserIdentityProfileSchema.safeParse({ ...validProfile, createdAt: validOffset, updatedAt: validOffset }).success).toBe(true)
    expect(UserIdentityProfileSchema.safeParse({ ...validProfile, updatedAt: 't' }).success).toBe(false)
    expect(CharacterSummarySchema.safeParse({ ...validSummary, updatedAt: 't' }).success).toBe(false)
    expect(CharacterDetailSchema.safeParse({
      summary: validSummary, current: { ...validRevisionContent, createdAt: 't' }
    }).success).toBe(false)
    const state = {
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2, stateVersion: 1,
      mood: { label: '开心', intensity: 0.5, updatedAt: validZ },
      lastInteractionAt: validOffset, proactiveEnabled: false, updatedAt: validZ
    }
    expect(CharacterPublicStateSchema.safeParse(state).success).toBe(true)
    expect(CharacterPublicStateSchema.safeParse({ ...state, mood: { ...state.mood, updatedAt: 't' } }).success).toBe(false)
    expect(CharacterPublicStateSchema.safeParse({ ...state, lastInteractionAt: '2026-08-30' }).success).toBe(false)
  })
})

describe('CharacterSummary / Detail / Revision schema', () => {
  it('summary 全字段通过；缺 characterId/currentRevision 拒绝', () => {
    expect(CharacterSummarySchema.safeParse(validSummary).success).toBe(true)
    const bad: Record<string, unknown> = { ...validSummary }
    delete bad.characterId
    expect(CharacterSummarySchema.safeParse(bad).success).toBe(false)
    expect(CharacterSummarySchema.safeParse({ ...validSummary, currentRevision: 0 }).success).toBe(false)
  })
  it('detail {summary,current} 通过；缺 current 拒绝', () => {
    expect(CharacterDetailSchema.safeParse({ summary: validSummary, current: validRevisionContent }).success).toBe(true)
    expect(CharacterDetailSchema.safeParse({ summary: validSummary }).success).toBe(false)
  })
  it('unknown source/status/createdBy 拒绝（fail-closed）', () => {
    expect(CharacterSummarySchema.safeParse({ ...validSummary, source: 'imported' }).success).toBe(false)
    expect(CharacterSummarySchema.safeParse({ ...validSummary, status: 'hidden' }).success).toBe(false)
    expect(CharacterDetailSchema.safeParse({
      summary: validSummary, current: { ...validRevisionContent, createdBy: 'wizard' }
    }).success).toBe(false)
  })
})

describe('CharacterStatePolicy（冻结：只取 preserve|reset_evolution）', () => {
  it('缩写 reset 与其他值拒绝', () => {
    expect(CharacterStatePolicySchema.safeParse('preserve').success).toBe(true)
    expect(CharacterStatePolicySchema.safeParse('reset_evolution').success).toBe(true)
    expect(CharacterStatePolicySchema.safeParse('reset').success).toBe(false)
    expect(CharacterStatePolicySchema.safeParse('preserve_evolution').success).toBe(false)
  })
})

describe('Presentation（§18.1：拒绝绝对路径与危险颜色）', () => {
  it('注册表 ID：合法 ID 通过，绝对路径/URL/相对逃逸拒绝', () => {
    expect(isSafeRegistryId('mmodel_pro_intimate_01')).toBe(true)
    expect(isSafeRegistryId('/models/hiyori/free/hiyori.model3.json')).toBe(false)
    expect(isSafeRegistryId('C:\\models\\x.model3.json')).toBe(false)
    expect(isSafeRegistryId('C:/models/x.model3.json')).toBe(false)
    expect(isSafeRegistryId('https://evil.example/x.png')).toBe(false)
    expect(isSafeRegistryId('data:text/plain,evil')).toBe(false)
    expect(isSafeRegistryId('../escape')).toBe(false)
    expect(isSafeRegistryId('   ')).toBe(false)
    expect(isSafeRegistryId('')).toBe(false)
  })
  it('themeColor：hex/rgb/命名色通过，url()/expression()/注入串拒绝', () => {
    expect(isSafeThemeColor('#ff88aa')).toBe(true)
    expect(isSafeThemeColor('rgb(10, 20, 30)')).toBe(true)
    expect(isSafeThemeColor('hsla(120, 50%, 50%, 0.5)')).toBe(true)
    expect(isSafeThemeColor('lightblue')).toBe(true)
    expect(isSafeThemeColor('RED')).toBe(true)
    for (const value of ['inherit', 'currentColor', 'initial', 'unset', 'revert', 'randombrand']) {
      expect(isSafeThemeColor(value)).toBe(false)
    }
    expect(isSafeThemeColor('url(http://evil.example/x)')).toBe(false)
    expect(isSafeThemeColor('expression(alert(1))')).toBe(false)
    expect(isSafeThemeColor('red; background:url(x)')).toBe(false)
    expect(isSafeThemeColor('')).toBe(false)
  })
  it('CharacterPresentation 内嵌校验生效', () => {
    expect(CharacterDetailSchema.safeParse({
      summary: { ...validSummary, presentation: { live2dModelId: '/abs/path.model3.json' } },
      current: validRevisionContent
    }).success).toBe(false)
  })
})

describe('aliases / examples / draft 上限（前端从严暂定，handoff 对拍前不得放宽）', () => {
  it('aliases 超量与单项超长拒绝', () => {
    const many = CharacterSummarySchema.safeParse({
      ...validSummary, aliases: Array.from({ length: 33 }, (_, i) => `a${i}`)
    })
    expect(many.success).toBe(false)
    const long = CharacterSummarySchema.safeParse({ ...validSummary, aliases: ['x'.repeat(65)] })
    expect(long.success).toBe(false)
  })
  it('examples 超量拒绝；示例缺 user/assistant 拒绝', () => {
    const many = CharacterExampleSchema.safeParse({ user: 'u', assistant: 'a' })
    expect(many.success).toBe(true)
    expect(CharacterExampleSchema.safeParse({ user: 'u' }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({
      displayName: 'x', description: '', aliases: [],
      promptProfile: {
        ...validPromptProfile,
        examples: Array.from({ length: 51 }, () => ({ user: 'u', assistant: 'a' }))
      },
      runtimeDefaults: validRuntimeDefaults, presentation: validPresentation
    }).success).toBe(false)
  })
  it('长度上限与后端 §13.1 对齐；emotion/initiative 可为空但不可缺字段', () => {
    const base = {
      displayName: 'x', description: '', aliases: [],
      promptProfile: { ...validPromptProfile, emotionStyle: '', conversationInitiative: '' },
      runtimeDefaults: validRuntimeDefaults, presentation: validPresentation
    }
    expect(CharacterDraftSchema.safeParse({ ...base, displayName: 'x'.repeat(65) }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({ ...base, description: 'x'.repeat(501) }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({ ...base, aliases: Array.from({ length: 11 }, () => 'x') }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({ ...base, aliases: ['x'.repeat(33)] }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({
      ...base, promptProfile: { ...base.promptProfile, corePersonality: 'x'.repeat(12_001) }
    }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({
      ...base, promptProfile: { ...base.promptProfile, relationshipStyle: 'x'.repeat(6_001) }
    }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({
      ...base, promptProfile: { ...base.promptProfile, emotionStyle: 'x'.repeat(5_001) }
    }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({
      ...base, promptProfile: { ...base.promptProfile, speakingStyle: 'x'.repeat(6_001) }
    }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({
      ...base, promptProfile: { ...base.promptProfile, conversationInitiative: 'x'.repeat(3_001) }
    }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({
      ...base, promptProfile: { ...base.promptProfile, examples: [{ user: 'x'.repeat(1_001), assistant: 'ok' }] }
    }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({ ...base, openingMessage: 'x'.repeat(1_001) }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({ ...base, runtimeDefaults: { ...validRuntimeDefaults, wakeWords: Array.from({ length: 21 }, () => 'x') } }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse({ ...base, runtimeDefaults: { ...validRuntimeDefaults, wakeWords: ['x'.repeat(33)] } }).success).toBe(false)
    const withoutEmotion: Record<string, unknown> = { ...base.promptProfile }
    delete withoutEmotion.emotionStyle
    expect(CharacterDraftSchema.safeParse({ ...base, promptProfile: withoutEmotion }).success).toBe(false)
    const withoutInitiative: Record<string, unknown> = { ...base.promptProfile }
    delete withoutInitiative.conversationInitiative
    expect(CharacterDraftSchema.safeParse({ ...base, promptProfile: withoutInitiative }).success).toBe(false)
    expect(CharacterDraftSchema.safeParse(base).success).toBe(true)
  })
  it('角色必填文本与列表项拒绝全空白；emotion/initiative 仅允许真正空串', () => {
    const base = {
      displayName: 'x', description: '', aliases: [],
      promptProfile: { ...validPromptProfile, emotionStyle: '', conversationInitiative: '' },
      runtimeDefaults: validRuntimeDefaults, presentation: validPresentation
    }
    for (const bad of [
      { ...base, displayName: ' \t' },
      { ...base, aliases: [' \t'] },
      { ...base, promptProfile: { ...base.promptProfile, corePersonality: ' ' } },
      { ...base, promptProfile: { ...base.promptProfile, relationshipStyle: '\n' } },
      { ...base, promptProfile: { ...base.promptProfile, speakingStyle: ' \n' } },
      { ...base, promptProfile: { ...base.promptProfile, examples: [{ user: ' ', assistant: 'ok' }] } },
      { ...base, promptProfile: { ...base.promptProfile, examples: [{ user: 'ok', assistant: '\t' }] } },
      { ...base, runtimeDefaults: { ...validRuntimeDefaults, wakeWords: [' '] } },
      { ...base, runtimeDefaults: { ...validRuntimeDefaults, emotion: { idleExpressions: [' '] } } },
      { ...base, runtimeDefaults: { ...validRuntimeDefaults, proactive: { ...validRuntimeDefaults.proactive, triggers: [' '] } } },
      { ...base, promptProfile: { ...base.promptProfile, emotionStyle: ' ' } },
      { ...base, promptProfile: { ...base.promptProfile, conversationInitiative: '\t' } }
    ]) {
      expect(CharacterDraftSchema.safeParse(bad).success).toBe(false)
    }
    expect(CharacterDraftSchema.safeParse(base).success).toBe(true)
  })
  it('draft 缺 runtimeDefaults/promptProfile 拒绝', () => {
    expect(CharacterDraftSchema.safeParse({ displayName: 'x' }).success).toBe(false)
  })
})

describe('CharacterPublicState（§5.11）', () => {
  const validState = {
    mood: { label: '开心', intensity: 0.6, updatedAt: '2026-08-30T00:00:00.000Z' },
    proactiveEnabled: true,
    updatedAt: '2026-08-30T00:00:00.000Z',
    characterId: 'ch_elysia', characterInstanceId: 'ci_1',
    characterRevision: 2, stateVersion: 7
  }
  it('全字段通过；intensity 边界 0/1 通过、越界拒绝', () => {
    expect(CharacterPublicStateSchema.safeParse(validState).success).toBe(true)
    expect(CharacterPublicStateSchema.safeParse({
      ...validState, mood: { ...validState.mood, intensity: 0 }
    }).success).toBe(true)
    expect(CharacterPublicStateSchema.safeParse({
      ...validState, mood: { ...validState.mood, intensity: 1.01 }
    }).success).toBe(false)
    expect(CharacterPublicStateSchema.safeParse({
      ...validState, mood: { ...validState.mood, intensity: -0.1 }
    }).success).toBe(false)
  })
  it('stateVersion 从 1 开始：0 拒绝；mood:null 拒绝（领域层归一后不得再传 null）', () => {
    expect(CharacterPublicStateSchema.safeParse({ ...validState, stateVersion: 0 }).success).toBe(false)
    expect(CharacterPublicStateSchema.safeParse({ ...validState, mood: null }).success).toBe(false)
  })
})

describe('PersistedCharacterDraft（§12.3：完整记录语义）', () => {
  const storageDraft = {
    displayName: '草稿角色',
    description: '未提交说明',
    aliases: [],
    promptProfile: { ...validPromptProfile },
    runtimeDefaults: { ...validRuntimeDefaults },
    presentation: validPresentation
  }
  const createRecord = {
    key: 'create:one', mode: 'create' as const, displayName: '草稿角色',
    updatedAt: '2026-08-30T00:00:00.000Z', draft: storageDraft
  }

  it('create 不得带 characterId/baseRevision；edit 与 clone 必须同时带两者', () => {
    expect(PersistedCharacterDraftSchema.safeParse(createRecord).success).toBe(true)
    expect(PersistedCharacterDraftSchema.safeParse({ ...createRecord, characterId: 'ch_1' }).success).toBe(false)
    expect(PersistedCharacterDraftSchema.safeParse({ ...createRecord, baseRevision: 1 }).success).toBe(false)

    const edit = { ...createRecord, key: 'edit:ch_1', mode: 'edit' as const, characterId: 'ch_1', baseRevision: 1 }
    expect(PersistedCharacterDraftSchema.safeParse(edit).success).toBe(true)
    expect(PersistedCharacterDraftSchema.safeParse({ ...edit, baseRevision: undefined }).success).toBe(false)
    expect(PersistedCharacterDraftSchema.safeParse({ ...edit, characterId: undefined }).success).toBe(false)

    const clone = { ...edit, key: 'clone:ch_1', mode: 'clone' as const }
    expect(PersistedCharacterDraftSchema.safeParse(clone).success).toBe(true)
    expect(PersistedCharacterDraftSchema.safeParse({ ...clone, characterId: undefined }).success).toBe(false)
    expect(PersistedCharacterDraftSchema.safeParse({ ...clone, baseRevision: undefined }).success).toBe(false)
  })

  it('displayName 必须与 draft.displayName 一致；statePolicy 可保存，旧记录缺省按兼容路径通过', () => {
    expect(PersistedCharacterDraftSchema.safeParse({ ...createRecord, statePolicy: 'reset_evolution' }).success).toBe(true)
    expect(PersistedCharacterDraftSchema.safeParse(createRecord).success).toBe(true)
    expect(PersistedCharacterDraftSchema.safeParse({ ...createRecord, displayName: '另一个名称' }).success).toBe(false)
    expect(PersistedCharacterDraftSchema.safeParse({ ...createRecord, statePolicy: 'reset' }).success).toBe(false)
    expect(PersistedCharacterDraftSchema.safeParse({ ...createRecord, unknown: true }).success).toBe(false)
    expect(CharacterDraftStorageSchema.safeParse(storageDraft).success).toBe(true)
  })
})

describe('mutation / archive / preview / reset result schemas', () => {
  const mutation = {
    character: { summary: validSummary, current: validRevisionContent },
    stateImpact: { statePolicy: 'preserve', affectedInstances: 0, pendingInstances: 0, resetFields: [] }
  }
  it('mutation/archive 结果完整镜像且未知字段拒绝', () => {
    expect(CharacterMutationResultSchema.safeParse(mutation).success).toBe(true)
    expect(CharacterMutationResultSchema.safeParse({ ...mutation, extra: true }).success).toBe(false)
    expect(CharacterArchiveResultSchema.safeParse({ character: validSummary }).success).toBe(true)
    expect(CharacterArchiveResultSchema.safeParse({ character: validSummary, userProfile: validProfile }).success).toBe(true)
    expect(CharacterArchiveResultSchema.safeParse({ character: validSummary, extra: true }).success).toBe(false)
    expect(CharacterMutationResultSchema.safeParse({
      ...mutation,
      stateImpact: { ...mutation.stateImpact, affectedInstances: 0, pendingInstances: 1 }
    }).success).toBe(false)
    expect(CharacterMutationResultSchema.safeParse({
      ...mutation,
      stateImpact: { ...mutation.stateImpact, resetFields: ['mood'] }
    }).success).toBe(false)
    expect(CharacterMutationResultSchema.safeParse({
      ...mutation,
      stateImpact: { ...mutation.stateImpact, statePolicy: 'reset_evolution', resetFields: ['mood'] }
    }).success).toBe(true)
  })
  it('preview command/result 形状严格；ephemeral 必须为 true', () => {
    const draft = {
      displayName: 'x', description: '', aliases: [], promptProfile: validPromptProfile,
      runtimeDefaults: validRuntimeDefaults, presentation: validPresentation
    }
    expect(CharacterPreviewCommandSchema.safeParse({ draft, userMessage: '你好' }).success).toBe(true)
    expect(CharacterPreviewCommandSchema.safeParse({ draft, userMessage: 'x'.repeat(20_001) }).success).toBe(false)
    expect(CharacterPreviewResultSchema.safeParse({ ephemeral: true, reply: 'ok' }).success).toBe(true)
    expect(CharacterPreviewResultSchema.safeParse({ ephemeral: false, reply: 'ok' }).success).toBe(false)
    expect(CharacterPreviewResultSchema.safeParse({ ephemeral: true, reply: 'ok', usage: { total: -1 } }).success).toBe(false)
    expect(CharacterPreviewResultSchema.safeParse({ ephemeral: true, reply: 'ok', usage: { total: 1 }, extra: true }).success).toBe(false)
  })
  it('reset command/result 版本从 1 开始且返回字段严格', () => {
    const state = {
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2, stateVersion: 2,
      proactiveEnabled: false, updatedAt: '2026-08-30T00:00:00.000Z'
    }
    expect(ResetCharacterEvolutionCommandSchema.safeParse({ characterInstanceId: 'ci_1', expectedStateVersion: 1 }).success).toBe(true)
    expect(ResetCharacterEvolutionCommandSchema.safeParse({ characterInstanceId: 'ci_1', expectedStateVersion: 0 }).success).toBe(false)
    expect(ResetCharacterEvolutionResultSchema.safeParse({ state, resetFields: ['mood'] }).success).toBe(true)
    expect(ResetCharacterEvolutionResultSchema.safeParse({ state, resetFields: ['reset'] }).success).toBe(false)
    expect(ResetCharacterEvolutionResultSchema.safeParse({ state, resetFields: ['mood'], extra: true }).success).toBe(false)
  })
})

describe('校验与绑定快照（§5.8/§5.9/§5.10）', () => {
  it('validation path 必须是 JSON Pointer', () => {
    expect(CharacterValidationIssueSchema.safeParse({
      severity: 'error', code: 'TOO_LONG', path: '/promptProfile/corePersonality', message: '超长'
    }).success).toBe(true)
    expect(CharacterValidationIssueSchema.safeParse({
      severity: 'error', code: 'TOO_LONG', path: 'promptProfile.corePersonality', message: '超长'
    }).success).toBe(false)
  })
  it('绑定快照：characterRevision=0 拒绝；displayName 缺失拒绝', () => {
    expect(CharacterBindingSnapshotSchema.safeParse({
      characterId: 'ch_1', characterInstanceId: 'ci_1', characterRevision: 1,
      displayName: 'Elysia', presentation: {}
    }).success).toBe(true)
    expect(CharacterBindingSnapshotSchema.safeParse({
      characterId: 'ch_1', characterInstanceId: 'ci_1', characterRevision: 0,
      displayName: 'Elysia', presentation: {}
    }).success).toBe(false)
    expect(CharacterBindingSnapshotSchema.safeParse({
      characterId: 'ch_1', characterInstanceId: 'ci_1', characterRevision: 1, presentation: {}
    }).success).toBe(false)
  })
  it('generation ref：displayName/presentation 可省略；未知键拒绝', () => {
    expect(CharacterGenerationRefSchema.safeParse({
      characterId: 'ch_1', characterInstanceId: 'ci_1', characterRevision: 4
    }).success).toBe(true)
    expect(CharacterGenerationRefSchema.safeParse({
      characterId: 'ch_1', characterInstanceId: 'ci_1', characterRevision: 4, nickname: 'x'
    }).success).toBe(false)
  })
  it('查询 schema：limit 上限与非法 source 拒绝', () => {
    expect(CharacterListQuerySchema.safeParse({ limit: 100 }).success).toBe(true)
    expect(CharacterListQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(CharacterListQuerySchema.safeParse({ source: 'all' }).success).toBe(false)
  })
})

describe('BackendFeatureFlags（§5.2）', () => {
  it('布尔必填；缺字段拒绝', () => {
    expect(BackendFeatureFlagsSchema.safeParse({ characterProfiles: false, characterStateStream: false }).success).toBe(true)
    expect(BackendFeatureFlagsSchema.safeParse({ characterProfiles: true }).success).toBe(false)
    expect(BackendFeatureFlagsSchema.safeParse({ characterProfiles: false, characterStateStream: false, extra: true }).success).toBe(false)
  })
})
