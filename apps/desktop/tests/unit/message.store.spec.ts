// tests/unit/message.store.spec.ts
// Task 4:messageStore 流式应用——generation 守卫/归并(StreamAccumulator)/cancel 乐观置位/断线 in-flight/loadReplay/乐观发送。
// env=node:不触 Electron——store 经 stores/desktop-api 注入 mock api(R2);pinia 用 createPinia + setActivePinia。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { BackendEvent, GenerationStartedEvent, Message } from '@shared/contracts'

// mock desktopApi(store 依赖注入)——通过 stores/desktop-api.types.ts 的 DesktopApiLike
const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {})
}
// 注入机制定死(P1-3):stores/desktop-api.ts export let api + setDesktopApi;store 惰性 import { api };
// main.ts 调 setDesktopApi(window.desktopApi);测试 beforeEach 里 setDesktopApi(mockApi)(node env 无 window,不触全局)

// started 返回 GenerationStartedEvent(而非 BackendEvent 联合):completed 测试里 {...started(), event:'generation.completed'}
// 的联合展开会在缺少 responseId 的成员上无法赋给 BackendEvent,typecheck:node 需精确类型。
function started(): GenerationStartedEvent { return { eventId: 'e', sequence: 1, event: 'generation.started', generationId: 'gen-1', messageId: 'msg-1', responseId: 'gen-1', conversationId: 'conv-1', model: 'm1' } }
function delta(seg: string, seq: number, text: string): BackendEvent { return { eventId: 'e', sequence: 2, event: 'generation.delta', generationId: 'gen-1', segmentId: seg, segmentIndex: 0, channel: 'public_reply', kind: 'markdown', deltaSequence: seq, text } }

describe('messageStore 流式应用', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi) })   // R2:注入 mock api(import { setDesktopApi } from stores/desktop-api)

  it('started→delta→completed 归并 assistant 消息(Token/model/emotion 落位)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(delta('seg-1', 0, '你好'))
    store.applyEvent({ ...started(), event: 'generation.completed', usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }, model: 'm1', emotion: 'happy' })
    expect(store.byId['msg-1']?.role).toBe('assistant')
    expect(store.byId['msg-1']?.assistantSegments?.[0]?.text).toBe('你好')
    expect(store.byId['msg-1']?.status).toBe('completed')
    expect(store.byId['msg-1']?.usage?.total).toBe(3)
    expect(store.byId['msg-1']?.emotion).toBe('happy')
  })

  it('generationId 守卫:跨代 delta 丢弃', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent({ ...delta('seg-1', 0, 'ok'), generationId: 'gen-OTHER' })
    expect(store.byId['msg-1']?.assistantSegments).toHaveLength(0)
  })

  it('cancel 乐观置 interrupted', async () => {
    const store = useMessageStore()
    store.applyEvent(started())
    await store.cancel()   // P1-2:与实现顺序一致(await desktopApi.cancel 后置位)
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('断线且 in-flight → assistant 置 interrupted(P1-6)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.handleConnectionStateChange({ status: 'reconnecting' })   // 由 onChatState 回调接线调用(P2-1)
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('cancel 后同代迟到 completed 不复活 interrupted(P2-5)', async () => {
    const store = useMessageStore()
    store.applyEvent(started())
    await store.cancel()
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    // activeGenerationId 已清空,同代迟到 completed 丢弃(accumulator 仍在也不复活)
    store.applyEvent({ ...started(), event: 'generation.completed', usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }, model: 'm1', emotion: 'happy' })
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.byId['msg-1']?.usage).toBeUndefined()
  })

  it('断线后同代迟到 delta/completed 丢弃(P2-5)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.handleConnectionStateChange({ status: 'reconnecting' })
    // 迟到 delta:不追加分段
    store.applyEvent(delta('seg-1', 0, '迟到'))
    expect(store.byId['msg-1']?.assistantSegments).toHaveLength(0)
    // 迟到 completed:不复活为 completed
    store.applyEvent({ ...started(), event: 'generation.completed', usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }, model: 'm1', emotion: 'happy' })
    expect(store.byId['msg-1']?.status).toBe('interrupted')
  })

  it('loadReplay 按 messageId 去重插入(P2-2)', () => {
    const store = useMessageStore()
    const m1 = { messageId: 'msg-r1', conversationId: 'conv-1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' } as Message
    store.loadReplay('conv-1', [m1, { ...m1 }])
    expect(Object.keys(store.byId)).toHaveLength(1)   // 去重
  })

  it('乐观发送:pending → acknowledged(failed 时 failed)', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1' })   // 无 serverMessageId
    const store = useMessageStore()
    await store.send('hi')
    const msgs = Object.values(store.byId)
    expect(msgs.some((m) => m.role === 'user' && m.status === 'acknowledged')).toBe(true)
  })
})
