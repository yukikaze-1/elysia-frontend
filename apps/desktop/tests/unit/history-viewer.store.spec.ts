// tests/unit/history-viewer.store.spec.ts
// Task 15:historyViewerStore（spec §4.1/§4.5/§4.8，D4/D10/D11/D12）——open 预置、submitQuery 成功/失败保留旧结果、
// loadMore 游标 + busy 防重入、无结果空态、jumpTo 编排、不阻塞聊天（P2-5：打开查看器期间 messageStore 事件继续应用，D10）。
// env=node：setDesktopApi 注入 mock；pinia 用 createPinia + setActivePinia（P1-2：node 无全局 pinia，缺则每用例抛「No active Pinia」）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useHistoryViewerStore } from '../../src/renderer/src/stores/historyViewer.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'

function item(messageId: string, createdAt: string): import('@shared/contracts').ChatHistoryItem {
  return { hitId: `c1:${messageId}:`, conversationId: 'c1', messageId, senderLabel: 'user', createdAt, sortKey: `${createdAt}|${messageId}` }
}

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi({ queryChatHistory: vi.fn() } as never)
})

describe('historyViewerStore', () => {
  it('open(initialCategory?) 预置分类（资源入口 → image_video）', () => {
    const s = useHistoryViewerStore()
    s.openViewer('image_video')
    expect(s.open).toBe(true)
    expect(s.category).toBe('image_video')
    s.openViewer()
    expect(s.category).toBe('all')
  })
  it('submitQuery 成功：写 items/hasMore/nextCursor/hasSearched', async () => {
    setDesktopApi({ queryChatHistory: async () => ({ items: [item('m1', 't1')], hasMore: false, nextCursor: undefined }) } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    await s.submitQuery()
    expect(s.items).toHaveLength(1)
    expect(s.hasSearched).toBe(true)
    expect(s.error).toBeUndefined()
  })
  it('submitQuery 失败：保留旧结果 + 写 error（不清空聊天内容）', async () => {
    setDesktopApi({ queryChatHistory: vi.fn(async () => { throw new Error('[HTTP_500] 服务端错误') }) } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    s.$patch({ items: [item('mOld', 'tOld')] })
    await s.submitQuery()
    expect(s.items).toHaveLength(1)          // 旧结果保留
    expect(s.error?.message).toContain('服务端错误')
    expect(s.hasSearched).toBe(false)        // 阶段3 整改 C1：失败不置 hasSearched（防「没有找到相关聊天记录」伪空态）
  })
  it('loadMore：带 cursor 去重合并 + busy 防重入', async () => {
    const calls: Array<Record<string, unknown>> = []
    setDesktopApi({
      queryChatHistory: async (input: Record<string, unknown>) => {
        calls.push(input)
        return { items: [item('m2', 't2')], hasMore: false, nextCursor: undefined }
      }
    } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    s.$patch({ items: [item('m1', 't1')], hasMore: true, nextCursor: 'cur-1' })
    const p1 = s.loadMore()
    const p2 = s.loadMore()       // busy 防重入：第二次直接返回
    await Promise.all([p1, p2])
    expect(calls).toHaveLength(1)
    expect(calls[0].cursor).toBe('cur-1')
    expect(s.items.map((i) => i.messageId)).toEqual(['m1', 'm2'])
  })
  it('无结果空态：hasSearched=true 且 items 空', async () => {
    setDesktopApi({ queryChatHistory: async () => ({ items: [], hasMore: false }) } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    await s.submitQuery()
    expect(s.hasSearched).toBe(true)
    expect(s.items).toHaveLength(0)
  })
  it('jumpTo：关闭查看器并返回跳转目标（含 segmentId）', () => {
    const s = useHistoryViewerStore()
    s.openViewer()
    const hit = { ...item('m5', 't5'), segmentId: 'seg1' }
    const target = s.jumpTo(hit)
    expect(s.open).toBe(false)
    expect(target).toEqual({ conversationId: 'c1', messageId: 'm5', segmentId: 'seg1' })
  })
  it('打开查看器不阻塞聊天流：D10 store 事件继续应用（查看器 open 期间 messageStore 归并不受影响）', async () => {
    const s = useHistoryViewerStore()
    s.openViewer()
    expect(s.open).toBe(true)
    useConversationStore().$patch({ currentId: 'c1' })   // F2：事件归属守卫依赖 currentId
    const ms = useMessageStore()
    ms.applyEvent({ eventId: 'e1', sequence: 1, event: 'generation.started', generationId: 'g1', messageId: 'm10', responseId: 'g1', conversationId: 'c1' })
    ms.applyEvent({ eventId: 'e2', sequence: 2, event: 'generation.delta', generationId: 'g1', segmentId: 's1', segmentIndex: 0, channel: 'public_reply', kind: 'markdown', deltaSequence: 0, text: '流式继续' })
    expect(ms.byId.m10?.assistantSegments?.[0]?.text).toBe('流式继续')   // 查看器打开不阻断消息归并
  })
})
