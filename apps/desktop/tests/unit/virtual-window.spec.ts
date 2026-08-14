// tests/unit/virtual-window.spec.ts —— spec §4.3.1 纯函数层：估高+实测混合前缀和/二分窗口/锚点数学。
import { describe, expect, it } from 'vitest'
import type { Message } from '@shared/contracts'
import { cmpMsg } from '../../src/renderer/src/utils/message-order'
import {
  estimateHeight, buildPrefix, computeWindow, captureAnchor, restoreScrollTop, compensateScroll
} from '../../src/renderer/src/utils/virtual-window'

function msg(id: string, createdAt: string): Message {
  return { messageId: id, conversationId: 'c1', role: 'user', content: 'hello', status: 'completed', createdAt }
}
function mh(items: Message[]): Record<string, number> {
  const h: Record<string, number> = {}
  for (const m of items) h[m.messageId] = 50
  return h
}

describe('cmpMsg（(createdAt, messageId) 升序）', () => {
  it('时间不同按 createdAt；时间相同按 messageId；全等为 0', () => {
    expect(cmpMsg(msg('a', '2026-01-01T00:00:00.000Z'), msg('b', '2026-01-02T00:00:00.000Z'))).toBeLessThan(0)
    expect(cmpMsg(msg('b', '2026-01-02T00:00:00.000Z'), msg('a', '2026-01-01T00:00:00.000Z'))).toBeGreaterThan(0)
    expect(cmpMsg(msg('a', '2026-01-01T00:00:00.000Z'), msg('b', '2026-01-01T00:00:00.000Z'))).toBeLessThan(0)
    expect(cmpMsg(msg('a', 't'), msg('a', 't'))).toBe(0)
  })
})

describe('estimateHeight 启发式', () => {
  it('user 短文本 >0；assistant 长 markdown（含代码围栏）高于短文本', () => {
    const short = msg('u', 't')
    const long: Message = { ...msg('a', 't'), role: 'assistant', assistantSegments: [{ segmentId: 's', segmentIndex: 0, channel: 'public_reply', kind: 'markdown', text: '```ts\ncode\n```\n\nlong text '.repeat(20), completed: true }] }
    expect(estimateHeight(short)).toBeGreaterThan(0)
    expect(estimateHeight(long)).toBeGreaterThan(estimateHeight(short))
  })
})

describe('buildPrefix / computeWindow（前缀和 + 二分窗口）', () => {
  const items = [msg('m1', 't1'), msg('m2', 't2'), msg('m3', 't3'), msg('m4', 't4'), msg('m5', 't5')]
  const prefix = buildPrefix(items, mh(items)) // 每条实测 50 → prefix = [0,50,100,150,200,250]
  it('buildPrefix 全实测：前缀和递增且末项=总高', () => {
    expect(prefix).toEqual([0, 50, 100, 150, 200, 250])
  })
  it('buildPrefix 缺失估高兜底：heights 缺 m2 → 用 estimateHeight', () => {
    const h = mh(items); delete h['m2']
    const p = buildPrefix(items, h)
    expect(p[1]).toBe(50)
    expect(p[2]).toBe(50 + estimateHeight(items[1]))
  })
  it('computeWindow 空列表 → 全 0', () => {
    expect(computeWindow([0], 0, 600, 400)).toEqual({ startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 })
  })
  it('computeWindow 视口中部 → 含 overscan 的窗口 + paddingTop/Bottom', () => {
    const w = computeWindow(prefix, 120, 100, 40) // top=80,bottom=260
    expect(w.startIndex).toBeGreaterThanOrEqual(0)
    expect(w.endIndex).toBeGreaterThan(w.startIndex)
    expect(w.paddingTop + w.paddingBottom).toBeLessThan(prefix[prefix.length - 1])
    expect(w.paddingTop).toBe(prefix[w.startIndex])
    expect(w.paddingBottom).toBe(prefix[prefix.length - 1] - prefix[w.endIndex])
  })
  it('computeWindow 越界 clamp（scrollTop 超内容 → 末窗口、paddingBottom=0）', () => {
    const w = computeWindow(prefix, 9999, 100, 0)
    expect(w.endIndex).toBe(prefix.length - 1)
    expect(w.paddingBottom).toBe(0)
  })
})

describe('captureAnchor / restoreScrollTop / compensateScroll（prepend 不跳动，P0-1）', () => {
  const items = [msg('m1', 't1'), msg('m2', 't2'), msg('m3', 't3'), msg('m4', 't4')]
  const prefix = buildPrefix(items, mh(items)) // [0,50,100,150,200]
  it('captureAnchor 取首个可见消息 + 视口偏移', () => {
    const a = captureAnchor(items, prefix, 110, 100) // prefix[2]=100 <= 110 → 锚点 m3
    expect(a.messageId).toBe('m3')
    expect(a.offset).toBe(10)
  })
  it('restoreScrollTop 恢复 = 锚点消息顶 + offset（prepend 后前缀和增长，锚点位移不变）', () => {
    const before = restoreScrollTop(items, prefix, { messageId: 'm3', offset: 10 })
    expect(before).toBe(110)
    const prepended = [msg('p1', 't0.5'), ...items]
    const p2 = buildPrefix(prepended, mh(prepended)) // 每条 50 → p2=[0,50,100,150,200,250]
    const after = restoreScrollTop(prepended, p2, { messageId: 'm3', offset: 10 })
    expect(after).toBe(160) // m3 现在 index 3 → prefix[3]=150 + offset 10 = 160（锚点上方新增一行 → 位移 +50）
    expect(after - before).toBe(50)
  })
  it('restoreScrollTop 锚点不在列表 → 0', () => {
    expect(restoreScrollTop(items, prefix, { messageId: 'nope', offset: 0 })).toBe(0)
  })
  it('P1-2 loadOlder 前插锚点回环：captureAnchor→前插多页→restoreScrollTop 后锚点消息与视口偏移不变', () => {
    const anchor = captureAnchor(items, prefix, 110, 100) // prefix[2]=100 <= 110 → 锚点 m3，offset 10
    const prepended = [msg('p1', 't0.2'), msg('p2', 't0.1'), ...items] // 更早两页前插
    const p2 = buildPrefix(prepended, mh(prepended)) // 每条 50 → m3 现 index 4 → prefix[4]=200
    const restored = restoreScrollTop(prepended, p2, anchor)
    expect(restored).toBe(210) // 200 + offset 10：scrollTop 前移 100px 补偿前插高度（锚点视口位置不变）
    // 回环：恢复后的滚动位置再捕获，锚点消息与偏移与捕获时一致（用户感知「向上翻不跳动」，评审 P1-2）
    const recaptured = captureAnchor(prepended, p2, restored, 100)
    expect(recaptured.messageId).toBe(anchor.messageId)
    expect(recaptured.offset).toBe(anchor.offset)
  })
  it('compensateScroll 累计实测-估高 delta（D5 高度补偿）', () => {
    // Σ(new-old)=30+0-40=-10：新行更高 delta 正 → 往下滚；新行更矮 delta 负 → 往上滚（评审 P0-2 统一为实现语义）
    expect(compensateScroll([{ old: 50, new: 80 }, { old: 40, new: 40 }, { old: 100, new: 60 }])).toBe(-10)
  })
  it('P0-1 不变量：order 恒升序时前缀和=可视位移（锚点上方新增行只增加前缀和、offset 不变）', () => {
    const a = captureAnchor(items, prefix, 110, 100)
    const sorted = [...items, msg('m0', 't0')].sort(cmpMsg) // m0 最旧 → 前插
    expect(sorted[0].messageId).toBe('m0')
    const p = buildPrefix(sorted, mh(sorted))
    const after = restoreScrollTop(sorted, p, a)
    expect(after).toBeGreaterThan(110) // 锚点下方新增 → 前缀和增量
    expect(a.offset).toBe(10) // 锚点偏移不变
  })
})
