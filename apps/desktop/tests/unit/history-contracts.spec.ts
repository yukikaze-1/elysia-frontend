// tests/unit/history-contracts.spec.ts
// Task 4:历史查看器/表情契约形状（spec §4.3，D2/D8）——类型导出 + 对象字面量符合形状（编译期 + 运行时）。
// env=node：纯类型/常量断言。
import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../../src/shared/contracts'
import type { ChatHistoryItem, ChatHistoryPage, ChatHistoryQuery, ChatHistoryScope, ConversationResource, HistoryCategory } from '../../src/shared/contracts/backend'
import type { StickerItem, StickerManifest } from '../../src/shared/contracts/sticker'
import type { SendMessageInput } from '../../src/shared/contracts/message'
import { chatGetMessageContextSchema, chatListStickersSchema, chatQueryHistorySchema, chatSendSchema } from '../../src/main/ipc/channels'

/** 编译期相等断言（仓库先例：`stores/desktop-api.types.ts`）——导出仅为满足 noUnusedLocals */
type AssertAssignable<A extends B, B> = A extends B ? true : never
type UnionOf<T> = T extends string ? T : never
export type _HistoryCategoryMatchesSchema = AssertAssignable<HistoryCategory, UnionOf<(typeof chatQueryHistorySchema)['shape']['category']['options'][number]>>
export type _HistoryCategorySchemaMatchesUnion = AssertAssignable<UnionOf<(typeof chatQueryHistorySchema)['shape']['category']['options'][number]>, HistoryCategory>

describe('历史查看器契约（spec §4.3）', () => {
  it('ChatHistoryQuery 收敛形状：scope/query/localDate/timeZone/category/limit', () => {
    const scope: ChatHistoryScope = { type: 'conversation', conversationId: 'c1' }
    const q: ChatHistoryQuery = { scope, query: '关键词', localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'sticker', limit: 50 }
    expect(q.scope).toBe(scope)
    expect(q.category).toBe('sticker')
    expect(q.limit).toBe(50)
    // 2026-09-10 陈旧性审查：原作 `expect('keyword' in q).toBe(false)` —— 断言测试自己刚写的字面量，恒真；
    // 且 chatQueryHistorySchema **不是** .strict()（zod 默认剥未知键），故「补回废弃字段会被拒」并不成立。
    // 这里只锁真正有效的两条：合法查询能过 IPC 请求 schema（limit 上下界已在下方 schema 用例单独锁定）。
    expect(chatQueryHistorySchema.safeParse(q).success).toBe(true)
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
  // 2026-09-10 陈旧性审查重写：原作
  //   `const categories: HistoryCategory[] = [...]; expect(categories).toHaveLength(6)`
  // 是「字面量与旁边的数字对一遍」，两侧都是测试自己写的。改为把**类型联合**与 **IPC schema 枚举**闭合：
  // 任一新增分类而另一侧没跟上即编译失败（编译期），并锁顺序（运行时）。
  it('HistoryCategory 六值与 IPC schema 枚举双向一致', () => {
    expect(chatQueryHistorySchema.shape.category.options)
      .toEqual(['all', 'image_video', 'sticker', 'file', 'audio', 'link'])
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
    // 2026-09-10 陈旧性审查：原作 `expect(MessagePageSchema).toBeDefined()` 只证明符号存在，
  // 「getMessageContext 复用 MessagePageSchema」这条声称完全没被验证。改为断言它真能校验消息页形状。
    expect(MessagePageSchema.safeParse({
      items: [{ messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't', content: 'hi' }],
      hasMore: false
    }).success).toBe(true)
    expect(MessagePageSchema.safeParse({ items: [{ conversationId: 'c1' }], hasMore: false }).success).toBe(false)
  })
})
