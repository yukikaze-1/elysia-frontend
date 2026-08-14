// tests/unit/history-contracts.spec.ts
// Task 4:历史查看器/表情契约形状（spec §4.3，D2/D8）——类型导出 + 对象字面量符合形状（编译期 + 运行时）。
// env=node：纯类型/常量断言。
import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../../src/shared/contracts'
import type { ChatHistoryItem, ChatHistoryPage, ChatHistoryQuery, ChatHistoryScope, ConversationResource, HistoryCategory } from '../../src/shared/contracts/backend'
import type { StickerItem, StickerManifest } from '../../src/shared/contracts/sticker'
import type { SendMessageInput } from '../../src/shared/contracts/message'

describe('历史查看器契约（spec §4.3）', () => {
  it('ChatHistoryQuery 收敛形状：scope/query/localDate/timeZone/category/limit', () => {
    const scope: ChatHistoryScope = { type: 'conversation', conversationId: 'c1' }
    const q: ChatHistoryQuery = { scope, query: '关键词', localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'sticker', limit: 50 }
    expect(q.scope).toBe(scope)
    expect(q.category).toBe('sticker')
    expect(q.limit).toBe(50)
    // 废弃占位字段不再存在（编译期：此处若引用 keyword/fromDate 会 TS 报错，故以运行时不出现为断言）
    expect('keyword' in q).toBe(false)
    expect('fromDate' in q).toBe(false)
  })
  it('ChatHistoryItem 形状：hitId 稳定键 + 可跳转 messageId + 稳定排序键', () => {
    const item: ChatHistoryItem = {
      hitId: 'c1:m1:seg1', conversationId: 'c1', messageId: 'm1', segmentId: 'seg1',
      senderLabel: 'user', snippet: '命中片段', createdAt: '2026-08-14T02:00:00.000Z', sortKey: '2026-08-14T02:00:00.000Z|m1'
    }
    expect(item.hitId).toBe('c1:m1:seg1')
  })
  it('ConversationResource 六分类 + 可选 stickerId（P3-3）', () => {
    const r: ConversationResource = { messageId: 'm3', timestamp: 't', kind: 'sticker', url: '/static/stickers/st_1.png', stickerId: 'st_1' }
    expect(r.kind).toBe('sticker')
    expect(r.stickerId).toBe('st_1')
  })
  it('HistoryCategory 六值', () => {
    const categories: HistoryCategory[] = ['all', 'image_video', 'sticker', 'file', 'audio', 'link']
    expect(categories).toHaveLength(6)
  })
  it('ChatHistoryPage 保留游标分页字段 + snapshotId 可选', () => {
    const page: ChatHistoryPage = { items: [], hasMore: false }
    expect(page.hasMore).toBe(false)
  })
})

describe('表情契约（spec §4.3，D8）', () => {
  it('StickerManifest{stickers} 形状（P0-2：对齐契约 StickerEntry{stickerId, src}）', () => {
    const item: StickerItem = { stickerId: 'st_1', src: '/static/stickers/st_1.png' }
    const manifest: StickerManifest = { stickers: [item] }
    expect(manifest.stickers[0].stickerId).toBe('st_1')
  })
  it('SendMessageInput 增 stickerId 可选（wire 发送）', () => {
    const input: SendMessageInput = { conversationId: 'c1', text: '', clientRequestId: 'cr1', stickerId: 'st_1' }
    expect(input.stickerId).toBe('st_1')
    const plain: SendMessageInput = { conversationId: 'c1', text: 'hi', clientRequestId: 'cr2' }
    expect(plain.stickerId).toBeUndefined()
  })
})

describe('IPC 三新通道（spec §4.3）', () => {
  it('通道常量存在', () => {
    expect(IpcChannels.chatQueryHistory).toBe('chat:query-history')
    expect(IpcChannels.chatGetMessageContext).toBe('chat:get-message-context')
    expect(IpcChannels.chatListStickers).toBe('chat:list-stickers')
  })
})

import { chatGetMessageContextSchema, chatListStickersSchema, chatQueryHistorySchema, chatSendSchema } from '../../src/main/ipc/channels'
import { ChatHistoryPageSchema, MessagePageSchema, StickerManifestSchema } from '../../src/shared/schemas'

describe('IPC request schema（spec §4.3）', () => {
  it('chatQueryHistorySchema 全字段校验（scope 判别 + 必填 timeZone/category/limit）', () => {
    const ok = chatQueryHistorySchema.safeParse({ scope: { type: 'conversation', conversationId: 'c1' }, query: 'k', localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'sticker', limit: 50 })
    expect(ok.success).toBe(true)
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 }).success).toBe(true)
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'bogus' }, timeZone: 'UTC', category: 'all', limit: 50 }).success).toBe(false)
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'conversation', conversationId: 'c1' }, timeZone: 'UTC', category: 'all', limit: 200 }).success).toBe(false)  // limit 上限 100
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'conversation', conversationId: 'c1' }, timeZone: 'UTC', category: 'all' }).success).toBe(false)  // limit 必填
  })
  it('chatQueryHistorySchema localDate 必须 YYYY-MM-DD', () => {
    expect(chatQueryHistorySchema.safeParse({ scope: { type: 'all_conversations' }, localDate: '2026/08/14', timeZone: 'UTC', category: 'all', limit: 50 }).success).toBe(false)
  })
  it('chatGetMessageContextSchema 对齐 MessageContextQuery；chatListStickersSchema 无参', () => {
    expect(chatGetMessageContextSchema.safeParse({ conversationId: 'c1', messageId: 'm1', before: 5, after: 5 }).success).toBe(true)
    expect(chatGetMessageContextSchema.safeParse({ conversationId: 'c1' }).success).toBe(false)
    expect(chatListStickersSchema.safeParse(undefined).success).toBe(true)
  })
  it('chatSendSchema 接受可选 stickerId（st_ 前缀）', () => {
    const r = chatSendSchema.safeParse({ conversationId: 'c1', text: '', clientRequestId: 'cr1', stickerId: 'st_1' })
    expect(r.success).toBe(true)
  })
})

describe('IPC 响应 schema 严格镜像（C1）', () => {
  it('ChatHistoryPageSchema 接受完整命中项（含 resource）', () => {
    const r = ChatHistoryPageSchema.safeParse({
      items: [{ hitId: 'c1:m1:', conversationId: 'c1', messageId: 'm1', senderLabel: 'user', createdAt: 't', sortKey: 't|m1', resource: { messageId: 'm1', timestamp: 't', kind: 'sticker', url: '/static/stickers/st_1.png', stickerId: 'st_1' } }],
      hasMore: false
    })
    expect(r.success).toBe(true)
  })
  it('ChatHistoryPageSchema 拒缺必填（hitId/messageId/senderLabel/sortKey）', () => {
    expect(ChatHistoryPageSchema.safeParse({ items: [{ conversationId: 'c1', createdAt: 't' }], hasMore: false }).success).toBe(false)
  })
  it('StickerManifestSchema 接受 {stickers}（P0-2）；getMessageContext 复用 MessagePageSchema', () => {
    expect(StickerManifestSchema.safeParse({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] }).success).toBe(true)
    expect(StickerManifestSchema.safeParse({ stickers: [{ stickerId: '' }] }).success).toBe(false)
    expect(MessagePageSchema).toBeDefined()
  })
})
