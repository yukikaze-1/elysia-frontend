// src/shared/domain/history-date.ts
// 阶段 3 G4（spec §4.4，D3）：日期时区纯函数（Intl 实现，双端复用）。
// 禁止 naive 本地日期假设（docs/02 §11「避免 UTC 跨日错误」）；无 Electron/无状态依赖。
// 阶段3 联调前整改 P0-01：localDateToHalfOpenRange 及其私有助手已删除（后端按自然日自转），
// 仅保留 isoToLocalDate 供 mock 自然日过滤等本地用途。

/** ISO 时间 → 用户本地自然日标签(YYYY-MM-DD)，供结果日期分组 */
export function isoToLocalDate(iso: string, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = dtf.formatToParts(new Date(iso))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
