// src/shared/contracts/live2d.ts
// 阶段 5 批次 A（spec D5A-07/D5A-10）：Live2D 模型摘要 + 本地设置契约。
// Live2DModelSummary 随 Task 2（A3）落地；Live2DSettings（enabled/modelId）由 Task 6（A6）扩展，
// 供 SettingsState/SettingsPatch 持久化（docs/11 §7.1 子集，完整设置 UI 归批次 B/B5）。
// 阶段 5 批次 B（B5，D5B-06/D5B-08）：Live2DSettings 扩为 doc 05 §14 全量 10 字段 + 新建四值
// PerformanceMode（统一 'auto'|'quality'|'balanced'|'low_power'，D5B-06；旧三值 'high'/'low' 读回归一）。
// 注：Live2DSettings 经 contracts/voice.ts SettingsState 接入 schema 栈（shared/schemas/ipc-response.ts
// SettingsStateSchema.live2d 带 .default(DEFAULT_LIVE2D)，旧 settings.json 无新字段也不破坏既有 voice/dictation）。

/** 性能模式（doc 05 §12，D5B-06 唯一枚举）。批次 A Controller 的三值 'auto'|'high'|'low' 已并入本四值：
 *  'high'→'quality'、'low'→'low_power' 由 schema 归一函数处理。帧率/降帧消费归批次 C。 */
export type PerformanceMode = 'auto' | 'quality' | 'balanced' | 'low_power'

/**
 * `cyrene://` Live2D 供给分支的路径前缀（不含 scheme/host）——**协议层、适配器、dev 供给通道的单一来源**。
 *
 * 2026-09-10 收口：此前 Main 侧 protocol/live2d-path.ts 与 Renderer 侧 adapter.ts 各写一份字面量，
 * 只靠注释声明「二者对应」。dev 形态模型加载失败的排查中，正是这条隐式耦合让「谁在什么 origin 上
 * 请求哪个 scheme」难以一眼看出。现改为共享常量：改一处即两边同步。
 * 完整 URL 形态：打包/preview = `cyrene://renderer${LIVE2D_PATH_PREFIX}{modelId}/{relPath}`。
 */
export const LIVE2D_PATH_PREFIX = '/__cyrene-live2d/'

/** Live2D 性能读数（7D）：FrameBudget 帧耗时 EMA + 目标帧率 + 模式——诊断页「Live2D 性能」数据源。 */
export interface Live2dFrameStats {
  emaCostMs: number
  autoTargetFps: number | null
  mode: PerformanceMode
}

/** 本地设置（D5B-08 全量 10 字段）。enabled 语义：缺省 true；与 G1 布局折叠标志 live2dShown（布局级隐藏）正交；
 *  modelId 为已加载模型 id（null = 未选择/默认首个可用）；scale∈[0.5,3]、offsetX/Y∈[-2,2] 安全钳制。 */
export interface Live2DSettings {
  enabled: boolean
  modelId: string | null
  scale: number
  offsetX: number
  offsetY: number
  mouseTracking: boolean
  autoMotions: boolean
  lipSync: boolean
  performanceMode: PerformanceMode
  reduceMotion: boolean
}

/**
 * Main 模型注册表摘要（registry.listInstalledModels 产出；经 IPC live2d:list-models 供 Renderer）。
 * 字段 = doc 05 §3 Live2DModelSummary 的扩展超集（多出 licenseRef/integrityState/两级 available）。
 * 仅 available=false 时给脱敏原因（枚举码 missing_file/size_mismatch/hash_mismatch，非原始错误文本）。
 * M4（批次 C 收口）：reason 闭合联合（原开放 string）——消费端可收窄、schema 拒绝非三码字符串（防字符串注入 UI）。
 */
export type Live2DIntegrityState = 'unverified' | 'verified' | 'failed'
/** available=false 的脱敏原因枚举码（M4 闭合：三码，不引第 4 个——manifest.id 错配等用最贴近码 missing_file） */
export type Live2DUnavailableReason = 'missing_file' | 'size_mismatch' | 'hash_mismatch'

export interface Live2DModelSummary {
  id: string
  displayName: string
  preview: string | null   // 相对模型目录的预览图路径；无则 null（UI 占位）
  version: string          // manifest.version ?? '0'
  available: boolean       // 两级可用性：manifest 合法 + integrity 覆盖的模型文件存在且尺寸一致
  reason?: Live2DUnavailableReason // 仅 available=false 时给出，脱敏枚举码
  licenseRef: string       // 模型目录内许可文件相对路径（validation 要求存在）
  integrityState: Live2DIntegrityState  // unverified（list 未 hash 复核）/ verified（verifyIntegrity 通过）/ failed
}

/**
 * 模型文件读取结果（IPC `live2d:read-model-file`）——**dev 形态专用供给通道**。
 *
 * 为什么存在（2026-09-10）：dev 形态（`pnpm dev`）页面由 Vite dev server 供给，origin 是
 * `http://localhost:<port>`；模型文件却只在 `cyrene://renderer/__cyrene-live2d/…` 上。scheme 恒
 * `corsEnabled:false`（阶段 5 D-4 安全结论：放开后非受信 origin 也能读 `cyrene://` 资源），故跨源 fetch
 * 被 Chromium 直接拒绝，界面只能显示原生 `Failed to fetch`——而模型清单走 invoke 通道不受影响，
 * 于是表现为「清单 3/3 可用，却加载失败」。打包/preview 形态页面自身即 `cyrene://renderer`（同源），
 * 仍走协议通道，不经本通道。
 *
 * 不授予额外能力：打包形态下 Renderer 本就能同源 fetch 同一批字节，本通道只是把等价读取搬到 dev 可用的
 * 传输上；门禁（verify → registered/available → containment 白名单）与协议通道共用 serve-gate.ts 同一实现。
 * `ok:false` 只回 HTTP 语义状态码，不回原因文本——原始错误留在 Main。
 */
export type Live2dModelFileResult =
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; status: number }
