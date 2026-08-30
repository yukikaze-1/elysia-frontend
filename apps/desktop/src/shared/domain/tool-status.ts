// src/shared/domain/tool-status.ts
// 工具失败结果的展示态分类（UII-QQ 工具卡二轮收尾）：用户取消/超时/真实失败按稳定错误类型严格等值区分，
// 只影响展示态（ToolCallStatus），不修改 wire 协议与 ToolCallRecord 契约。分类依据（仓库内实际字段，不猜测扩大）：
// - wire tool.status 六态含 'cancelled'（tool-status-sender：用户取消回传 cancelled、无 error 载荷）；
// - repo 值枚举含 'cancelled'/'timeout'（contracts/backend RepoCallStatus）；
// - Main 先例错误码：TIMEOUT（截图会话超时/服务端过期）；CANCELLED（message.store isCancellationCode，D3）。
// 后端归档 error_type 的确切取值需以后端数据为准——未命中分类的一律按真实失败处理（不伪造取消）。
export const TOOL_CANCEL_ERROR_TYPES: readonly string[] = ['CANCELLED', 'TOOL_CANCELLED', 'USER_CANCELLED']

export function isToolCancelType(errorType: string | undefined): boolean {
  return errorType !== undefined && TOOL_CANCEL_ERROR_TYPES.includes(errorType)
}

export function isToolTimeoutType(errorType: string | undefined): boolean {
  return errorType === 'TIMEOUT'
}

/** 旧归档只有错误文字、无 error_type 的严格兼容：完全等于固定文案才按取消（禁止宽泛 includes('取消') 猜测）。 */
export const TOOL_CANCEL_LEGACY_TEXTS: readonly string[] = ['用户取消', '用户取消选择']

export type ClassifiedToolStatus = 'completed' | 'failed' | 'cancelled' | 'timeout'

/** 归档配对分类（pairToolCalls 用）：R-A3 空串错误视为成功（D6B-21）→ completed；
 *  无错误且 success≠false → completed（缺省视为 true）；有错误或 success=false 时按 errorType
 *  分类取消/超时（旧归档无 errorType 时仅接受固定文案全等），未命中一律真实失败。 */
export function classifyArchivedToolStatus(info: { success?: boolean; error?: string; errorType?: string }): ClassifiedToolStatus {
  const hasError = info.error !== undefined && info.error !== ''
  if (info.error === '') return 'completed'   // R-A3（D6B-21）：空串无失败细节
  if (!hasError && info.success !== false) return 'completed'
  if (isToolCancelType(info.errorType)) return 'cancelled'
  if (isToolTimeoutType(info.errorType)) return 'timeout'
  if (hasError && info.errorType === undefined && TOOL_CANCEL_LEGACY_TEXTS.includes(info.error!)) return 'cancelled'
  return 'failed'
}
