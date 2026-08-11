// tests/unit/conversation.store.spec.ts
// Task 4:conversationStore——list/activate(resetConversation+getMessages→loadPage)/create/rename(单对象载荷)/remove/getMore(cursor 透传)。
// env=node:store 经 stores/desktop-api 注入 mock api;pinia 用 createPinia + setActivePinia。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { Message } from '@shared/contracts'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {})
}

const convA = { id: 'c1', title: '会话A', updatedAt: '2026-08-11T00:00:00Z', preview: 'hi' }
const convB = { id: 'c2', title: '会话B', updatedAt: '2026-08-11T00:00:01Z' }

describe('conversationStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.resetAllMocks()
  })

  it('list:调 api.listConversations({}),记录 items/hasMore/nextCursor', async () => {
    const store = useConversationStore()
    mockApi.listConversations.mockResolvedValue({ items: [convA, convB], hasMore: true, nextCursor: 'cur-1' })
    await store.list()
    expect(mockApi.listConversations).toHaveBeenCalledWith({})
    expect(store.items).toHaveLength(2)
    expect(store.items[0].id).toBe('c1')
    expect(store.hasMore).toBe(true)
    expect(store.nextCursor).toBe('cur-1')
  })

  it('activate(id):api.activate + resetConversation + getMessages → loadPage', async () => {
    const store = useConversationStore()
    const messageStore = useMessageStore()
    const resetSpy = vi.spyOn(messageStore, 'resetConversation')
    const loadPageSpy = vi.spyOn(messageStore, 'loadPage')
    // 预置旧会话残留消息:activate 后应被 resetConversation 清空
    messageStore.byId['stale-1'] = { messageId: 'stale-1', conversationId: 'old', role: 'user', content: 'old', status: 'completed', createdAt: 't' }
    const msg: Message = { messageId: 'm1', conversationId: 'c1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' }
    mockApi.activate.mockResolvedValue({ conversationId: 'c1' })
    mockApi.getMessages.mockResolvedValue({ items: [msg], hasMore: false })
    await store.activate('c1')
    expect(mockApi.activate).toHaveBeenCalledWith('c1')
    expect(store.currentId).toBe('c1')
    expect(resetSpy).toHaveBeenCalledWith('c1')
    expect(mockApi.getMessages).toHaveBeenCalledWith({ conversationId: 'c1' })
    expect(loadPageSpy).toHaveBeenCalledWith({ items: [msg], hasMore: false })
    // 可观察状态:旧消息清空 + 第一页历史载入
    expect(messageStore.byId['stale-1']).toBeUndefined()
    expect(messageStore.byId['m1']?.content).toBe('hi')
  })

  it('create:createConversation({}) 后刷新列表并置 currentId', async () => {
    const store = useConversationStore()
    const created = { id: 'c9', title: '新会话', updatedAt: '2026-08-11T00:00:02Z' }
    mockApi.createConversation.mockResolvedValue(created)
    mockApi.listConversations.mockResolvedValue({ items: [convA, created], hasMore: false })
    await store.create()
    expect(mockApi.createConversation).toHaveBeenCalledWith({})
    expect(store.currentId).toBe('c9')
    expect(mockApi.listConversations).toHaveBeenCalled()
    expect(store.items).toHaveLength(2)
  })

  it('rename:单对象载荷 {conversationId,title}', async () => {
    const store = useConversationStore()
    mockApi.renameConversation.mockResolvedValue({ ...convA, title: '新标题' })
    mockApi.listConversations.mockResolvedValue({ items: [convA], hasMore: false })
    await store.rename({ conversationId: 'c1', title: '新标题' })
    expect(mockApi.renameConversation).toHaveBeenCalledWith({ conversationId: 'c1', title: '新标题' })
  })

  it('remove:deleteConversation(id) 后刷新列表', async () => {
    const store = useConversationStore()
    mockApi.deleteConversation.mockResolvedValue(undefined)
    mockApi.listConversations.mockResolvedValue({ items: [convB], hasMore: false })
    await store.remove('c1')
    expect(mockApi.deleteConversation).toHaveBeenCalledWith('c1')
    expect(store.items.map((c) => c.id)).toEqual(['c2'])
  })

  it('remove 当前激活会话:currentId 清空 + messageStore 清空(不悬空,L1)', async () => {
    const store = useConversationStore()
    const messageStore = useMessageStore()
    store.$patch({ currentId: 'c1' })
    // 预置旧消息:删除激活会话后应被清空(聊天区显示空态)
    messageStore.byId['stale-1'] = { messageId: 'stale-1', conversationId: 'c1', role: 'user', content: 'old', status: 'completed', createdAt: 't' }
    mockApi.deleteConversation.mockResolvedValue(undefined)
    mockApi.listConversations.mockResolvedValue({ items: [convB], hasMore: false })
    await store.remove('c1')
    expect(store.currentId).toBeUndefined()
    expect(messageStore.byId['stale-1']).toBeUndefined()
  })

  it('getMore:nextCursor 透传追加;无 cursor 早退不调 api', async () => {
    const store = useConversationStore()
    mockApi.listConversations.mockResolvedValue({ items: [convA], hasMore: true, nextCursor: 'cur-1' })
    await store.list()
    mockApi.listConversations.mockResolvedValue({ items: [convB], hasMore: false, nextCursor: undefined })
    await store.getMore()
    expect(mockApi.listConversations).toHaveBeenLastCalledWith({ cursor: 'cur-1' })
    expect(store.items.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(store.hasMore).toBe(false)
    expect(store.nextCursor).toBeUndefined()
    // nextCursor 已空 → 早退,不再调 api
    const callsBefore = mockApi.listConversations.mock.calls.length
    await store.getMore()
    expect(mockApi.listConversations.mock.calls.length).toBe(callsBefore)
  })
})
