import type { CharacterPublicState } from '@shared/contracts'

/**
 * The public state card deliberately has a small, presentation-only time API.
 * Keeping the clock outside of the formatter makes the displayed value stable
 * in tests and avoids coupling the card to a one-second ticking clock.
 */
export type RelativeTimeInput = string | number | Date | undefined | null

function toMillis(value: RelativeTimeInput): number | undefined {
  if (value === undefined || value === null) return undefined
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(millis) ? millis : undefined
}

/** Return the timestamp used for the public "recent interaction" row. */
export function resolveRecentInteractionAt(state: Pick<CharacterPublicState, 'lastInteractionAt' | 'updatedAt'>): string | undefined {
  const preferred = typeof state.lastInteractionAt === 'string' ? state.lastInteractionAt.trim() : ''
  if (preferred && toMillis(preferred) !== undefined) return preferred
  const fallback = typeof state.updatedAt === 'string' ? state.updatedAt.trim() : ''
  return fallback && toMillis(fallback) !== undefined ? fallback : undefined
}

/**
 * Format a coarse, deterministic relative time for the narrow character rail.
 * There are no seconds or percentage-like values, so the card does not appear
 * to be more precise than the source timestamps warrant.
 */
export function formatRelativeTime(value: RelativeTimeInput, now: RelativeTimeInput = Date.now()): string {
  const timestamp = toMillis(value)
  const current = toMillis(now)
  if (timestamp === undefined || current === undefined) return '时间未知'

  const elapsedMs = Math.max(0, current - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (elapsedMs < minute) return '刚刚'
  if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)} 分钟前`
  if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)} 小时前`
  if (elapsedMs < 2 * day) return '昨天'
  if (elapsedMs < 7 * day) return `${Math.floor(elapsedMs / day)} 天前`

  const date = new Date(timestamp)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

/** Keep intensity as a quiet visual cue; never render it as a number. */
export function clampMoodIntensity(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}
