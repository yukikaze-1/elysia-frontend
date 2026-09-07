import { describe, expect, it } from 'vitest'
import { MOCK_CHARACTER_BACKEND_CODES, MockCharacterBackend } from '../../src/main/characters/mock-character-backend'
import { CharacterBindingSnapshotSchema, CharacterDetailSchema, CharacterPublicStateSchema, CharacterSummarySchema, ResetCharacterEvolutionResultSchema, UserIdentityProfileSchema } from '@shared/schemas'
import type { CharacterDraft } from '@shared/contracts'

function draft(name = '自定义角色'): CharacterDraft {
  return {
    displayName: name, description: '测试角色', aliases: ['测试'],
    promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
    runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: [name], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
    presentation: { themeColor: '#88aaff' }, openingMessage: '你好'
  }
}

describe('MockCharacterBackend 多角色闭环', () => {
  it('FE-E1 提供聊天 Mock 可消费的 active 角色 binding 快照，并与目录对象隔离', () => {
    const backend = new MockCharacterBackend()
    const bindings = backend.getConversationBindings()
    expect(Object.keys(bindings)).toEqual(['builtin/elysia', 'builtin/cyrene'])
    expect(CharacterBindingSnapshotSchema.safeParse(bindings['builtin/elysia']).success).toBe(true)
    bindings['builtin/elysia'].displayName = '调用方改写'
    expect(backend.getConversationBindings()['builtin/elysia'].displayName).toBe('Elysia')
  })

  it('提供 Elysia/Cyrene 两个 builtin 角色，并支持领域分页/搜索过滤', async () => {
    const backend = new MockCharacterBackend()
    const first = await backend.listCharacters({ limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBeDefined()

    const rest = await backend.listCharacters({ cursor: first.nextCursor, limit: 1 })
    expect(rest.items).toHaveLength(1)
    expect(new Set([...first.items, ...rest.items].map((item) => item.displayName))).toEqual(new Set(['Elysia', 'Cyrene']))
    expect((await backend.listCharacters({ search: 'cyrene' })).items.map((item) => item.displayName)).toEqual(['Cyrene'])
    expect((await backend.listCharacters({ source: 'builtin', status: 'active' })).items).toHaveLength(2)
  })

  it('所有返回值通过 strict domain schema，且深拷贝隔离调用方修改', async () => {
    const backend = new MockCharacterBackend()
    const profile = await backend.getMe()
    expect(UserIdentityProfileSchema.safeParse(profile).success).toBe(true)
    profile.displayName = '改写 profile'
    expect((await backend.getMe()).displayName).toBe('旅行者')

    const detail = await backend.getCharacter('builtin/elysia')
    expect(CharacterDetailSchema.safeParse(detail).success).toBe(true)
    detail.current.promptProfile.corePersonality = '改写 authored prompt'
    expect((await backend.getCharacter('builtin/elysia')).current.promptProfile.corePersonality).not.toBe('改写 authored prompt')

    const state = await backend.getCharacterState('instance-elysia')
    expect(CharacterPublicStateSchema.safeParse(state).success).toBe(true)
    state.mood!.intensity = 0
    expect((await backend.getCharacterState('instance-elysia')).mood?.intensity).toBe(0.62)
    expect(CharacterSummarySchema.safeParse((await backend.listCharacters({})).items[0]).success).toBe(true)
  })

  it('revision 分页和未知角色/实例错误具有稳定 backendCode', async () => {
    const backend = new MockCharacterBackend()
    const page = await backend.listCharacterRevisions({ characterId: 'builtin/elysia', limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.hasMore).toBe(true)
    await expect(backend.getCharacter('missing')).rejects.toMatchObject({ details: { backendCode: 'CHARACTER_NOT_FOUND' } })
    await expect(backend.getCharacterState('missing')).rejects.toMatchObject({ details: { backendCode: 'CHARACTER_INSTANCE_NOT_FOUND' } })
  })

  it('reset evolution 使用状态版本 CAS，返回严格领域结果并只重置目标实例', async () => {
    const backend = new MockCharacterBackend()
    const before = await backend.getCharacterState('instance-elysia')
    const result = await backend.resetCharacterEvolution({ characterInstanceId: 'instance-elysia', expectedStateVersion: before.stateVersion })
    expect(ResetCharacterEvolutionResultSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({ state: { stateVersion: before.stateVersion + 1, mood: { label: '平静', intensity: 0 } } })
    expect((await backend.getCharacterState('instance-cyrene')).stateVersion).toBe(1)
    await expect(backend.resetCharacterEvolution({ characterInstanceId: 'instance-elysia', expectedStateVersion: before.stateVersion }))
      .rejects.toMatchObject({ details: { backendCode: 'CHARACTER_STATE_VERSION_CONFLICT', currentStateVersion: before.stateVersion + 1 } })
    await expect(backend.resetCharacterEvolution({ characterInstanceId: 'instance-elysia', expectedStateVersion: before.stateVersion + 1, unknown: true } as never))
      .rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' })
  })

  it('未知数字 cursor 不回退到第一页，而是稳定拒绝并保留 backendCode', async () => {
    const backend = new MockCharacterBackend()
    await expect(backend.listCharacters({ cursor: '1', limit: 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT', details: { backendCode: MOCK_CHARACTER_BACKEND_CODES.invalidCursor }
    })
    const first = await backend.listCharacters({ limit: 1 })
    expect(first.nextCursor).toBe('1')
    await expect(backend.listCharacters({ cursor: '2', limit: 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT', details: { backendCode: MOCK_CHARACTER_BACKEND_CODES.invalidCursor }
    })
    await expect(backend.listCharacters({ cursor: first.nextCursor, search: 'cyrene', limit: 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT', details: { backendCode: MOCK_CHARACTER_BACKEND_CODES.invalidCursor }
    })
    const page = await backend.listCharacters({ cursor: first.nextCursor, limit: 1 })
    expect(page.items[0].displayName).toBe('Cyrene')
  })

  it('updateMe 初始化/更新 revision，冲突与非法默认角色保留稳定 backendCode', async () => {
    const times = ['2026-08-31T00:00:00.000Z', '2026-08-31T01:00:00.000Z']
    // 使用正式测试注入面构造 initialized=false；不依赖生产环境分支。
    const injected = new MockCharacterBackend({ initialProfile: { initialized: false }, now: () => times.shift() ?? '2026-08-31T01:00:00.000Z' })
    expect((await injected.getMe()).initialized).toBe(false)
    const updated = await injected.updateMe({
      expectedRevision: 1,
      displayName: '小雨',
      preferredAddress: '小雨',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      defaultCharacterId: 'builtin/cyrene'
    })
    expect(updated).toMatchObject({ initialized: true, revision: 2, updatedAt: '2026-08-31T01:00:00.000Z', defaultCharacterId: 'builtin/cyrene' })
    updated.displayName = '调用方改写'
    expect((await injected.getMe()).displayName).toBe('小雨')

    await expect(injected.updateMe({ expectedRevision: 1, displayName: '旧写入', locale: 'zh-CN', timezone: 'Asia/Shanghai' }))
      .rejects.toMatchObject({ details: { backendCode: MOCK_CHARACTER_BACKEND_CODES.profileRevisionConflict, currentRevision: 2 } })
    await expect(injected.updateMe({ expectedRevision: 2, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai', defaultCharacterId: 'missing' }))
      .rejects.toMatchObject({ details: { backendCode: MOCK_CHARACTER_BACKEND_CODES.defaultCharacterInvalid } })
    await expect(injected.updateMe({ expectedRevision: 2, displayName: '小雨', locale: 'zh-CN', timezone: 'Asia/Shanghai', unknown: true } as never))
      .rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' })
  })

  it('create/clone/update/rollback 历史不可变且 builtin 写入被拒绝', async () => {
    const backend = new MockCharacterBackend()
    await expect(backend.updateCharacter({ characterId: 'builtin/elysia', expectedRevision: 2, statePolicy: 'preserve', draft: draft() }))
      .rejects.toMatchObject({ details: { backendCode: MOCK_CHARACTER_BACKEND_CODES.immutable } })
    const cloned = await backend.cloneCharacter({ characterId: 'builtin/elysia', displayName: 'Elysia 副本' })
    expect(cloned.summary).toMatchObject({ source: 'custom', mutable: true, currentRevision: 1, displayName: 'Elysia 副本' })
    const created = await backend.createCharacter({ draft: draft('新角色') })
    expect(created.summary.characterId).not.toBe(cloned.summary.characterId)
    const updated = await backend.updateCharacter({ characterId: created.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: draft('第二版') })
    expect(updated).toMatchObject({ character: { current: { revision: 2, displayName: '第二版' } }, stateImpact: { statePolicy: 'preserve', resetFields: [] } })
    await expect(backend.updateCharacter({ characterId: created.summary.characterId, expectedRevision: 1, statePolicy: 'preserve', draft: draft('冲突') }))
      .rejects.toMatchObject({ details: { backendCode: MOCK_CHARACTER_BACKEND_CODES.revisionConflict, currentRevision: 2 } })
    const rolled = await backend.rollbackCharacter({ characterId: created.summary.characterId, targetRevision: 1, expectedRevision: 2, statePolicy: 'reset_evolution' })
    expect(rolled.character.current).toMatchObject({ revision: 3, displayName: '新角色' })
    expect(rolled.stateImpact.resetFields).toContain('mood')
    const history = await backend.listCharacterRevisions({ characterId: created.summary.characterId, limit: 10 })
    expect(history.items.map((item) => item.revision)).toEqual([3, 2, 1])
  })

  it('archive 默认角色原子回落且历史保留；validation warning/error 与 preview 零副作用', async () => {
    const backend = new MockCharacterBackend()
    const created = await backend.createCharacter({ draft: draft('将归档') })
    await backend.updateMe({ expectedRevision: 1, displayName: '旅行者', locale: 'zh-CN', timezone: 'Asia/Shanghai', defaultCharacterId: created.summary.characterId })
    const beforeHistory = await backend.listCharacterRevisions({ characterId: created.summary.characterId })
    const beforeCatalog = await backend.listCharacters({ status: 'active' })
    const beforeProfile = await backend.getMe()
    const archive = await backend.archiveCharacter(created.summary.characterId)
    expect(archive).toMatchObject({ character: { status: 'archived' }, userProfile: { defaultCharacterId: 'builtin/elysia', revision: 3 } })
    expect((await backend.listCharacters({ status: 'active' })).items).toHaveLength(beforeCatalog.items.length - 1)
    expect((await backend.listCharacterRevisions({ characterId: created.summary.characterId })).items).toEqual(beforeHistory.items)

    const warningDraft = draft('提示角色'); warningDraft.description = ''
    expect(await backend.validateCharacter(warningDraft)).toMatchObject({ valid: true, issues: [{ severity: 'warning', path: '/description' }] })
    const invalid = structuredClone(warningDraft); invalid.displayName = '   '
    const validation = await backend.validateCharacter(invalid)
    expect(validation.valid).toBe(false)
    expect(validation.issues[0].path.startsWith('/')).toBe(true)
    const preview = await backend.previewCharacter({ draft: draft('预览角色'), userMessage: '你好' })
    expect(preview.ephemeral).toBe(true)
    expect(await backend.getMe()).toEqual(archive.userProfile)
    expect((await backend.listCharacters({ status: 'active' })).items).toHaveLength(beforeCatalog.items.length - 1)
    expect(beforeProfile.revision).toBe(2)
  })
})
