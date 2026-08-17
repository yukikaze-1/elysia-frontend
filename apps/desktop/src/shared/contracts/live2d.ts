// src/shared/contracts/live2d.ts
// 阶段 5 批次 A（spec D5A-07）：Live2D 模型摘要共享契约。
// 注：Live2DSettings（enabled/modelId）归 Task 6（A6）在本文件扩展；本任务只定义 Live2DModelSummary。

/**
 * Main 模型注册表摘要（registry.listInstalledModels 产出；经 IPC live2d:list-models 供 Renderer）。
 * 字段 = doc 05 §3 Live2DModelSummary 的扩展超集（多出 licenseRef/integrityState/两级 available）。
 * 仅 available=false 时给脱敏原因（枚举码 missing_file/size_mismatch/hash_mismatch，非原始错误文本）。
 */
export type Live2DIntegrityState = 'unverified' | 'verified' | 'failed'

export interface Live2DModelSummary {
  id: string
  displayName: string
  preview: string | null   // 相对模型目录的预览图路径；无则 null（UI 占位）
  version: string          // manifest.version ?? '0'
  available: boolean       // 两级可用性：manifest 合法 + integrity 覆盖的模型文件存在且尺寸一致
  reason?: string          // 仅 available=false 时给出，脱敏枚举码
  licenseRef: string       // 模型目录内许可文件相对路径（validation 要求存在）
  integrityState: Live2DIntegrityState  // unverified（list 未 hash 复核）/ verified（verifyIntegrity 通过）/ failed
}
