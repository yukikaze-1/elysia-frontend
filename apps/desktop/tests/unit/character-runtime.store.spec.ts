import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CharacterBindingSnapshot, CharacterPublicState, CharacterStateChangedEvent } from '@shared/contracts'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useCharacterRuntimeStore } from '../../src/renderer/src/stores/character-runtime.store'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function binding(revision: number, conversationId = 'conversation-a'): CharacterBindingSnapshot {
  void conversationId
  return {
    characterId: 'builtin/elysia',
    characterInstanceId: 'instance-shared',
    characterRevision: revision,
    displayName: 'Elysia',
    presentation: {}
  }
}

function state(revision: number, stateVersion: number, currentActivity?: string): CharacterPublicState {
  return {
    characterId: 'builtin/elysia',
    characterInstanceId: 'instance-shared',
    characterRevision: revision,
    stateVersion,
    ...(currentActivity ? { currentActivity } : {}),
    proactiveEnabled: false,
    updatedAt: '2026-09-01T00:00:00.000Z'
  }
}

function event(revision: number, stateVersion: number, conversationId: string, currentActivity?: string): CharacterStateChangedEvent {
  return {
    event: 'character.state.changed',
    eventId: `state-${revision}-${stateVersion}-${conversationId}`,
    sequence: stateVersion,
    conversationId,
    ...state(revision, stateVersion, currentActivity),
    state: {
      ...(currentActivity ? { currentActivity } : {}),
      proactiveEnabled: false,
      updatedAt: '2026-09-01T00:00:00.000Z'
    }
  }
}

describe('characterRuntimeStore FE-F1a', () => {
  const getCharacterState = vi.fn<(instanceId: string) => Promise<CharacterPublicState>>()

  beforeEach(() => {
    setActivePinia(createPinia())
    getCharacterState.mockReset()
    setDesktopApi({ getCharacterState } as never)
  })

  it('同 instance 的不同 revision pending 独立拥有 GET；A 迟到不得改写 B 的 loading/error/view', async () => {
    const first = deferred<CharacterPublicState>()
    const second = deferred<CharacterPublicState>()
    getCharacterState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    const requestA = store.loadState('instance-shared')
    store.setActiveBinding(binding(2), 'conversation-b')
    const requestB = store.loadState('instance-shared')

    expect(getCharacterState).toHaveBeenCalledTimes(2)
    expect(store.activeStatus).toBe('loading')
    first.resolve(state(1, 9, 'A 的迟到状态'))
    await requestA
    expect(store.activeStatus).toBe('loading')
    expect(store.activeState).toBeUndefined()
    expect(store.activeError).toBeUndefined()

    second.reject(new Error('[BACKEND_REJECTED] [backendCode=STATE_B_DOWN] B 失败'))
    await requestB
    expect(store.activeStatus).toBe('error')
    expect(store.activeError).toMatchObject({ code: 'BACKEND_REJECTED', backendCode: 'STATE_B_DOWN' })
    expect(store.activeState).toBeUndefined()
  })

  it('同 instance 的不同 revision 旧请求失败时，不得改写新 revision 的 loading/error', async () => {
    const first = deferred<CharacterPublicState>()
    const second = deferred<CharacterPublicState>()
    getCharacterState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    const requestA = store.loadState('instance-shared')
    store.setActiveBinding(binding(2), 'conversation-b')
    const requestB = store.loadState('instance-shared')

    first.reject(new Error('[BACKEND_REJECTED] [backendCode=STATE_A_DOWN] A 迟到失败'))
    await requestA
    expect(store.activeStatus).toBe('loading')
    expect(store.activeError).toBeUndefined()
    expect(store.statusByBindingKey).not.toHaveProperty('["instance-shared","builtin/elysia",2]', 'error')

    second.resolve(state(2, 1, 'B 正常状态'))
    await requestB
    expect(store.activeStatus).toBe('ready')
    expect(store.activeState).toMatchObject({ characterRevision: 2, currentActivity: 'B 正常状态' })
  })

  it('同 instance 的不同 revision ready 不短路；切换 B 后发起自己的 GET，切回 A 恢复 A 快照', async () => {
    getCharacterState.mockResolvedValueOnce(state(1, 1, 'A ready')).mockResolvedValueOnce(state(2, 2, 'B ready'))
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    await store.loadState('instance-shared')
    expect(store.activeState).toMatchObject({ characterRevision: 1, currentActivity: 'A ready' })

    store.setActiveBinding(binding(2), 'conversation-b')
    expect(store.activeState).toBeUndefined()
    const requestB = store.loadState('instance-shared')
    expect(store.activeStatus).toBe('loading')
    await requestB
    expect(getCharacterState).toHaveBeenCalledTimes(2)
    expect(store.activeState).toMatchObject({ characterRevision: 2, currentActivity: 'B ready' })

    store.setActiveBinding(binding(1), 'conversation-a')
    expect(store.activeState).toMatchObject({ characterRevision: 1, currentActivity: 'A ready' })
    expect(store.activeStatus).toBe('ready')
  })

  it('非活动会话可更新同 canonical instance 的另一 revision cache；活动视图和切换回来均不串', () => {
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    store.handleStateChanged(event(1, 1, 'conversation-a', 'A 初始'))
    store.handleStateChanged(event(2, 2, 'conversation-b', 'B 非活动'))

    expect(store.activeBinding).toMatchObject({ characterRevision: 1 })
    expect(store.activeState).toMatchObject({ characterRevision: 1, currentActivity: 'A 初始' })
    expect(store.statesByInstanceId['instance-shared']).toMatchObject({ characterRevision: 2, currentActivity: 'B 非活动' })

    store.setActiveBinding(binding(2), 'conversation-b')
    expect(store.activeState).toMatchObject({ characterRevision: 2, currentActivity: 'B 非活动' })
    store.setActiveBinding(binding(1), 'conversation-a')
    expect(store.activeState).toMatchObject({ characterRevision: 1, currentActivity: 'A 初始' })
  })

  it('同 instance 同 revision 的跨会话 WS 共享同一 revision 快照，并保持 stateVersion 单调', () => {
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    store.handleStateChanged(event(1, 2, 'conversation-b', '跨会话更新'))
    store.handleStateChanged(event(1, 1, 'conversation-c', '旧版本'))

    expect(store.activeState).toMatchObject({
      characterInstanceId: 'instance-shared',
      characterRevision: 1,
      stateVersion: 2,
      currentActivity: '跨会话更新'
    })
    store.setActiveBinding(binding(1), 'conversation-c')
    expect(store.activeState).toMatchObject({ stateVersion: 2, currentActivity: '跨会话更新' })
  })

  it('同 instance 跨 revision 的 WS 事件遵守全局 stateVersion 高水位', () => {
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    store.handleStateChanged(event(1, 5, 'conversation-a', 'rev1 高水位'))
    store.handleStateChanged(event(2, 4, 'conversation-b', 'rev2 旧事件'))
    store.handleStateChanged(event(2, 5, 'conversation-b', 'rev2 同版本事件'))

    expect(store.statesByBindingKey).not.toHaveProperty('["instance-shared","builtin/elysia",2]')
    expect(store.statesByInstanceId['instance-shared']).toMatchObject({ characterRevision: 1, stateVersion: 5, currentActivity: 'rev1 高水位' })

    store.handleStateChanged(event(2, 6, 'conversation-b', 'rev2 新事件'))
    expect(store.activeState).toMatchObject({ characterRevision: 1, stateVersion: 5, currentActivity: 'rev1 高水位' })
    store.setActiveBinding(binding(2), 'conversation-b')
    expect(store.activeState).toMatchObject({ characterRevision: 2, stateVersion: 6, currentActivity: 'rev2 新事件' })
  })

  it('REST snapshot 低于同 instance 全局 stateVersion 时不创建 revision cache，后续新版本仍可读取', async () => {
    getCharacterState
      .mockResolvedValueOnce(state(1, 5, 'rev1 高水位'))
      .mockResolvedValueOnce(state(2, 4, 'rev2 旧快照'))
      .mockResolvedValueOnce(state(2, 6, 'rev2 新快照'))
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    await store.loadState('instance-shared')

    store.setActiveBinding(binding(2), 'conversation-b')
    await store.loadState('instance-shared')
    expect(store.statesByBindingKey).not.toHaveProperty('["instance-shared","builtin/elysia",2]')
    expect(store.activeStatus).toBe('stale')
    expect(store.activeState).toBeUndefined()

    await store.loadState('instance-shared', true)
    expect(store.activeStatus).toBe('ready')
    expect(store.activeState).toMatchObject({ characterRevision: 2, stateVersion: 6, currentActivity: 'rev2 新快照' })
  })

  it('活动会话收到另一 revision 或另一 character 的 WS 事件时 fail-closed，不改写 active binding', () => {
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    store.handleStateChanged(event(1, 1, 'conversation-a', 'A 初始'))
    store.handleStateChanged(event(2, 2, 'conversation-a', '错误 revision'))
    store.handleStateChanged({
      ...event(1, 3, 'conversation-a', '错误 character'),
      characterId: 'builtin/cyrene',
      state: { proactiveEnabled: false, updatedAt: '2026-09-01T00:00:00.000Z' }
    })

    expect(store.activeBinding).toMatchObject({ characterId: 'builtin/elysia', characterRevision: 1 })
    expect(store.activeState).toMatchObject({ characterRevision: 1, stateVersion: 1, currentActivity: 'A 初始' })
  })

  it('REST 身份/请求 revision 不一致时记录脱敏错误；epoch 严格前进，2→1 的旧事件无效', async () => {
    getCharacterState.mockResolvedValueOnce({ ...state(2, 1), characterId: 'builtin/cyrene' })
    const store = useCharacterRuntimeStore()
    store.setActiveBinding(binding(1), 'conversation-a')
    await store.loadState('instance-shared')
    expect(store.activeStatus).toBe('error')
    expect(store.activeError).toMatchObject({ code: 'CHARACTER_STATE_IDENTITY_MISMATCH' })
    expect(store.activeError?.message).not.toContain('builtin/cyrene')

    store.setConnectionEpoch(2)
    store.setConnectionEpoch(1)
    expect(store.connectionEpoch).toBe(2)
    store.handleStateChanged(event(1, 99, 'conversation-a', '旧 epoch'), 1)
    expect(store.statesByBindingKey).toEqual({})
  })

  it('新 connectionScopeId 清空旧快照/错误/高水位并接受低 stateVersion；同 scope 只标 stale', () => {
    const store = useCharacterRuntimeStore()
    store.setConnectionScopeId('scope-a')
    store.setActiveBinding(binding(1), 'conversation-a')
    store.handleStateChanged(event(1, 99, 'conversation-a', '旧连接'))

    // Automatic reconnects keep the source scope and therefore retain the
    // offline snapshot while invalidating requests for a fresh snapshot.
    store.setConnectionEpoch(1)
    expect(store.activeStatus).toBe('stale')
    expect(store.activeState).toMatchObject({ stateVersion: 99, currentActivity: '旧连接' })
    store.setConnectionScopeId('scope-a')
    expect(store.activeState).toMatchObject({ stateVersion: 99 })

    // An explicit connect (even same endpoint/account/identity) has a new
    // local source scope. Its low version must not be blocked by old high-water.
    store.setConnectionScopeId('scope-b')
    expect(store.statesByInstanceId).toEqual({})
    expect(store.statesByBindingKey).toEqual({})
    expect(store.activeState).toBeUndefined()
    store.setConnectionEpoch(2)
    store.handleStateChanged(event(1, 1, 'conversation-a', '新连接'))
    expect(store.activeState).toMatchObject({ stateVersion: 1, currentActivity: '新连接' })
  })

  it('无 scope 的 legacy capability re-entry 可强制视为新来源', () => {
    const store = useCharacterRuntimeStore()
    store.setConnectionScopeId('scope-a')
    store.setActiveBinding(binding(1), 'conversation-a')
    store.handleStateChanged(event(1, 4, 'conversation-a', '旧来源'))
    store.setConnectionScopeId(undefined, true)
    expect(store.activeState).toBeUndefined()
    store.handleStateChanged(event(1, 1, 'conversation-a', 'legacy 新来源'))
    expect(store.activeState).toMatchObject({ stateVersion: 1, currentActivity: 'legacy 新来源' })
  })
})
