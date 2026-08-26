// 自研轻量虚拟列表数学（D3/D5）：估高+实测混合前缀和 + 二分窗口 + 锚点捕获/恢复/高度补偿。
// Task 1（阶段 7 批次 C）泛型化：estimate/keyFor/isAnchorable 经 opts/keyFor 注入，消息列表用 Message
// 默认注入零改动，历史查看器（后续 Task）注入 header/item 差异化行。全部纯函数可单测。
import type { Message, ScrollAnchor } from '@shared/contracts'

/** 虚拟列表 overscan（组件层常量，单测以入参为准） */
export const OVERSCAN_PX = 400

function countFences(text: string): number {
  let n = 0
  for (const line of text.split('\n')) if (line.trimStart().startsWith('```')) n++
  return Math.ceil(n / 2)
}

/** 消息列表专用估算（fence counting 等，原 estimateHeight 的 Message 版逻辑） */
export function estimateMessageHeight(m: Message): number {
  const BASE = 36
  const LINE = 20
  if (m.role === 'user') {
    const lines = Math.max(1, Math.ceil((m.content?.length ?? 1) / 40))
    return BASE + lines * LINE
  }
  if (m.role === 'assistant') {
    let textLen = 0
    let extra = 0
    for (const seg of m.assistantSegments ?? []) {
      textLen += seg.text?.length ?? 0
      if (seg.kind === 'markdown' && seg.text) {
        extra += countFences(seg.text) * 3
        extra += (seg.text.match(/^\s*[-*] |^\s*\d+\. /gm)?.length ?? 0) / 2
      }
    }
    return BASE + Math.ceil(textLen / 45) * LINE + Math.round(extra) * LINE
  }
  return BASE
}

/** 双签名重载：`estimateHeight(m: Message)` 既有重载（消息列表零改动）+ `estimateHeight<T>(item, estimate)` 泛型签名（历史查看器注入 estimate） */
export function estimateHeight(m: Message): number
export function estimateHeight<T>(item: T, estimate: (t: T) => number): number
export function estimateHeight(item: unknown, estimate?: (t: unknown) => number): number {
  if (estimate) return estimate(item)
  return estimateMessageHeight(item as Message)
}

export interface PrefixOpts<T> { estimate: (t: T) => number; keyFor: (t: T) => string }

/** 消息列表默认注入（Message 版）：keyFor=messageId、estimate=estimateMessageHeight */
const MESSAGE_PREFIX_OPTS: PrefixOpts<Message> = { estimate: estimateMessageHeight, keyFor: (m) => m.messageId }

export function buildPrefix(items: Message[], heights: Record<string, number>): number[]   // 既有 2 参（消息列表零改动）
export function buildPrefix<T>(items: T[], heights: Record<string, number>, opts: PrefixOpts<T>): number[]
export function buildPrefix(items: unknown[], heights: Record<string, number>, opts?: PrefixOpts<unknown>): number[] {
  const o = opts ?? (MESSAGE_PREFIX_OPTS as PrefixOpts<unknown>)
  const prefix: number[] = new Array(items.length + 1)
  prefix[0] = 0
  for (let i = 0; i < items.length; i++) {
    const key = o.keyFor(items[i])
    prefix[i + 1] = prefix[i] + (heights[key] ?? o.estimate(items[i]))
  }
  return prefix
}

function lowerBound(arr: number[], target: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(arr: number[], target: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface WindowSlice {
  startIndex: number
  endIndex: number
  paddingTop: number
  paddingBottom: number
}

/** 二分窗口：滚动事件只做 O(log n)；上下 overscan 撑开避免滚动闪烁 */
export function computeWindow(
  prefix: number[], scrollTop: number, viewportHeight: number, overscanPx: number
): WindowSlice {
  if (prefix.length <= 1) return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 }
  const top = Math.max(0, scrollTop - overscanPx)
  const bottom = scrollTop + viewportHeight + overscanPx
  const startIndex = Math.max(0, lowerBound(prefix, top) - 1)
  const endIndex = Math.min(prefix.length - 1, upperBound(prefix, bottom) - 1)
  const start = Math.min(startIndex, prefix.length - 1)
  const end = Math.max(start, endIndex)
  return { startIndex: start, endIndex: end, paddingTop: prefix[start], paddingBottom: prefix[prefix.length - 1] - prefix[end] }
}

export interface AnchorOpts<T> { isAnchorable: (t: T) => boolean; keyFor: (t: T) => string }

/** 消息列表默认锚定（Message 版）：isAnchorable 恒 true、keyFor=messageId */
const MESSAGE_ANCHOR_OPTS: AnchorOpts<Message> = { isAnchorable: () => true, keyFor: (m) => m.messageId }

export function captureAnchor(items: Message[], prefix: number[], scrollTop: number, _viewportHeight: number): ScrollAnchor   // 既有 4 参（消息列表零改动）
export function captureAnchor<T>(items: T[], prefix: number[], scrollTop: number, viewportHeight: number, opts: AnchorOpts<T>): ScrollAnchor
export function captureAnchor(items: unknown[], prefix: number[], scrollTop: number, _viewportHeight: number, opts?: AnchorOpts<unknown>): ScrollAnchor {
  const o = opts ?? (MESSAGE_ANCHOR_OPTS as AnchorOpts<unknown>)
  if (items.length === 0) return { messageId: '', offset: 0 }
  let idx = Math.max(0, lowerBound(prefix, scrollTop) - 1)
  // 跳过 header 行：向后找到首个 isAnchorable 行（准确性 M-8 注：视口顶在 header 内时 offset 可为负，影响极小——消息列表无 header 不触发）
  while (idx < items.length && !o.isAnchorable(items[idx])) idx++
  if (idx >= items.length) return { messageId: '', offset: 0 }
  return { messageId: o.keyFor(items[idx]), offset: scrollTop - prefix[idx] }
}

export function restoreScrollTop(items: Message[], prefix: number[], anchor: ScrollAnchor): number   // 既有 3 参（消息列表零改动）
export function restoreScrollTop<T>(items: T[], prefix: number[], anchor: ScrollAnchor, keyFor: (t: T) => string): number
export function restoreScrollTop(items: unknown[], prefix: number[], anchor: ScrollAnchor, keyFor?: (t: unknown) => string): number {
  const kf = keyFor ?? ((m: unknown) => (m as Message).messageId)
  if (!anchor.messageId) return 0
  const idx = items.findIndex((t) => kf(t) === anchor.messageId)
  if (idx < 0) return 0
  return prefix[idx] + anchor.offset
}

/** 高度补偿（D5）：锚点上方已渲染行实测 vs 估高变化累计 delta，加回 scrollTop 使锚点可视位移不变 */
export function compensateScroll(deltas: Array<{ old: number; new: number }>): number {
  return deltas.reduce((acc, d) => acc + (d.new - d.old), 0)
}
