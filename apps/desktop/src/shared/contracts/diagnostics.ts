// src/shared/contracts/diagnostics.ts
// 阶段 7 批次 A（D7A-06/15）：诊断功能契约层——「开发与诊断」设置页（日志管理/开发者模式/
// 连接诊断/脱敏诊断导出）。约束：displayDir 为 sanitize 后展示形态（绝对路径不上行，M-2）；
// dev-event 仅元数据零正文（原始 arguments/内容永不进 Renderer）。
/** 诊断状态（diagnostics:state 响应）：devMode 为会话态；lastCleanup 承载 clear-logs 结果回显 */
export interface DiagnosticsState {
  devMode: boolean
  displayDir: string
  logSizeBytes: number
  logFiles: Array<{ name: string; sizeBytes: number; modifiedAt: string }>
  retentionDays: number
  auditRetentionDays: number
  eventDropped: number
  lastCleanup: { removedFiles: number; freedBytes: number } | null
}

/** 开发者模式协议事件条目（push）：仅元数据字段白名单 {ts, type, preview}——先 redact+sanitize 双净化再截断 */
export interface DiagnosticsDevEvent {
  ts: string
  type: string
  preview: string
}

/** 诊断导出结果（diagnostics:export 响应）：判别联合——cancelled 常量分支区分成功/用户取消 */
export type DiagnosticsExportResult =
  | { cancelled: false; displayPath: string; sizeBytes: number; truncatedLog: boolean; truncatedAudit: boolean }
  | { cancelled: true }

/** dev-event preview 截断上界（含尾标「…」——先截 199 再补尾标，D7A-15/契约 R2-2） */
export const DIAGNOSTICS_PREVIEW_MAX = 200
/** dev-event type（领域事件名）上界 */
export const DIAGNOSTICS_TYPE_MAX = 64

// —— 阶段 7 批次 B（Task 1）：Renderer 崩溃 marker 契约（diagnostics:last-crash 响应）——
/** Renderer 崩溃 reason 闭合枚举：8 值（不存在于 wire 字段之外便不可注入，fail-closed） */
export type RendererCrashReason = 'clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' | 'oom' | 'launch-failed' | 'integrity-failure' | 'memory-eviction'
/** Renderer 崩溃事件（最近一次崩溃 marker；read-after-clear——读取后 Main 侧清空） */
export interface RendererCrashEvent { reason: RendererCrashReason; exitCode: number }
