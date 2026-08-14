// tests/unit/mock-backend-search.spec.ts
// Task 8:MockBackend 历史/上下文/表情确定性（spec §2.7/§4.3）——过滤/分页/窗口切片/listStickers。
// env=node：注入时钟/ID 工厂。
import { describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'

const NOW = new Date('2026-08-14T04:00:00.000Z')
let idCounter = 0
function mkBackend(): MockBackend {
  idCounter = 0
  return new MockBackend({ now: () => NOW, idFactory: () => `id${++idCounter}` })
}

describe('MockBackend.queryChatHistory（spec §2.7）', () => {
  it('scope=conversation 过滤当前会话；结果按时间稳定排序', async () => {
    const mb = mkBackend()
    const page = await mb.queryChatHistory({ scope: { type: 'conversation', conversationId: 'conv-1001' }, timeZone: 'Asia/Shanghai', category: 'all', limit: 50 })
    expect(page.items.every((i) => i.conversationId === 'conv-1001')).toBe(true)
    const keys = page.items.map((i) => i.sortKey)
    expect([...keys].sort()).toEqual(keys)
  })
  it('关键词过滤（大小写不敏感，命中 content 片段）', async () => {
    const mb = mkBackend()
    const page = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, query: '表情', timeZone: 'UTC', category: 'all', limit: 50 })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items[0].snippet).toContain('表情')
  })
  it('分类过滤：category=sticker 只回贴图项（resource.kind=sticker）', async () => {
    const mb = mkBackend()
    const page = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'sticker', limit: 50 })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((i) => i.resource?.kind === 'sticker')).toBe(true)
  })
  it('本地自然日过滤（isoToLocalDate 换算）', async () => {
    const mb = mkBackend()
    const page = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'all', limit: 50 })
    // 上海 2026-08-14 = UTC [2026-08-13T16:00Z, 2026-08-14T16:00Z)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((i) => i.createdAt >= '2026-08-13T16:00:00.000Z' && i.createdAt < '2026-08-14T16:00:00.000Z')).toBe(true)
  })
  it('游标分页：limit 切片 + mock:{offset} 游标 + hasMore', async () => {
    const mb = mkBackend()
    const first = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 2 })
    expect(first.items.length).toBe(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toMatch(/^mock:\d+$/)
    const second = await mb.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 2, cursor: first.nextCursor })
    expect(second.items.length).toBeGreaterThan(0)
    const allIds = [...first.items, ...second.items].map((i) => i.messageId)
    expect(new Set(allIds).size).toBe(allIds.length)   // 不重复
  })
})

describe('MockBackend.getMessageContext（spec §4.5）', () => {
  it('窗口切片：before/after 围绕锚点，含锚点消息', async () => {
    const mb = mkBackend()
    const page = await mb.getMessageContext({ conversationId: 'conv-1001', messageId: 'msg-1002', before: 1, after: 1 })
    expect(page.items.some((m) => m.messageId === 'msg-1002')).toBe(true)
    expect(page.items.length).toBeLessThanOrEqual(3)
    expect(page.hasMore).toBe(false)
  })
  it('锚点不存在 → NOT_FOUND', async () => {
    const mb = mkBackend()
    await expect(mb.getMessageContext({ conversationId: 'conv-1001', messageId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('MockBackend.listStickers + sendMessage 记录（D8）', () => {
  it('listStickers 返回内置 st_ 清单（P0-2：StickerManifest{stickers}）', async () => {
    const mb = mkBackend()
    const manifest = await mb.listStickers()
    expect(manifest.stickers.length).toBeGreaterThan(0)
    expect(manifest.stickers.every((s) => /^st_/.test(s.stickerId))).toBe(true)
  })
  it('sendMessage 带 stickerId → 记录为 sticker 消息，可被 category=sticker 查到', async () => {
    const mb = mkBackend()
    await mb.connect({ serverUrl: 'mock://local' })
    await mb.sendMessage({ conversationId: 'conv-1001', text: '', clientRequestId: 'cr1', stickerId: 'st_1' })
    const page = await mb.queryChatHistory({ scope: { type: 'conversation', conversationId: 'conv-1001' }, timeZone: 'UTC', category: 'sticker', limit: 50 })
    expect(page.items.some((i) => i.resource?.stickerId === 'st_1')).toBe(true)   // Mock 领域富化（见下注）
  })
})
