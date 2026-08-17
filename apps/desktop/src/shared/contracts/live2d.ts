// src/shared/contracts/live2d.ts
// 阶段 5 批次 A（spec D5A-07/D5A-10）：Live2D 模型摘要 + 本地设置契约。
// Live2DModelSummary 随 Task 2（A3）落地；Live2DSettings（enabled/modelId）由 Task 6（A6）扩展，
// 供 SettingsState/SettingsPatch 持久化（docs/11 §7.1 子集，完整设置 UI 归批次 B/B5）。
// 注：Live2DSettings 经 contracts/voice.ts SettingsState 接入 schema 栈（shared/schemas/ipc-response.ts
// SettingsStateSchema.live2d 带 .default(DEFAULT_LIVE2D)，旧 settings.json 无该段不破坏既有 voice/dictation）。

/** 本地设置（D5A-10）。enabled 语义：缺省 true；与 G1 布局折叠标志 live2dShown（布局级隐藏）正交；
 *  modelId 为已加载模型 id（null = 未选择/默认首个可用）。 */
export interface Live2DSettings {
  enabled: boolean
  modelId: string | null
}

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
