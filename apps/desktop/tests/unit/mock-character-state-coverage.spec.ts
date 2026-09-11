// tests/unit/mock-character-state-coverage.spec.ts
// H-07（2026-09-11）：mock 角色后端必须为**每一个**角色提供公开状态，并让状态 revision 跟随角色 revision。
//
// 背景（只读侦察 + 本轮读码确认，两处确定性缺陷）：
//   ① `createCharacter`/`cloneCharacter` 把角色推进 `characters` 与 `histories`，却**从不写 `states`**；
//      而 `getConversationBinding` 早已把自建角色绑定到 `instance-<mangled-id>`。
//      于是 mock 下**每一个用户自建角色**的公开状态卡片永久 `CHARACTER_INSTANCE_NOT_FOUND`
//      （不是"有时"——是必然）。全仓原本**没有任何** `instance-custom*` 用例，故从未被发现。
//   ② `states` 的 `characterRevision` 在构造时定死、此后永不更新，而 `updateCharacter` 会推进角色 revision；
//      follow_latest 绑定到新 revision 后，渲染层的身份栅栏必然会抛错且**不会自愈**。
//
// 本 spec 覆盖的正是那条缺失路径：**自建/克隆角色 + revision 推进后仍能读到状态**。
// 这也是"修复前必红"的判别点——修复前第一条断言即失败（CHARACTER_INSTANCE_NOT_FOUND）。
import { describe, expect, it } from 'vitest'
import type { CharacterDraft } from '@shared/contracts'
import { MockCharacterBackend } from '../../src/main/characters/mock-character-backend'

function draft(displayName = '测试角色'): CharacterDraft {
  return {
    displayName, description: '', aliases: [],
    promptProfile: { corePersonality: '真诚', relationshipStyle: '朋友', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: [] },
    runtimeDefaults: { voice: {}, emotion: { idleExpressions: [] }, wakeWords: [], proactive: { enabled: false, intervalSeconds: 3600, triggers: [] } },
    presentation: {}
  }
}

describe('mock 角色状态覆盖（H-07）', () => {
  it('自建角色**有**公开状态，且能按绑定里的 instanceId 读到（修复前必然 CHARACTER_INSTANCE_NOT_FOUND）', async () => {
    const backend = new MockCharacterBackend()
    const created = await backend.createCharacter({ draft: draft('自建甲') })
    const characterId = created.summary.characterId

    // 绑定与状态必须指向同一实例：这是缺陷①的要害（绑定有、状态没有 ⇒ 卡片永久报错）
    const binding = backend.getConversationBinding(characterId)
    expect(binding, '自建角色应可绑定会话').toBeDefined()

    const state = await backend.getCharacterState(binding!.characterInstanceId)
    expect(state.characterId).toBe(characterId)
    expect(state.characterInstanceId).toBe(binding!.characterInstanceId)
  })

  it('克隆出的角色同样有公开状态（clone 走的是另一条创建路径，修复前同样缺失）', async () => {
    const backend = new MockCharacterBackend()
    const cloned = await backend.cloneCharacter({ characterId: 'builtin/elysia', displayName: '克隆乙' })
    const binding = backend.getConversationBinding(cloned.summary.characterId)
    expect(binding).toBeDefined()
    const state = await backend.getCharacterState(binding!.characterInstanceId)
    expect(state.characterId).toBe(cloned.summary.characterId)
  })

  it('角色 revision 推进后，状态的 characterRevision 必须跟上（否则渲染层身份栅栏永久失配且不自愈）', async () => {
    const backend = new MockCharacterBackend()
    const created = await backend.createCharacter({ draft: draft('自建丙') })
    const characterId = created.summary.characterId
    const instanceId = backend.getConversationBinding(characterId)!.characterInstanceId

    const before = await backend.getCharacterState(instanceId)
    expect(before.characterRevision).toBe(1)

    const updated = await backend.updateCharacter({ characterId, expectedRevision: 1, statePolicy: 'preserve', draft: draft('自建丙改') })
    const expectedRevision = updated.character.current.revision
    expect(expectedRevision, '更新应推进 revision').toBe(2)

    const after = await backend.getCharacterState(instanceId)
    expect(after.characterRevision, '状态 revision 必须等于角色新 revision，否则 follow_latest 绑定后必然失配').toBe(expectedRevision)
    // 与绑定对拍：绑定给的 revision 与状态给的 revision 必须一致（渲染层身份栅栏就是比这两者）
    expect(backend.getConversationBinding(characterId)!.characterRevision).toBe(after.characterRevision)
    // preserve 语义：只推进 revision，情绪等演化字段保留（mood 在契约里是可选字段）
    expect(after.mood?.label).toBe(before.mood?.label)
  })

  it('statePolicy=reset_evolution 时情绪被重置（且 revision 同样跟上）', async () => {
    const backend = new MockCharacterBackend()
    const created = await backend.createCharacter({ draft: draft('自建丁') })
    const characterId = created.summary.characterId
    const instanceId = backend.getConversationBinding(characterId)!.characterInstanceId
    const before = await backend.getCharacterState(instanceId)

    const updated = await backend.updateCharacter({ characterId, expectedRevision: 1, statePolicy: 'reset_evolution', draft: draft('自建丁改') })
    const after = await backend.getCharacterState(instanceId)

    expect(after.characterRevision).toBe(updated.character.current.revision)
    expect(after.mood?.label).toBe('平静')
    expect(after.mood?.intensity).toBe(0)
    expect(after.stateVersion, 'stateVersion 必须严格递增（渲染层高水位栅栏依赖）').toBeGreaterThan(before.stateVersion)
  })

  it('回滚也推进 revision，状态同样要跟上', async () => {
    const backend = new MockCharacterBackend()
    const created = await backend.createCharacter({ draft: draft('自建戊') })
    const characterId = created.summary.characterId
    const instanceId = backend.getConversationBinding(characterId)!.characterInstanceId
    await backend.updateCharacter({ characterId, expectedRevision: 1, statePolicy: 'preserve', draft: draft('自建戊改') })

    const rolled = await backend.rollbackCharacter({ characterId, expectedRevision: 2, targetRevision: 1, statePolicy: 'preserve' })
    const after = await backend.getCharacterState(instanceId)
    expect(after.characterRevision).toBe(rolled.character.current.revision)
  })

  it('内置角色的状态不受影响（回归：两处内置实例仍可读，且状态 revision 与绑定的 revision 一致）', async () => {
    const backend = new MockCharacterBackend()
    // 注意：内置角色构造时 currentRevision 就是 2（makeCharacter），不是 1——断言绑定的具体数值是错的，
    // 该断言的是**不变量**：状态 revision 必须等于绑定 revision（渲染层身份栅栏比的正是这两者）。
    for (const [characterId, instanceId] of [['builtin/elysia', 'instance-elysia'], ['builtin/cyrene', 'instance-cyrene']] as const) {
      const state = await backend.getCharacterState(instanceId)
      const binding = backend.getConversationBinding(characterId)
      expect(state.characterId).toBe(characterId)
      expect(binding).toBeDefined()
      expect(state.characterRevision, `${characterId} 的状态与绑定 revision 必须一致`).toBe(binding!.characterRevision)
    }
  })

  it('未创建过的实例仍按契约拒绝（不得因为"补状态"而放宽为凭空造一个）', async () => {
    const backend = new MockCharacterBackend()
    await expect(backend.getCharacterState('instance-does-not-exist')).rejects.toThrow()
  })
})
