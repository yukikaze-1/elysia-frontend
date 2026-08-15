// tests/unit/conversation.store.spec.ts
// Task 4:conversationStore——list/activate(resetConversation+getMessages→loadPage)/create/rename(单对象载荷)/remove/getMore(cursor 透传)。
// env=node:store 经 stores/desktop-api 注入 mock api;pinia 用 createPinia + setActivePinia。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useCacheStore } from '../../src/renderer/src/stores/cache.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { Message } from '@shared/contracts'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  hydratePersistence: vi.fn(), persistSession: vi.fn(), cacheMessages: vi.fn(), openExternal: vi.fn(), attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn(),
  queryChatHistory: vi.fn(), getMessageContext: vi.fn(), listStickers: vi.fn(),
  listModelProfiles: vi.fn(), saveModelProfile: vi.fn(), deleteModelProfile: vi.fn(), testModelProfile: vi.fn(), activateModelProfile: vi.fn(), getActiveModelSelection: vi.fn(),
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn()
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

  it('F1:操作失败置 error,成功后清旧错误(短横幅语义)', async () => {
    const store = useConversationStore()
    mockApi.listConversations.mockRejectedValueOnce(new Error('[AUTHENTICATION_FAILED] 401'))
    await store.list()
    expect(store.error?.code).toBe('AUTHENTICATION_FAILED')
    mockApi.listConversations.mockResolvedValueOnce({ items: [convA], hasMore: false })
    await store.list()
    expect(store.error).toBeUndefined()
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

  // —— 批次B T8:初始化编排(FE-P1-03 §4.1)+ epoch 守卫(FE-P1-04 §4.2.3/4)+ ready/busy/error + 补激活(§4.1.3) ——
  it('activate epoch:快速 A→B→A 迟到 A 响应不覆盖', async () => {
    const store = useConversationStore()
    const messageStore = useMessageStore()
    const msgB: Message = { messageId: 'b1', conversationId: 'c2', role: 'user', content: 'B', status: 'completed', createdAt: 't' }
    const msgA: Message = { messageId: 'a1', conversationId: 'c1', role: 'user', content: 'A', status: 'completed', createdAt: 't' }
    let resolveLateActivate!: (v: { conversationId: string }) => void
    mockApi.activate.mockImplementationOnce(() => new Promise((r) => { resolveLateActivate = r }))  // 第一次 A:activate 挂起(迟到)
    mockApi.activate.mockResolvedValue({ conversationId: 'c' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false })
    const late = store.activate('c1')          // epoch=1,挂起于 api.activate
    mockApi.getMessages.mockResolvedValue({ items: [msgB], hasMore: false })
    await store.activate('c2')                 // epoch=2 完整完成
    expect(store.currentId).toBe('c2')
    mockApi.getMessages.mockResolvedValue({ items: [msgA], hasMore: false })
    await store.activate('c1')                 // epoch=3 完整完成
    expect(store.currentId).toBe('c1')
    resolveLateActivate({ conversationId: 'c1' })  // 迟到的第一次 A 响应到达
    await late
    expect(store.currentId).toBe('c1')             // 不被迟到响应覆盖
    expect(messageStore.byId['a1']?.content).toBe('A')  // 最终 A 的页面已载入
    expect(messageStore.byId['b1']).toBeUndefined()     // 最终 A 激活时 reset 已清空 B
    expect(store.busy).toBe(false)
  })

  it('activate epoch:getMessages 迟到页面不提交到新会话', async () => {
    const store = useConversationStore()
    const messageStore = useMessageStore()
    const msgB: Message = { messageId: 'b1', conversationId: 'c2', role: 'user', content: 'B', status: 'completed', createdAt: 't' }
    const staleA: Message = { messageId: 'a-stale', conversationId: 'c1', role: 'user', content: 'A-stale', status: 'completed', createdAt: 't' }
    let resolveStalePage!: (v: { items: Message[]; hasMore: boolean }) => void
    mockApi.activate.mockResolvedValue({ conversationId: 'c1' })
    mockApi.getMessages.mockImplementationOnce(() => new Promise((r) => { resolveStalePage = r }))  // 第一次 A:getMessages 挂起
    const first = store.activate('c1')             // epoch=1,到达 getMessages 后挂起
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()  // 让 first 推进到 getMessages 挂起点
    mockApi.getMessages.mockResolvedValue({ items: [msgB], hasMore: false })
    await store.activate('c2')                     // epoch=2 完整完成
    expect(store.currentId).toBe('c2')
    resolveStalePage({ items: [staleA], hasMore: false })  // 迟到的 c1 页面
    await first
    expect(store.currentId).toBe('c2')                  // 不被覆盖
    expect(messageStore.byId['a-stale']).toBeUndefined() // 迟到页面未提交到 B
    expect(messageStore.byId['b1']?.content).toBe('B')
  })

  it('onConnected 幂等:同 connectionId 只跑一次', async () => {
    const store = useConversationStore()
    mockApi.listConversations.mockResolvedValue({ items: [convA], hasMore: false })
    await store.onConnected('conn-1')
    expect(store.ready).toBe(true)
    const calls = mockApi.listConversations.mock.calls.length
    await store.onConnected('conn-1')
    expect(mockApi.listConversations.mock.calls.length).toBe(calls)
    expect(store.initializedFor).toBe('conn-1')
  })

  it('onConnected 首次:list 后 activeId 存在 → activate', async () => {
    const store = useConversationStore()
    useConnectionStore().$patch({ state: { status: 'connected', activeConversationId: 'c1' } })
    mockApi.listConversations.mockResolvedValue({ items: [convA], hasMore: false })
    mockApi.activate.mockResolvedValue({ conversationId: 'c1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false })
    await store.onConnected('conn-1')
    expect(mockApi.listConversations).toHaveBeenCalledWith({})
    expect(mockApi.activate).toHaveBeenCalledWith('c1')
    expect(store.currentId).toBe('c1')
    expect(store.ready).toBe(true)
  })

  it('onConnected 首次无 activeId → currentId 留空 + ready true(空态)', async () => {
    const store = useConversationStore()
    useConnectionStore().$patch({ state: { status: 'connected' } })
    mockApi.listConversations.mockResolvedValue({ items: [], hasMore: false })
    await store.onConnected('conn-1')
    expect(store.currentId).toBeUndefined()
    expect(store.ready).toBe(true)
    expect(mockApi.activate).not.toHaveBeenCalled()
  })

  it('onConnected 重连(有 currentId):只 safeList + reconcile(activeId!==currentId → activate)', async () => {
    const store = useConversationStore()
    store.$patch({ currentId: 'c1' })
    useConnectionStore().$patch({ state: { status: 'connected', activeConversationId: 'c2' } })
    mockApi.listConversations.mockResolvedValue({ items: [convA, convB], hasMore: false })
    mockApi.activate.mockResolvedValue({ conversationId: 'c2' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false })
    await store.onConnected('conn-2')
    expect(mockApi.listConversations).toHaveBeenCalled()
    expect(mockApi.activate).toHaveBeenCalledWith('c2')
    expect(store.currentId).toBe('c2')
    expect(store.ready).toBe(true)
  })

  it('safeList 失败写 error 不抛', async () => {
    const store = useConversationStore()
    mockApi.listConversations.mockRejectedValue(new Error('list boom'))
    await expect(store.safeList()).resolves.toBe(false)
    expect(store.error?.message).toContain('list boom')
    expect(store.busy).toBe(false)
  })

  it('onConnected 列表失败不进 ready，同 connectionId 可重试成功', async () => {
    const store = useConversationStore()
    mockApi.listConversations.mockRejectedValueOnce(new Error('temporary list failure'))
    await store.onConnected('conn-retry')
    expect(store.ready).toBe(false)
    expect(store.initializedFor).toBeUndefined()
    expect(store.error?.message).toContain('temporary list failure')

    mockApi.listConversations.mockResolvedValueOnce({ items: [convA], hasMore: false })
    await store.onConnected('conn-retry')
    expect(mockApi.listConversations).toHaveBeenCalledTimes(2)
    expect(store.ready).toBe(true)
    expect(store.initializedFor).toBe('conn-retry')
    expect(store.items).toEqual([convA])
  })

  it('ready 初始 false,onConnected(safeList) 后 true(N1)', async () => {
    const store = useConversationStore()
    expect(store.ready).toBe(false)
    mockApi.listConversations.mockResolvedValue({ items: [], hasMore: false })
    await store.onConnected('conn-1')
    expect(store.ready).toBe(true)
  })

  it('onActiveConversationAppeared:currentId 空 → activate;已设 → 不动;busy → 跳过', async () => {
    const store = useConversationStore()
    mockApi.activate.mockResolvedValue({ conversationId: 'c1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false })
    // currentId 空 → activate
    await store.onActiveConversationAppeared('c1')
    expect(mockApi.activate).toHaveBeenCalledWith('c1')
    expect(store.currentId).toBe('c1')
    const callsAfterActivate = mockApi.activate.mock.calls.length
    // 已设 → 不动
    await store.onActiveConversationAppeared('c2')
    expect(mockApi.activate.mock.calls.length).toBe(callsAfterActivate)
    expect(store.currentId).toBe('c1')
    // busy → 跳过
    store.$patch({ currentId: undefined })
    store.$patch({ busy: true })
    await store.onActiveConversationAppeared('c3')
    expect(mockApi.activate.mock.calls.length).toBe(callsAfterActivate)
    expect(store.currentId).toBeUndefined()
  })

  it('safeList 期间用户切会话不覆盖(m6)', async () => {
    const store = useConversationStore()
    useConnectionStore().$patch({ state: { status: 'connected', activeConversationId: 'c1' } })
    let resolveList!: (v: unknown) => void
    mockApi.listConversations.mockImplementationOnce(() => new Promise((r) => { resolveList = r }))
    mockApi.activate.mockResolvedValue({ conversationId: 'c1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false })
    const init = store.onConnected('conn-1')   // 挂起于 safeList
    await store.activate('c9')                 // 挂起期间用户手动切到 c9
    expect(store.currentId).toBe('c9')
    resolveList({ items: [convA, convB], hasMore: false })
    await init
    expect(store.currentId).toBe('c9')             // 不覆盖用户选择
    expect(mockApi.activate).not.toHaveBeenCalledWith('c1')  // activeId c1 不再自动 activate
    expect(store.ready).toBe(true)
  })

  it('activate 失败写 error + busy 复位', async () => {
    const store = useConversationStore()
    mockApi.activate.mockRejectedValue(new Error('activate boom'))
    await store.activate('c1')
    expect(store.error?.message).toContain('activate boom')
    expect(store.busy).toBe(false)
    expect(store.currentId).toBe('c1')   // currentId 已立即切走(失败也留在目标会话)
  })
})

describe('G2 离线视图 / activateLocal / 在线恢复（spec §4.5.3 P1-1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.resetAllMocks()
  })

  it('activate 首屏后 setPageMeta 初始化 hasMoreBefore（有 nextCursor 才可向上加载）', async () => {
    mockApi.activate.mockResolvedValue({ conversationId: 'conv-1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: true, nextCursor: 'cur-1' })
    const conv = useConversationStore()
    await conv.activate('conv-1')
    expect(useMessageStore().hasMoreBefore).toBe(true)
    expect(useMessageStore().beforeCursor).toBe('cur-1')
  })

  it('setOfflineCache 装载缓存列表 + offlineView=true', () => {
    const conv = useConversationStore()
    conv.setOfflineCache([convA, convB])
    expect(conv.items).toHaveLength(2)
    expect(conv.offlineView).toBe(true)
  })

  it('activateLocal（disconnected + 缓存会话）载入快照、不调 api.activate/getMessages、hasMoreBefore=false', async () => {
    useConnectionStore().state.status = 'disconnected'
    const cache = useCacheStore()
    cache.syncConversations([convA])
    cache.hydrate({ drafts: [], scrollAnchors: {}, conversations: [convA], messageSnapshots: { [convA.id]: [{ messageId: 'm1', conversationId: convA.id, role: 'user', content: 'hi', status: 'completed', createdAt: 't' }] } })
    mockApi.activate.mockClear(); mockApi.getMessages.mockClear()
    const conv = useConversationStore()
    await conv.activateLocal(convA.id)
    expect(conv.currentId).toBe(convA.id)
    expect(conv.offlineView).toBe(true)
    expect(mockApi.activate).not.toHaveBeenCalled()
    expect(mockApi.getMessages).not.toHaveBeenCalled()
    expect(useMessageStore().order).toEqual(['m1'])
    expect(useMessageStore().hasMoreBefore).toBe(false)
  })

  it('activateLocal 非缓存会话 → 拒绝 + 提示', async () => {
    useConnectionStore().state.status = 'disconnected'
    const conv = useConversationStore()
    await conv.activateLocal('not-cached')
    expect(conv.error?.code).toBe('OFFLINE_NOT_CACHED')
    expect(conv.currentId).toBeUndefined()
  })

  it('离线视图下 activate 拒绝；在线恢复 activate 正常并清 offlineView', async () => {
    useConnectionStore().state.status = 'disconnected'
    const conv = useConversationStore()
    conv.setOfflineCache([convA])
    await conv.activate('conv-1')
    expect(conv.error?.code).toBe('OFFLINE_VIEW')
    useConnectionStore().state.status = 'connected'
    mockApi.activate.mockResolvedValue({ conversationId: 'conv-1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false, nextCursor: undefined })
    await conv.activate('conv-1')
    expect(conv.offlineView).toBe(false)
    expect(conv.error).toBeUndefined()
  })
})

describe('conversation.store activate(id, anchor?) 与 jumpToMessage（spec §4.5，D5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.resetAllMocks()
  })

  it('activate 无 anchor 行为不变（回归：首屏 getMessages 拉取）', async () => {
    const getMessages = vi.fn(async () => ({ items: [], hasMore: false }))
    setDesktopApi({ activate: async () => ({ conversationId: 'c2' }), getMessages, getMessageContext: vi.fn() } as never)
    const cs = useConversationStore()
    await cs.activate('c2')
    expect(getMessages).toHaveBeenCalledTimes(1)
  })
  it('activate 带 anchor → loadContextWindow 替代首页 + setHighlight', async () => {
    const ms = useMessageStore()
    const loadContextWindow = vi.fn(async () => true)
    const setHighlight = vi.fn()
    ms.loadContextWindow = loadContextWindow as never
    ms.setHighlight = setHighlight as never
    setDesktopApi({ activate: async () => ({ conversationId: 'c3' }) } as never)
    const cs = useConversationStore()
    await cs.activate('c3', { messageId: 'm9', segmentId: 'seg1' })
    expect(loadContextWindow).toHaveBeenCalledWith('m9')
    expect(setHighlight).toHaveBeenCalledWith('m9', 'seg1')
  })
  it('jumpToMessage 当前会话：直接 loadContextWindow + setHighlight；失败写 error', async () => {
    const ms = useMessageStore()
    ms.loadContextWindow = vi.fn(async () => false) as never
    ms.setHighlight = vi.fn() as never
    setDesktopApi({} as never)
    const cs = useConversationStore()
    cs.$patch({ currentId: 'c1' })
    const ok = await cs.jumpToMessage('c1', 'm1')
    expect(ok).toBe(false)
    expect(cs.error?.message).toContain('无法定位消息')
  })
  it('jumpToMessage 跨会话：走 activate(anchor)（api.activate + loadContextWindow + setHighlight）', async () => {
    const ms = useMessageStore()
    const loadContextWindow = vi.fn(async () => true)
    const setHighlight = vi.fn()
    ms.loadContextWindow = loadContextWindow as never
    ms.setHighlight = setHighlight as never
    setDesktopApi({ activate: async () => ({ conversationId: 'c9' }) } as never)
    const cs = useConversationStore()
    cs.$patch({ currentId: 'c1' })
    await cs.jumpToMessage('c9', 'm1', 'seg1')
    expect(loadContextWindow).toHaveBeenCalledWith('m1')          // 经 activate(anchor) 分支
    expect(setHighlight).toHaveBeenCalledWith('m1', 'seg1')
    expect(cs.currentId).toBe('c9')
  })
})
