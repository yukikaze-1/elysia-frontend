// src/renderer/src/utils/recent-emoji.ts
// 阶段 3 G4（spec §4.6，D7）：最近 Emoji localStorage 纯函数。
// 非敏感纯展示偏好 → localStorage 例外合理（若后续统一设置持久化通道再迁移）。
export const RECENT_EMOJI_KEY = 'cyrene:ui:recent-emoji'
export const RECENT_EMOJI_MAX = 24

/** 新 emoji 置前去重，上限 24 */
export function recordEmoji(recent: string[], emoji: string): string[] {
  const next = [emoji, ...recent.filter((e) => e !== emoji)]
  return next.slice(0, RECENT_EMOJI_MAX)
}

export function loadRecentEmoji(storage: Pick<Storage, 'getItem' | 'setItem'>): string[] {
  try {
    const raw = storage.getItem(RECENT_EMOJI_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is string => typeof e === 'string')
  } catch {
    return []
  }
}

export function saveRecentEmoji(recent: string[], storage: Pick<Storage, 'getItem' | 'setItem'>): void {
  try {
    storage.setItem(RECENT_EMOJI_KEY, JSON.stringify(recent))
  } catch {
    // localStorage 满/禁用：非敏感偏好，静默忽略
  }
}
