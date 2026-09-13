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

/**
 * 估算记忆化（H-08，2026-09-11）。
 *
 * 背景（评审核实 + 本轮读码确认）：`estimateMessageHeight` 的代价是 **O(全文长度)**——
 * assistant 分支要 `text.split('\n')` 分配整段行数组，还对每段跑一次全局正则
 * （`/^\s*[-*] |^\s*\d+\. /gm`）。而 `buildPrefix` 对**每个尚未实测的行**都会调它一次，
 * 于是每次 prefix 重算都会把未渲染行的全文重扫一遍（长会话里这是数 MB 级扫描）。
 *
 * 记忆化键的取法（**刻意不用全文哈希**——那本身就是 O(全文)，等于没省）：
 * 用「role + content 长度 + 段数 + 段文本长度之和」这类**O(段数)** 的廉价版本号。
 * 它覆盖了所有现实变更（流式追加会同时改变段数与总长）。已知边界：若内容被替换成
 * **完全等长**且段数相同的文本，版本号不变、会复用旧估算——代价只是估算略偏，
 * 而估算误差本就被 ResizeObserver 的实测高修正吸收（`heights[key] = h` 后即不再走估算路径），
 * 属自愈误差，不会累积。
 *
 * 缓存**有界**（`ESTIMATE_CACHE_MAX`）：本轮 H-08 的另一半正是「永不封顶」，
 * 给估算器加一个无界缓存会把刚修好的问题换个地方再造一遍。
 */
const ESTIMATE_CACHE_MAX = 2000
const estimateCache = new Map<string, { version: string; height: number }>()

/** 诊断计数（测试与调试用）：真实 compute 次数。命中缓存不增加——判别力就建立在这一点上 */
export const estimateHeightStats = {
  computes: 0,
  cacheHits: 0,
  reset(): void { this.computes = 0; this.cacheHits = 0; estimateCache.clear() },
  size(): number { return estimateCache.size }
}

/** 廉价版本号：O(段数)，不扫字符 */
function estimateVersionOf(m: Message): string {
  if (m.role === 'user') return `u|${m.content?.length ?? 0}`
  if (m.role !== 'assistant') return `${m.role}|0`
  let total = 0
  const segs = m.assistantSegments ?? []
  for (const seg of segs) total += seg.text?.length ?? 0
  return `a|${segs.length}|${total}`
}

/** 消息列表专用估算（fence counting 等，原 estimateHeight 的 Message 版逻辑） */
export function estimateMessageHeight(m: Message): number {
  const version = estimateVersionOf(m)
  const cached = estimateCache.get(m.messageId)
  if (cached !== undefined && cached.version === version) {
    estimateHeightStats.cacheHits++
    return cached.height
  }
  const height = computeMessageHeight(m)
  estimateHeightStats.computes++
  // 有界：超出上限时按插入顺序淘汰最旧的一批（Map 保序）。估算可随时重算，淘汰永远安全。
  if (estimateCache.size >= ESTIMATE_CACHE_MAX) {
    const drop = Math.ceil(ESTIMATE_CACHE_MAX / 4)
    let removed = 0
    for (const key of estimateCache.keys()) {
      estimateCache.delete(key)
      if (++removed >= drop) break
    }
  }
  estimateCache.set(m.messageId, { version, height })
  return height
}

/** 真实计算（无缓存）——O(全文)；只有 computeMessageHeight 与单测直接调用它 */
export function computeMessageHeight(m: Message): number {
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
  const prefix: number[] = new Array<number>(items.length + 1)
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
