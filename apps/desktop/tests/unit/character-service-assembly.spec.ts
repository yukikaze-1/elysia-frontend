import { describe, expect, it, vi } from 'vitest'
import type { BackendConnectionPort } from '../../src/main/transport/backend-ports'
import type { CharacterServiceBackendPort } from '../../src/main/characters/character-backend-port'
import { resolveCharacterServiceBackend } from '../../src/main/characters/character-service-assembly'

function makeCharacterPort(): CharacterServiceBackendPort {
  return {
    getMe: vi.fn(),
    updateMe: vi.fn(),
    listCharacters: vi.fn(),
    getCharacter: vi.fn(),
    createCharacter: vi.fn(),
    updateCharacter: vi.fn(),
    cloneCharacter: vi.fn(),
    archiveCharacter: vi.fn(),
    rollbackCharacter: vi.fn(),
    validateCharacter: vi.fn(),
    previewCharacter: vi.fn(),
    listCharacterRevisions: vi.fn(),
    getCharacterState: vi.fn(),
    resetCharacterEvolution: vi.fn()
  }
}

describe('CharacterService Main backend 装配', () => {
  it('Real 使用当前 adapter 的结构化角色端口与实时 ConnectionState 能力', () => {
    const state = { status: 'connected' as const, features: { characterProfiles: true, characterStateStream: false } }
    const realAdapter = { getConnectionState: vi.fn(() => state) } as unknown as CharacterServiceBackendPort & BackendConnectionPort

    const resolved = resolveCharacterServiceBackend({ useMock: false, adapter: realAdapter })

    expect(resolved.backend).toBe(realAdapter)
    expect(resolved.getFeatures()).toEqual({ characterProfiles: true, characterStateStream: false })
    state.features = { characterProfiles: false, characterStateStream: true }
    expect(resolved.getFeatures()).toEqual({ characterProfiles: false, characterStateStream: true })
    expect(realAdapter.getConnectionState).toHaveBeenCalledTimes(2)
  })

  it('Real 模式缺少 adapter 时 fail closed：重载已在类型层禁止，运行期仍有第二道', () => {
    // 类型层由重载保证（`{ useMock: false }` 缺 adapter 即编译错误）；这条用例走"未经类型检查的调用方"
    // 路径，验运行期仍然 fail closed（JS 调用方 / 跨边界传对象）。
    const untyped = resolveCharacterServiceBackend as unknown as (options: unknown) => unknown
    expect(() => untyped({ useMock: false })).toThrow('Real 角色后端未装配')
  })

  it('Mock 保留显式角色端口与 features 来源，不读取 adapter 能力', () => {
    const mockBackend = makeCharacterPort()
    const mockFeatures = { characterProfiles: true, characterStateStream: true } as const
    const adapter = { getConnectionState: vi.fn(() => ({ status: 'connected' as const, features: { characterProfiles: false, characterStateStream: false } })) } as unknown as CharacterServiceBackendPort & BackendConnectionPort
    const resolved = resolveCharacterServiceBackend({
      useMock: true,
      adapter,
      mockBackend,
      getMockFeatures: () => mockFeatures
    })

    expect(resolved.backend).toBe(mockBackend)
    expect(resolved.getFeatures()).toBe(mockFeatures)
    expect(adapter.getConnectionState).not.toHaveBeenCalled()
  })

  it('Mock 模式缺少角色端口时 fail closed', () => {
    const adapter = { getConnectionState: vi.fn(() => ({ status: 'disconnected' as const })) } as unknown as CharacterServiceBackendPort & BackendConnectionPort
    expect(() => resolveCharacterServiceBackend({ useMock: true, adapter })).toThrow('Mock 角色后端未装配')
  })
})
