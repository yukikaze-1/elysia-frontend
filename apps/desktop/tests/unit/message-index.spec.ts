// tests/unit/message-index.spec.ts
// `message/index-store` 的判别力测试：有序插入、去重、乐观 key 迁移。
//
// 这些判据此前只能经「整棵 Pinia + mock api」的消息 store 集成用例到达。下沉后可以直接
// 构造边界：同序 tie-break、原位替换后的重排、旧 key 已被清（I1）等。
//
// 读法：`createMessageIndex(state)` 只操作传入的 state 对象（store 才是 ref 的持有者），
// 故用例直接对同一个 state 断言——这也顺带钉住「本模块不持有第二份状态」这一契约。
import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/shared/contracts'
import { createMessageIndex, type MessageIndexState } from '../../src/renderer/src/message/index-store'

function msg(messageId: string, createdAt: string, extra: Partial<Message> = {}): Message {
  return { messageId, conversationId: 'c1', role: 'assistant', createdAt, ...extra } as Message
}

function freshState(): MessageIndexState {
  return { byId: {}, order: [] }
}

describe('createMessageIndex 有序插入（P0-1）', () => {
  it('按 (createdAt, messageId) 升序插入，插入顺序不影响最终 order', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    index.upsert(msg('b', '2026-01-01T00:00:02.000Z'))
    index.upsert(msg('c', '2026-01-01T00:00:03.000Z'))
    index.upsert(msg('a', '2026-01-01T00:00:01.000Z'))
    expect(state.order).toEqual(['a', 'b', 'c'])
  })

  it('同 createdAt 时按 messageId 升序（tie-break 确定，不依赖插入顺序）', () => {
    const first = freshState()
    const firstIndex = createMessageIndex(first)
    firstIndex.upsert(msg('z', '2026-01-01T00:00:01.000Z'))
    firstIndex.upsert(msg('a', '2026-01-01T00:00:01.000Z'))
    const second = freshState()
    const secondIndex = createMessageIndex(second)
    secondIndex.upsert(msg('a', '2026-01-01T00:00:01.000Z'))
    secondIndex.upsert(msg('z', '2026-01-01T00:00:01.000Z'))
    expect(first.order).toEqual(['a', 'z'])
    expect(second.order).toEqual(['a', 'z'])
  })

  it('非时间序到达的一整页合并后仍严格升序（免疫乱序页）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    for (const [id, at] of [['m5', '05'], ['m1', '01'], ['m4', '04'], ['m2', '02'], ['m3', '03']] as const) {
      index.upsert(msg(id, `2026-01-01T00:00:${at}.000Z`))
    }
    expect(state.order).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })

  it('重复 messageId 原位替换、不重插（loadPage 二次去重）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    index.upsert(msg('a', '2026-01-01T00:00:01.000Z'))
    index.upsert(msg('b', '2026-01-01T00:00:02.000Z'))
    index.upsert(msg('a', '2026-01-01T00:00:01.000Z', { content: 'updated' }))
    expect(state.order).toEqual(['a', 'b'])
    expect(state.byId['a'].content).toBe('updated')
  })

  it('替换纠正 createdAt 后按新位置重排（权威 replay 修正乐观消息时间）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    index.upsert(msg('a', '2026-01-01T00:00:01.000Z'))
    index.upsert(msg('b', '2026-01-01T00:00:02.000Z'))
    // 权威副本把 a 的时间推到 b 之后
    index.upsert(msg('a', '2026-01-01T00:00:03.000Z'))
    expect(state.order).toEqual(['b', 'a'])
  })

  it('空表插入与已满表插入都落在正确位置（二分边界：lo=0 与 lo=length）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    index.upsert(msg('mid', '2026-01-01T00:00:02.000Z'))
    index.upsert(msg('first', '2026-01-01T00:00:01.000Z'))   // 插到头部
    index.upsert(msg('last', '2026-01-01T00:00:03.000Z'))    // 插到尾部
    expect(state.order).toEqual(['first', 'mid', 'last'])
  })

  it('reorder 对已有表按相同判据重新排序（批量加载后保序）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    state.byId = {
      b: msg('b', '2026-01-01T00:00:02.000Z'),
      a: msg('a', '2026-01-01T00:00:01.000Z')
    }
    state.order = ['b', 'a']
    index.reorder()
    expect(state.order).toEqual(['a', 'b'])
  })

  it('每次写入都替换 order 载体（不原地 sort/mutate，保证 ref 载体下的响应性）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    index.upsert(msg('a', '2026-01-01T00:00:01.000Z'))
    const afterInsert = state.order
    index.upsert(msg('b', '2026-01-01T00:00:02.000Z'))
    expect(state.order).not.toBe(afterInsert)
    const afterSecond = state.order
    index.upsert(msg('a', '2026-01-01T00:00:09.000Z'))   // 走重排分支
    expect(state.order).not.toBe(afterSecond)
    index.reorder()
    expect(state.order).not.toBe(afterSecond)
  })
})

describe('createMessageIndex 乐观 key 迁移（P2-1 / I1）', () => {
  it('迁移同步 byId/order 两处 key 与 msg.messageId 本体', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    const optimistic = msg('local-req1', '2026-01-01T00:00:01.000Z')
    index.upsert(optimistic)
    const before = state.order
    index.migrateKey('local-req1', 'msg-9', optimistic)
    expect(state.order).toEqual(['msg-9'])
    expect(state.order).not.toBe(before)   // order 载体也被替换
    expect(state.byId['local-req1']).toBeUndefined()
    expect(state.byId['msg-9']).toBe(optimistic)
    expect(optimistic.messageId).toBe('msg-9')
  })

  it('旧 key 已被清（切会话）→ 不重插：迟到 ACK 不得把消息塞回新会话（I1）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    const optimistic = msg('local-req1', '2026-01-01T00:00:01.000Z')
    index.upsert(optimistic)
    // resetConversation 语义：整表清空
    state.byId = {}
    state.order = []
    index.migrateKey('local-req1', 'msg-9', optimistic)
    expect(state.order).toEqual([])
    expect(state.byId['msg-9']).toBeUndefined()
    // 且不得改写消息本体：它已不属于当前会话
    expect(optimistic.messageId).toBe('local-req1')
  })

  it('新旧 key 相同 → 幂等 no-op（不丢消息）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    const m = msg('same', '2026-01-01T00:00:01.000Z')
    index.upsert(m)
    index.migrateKey('same', 'same', m)
    expect(state.order).toEqual(['same'])
    expect(state.byId['same']).toBe(m)
  })

  it('旧 key 存在但 order 里已无该 key → 仍迁移 byId，不产生幽灵 order 项', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    const m = msg('local-x', '2026-01-01T00:00:01.000Z')
    index.upsert(m)
    state.order = []   // 模拟 order 被别处先行清理
    index.migrateKey('local-x', 'msg-1', m)
    expect(state.order).toEqual([])
    expect(state.byId['msg-1']).toBe(m)
    expect(state.byId['local-x']).toBeUndefined()
  })

  it('迁移保持原有位置而非重排（乐观消息的位置就是它被发送时的位置）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    const optimistic = msg('local-req1', '2026-01-01T00:00:05.000Z')
    index.upsert(msg('a', '2026-01-01T00:00:01.000Z'))
    index.upsert(optimistic)
    index.upsert(msg('z', '2026-01-01T00:00:09.000Z'))
    // 服务端分配的新 key 恰好排在 a 之前，但位置必须保持不变
    index.migrateKey('local-req1', 'msg-0', optimistic)
    expect(state.order).toEqual(['a', 'msg-0', 'z'])
  })
})

describe('createMessageIndex lastTurnUsage', () => {
  it('取最后一条带 usage 的 assistant 消息（跳过 user 与无 usage 的 assistant）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    index.upsert(msg('a1', '2026-01-01T00:00:01.000Z', { usage: { input: 1, output: 2, total: 3, source: 'provider_reported' } }))
    index.upsert(msg('a2', '2026-01-01T00:00:02.000Z'))
    index.upsert({
      messageId: 'u1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: '2026-01-01T00:00:03.000Z',
      usage: { input: 9, output: 9, total: 18, source: 'provider_reported' }
    })
    expect(index.lastTurnUsage()).toEqual({ input: 1, output: 2, total: 3, source: 'provider_reported' })
  })

  it('没有任何带 usage 的消息 → undefined（界面据此隐藏整条，不显示 0）', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    index.upsert(msg('a1', '2026-01-01T00:00:01.000Z'))
    expect(index.lastTurnUsage()).toBeUndefined()
  })

  it('取的是「最近一轮」而非「最近的带 usage 消息」——位置在 order 末尾者优先', () => {
    const state = freshState()
    const index = createMessageIndex(state)
    index.upsert(msg('old', '2026-01-01T00:00:01.000Z', { usage: { input: 1, output: 1, total: 2, source: 'provider_reported' } }))
    index.upsert(msg('new', '2026-01-01T00:00:02.000Z', { usage: { input: 7, output: 7, total: 14, source: 'server_aggregate' } }))
    expect(index.lastTurnUsage()).toEqual({ input: 7, output: 7, total: 14, source: 'server_aggregate' })
  })
})
