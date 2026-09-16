import type { BackendFeatureFlags } from '@shared/contracts'
import type { BackendConnectionPort } from '../transport/backend-ports'
import type { CharacterServiceBackendPort } from './character-backend-port'

/**
 * Main 为 CharacterService 解析出的领域端口与能力来源。
 *
 * Real 分支的两个能力来自**同一个 RealBackend 实例**的两张窄视图：角色领域端口
 * （`CharacterServiceBackendPort`）与连接状态快照（能力旗标来源）。Mock 则继续使用自己的
 * 显式角色端口与能力快照——它不读连接状态，故 `adapter` 在 mock 分支不参与装配。
 */
export interface CharacterServiceBackendAssembly {
  backend: CharacterServiceBackendPort
  getFeatures: () => BackendFeatureFlags | undefined
}

/** CharacterServiceBackendPort + 连接状态快照的组合视图（角色域看不到 Chat/Voice/Model/Tool 等方法） */
export type CharacterServiceAdapter = CharacterServiceBackendPort & BackendConnectionPort

export interface CharacterServiceBackendAssemblyOptions {
  useMock: boolean
  /**
   * Real 分支必填（可选性由下面的重载保证：`{ useMock: false }` 缺它就是编译错误）；类型是两个
   * 端口视图的交集，而不是聚合面。Mock 分支不读它（能力快照另有来源）。
   */
  adapter?: CharacterServiceAdapter
  mockBackend?: CharacterServiceBackendPort
  getMockFeatures?: () => BackendFeatureFlags | undefined
}

/**
 * 解析 Main 当前模式的角色领域依赖。
 *
 * 不在此处复制连接状态；Real 的能力 getter 每次读取 adapter 当前快照，
 * 因而 server_info 在连接/来源切换后的能力替换会被 CharacterService 观察到。
 */
// 重载（架构整改 Prompt 3 反向 review M9 收口）：`useMock: false` 必须携带 adapter——这是**编译期**
// 约束，不是运行期检查；mock 分支保留可选的 adapter 以维持既有单测的"不读 adapter 能力"断言。
export function resolveCharacterServiceBackend(
  options: { useMock: true; mockBackend?: CharacterServiceBackendPort; getMockFeatures?: () => BackendFeatureFlags | undefined; adapter?: CharacterServiceAdapter }
): CharacterServiceBackendAssembly
export function resolveCharacterServiceBackend(
  options: { useMock: false; adapter: CharacterServiceAdapter }
): CharacterServiceBackendAssembly
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

  // 组合根传入的 RealBackend 同时满足两个端口视图（类声明里 `implements BackendAdapter, CharacterServiceBackendPort`
  // 由编译器证明），故这里直接取值——不需要任何类型断言。运行期判空是 fail-closed 的第二道（重载已挡住
  // "real 分支不带 adapter" 的调用）。
  const adapter = options.adapter
  if (!adapter) throw new Error('Real 角色后端未装配')
  return {
    backend: adapter,
    getFeatures: () => adapter.getConnectionState().features
  }
}
