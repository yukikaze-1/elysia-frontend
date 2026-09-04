import { describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import type { CharacterBindingSnapshot, ConnectionState } from '@shared/contracts'
import { createCharacterRuntimeCoordinator } from '../../src/renderer/src/stores/character-runtime-coordinator'

function binding(id: string, instanceId = `instance-${id}`): CharacterBindingSnapshot {
  return {
    characterId: `builtin/${id}`,
    characterInstanceId: instanceId,
    characterRevision: 1,
    displayName: id,
    presentation: {}
  }
}

describe('characterRuntimeCoordinator（FE-F1）', () => {
  it('connected + characterProfiles=true 时按活动 binding 读取 snapshot', () => {
    const conversation = reactive({ currentId: 'conversation-a', currentCharacter: binding('elysia') })
    const connection = reactive<{ state: ConnectionState }>({
      state: { status: 'connected', connectionId: 'c1', features: { characterProfiles: true, characterStateStream: false } }
    })
    const runtime = {
      activeBinding: undefined as CharacterBindingSnapshot | undefined,
      setActiveBinding: vi.fn((next: CharacterBindingSnapshot | undefined) => { runtime.activeBinding = next }),
      loadState: vi.fn(async () => {})
    }
    const coordinator = createCharacterRuntimeCoordinator(conversation, connection, runtime)
    coordinator.start()

    expect(runtime.activeBinding).toMatchObject({ characterId: 'builtin/elysia' })
    expect(runtime.loadState).toHaveBeenCalledWith('instance-elysia', expect.objectContaining({ characterId: 'builtin/elysia' }))
    coordinator.stop()
  })

  it('离线保留活动 binding，读取已缓存 stale 由 runtime/UI 负责且不发起 REST', async () => {
    const conversation = reactive({ currentId: 'conversation-a', currentCharacter: binding('elysia') })
    const connection = reactive<{ state: ConnectionState }>({ state: { status: 'disconnected' } })
    const runtime = {
      activeBinding: undefined as CharacterBindingSnapshot | undefined,
      setActiveBinding: vi.fn((next: CharacterBindingSnapshot | undefined) => { runtime.activeBinding = next }),
      loadState: vi.fn(async () => {})
    }
    const coordinator = createCharacterRuntimeCoordinator(conversation, connection, runtime)
    coordinator.start()
    expect(runtime.activeBinding?.characterId).toBe('builtin/elysia')
    expect(runtime.loadState).not.toHaveBeenCalled()

    connection.state = { status: 'connected', connectionId: 'c2', features: { characterProfiles: true, characterStateStream: false } }
    await nextTick()
    await Promise.resolve()
    expect(runtime.activeBinding?.characterId).toBe('builtin/elysia')
    expect(runtime.loadState).toHaveBeenCalledTimes(1)
    coordinator.stop()
  })

  it('快速 A→B 只把 B 作为活动 binding，请求捕获各自身份', async () => {
    const a = binding('elysia', 'instance-a')
    const b = binding('cyrene', 'instance-b')
    const conversation = reactive({ currentId: 'conversation-a', currentCharacter: a })
    const connection = reactive<{ state: ConnectionState }>({
      state: { status: 'connected', connectionId: 'c1', features: { characterProfiles: true, characterStateStream: true } }
    })
    const runtime = {
      activeBinding: undefined as CharacterBindingSnapshot | undefined,
      setActiveBinding: vi.fn((next: CharacterBindingSnapshot | undefined) => { runtime.activeBinding = next }),
      loadState: vi.fn(async () => {})
    }
    const coordinator = createCharacterRuntimeCoordinator(conversation, connection, runtime)
    coordinator.start()
    conversation.currentId = 'conversation-b'
    conversation.currentCharacter = b
    await nextTick()
    await Promise.resolve()

    expect(runtime.activeBinding).toMatchObject({ characterId: 'builtin/cyrene', characterInstanceId: 'instance-b' })
    expect(runtime.loadState).toHaveBeenNthCalledWith(1, 'instance-a', expect.objectContaining({ characterId: 'builtin/elysia' }))
    expect(runtime.loadState).toHaveBeenNthCalledWith(2, 'instance-b', expect.objectContaining({ characterId: 'builtin/cyrene' }))
    coordinator.stop()
  })

  it('characterStateStream 单独变化时重新同步并重新读取 snapshot', async () => {
    const conversation = reactive({ currentId: 'conversation-a', currentCharacter: binding('elysia') })
    const connection = reactive<{ state: ConnectionState }>({
      state: { status: 'connected', connectionId: 'c1', features: { characterProfiles: true, characterStateStream: false } }
    })
    const runtime = {
      activeBinding: undefined as CharacterBindingSnapshot | undefined,
      setActiveBinding: vi.fn((next: CharacterBindingSnapshot | undefined) => { runtime.activeBinding = next }),
      loadState: vi.fn(async () => {})
    }
    const coordinator = createCharacterRuntimeCoordinator(conversation, connection, runtime)
    coordinator.start()
    expect(runtime.loadState).toHaveBeenCalledTimes(1)

    connection.state = { status: 'connected', connectionId: 'c1', features: { characterProfiles: true, characterStateStream: true } }
    await nextTick()
    await Promise.resolve()
    expect(runtime.activeBinding).toMatchObject({ characterInstanceId: 'instance-elysia' })
    expect(runtime.loadState).toHaveBeenCalledTimes(2)
    coordinator.stop()
  })

  it('stop 后 watcher 不再同步，且停止前排队的同步不会落到 runtime', async () => {
    const conversation = reactive({ currentId: 'conversation-a', currentCharacter: binding('elysia') })
    const connection = reactive<{ state: ConnectionState }>({
      state: { status: 'connected', connectionId: 'c1', features: { characterProfiles: true, characterStateStream: true } }
    })
    const runtime = {
      activeBinding: undefined as CharacterBindingSnapshot | undefined,
      setActiveBinding: vi.fn((next: CharacterBindingSnapshot | undefined) => { runtime.activeBinding = next }),
      loadState: vi.fn(async () => {})
    }
    const coordinator = createCharacterRuntimeCoordinator(conversation, connection, runtime)
    coordinator.start()
    conversation.currentId = 'conversation-b'
    conversation.currentCharacter = binding('cyrene', 'instance-b')
    coordinator.stop()
    await nextTick()
    await Promise.resolve()
    expect(runtime.loadState).toHaveBeenCalledTimes(1)
  })

  it('start-stop-start 时旧周期排队的 microtask 不得影响新周期', async () => {
    const a = binding('elysia', 'instance-a')
    const b = binding('cyrene', 'instance-b')
    const conversation = reactive({ currentId: 'conversation-a', currentCharacter: a })
    const connection = reactive<{ state: ConnectionState }>({
      state: { status: 'connected', connectionId: 'c1', features: { characterProfiles: true, characterStateStream: true } }
    })
    const runtime = {
      activeBinding: undefined as CharacterBindingSnapshot | undefined,
      setActiveBinding: vi.fn((next: CharacterBindingSnapshot | undefined) => { runtime.activeBinding = next }),
      loadState: vi.fn(async () => {})
    }
    const coordinator = createCharacterRuntimeCoordinator(conversation, connection, runtime)
    coordinator.start()

    conversation.currentId = 'conversation-b'
    conversation.currentCharacter = b
    // Let Vue run the watcher callback, but stop before its explicitly queued
    // microtask gets a chance to reconcile the binding.
    await Promise.resolve()
    coordinator.stop()
    coordinator.start()
    await Promise.resolve()

    expect(runtime.activeBinding).toMatchObject({ characterId: 'builtin/cyrene', characterInstanceId: 'instance-b' })
    expect(runtime.loadState).toHaveBeenCalledTimes(2)
    expect(runtime.loadState).toHaveBeenNthCalledWith(2, 'instance-b', expect.objectContaining({ characterId: 'builtin/cyrene' }))
    coordinator.stop()
  })
})
