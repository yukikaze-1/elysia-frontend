// tests/unit/rest-search-mapper.spec.ts
// Task 6:search/context/stickers 响应归一化（spec §4.3/§4.6，D2）——RestMapper 派生 hitId/sortKey、仅文本映射（P0-1：
// search item 无 kind/url）、缺字段显式错误。
// env=node：RestMapper 纯逻辑，无 Electron。
import { describe, expect, it } from 'vitest'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import { parseRestMessageContext, parseRestSearchMessages, parseRestStickerList } from '../../src/main/transport/protocol-v2/rest-schemas'
import type { RestSearchMessageItem } from '../../src/main/transport/protocol-v2/rest-types'

const mapper = new RestMapper()

describe('parseRest* 响应 schema（C1 严格）', () => {
  it('search 响应合法通过；缺 messageId 拒（P0-1 camelCase）', () => {
    const ok = parseRestSearchMessages({ items: [{ conversationId: 'c1', messageId: 'm1', role: 'user', timestamp: 't', snippet: '命中' }], has_more: false })
    expect(ok.success).toBe(true)
    expect(parseRestSearchMessages({ items: [{ conversationId: 'c1', timestamp: 't' }], has_more: false }).success).toBe(false)
    // .strict()：多余字段拒（真实后端不回 kind/url）
    expect(parseRestSearchMessages({ items: [{ conversationId: 'c1', messageId: 'm1', role: 'user', timestamp: 't', kind: 'sticker' }], has_more: false }).success).toBe(false)
  })
  it('context 响应 anchor/before/after/conversationId 合法通过', () => {
    const r = parseRestMessageContext({ anchor: { role: 'user', message_id: 'm1', timestamp: 't' }, before: [], after: [], conversationId: 'c1' })
    expect(r.success).toBe(true)
  })
  it('stickers 响应 {stickers:[{stickerId, src}]} 通过；空 stickerId 拒（P0-2）', () => {
    expect(parseRestStickerList({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] }).success).toBe(true)
    expect(parseRestStickerList({ stickers: [{ stickerId: '' }] }).success).toBe(false)
  })
})

describe('RestMapper.toChatHistoryItem（D2 归一化，P0-1 仅文本映射）', () => {
  it('文本命中项：hitId/sortKey 派生 + senderLabel 映射', () => {
    const raw: RestSearchMessageItem = { conversationId: 'c1', messageId: 'm1', timestamp: '2026-08-14T02:00:00.000Z', role: 'user', snippet: '命中' }
    const item = mapper.toChatHistoryItem(raw)
    expect(item).toMatchObject({ hitId: 'c1:m1:', conversationId: 'c1', messageId: 'm1', senderLabel: 'user', snippet: '命中', sortKey: '2026-08-14T02:00:00.000Z|m1' })
    expect(item.resource).toBeUndefined()
  })
  it('带 segmentId → hitId 含分段；system/tool → 中文 senderLabel', () => {
    expect(mapper.toChatHistoryItem({ conversationId: 'c1', messageId: 'm2', timestamp: 't', segmentId: 'seg1' }).hitId).toBe('c1:m2:seg1')
    expect(mapper.toChatHistoryItem({ conversationId: 'c1', messageId: 'm3', timestamp: 't', role: 'system' }).senderLabel).toBe('系统')
    expect(mapper.toChatHistoryItem({ conversationId: 'c1', messageId: 'm4', timestamp: 't', role: 'tool' }).senderLabel).toBe('工具')
  })
  it('responseId/segmentId 透传；无 snippet 时缺省（不产 resource——search item 无 kind/url，P0-1）', () => {
    const item = mapper.toChatHistoryItem({ conversationId: 'c1', messageId: 'm5', timestamp: 't', responseId: 'g1', segmentId: 'seg2' })
    expect(item).toMatchObject({ responseId: 'g1', segmentId: 'seg2' })
    expect(item.snippet).toBeUndefined()
    expect(item.resource).toBeUndefined()
  })
})

describe('RestMapper.toChatHistoryPage / toMessagePageFromContext / toStickerManifest', () => {
  it('toChatHistoryPage：映射 + 稳定排序 + 游标透传', () => {
    const page = mapper.toChatHistoryPage({
      items: [
        { conversationId: 'c1', messageId: 'm2', role: 'user', timestamp: '2026-08-14T02:00:01.000Z' },
        { conversationId: 'c1', messageId: 'm1', role: 'user', timestamp: '2026-08-14T02:00:00.000Z' }
      ],
      has_more: true, cursor: 'abc'
    })
    expect(page.items.map((i) => i.messageId)).toEqual(['m1', 'm2'])
    expect(page).toMatchObject({ hasMore: true, nextCursor: 'abc' })
  })
  it('toMessagePageFromContext：before+anchor+after 合并 + 稳定排序 + hasMore:false', () => {
    const page = mapper.toMessagePageFromContext({
      anchor: { role: 'user', message_id: 'm5', timestamp: '2026-08-14T02:00:02.000Z' },
      before: [{ role: 'user', message_id: 'm4', timestamp: '2026-08-14T02:00:01.000Z' }],
      after: [{ role: 'assistant', message_id: 'm6', timestamp: '2026-08-14T02:00:03.000Z' }],
      conversationId: 'c1'
    })
    expect(page.items.map((i) => i.messageId)).toEqual(['m4', 'm5', 'm6'])
    expect(page.hasMore).toBe(false)
  })
  it('toStickerManifest：stickerId/src 必填透传（P0-2 对齐契约）', () => {
    const manifest = mapper.toStickerManifest({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] })
    expect(manifest.stickers[0]).toEqual({ stickerId: 'st_1', src: '/static/stickers/st_1.png' })
  })
})
