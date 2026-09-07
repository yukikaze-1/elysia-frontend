import type { BackendFeatureFlags } from '@shared/contracts'
import type { BackendAdapter } from '../transport/backend-adapter'
import type { CharacterServiceBackendPort } from './character-backend-port'

/**
 * Main 为 CharacterService 解析出的领域端口与能力来源。
 *
 * RealBackend 同时实现 BackendAdapter 与 CharacterServiceBackendPort；这里
 * 只保留角色领域端口，不把 transport 的通用请求能力向 CharacterService
 * 暴露。Mock 则继续使用自己的显式角色端口与能力快照。
 */
export interface CharacterServiceBackendAssembly {
  backend: CharacterServiceBackendPort
  getFeatures: () => BackendFeatureFlags | undefined
}

export interface CharacterServiceBackendAssemblyOptions {
  useMock: boolean
  adapter: BackendAdapter
  mockBackend?: CharacterServiceBackendPort
  getMockFeatures?: () => BackendFeatureFlags | undefined
}

/**
 * 解析 Main 当前模式的角色领域依赖。
 *
 * 不在此处复制连接状态；Real 的能力 getter 每次读取 adapter 当前快照，
 * 因而 server_info 在连接/来源切换后的能力替换会被 CharacterService 观察到。
 */
export function resolveCharacterServiceBackend(
  options: CharacterServiceBackendAssemblyOptions
): CharacterServiceBackendAssembly {
  if (options.useMock) {
    if (!options.mockBackend) throw new Error('Mock 角色后端未装配')
    return {
      backend: options.mockBackend,
      getFeatures: options.getMockFeatures ?? (() => undefined)
    }
  }

  // RealBackend 明确 implements BackendAdapter, CharacterServiceBackendPort；
  // Main 的共享变量以 BackendAdapter 保存，避免把角色端口扩散给其他服务。
  const backend = options.adapter as BackendAdapter & CharacterServiceBackendPort
  return {
    backend,
    getFeatures: () => options.adapter.getConnectionState().features
  }
}
