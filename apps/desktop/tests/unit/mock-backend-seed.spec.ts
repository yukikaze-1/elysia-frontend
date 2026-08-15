// tests/unit/mock-backend-seed.spec.ts
// Task 1: MockBackend.seedHistoryCount + parseMockHistoryCountEnv + 分页语义对齐 real（spec §4.3）
import { describe, expect, it } from 'vitest'
import { MockBackend, parseMockHistoryCountEnv } from '../../src/main/transport/mock-backend'

const NOW = new Date('2026-08-14T04:00:00.000Z')
let idCounter = 0
function mkSeed(count: number): MockBackend {
  idCounter = 0
  return new MockBackend({ seedHistoryCount: count, now: () => NOW, idFactory: () => `id${++idCounter}` })
}
const Q = { scope: { type: 'all_conversations' } as const, timeZone: 'UTC', category: 'all' as const }

describe('parseMockHistoryCountEnv（spec §4.3.1）', () => {
  it('undefined/空串 → undefined（不开大 seed）', () => {
    expect(parseMockHistoryCountEnv(undefined)).toBeUndefined()
    expect(parseMockHistoryCountEnv('')).toBeUndefined()
    expect(parseMockHistoryCountEnv('  ')).toBeUndefined()
  })
  it('正整数 → 原值', () => {
    expect(parseMockHistoryCountEnv('120')).toBe(120)
    expect(parseMockHistoryCountEnv('1')).toBe(1)
  })
  it('0/负数/NaN/非整数 → 默认 120（不允许空 seed）', () => {
    expect(parseMockHistoryCountEnv('0')).toBe(120)
    expect(parseMockHistoryCountEnv('-3')).toBe(120)
    expect(parseMockHistoryCountEnv('abc')).toBe(120)
    expect(parseMockHistoryCountEnv('120.5')).toBe(120)
  })
})

describe('MockBackend.seedHistoryCount 大 seed（spec §4.3.1）', () => {
  it('120 条确定性合成集：唯一 hitId、跨 ≥2 自然日、单调 createdAt、无 sticker、纯文本', async () => {
    const mb = mkSeed(120)
    const all = await mb.queryChatHistory({ ...Q, limit: 200 })
    expect(all.items).toHaveLength(120)
    expect(all.items[0].hitId).toBe('conv-1001:run2-msg-0001:')
    expect(new Set(all.items.map((i) => i.hitId)).size).toBe(120)
    expect(new Set(all.items.map((i) => i.createdAt.slice(0, 10))).size).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < all.items.length; i++) expect(all.items[i].createdAt >= all.items[i - 1].createdAt).toBe(true)
    expect(all.items.some((i) => i.resource?.kind === 'sticker')).toBe(false)
    expect(all.items.every((i) => i.snippet?.startsWith('模拟命中文本'))).toBe(true)
  })
  it('分页对齐 real：第一页=最新 50（页内升序）、第二页=更旧 50、合并后首屏 50 相对顺序保持、去重', async () => {
    const mb = mkSeed(120)
    const p1 = await mb.queryChatHistory({ ...Q, limit: 50 })
    expect(p1.items).toHaveLength(50)
    expect(p1.hasMore).toBe(true)
    const p1Keys = p1.items.map((i) => i.sortKey)
    expect([...p1Keys].sort()).toEqual(p1Keys)                 // 页内升序
    const p2 = await mb.queryChatHistory({ ...Q, limit: 50, cursor: p1.nextCursor })
    expect(p2.items).toHaveLength(50)
    expect(p2.items[p2.items.length - 1].sortKey < p1.items[0].sortKey).toBe(true)  // 第二页更旧
    const merged = [...p1.items, ...p2.items].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    expect(merged).toHaveLength(100)
    const p1HitIds = new Set(p1.items.map((i) => i.hitId))
    expect(merged.filter((i) => p1HitIds.has(i.hitId))).toEqual(p1.items)  // 首屏 50 相对顺序保持（子序列）
    expect(new Set(merged.map((i) => i.hitId)).size).toBe(100)             // 去重
  })
  it('默认（未设置 seedHistoryCount）行为不变：仍 5 条默认 seed', async () => {
    idCounter = 0
    const mb = new MockBackend({ now: () => NOW, idFactory: () => `id${++idCounter}` })
    const all = await mb.queryChatHistory({ ...Q, limit: 200 })
    expect(all.items).toHaveLength(5)
  })
})
