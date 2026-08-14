// 自研轻量虚拟列表数学（D3/D5）：估高+实测混合前缀和 + 二分窗口 + 锚点捕获/恢复/高度补偿。
// 全部纯函数可单测；组件层只做 ResizeObserver 实测写入 + 窗口渲染 + 锚点保存。
import type { Message, ScrollAnchor } from '@shared/contracts'

/** 虚拟列表 overscan（组件层常量，单测以入参为准） */
export const OVERSCAN_PX = 400

function countFences(text: string): number {
  let n = 0
  for (const line of text.split('\n')) if (line.trimStart().startsWith('```')) n++
  return Math.ceil(n / 2)
}

/** 纯启发式：未渲染行恒用估算高（实测覆盖后以实测为准） */
export function estimateHeight(m: Message): number {
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

/** 前缀和：prefix[i] = items[0..i-1] 高度累计；实测优先，缺失用 estimateHeight 兜底 */
export function buildPrefix(items: Message[], heights: Record<string, number>): number[] {
  const prefix: number[] = new Array(items.length + 1)
  prefix[0] = 0
  for (let i = 0; i < items.length; i++) {
    const id = items[i].messageId
    prefix[i + 1] = prefix[i] + (heights[id] ?? estimateHeight(items[i]))
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

/** 锚点：首个可见消息 + 视口偏移（D5，向上加载不跳动的前提）；viewportHeight 保留签名位（组件层扩展用） */
export function captureAnchor(items: Message[], prefix: number[], scrollTop: number, _viewportHeight: number): ScrollAnchor {
  if (items.length === 0) return { messageId: '', offset: 0 }
  const idx = Math.max(0, lowerBound(prefix, scrollTop) - 1)
  return { messageId: items[idx].messageId, offset: scrollTop - prefix[idx] }
}

/** 恢复：锚点消息顶 + offset（items 为恢复时刻的当前 order，锚点消息必在其中才可精确恢复） */
export function restoreScrollTop(items: Message[], prefix: number[], anchor: ScrollAnchor): number {
  if (!anchor.messageId) return 0
  const idx = items.findIndex((m) => m.messageId === anchor.messageId)
  if (idx < 0) return 0
  return prefix[idx] + anchor.offset
}

/** 高度补偿（D5）：锚点上方已渲染行实测 vs 估高变化累计 delta，加回 scrollTop 使锚点可视位移不变 */
export function compensateScroll(deltas: Array<{ old: number; new: number }>): number {
  return deltas.reduce((acc, d) => acc + (d.new - d.old), 0)
}
