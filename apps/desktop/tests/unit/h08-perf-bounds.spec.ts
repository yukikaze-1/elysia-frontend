// @vitest-environment happy-dom
// tests/unit/h08-perf-bounds.spec.ts
// H-08（2026-09-11）：长会话性能的两个**安全半边**——估算器记忆化 + 渲染缓存有界。
//
// 背景（评审核实 + 本轮读码确认）：
//   · `estimateMessageHeight` 代价是 **O(全文长度)**（assistant 分支 `split('\n')` 分配整段行数组 +
//     每段一次全局正则），而 `buildPrefix` 对**每个尚未实测的行**都会调它一次 ⇒ 每次 prefix 重算
//     重扫未渲染行全文（长会话里为数 MB 级）。
//   · `markdownCache` 键是**整段源文本**，而流式回复每个 80ms 节拍产生一个更长的新文本
//     ⇒ 一条回复写入 N 个条目、总字节 **O(N²)**，且此前只在会话切换时清空。
//
// 为什么必须"计数"而不是"跑得快"：本仓库的外部教训是**计时断言在 CI 上不稳**（负载/视口差异）。
// 故判别力建立在**可数的真实计算次数**上（`estimateHeightStats.computes`）与**可数的条目数**上
// （`markdownCacheSize`）——两者都是确定性的，且恰好就是"是否真的做了那件昂贵的事"。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { Message } from '@shared/contracts'
import {
  computeMessageHeight,
  estimateMessageHeight,
  estimateHeightStats
} from '../../src/renderer/src/utils/virtual-window'

function assistantMessage(messageId: string, texts: string[]): Message {
  return {
    messageId, conversationId: 'c1', role: 'assistant', status: 'completed', createdAt: 't',
    assistantSegments: texts.map((text, index) => ({ segmentId: `s${index}`, segmentIndex: index, channel: 'public_reply', kind: 'markdown', text }))
  } as Message
}

function userMessage(messageId: string, content: string): Message {
  return { messageId, conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't', content } as Message
}

const LONG = 'line of markdown text\n'.repeat(400)   // ≈ 9 KB

beforeEach(() => { estimateHeightStats.reset() })

describe('H-08：估算器记忆化（判别力 = 真实计算次数）', () => {
  it('重复估算同一未变更消息只做一次真实计算（缓存命中不重复扫全文）', () => {
    const m = assistantMessage('m1', [LONG])
    for (let i = 0; i < 50; i++) estimateMessageHeight(m)

    expect(estimateHeightStats.computes, '同一消息重复估算应只算一次').toBe(1)
    expect(estimateHeightStats.cacheHits).toBe(49)
  })

  it('这正是 buildPrefix 的热路径：未实测行会反复被估算（模拟一次 prefix 重算的多轮调用）', () => {
    const items = Array.from({ length: 20 }, (_, i) => assistantMessage(`m${i}`, [LONG]))
    // 模拟多次 prefix 重算（每次都会遍历全部未实测行）
    for (let round = 0; round < 5; round++) for (const m of items) estimateMessageHeight(m)

    expect(estimateHeightStats.computes, '20 条 × 5 轮只应真实计算 20 次').toBe(20)
    expect(estimateHeightStats.cacheHits).toBe(80)
  })

  it('内容增长后重新计算（流式追加必须失效缓存，不得复用旧估算）', () => {
    const m = assistantMessage('m1', [LONG])
    const before = estimateMessageHeight(m)
    expect(estimateHeightStats.computes).toBe(1)

    // 追加一个更长的段（流式的真实形态：assistantSegments 被整体替换）
    const grown = assistantMessage('m1', [LONG, 'another paragraph\n'.repeat(100)])
    const after = estimateMessageHeight(grown)

    expect(estimateHeightStats.computes, '内容变化必须重算').toBe(2)
    expect(after, '更长内容应给出更大估算').toBeGreaterThan(before)
    expect(after).toBe(computeMessageHeight(grown))
  })

  it('等长替换的已知边界：版本号不变则复用估算（已在实现里注明，属自愈误差）', () => {
    // 这条用例**记录**边界而不是假装它不存在：完全等长且段数相同的替换会复用旧值。
    // 影响面极小（估算只用于未实测行，实测高一到即覆盖），且不会累积。
    const a = assistantMessage('m1', ['aaaa\nbbbb\n'])
    const first = estimateMessageHeight(a)
    const b = assistantMessage('m1', ['cccc\ndddd\n'])   // 与 a 等长同结构
    expect(estimateMessageHeight(b)).toBe(first)
    expect(estimateHeightStats.computes, '等长替换不触发重算——这是有意的取舍').toBe(1)
  })

  it('不同消息各自计算（缓存按 messageId 隔离，不得串号）', () => {
    estimateMessageHeight(assistantMessage('m1', [LONG]))
    estimateMessageHeight(assistantMessage('m2', [LONG]))
    estimateMessageHeight(userMessage('u1', 'hello'))
    expect(estimateHeightStats.computes).toBe(3)
  })

  it('user 角色走 O(1) 版本号（content 长度），同样被记忆化', () => {
    const m = userMessage('u1', 'hello world')
    for (let i = 0; i < 10; i++) estimateMessageHeight(m)
    expect(estimateHeightStats.computes).toBe(1)
  })

  it('缓存有界：远超上限的不同消息不会让缓存无限增长（"永不封顶"不得换个地方重演）', () => {
    for (let i = 0; i < 2600; i++) estimateMessageHeight(userMessage(`u${i}`, `text ${i}`))
    expect(estimateHeightStats.size(), '估算缓存必须有界').toBeLessThanOrEqual(2000)
    expect(estimateHeightStats.size()).toBeGreaterThan(0)
  })
})

describe('H-08：markdown 渲染缓存有界（判别力 = 可数条目数）', () => {
  it('流式形态（每拍一个更长的文本 ⇒ 键各不同）不会让缓存无限增长', async () => {
    const { renderMarkdown, markdownCacheSize, clearMarkdownCache } = await import('../../src/renderer/src/utils/markdown')
    clearMarkdownCache()
    // 本用例要证的**只是**「键数远超上限时缓存仍有界」——文本大小与这条性质无关。
    // 故刻意用**极小且互不相同**的文本：早期版本模拟「文本持续变长」（累积到数 KB × 500 次
    // parse+sanitize），在 CI 上直接把 worker 打爆（`Ineffective mark-compacts near heap limit`
    // + `Worker exited unexpectedly`，本文件连结果都没打印出来）。
    // 教训：模拟"真实形态"时不能用真实体量去堆——判别力在**键的数量**上，不在字节数上。
    for (let i = 0; i < 350; i++) renderMarkdown(`# h${i}`)
    expect(markdownCacheSize(), '渲染缓存必须被限幅，否则单条回复即可驻留数 MB').toBeLessThanOrEqual(300)
  })

  it('淘汰后仍能正确渲染（淘汰是安全的：最坏只是重新 parse+sanitize）', async () => {
    const { renderMarkdown, clearMarkdownCache } = await import('../../src/renderer/src/utils/markdown')
    clearMarkdownCache()
    for (let i = 0; i < 350; i++) renderMarkdown(`# 标题 ${i}`)
    // 最早的条目可能已被淘汰——重新渲染必须仍给出正确块（而不是空/异常）
    const blocks = renderMarkdown('# 标题 0')
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.map((b) => ('html' in b ? b.html : '')).join('')).toContain('标题 0')
  })

  it('会话边界仍会清空（既有安全语义不因限幅而改变）', async () => {
    const { renderMarkdown, markdownCacheSize, clearMarkdownCache } = await import('../../src/renderer/src/utils/markdown')
    clearMarkdownCache()
    renderMarkdown('# 敏感内容')
    expect(markdownCacheSize()).toBeGreaterThan(0)
    clearMarkdownCache()
    expect(markdownCacheSize(), 'clearMarkdownCache 仍须真正清空').toBe(0)
  })
})

// 静音 lint：vi 在本文件用于 import 动态模块的替代路径（保留以便将来注入 spy）
void vi
