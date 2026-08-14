// src/shared/domain/history-date.ts
// 阶段 3 G4（spec §4.4，D3）：日期时区纯函数（Intl 实现，双端复用）。
// 禁止 naive 本地日期假设（docs/02 §11「避免 UTC 跨日错误」）；无 Electron/无状态依赖。

function getTimezoneOffsetMs(timeZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wallAsUtc - utcMs   // 该 UTC 瞬间下目标时区的偏移（ms）
}

/** 目标时区「本地墙钟时间」→ UTC 毫秒（两遍法：先按墙钟当 UTC 算偏移再修正，正确处理 DST 常规场景） */
function zonedTimeToUtc(y: number, m: number, d: number, h: number, min: number, s: number, timeZone: string): number {
  const asUtc = Date.UTC(y, m - 1, d, h, min, s)
  return asUtc - getTimezoneOffsetMs(timeZone, asUtc)
}

/** localDate(YYYY-MM-DD) + IANA timeZone → 半开区间 [本地日起始, 次日本地日起始) 的 UTC ISO 串 */
export function localDateToHalfOpenRange(localDate: string, timeZone: string): { from: string; to: string } {
  const [y, m, d] = localDate.split('-').map(Number)
  const from = new Date(zonedTimeToUtc(y, m, d, 0, 0, 0, timeZone)).toISOString()
  const to = new Date(zonedTimeToUtc(y, m, d + 1, 0, 0, 0, timeZone)).toISOString()   // Date.UTC 自动处理月/日进位
  return { from, to }
}

/** ISO 时间 → 用户本地自然日标签(YYYY-MM-DD)，供结果日期分组 */
export function isoToLocalDate(iso: string, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = dtf.formatToParts(new Date(iso))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
