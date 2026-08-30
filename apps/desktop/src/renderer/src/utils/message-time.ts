// 消息时间展示纯函数（UII-QQ 时间戳批次）：全部经 Intl.DateTimeFormat 按注入 timeZone 格式化，
// 禁止 ISO 字符串截取/naive 本地假设（同 domain/history-date 口径）；非法 createdAt 一律返回 null
// 由调用方安全隐藏（不抛错、不显示 Invalid Date）。now/timeZone/locale 可注入，供测试固定基准。
import type { Message } from '@shared/contracts'
import { estimateMessageHeight } from './virtual-window'

export interface TimeTextOpts {
  now?: Date          // 相对标签（今天/昨天）基准时刻；默认 new Date()
  timeZone?: string   // IANA 时区；缺省 = 用户本地时区（Intl 默认语义）
  locale?: string     // 缺省 = 运行环境默认 locale
}

/** Intl.DateTimeFormat 构造昂贵，按 (locale,timeZone,options) 缓存复用（长会话逐行调用） */
const formatterCache = new Map<string, Intl.DateTimeFormat>()
function cachedFormatter(locale: string | undefined, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${timeZone ?? ''}|${JSON.stringify(opts)}`
  let f = formatterCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone })
    formatterCache.set(key, f)
  }
  return f
}

/** 解析 createdAt：非法（空/非字符串/NaN）→ null，不抛错 */
export function parseMessageDate(createdAt: string): Date | null {
  if (typeof createdAt !== 'string' || createdAt === '') return null
  const d = new Date(createdAt)
  return Number.isNaN(d.getTime()) ? null : d
}

/** HH:mm（24 小时制 hourCycle=h23，午夜 00:xx 而非 24:xx）；非法 → null */
export function formatMessageTime(createdAt: string, opts?: TimeTextOpts): string | null {
  const d = parseMessageDate(createdAt)
  if (!d) return null
  return cachedFormatter(opts?.locale, opts?.timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
}

/** 完整本地时间 'YYYY年M月D日 HH:mm:ss'（固定中文顺序，数值取自 Intl parts，locale 不影响口径）；非法 → null */
export function formatFullTime(createdAt: string, opts?: TimeTextOpts): string | null {
  const d = parseMessageDate(createdAt)
  if (!d) return null
  const parts = cachedFormatter(opts?.locale, opts?.timeZone, {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}年${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}:${get('second')}`
}

/** 本地自然日键 'YYYY-MM-DD'（语义同 domain.isoToLocalDate，带 formatter 缓存）；非法 → null */
export function localDayKey(iso: string, timeZone?: string): string | null {
  const d = parseMessageDate(iso)
  if (!d) return null
  const parts = cachedFormatter(undefined, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 日键平移 N 天：在键（纯日历值）上做 UTC 正午锚点加减，天然规避 DST/月末边界 */
function shiftDayKey(key: string, deltaDays: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + deltaDays, 12))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** 日期分隔标签：今天 / 昨天 / 本年度更早 '8月29日' / 跨年度 '2025年12月31日'。
 *  相对判断基于注入 now 的本地日键（调用方跨午夜刷新 now 即可刷新标签） */
export function daySeparatorLabel(dayKey: string, opts?: TimeTextOpts): string {
  const now = opts?.now ?? new Date()
  const todayKey = Number.isNaN(now.getTime()) ? null : localDayKey(now.toISOString(), opts?.timeZone)
  if (!todayKey) return dayKey
  if (dayKey === todayKey) return '今天'
  if (dayKey === shiftDayKey(todayKey, -1)) return '昨天'
  const [y, m, d] = dayKey.split('-').map(Number)
  const md = `${m}月${d}日`
  return y === Number(todayKey.slice(0, 4)) ? md : `${y}年${md}`
}

/**
 * 全量消息 → 全局 index → 本地日键：哪些消息需要在其行内渲染日期分隔。
 * - 判定恒基于全量 items（与虚拟窗口 startIndex 无关——否则窗口切换会把首个可见消息误判为新日期）；
 * - 跳过 role='tool' 空占位（不产生分隔、不充当比较基线）；首条非 tool 恒分隔；
 * - createdAt 非法的消息自身不分隔、也不更新比较基线。
 */
export function dayFirstDayKeys(items: Message[], timeZone?: string): Map<number, string> {
  const map = new Map<number, string>()
  let prevKey: string | undefined   // undefined = 尚未见过带合法日期的非 tool 消息
  for (let i = 0; i < items.length; i++) {
    const m = items[i]
    if (!m || m.role === 'tool') continue
    const key = localDayKey(m.createdAt, timeZone)
    if (key === null) continue
    if (prevKey === undefined || key !== prevKey) map.set(i, key)
    prevKey = key
  }
  return map
}

/** 日期分隔行估高补额（未实测行的前缀和口径；实测路径由 ResizeObserver border-box 天然含分隔高度） */
export const DAY_SEPARATOR_ESTIMATE_PX = 40

/** 消息行估高：日首消息在 estimateMessageHeight 基础上加分隔补额，避免跨多天长会话前缀和持续低估 */
export function estimateMessageRowHeight(m: Message, isDayFirst: boolean): number {
  return estimateMessageHeight(m) + (isDayFirst ? DAY_SEPARATOR_ESTIMATE_PX : 0)
}
