// tests/unit/conversation.store.spec.ts
// Task 4:conversationStore——list/activate(resetConversation+getMessages→loadPage)/create/rename(单对象载荷)/remove/getMore(cursor 透传)。
// env=node:store 经 stores/desktop-api 注入 mock api;pinia 用 createPinia + setActivePinia。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { useCacheStore } from '../../src/renderer/src/stores/cache.store'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'
import { useVoiceStore } from '../../src/renderer/src/stores/voice.store'
import { useIdentityStore } from '../../src/renderer/src/stores/identity.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { Message } from '@shared/contracts'
import { createDesktopApiMock } from './helpers/desktop-api'

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
  listTtsVoices: vi.fn(), previewTts: vi.fn(), setTtsVoice: vi.fn(),
  // P4-B 语音/设置面
  voiceStartRecord: vi.fn(), voiceStopRecord: vi.fn(), voiceCommit: vi.fn(), voiceDiscard: vi.fn(),
  voiceStartRealtime: vi.fn(), voiceStopRealtime: vi.fn(), voiceCancelRealtime: vi.fn(),
  voiceStartDictation: vi.fn(), voiceStopDictation: vi.fn(), voiceCancelDictation: vi.fn(),
  audioCancel: vi.fn(), voiceSendAudio: vi.fn(), settingsLoad: vi.fn(), settingsSave: vi.fn(),
  listLive2dModels: vi.fn(), readLive2dModelFile: vi.fn(), onPersistFlushRequest: vi.fn(() => () => {}), persistFlushDone: vi.fn(async () => {}),
  onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(), toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn(),
  // 阶段 7 批次 A（Task 5）：诊断面（DesktopApiLike 全契约镜像——mock 补键）
  diagnosticsState: vi.fn(), diagnosticsDevModeSet: vi.fn(), diagnosticsOpenLogDir: vi.fn(), diagnosticsClearLogs: vi.fn(), diagnosticsExport: vi.fn(), onDiagnosticsDevEvent: vi.fn(() => () => {}), getLastCrash: vi.fn(),
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

  it('legacy list 同页重复 conversation id 也拒绝整页', async () => {
    const store = useConversationStore()
    mockApi.listConversations.mockResolvedValueOnce({ items: [convA, { ...convA, title: '重复标题' }], hasMore: false })
    expect(await store.list()).toBe(false)
    expect(store.items).toHaveLength(0)
    expect(useCacheStore().conversations).toHaveLength(0)
    expect(store.error?.message).toContain('重复')
  })

  it('legacy getMore 同页重复 conversation id 不污染已有页和游标', async () => {
    const store = useConversationStore()
    mockApi.listConversations.mockResolvedValueOnce({ items: [convA], hasMore: true, nextCursor: 'page-2' })
    expect(await store.list()).toBe(true)
    mockApi.listConversations.mockResolvedValueOnce({ items: [convB, { ...convB, title: '重复标题' }], hasMore: false })
    await store.getMore()
    expect(store.items.map((item) => item.id)).toEqual([convA.id])
    expect(store.hasMore).toBe(true)
    expect(store.nextCursor).toBe('page-2')
  })

  it('旧世代 list reject 不覆盖新连接的 error', async () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'list-old', serverUrl: 'https://same-list.example/api' })
    store.setConnectionState(connection.state)
    let rejectOld!: (cause: unknown) => void
    mockApi.listConversations.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
    const pending = store.list()
    await vi.waitFor(() => expect(mockApi.listConversations).toHaveBeenCalledTimes(1))

    connection.setState({ status: 'connected', connectionId: 'list-new', serverUrl: 'https://same-list.example/api' })
    store.setConnectionState(connection.state)
    store.$patch({ error: { code: 'NEW_CONNECTION_ERROR', message: 'new connection error' } })
    rejectOld(new Error('old list failure'))
    await expect(pending).resolves.toBe(false)
    expect(store.error?.code).toBe('NEW_CONNECTION_ERROR')
  })

  it('旧世代 getMore reject 不覆盖新连接的 error', async () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'more-old', serverUrl: 'https://same-more.example/api' })
    store.setConnectionState(connection.state)
    store.$patch({ nextCursor: 'old-cursor' })
    let rejectOld!: (cause: unknown) => void
    mockApi.listConversations.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
    const pending = store.getMore()
    await vi.waitFor(() => expect(mockApi.listConversations).toHaveBeenCalledTimes(1))

    connection.setState({ status: 'connected', connectionId: 'more-new', serverUrl: 'https://same-more.example/api' })
    store.setConnectionState(connection.state)
    store.$patch({ error: { code: 'NEW_MORE_ERROR', message: 'new getMore error' } })
    rejectOld(new Error('old getMore failure'))
    await pending
    expect(store.error?.code).toBe('NEW_MORE_ERROR')
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

  it('旧世代 rename 成功到达时不触发新世代 safeList 或清除新 error', async () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'rename-old', serverUrl: 'https://rename-a.example/api' })
    store.setConnectionState(connection.state)
    let resolveRename!: (value: unknown) => void
    mockApi.renameConversation.mockImplementationOnce(() => new Promise((resolve) => { resolveRename = resolve }))
    const pending = store.rename({ conversationId: 'same-id', title: '旧标题' })
    await vi.waitFor(() => expect(mockApi.renameConversation).toHaveBeenCalledTimes(1))

    connection.setState({ status: 'connected', connectionId: 'rename-new', serverUrl: 'https://rename-b.example/api' })
    store.setConnectionState(connection.state)
    store.$patch({ error: { code: 'NEW_RENAME_ERROR', message: 'new error' } })
    resolveRename({ id: 'same-id', title: '旧标题', updatedAt: '2026-08-31T00:00:00.000Z' })
    await pending
    expect(mockApi.listConversations).not.toHaveBeenCalled()
    expect(store.error?.code).toBe('NEW_RENAME_ERROR')
    expect(store.busy).toBe(false)
  })

  it('旧世代 rename 失败到达时不覆盖新世代 error', async () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'rename-fail-old', serverUrl: 'https://rename-fail-a.example/api' })
    store.setConnectionState(connection.state)
    let rejectRename!: (cause: unknown) => void
    mockApi.renameConversation.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRename = reject }))
    const pending = store.rename({ conversationId: 'same-id', title: '旧标题' })
    await vi.waitFor(() => expect(mockApi.renameConversation).toHaveBeenCalledTimes(1))

    connection.setState({ status: 'connected', connectionId: 'rename-fail-new', serverUrl: 'https://rename-fail-b.example/api' })
    store.setConnectionState(connection.state)
    store.$patch({ error: { code: 'NEW_RENAME_FAILURE', message: 'new failure' } })
    rejectRename(new Error('old rename failure'))
    await pending
    expect(mockApi.listConversations).not.toHaveBeenCalled()
    expect(store.error?.code).toBe('NEW_RENAME_FAILURE')
    expect(store.busy).toBe(false)
  })

  it('旧世代 remove 成功晚到不能清理新 backend 同 id 的 current/cache/messages/draft', async () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    const old = { id: 'remove-shared-id', title: 'A 会话', updatedAt: '2026-08-31T00:00:00.000Z' }
    connection.setState({ status: 'connected', connectionId: 'remove-old', serverUrl: 'https://remove-a.example/api' })
    store.setConnectionState(connection.state)
    store.$patch({ items: [old], currentId: old.id })
    const oldMessage: Message = { messageId: 'old-remove-message', conversationId: old.id, role: 'user', content: 'old', status: 'completed', createdAt: '2026-08-31T00:00:00.000Z' }
    useMessageStore().loadPage({ items: [oldMessage], hasMore: false })
    useCacheStore().hydrate({ drafts: [], scrollAnchors: {}, conversations: [old], messageSnapshots: { [old.id]: [oldMessage] } })
    useDraftStore().$patch({ drafts: { [old.id]: 'old draft' } })
    let resolveRemove!: (value?: unknown) => void
    mockApi.deleteConversation.mockImplementationOnce(() => new Promise((resolve) => { resolveRemove = resolve }))
    const pending = store.remove(old.id)
    await vi.waitFor(() => expect(mockApi.deleteConversation).toHaveBeenCalledTimes(1))

    connection.setState({ status: 'connected', connectionId: 'remove-new', serverUrl: 'https://remove-b.example/api' })
    store.setConnectionState(connection.state)
    const fresh = { id: old.id, title: 'B 会话', updatedAt: '2026-08-31T00:00:02.000Z' }
    const freshMessage: Message = { messageId: 'new-remove-message', conversationId: fresh.id, role: 'user', content: 'new', status: 'completed', createdAt: '2026-08-31T00:00:02.000Z' }
    store.$patch({ items: [fresh], currentId: fresh.id, error: { code: 'NEW_REMOVE_ERROR', message: 'new error' } })
    const cache = useCacheStore()
    cache.hydrate({ drafts: [], scrollAnchors: {}, conversations: [fresh], messageSnapshots: { [fresh.id]: [freshMessage] } })
    useMessageStore().loadPage({ items: [freshMessage], hasMore: false })
    useDraftStore().$patch({ drafts: { [fresh.id]: 'new draft' } })

    resolveRemove()
    await pending
    expect(mockApi.listConversations).not.toHaveBeenCalled()
    expect(store.currentId).toBe(fresh.id)
    expect(store.items).toEqual([fresh])
    expect(cache.snapshotMessages(fresh.id)).toEqual([freshMessage])
    expect(useMessageStore().order).toEqual([freshMessage.messageId])
    expect(useDraftStore().drafts[fresh.id]).toBe('new draft')
    expect(store.error?.code).toBe('NEW_REMOVE_ERROR')
    expect(store.busy).toBe(false)
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
    await vi.waitFor(() => expect(mockApi.activate).toHaveBeenCalledTimes(1))
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
    await vi.waitFor(() => expect(mockApi.getMessages).toHaveBeenCalledTimes(1))
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

  it('activate 等后端确认再切换；失败保留原会话并复位 busy', async () => {
    const store = useConversationStore()
    store.$patch({ currentId: 'c2', items: [convA, convB] })
    let rejectActivate!: (reason: Error) => void
    mockApi.activate.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectActivate = reject }))
    const pending = store.activate('c1')
    await vi.waitFor(() => expect(mockApi.activate).toHaveBeenCalledTimes(1))
    expect(store.currentId).toBe('c2')
    expect(store.busy).toBe(true)
    rejectActivate(new Error('activate boom'))
    await pending
    expect(store.error?.message).toContain('activate boom')
    expect(store.busy).toBe(false)
    expect(store.currentId).toBe('c2')
  })

  it('AGENT_BUSY 激活失败保持当前会话；仅用户再次点击且成功后才载入目标会话', async () => {
    const store = useConversationStore()
    const messageStore = useMessageStore()
    const messageA: Message = { messageId: 'message-a', conversationId: 'c1', role: 'assistant', content: 'A 的历史', status: 'completed', createdAt: 't-a' }
    const messageB: Message = { messageId: 'message-b', conversationId: 'c2', role: 'assistant', content: 'B 的历史', status: 'completed', createdAt: 't-b' }
    store.$patch({ currentId: 'c1', items: [convA, convB] })
    messageStore.loadPage({ items: [messageA], hasMore: false })
    mockApi.activate
      .mockRejectedValueOnce(new Error('[UNKNOWN] [backendCode=AGENT_BUSY] [retryable=true] backend busy'))
      .mockResolvedValueOnce({ conversationId: 'c2' })
    mockApi.getMessages.mockResolvedValueOnce({ items: [messageB], hasMore: false })

    await store.activate('c2')

    // The rejected activation must not clear or replace the currently visible A session.
    expect(mockApi.activate).toHaveBeenCalledTimes(1)
    expect(mockApi.getMessages).not.toHaveBeenCalled()
    expect(store.currentId).toBe('c1')
    expect(messageStore.byId[messageA.messageId]?.content).toBe('A 的历史')
    expect(messageStore.byId[messageB.messageId]).toBeUndefined()
    expect(store.error).toMatchObject({
      code: 'UNKNOWN',
      backendCode: 'AGENT_BUSY',
      retryable: true,
      message: '当前回复或语音仍在收尾，请稍后再切换会话'
    })
    expect(store.busy).toBe(false)

    // No background retry: only this explicit second call may reach the backend.
    await Promise.resolve()
    expect(mockApi.activate).toHaveBeenCalledTimes(1)

    await store.activate('c2')

    expect(mockApi.activate).toHaveBeenCalledTimes(2)
    expect(mockApi.activate).toHaveBeenLastCalledWith('c2')
    expect(mockApi.getMessages).toHaveBeenCalledTimes(1)
    expect(mockApi.getMessages).toHaveBeenCalledWith({ conversationId: 'c2' })
    expect(store.currentId).toBe('c2')
    expect(messageStore.byId[messageA.messageId]).toBeUndefined()
    expect(messageStore.byId[messageB.messageId]?.content).toBe('B 的历史')
    expect(store.error).toBeUndefined()
  })

  it('CHARACTER_BUSY 激活失败不套用会话忙提示，保留角色错误文案', async () => {
    const store = useConversationStore()
    store.$patch({ currentId: 'c1', items: [convA, convB] })
    mockApi.activate.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] [backendCode=CHARACTER_BUSY] 角色正在处理中，请等待当前操作完成。'))

    await store.activate('c2')

    expect(store.currentId).toBe('c1')
    expect(store.error).toMatchObject({
      code: 'BACKEND_REJECTED',
      backendCode: 'CHARACTER_BUSY',
      message: '角色正在处理中，请等待当前操作完成。'
    })
    expect(store.error?.message).not.toContain('当前回复或语音')
  })

  it('切换会话前取消当前 TTS 播放流', async () => {
    const store = useConversationStore()
    store.$patch({ currentId: 'c2', items: [convA, convB] })
    useVoiceStore().$patch({ tts: { playing: true, playingStreamId: 42, url: 'cyrene://renderer/test.wav' } })
    mockApi.activate.mockResolvedValue({ conversationId: 'c1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false })

    await store.activate('c1')

    expect(mockApi.audioCancel).toHaveBeenCalledWith({ streamId: 42 })
    expect(store.currentId).toBe('c1')
    expect(useVoiceStore().tts.playing).toBe(false)
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

describe('FE-E1 会话角色绑定与新建选角契约', () => {
  const binding = {
    characterId: 'builtin/elysia',
    characterInstanceId: 'instance-elysia',
    characterRevision: 3,
    displayName: 'Elysia',
    presentation: { themeColor: '#f2a7c6' }
  }
  const profile = {
    userId: 'user-1',
    displayName: '旅行者',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    initialized: true,
    defaultCharacterId: binding.characterId,
    revision: 1,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.resetAllMocks()
    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'character-1', features: { characterProfiles: true, characterStateStream: false } })
    const store = useConversationStore()
    store.setConnectionState(connection.state)
    useIdentityStore().profile = profile
    mockApi.listConversations.mockResolvedValue({ items: [], hasMore: false })
  })

  it('profiles=true 带角色 ID 创建，并保留服务端绑定快照', async () => {
    const store = useConversationStore()
    const created = { id: 'bound-1', title: '新会话', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.createConversation.mockResolvedValue(created)

    const result = await store.create(binding.characterId)

    expect(mockApi.createConversation).toHaveBeenCalledTimes(1)
    expect(mockApi.createConversation).toHaveBeenCalledWith({ characterId: binding.characterId })
    expect(result?.character?.characterId).toBe(binding.characterId)
    expect(store.items[0]?.character?.displayName).toBe('Elysia')
    expect(useCacheStore().conversations[0]?.character?.characterId).toBe(binding.characterId)
    expect(store.currentId).toBe('bound-1')
  })

  it('profiles=true 缺角色 ID 时拒绝且不调用后端', async () => {
    const store = useConversationStore()
    await expect(store.create()).resolves.toBeUndefined()
    expect(mockApi.createConversation).not.toHaveBeenCalled()
    expect(store.error?.code).toBe('CHARACTER_REQUIRED')
  })

  it('响应缺失或错配 binding 时视为协议错误，不写列表/当前/缓存', async () => {
    const store = useConversationStore()
    mockApi.createConversation.mockResolvedValueOnce({ id: 'missing-binding', title: 'x', updatedAt: '2026-08-31T00:00:00.000Z' })
    await expect(store.create(binding.characterId)).resolves.toBeUndefined()
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
    expect(useCacheStore().conversations).toHaveLength(0)

    mockApi.createConversation.mockResolvedValueOnce({ id: 'wrong-binding', title: 'x', updatedAt: '2026-08-31T00:00:00.000Z', character: { ...binding, characterId: 'builtin/cyrene' } })
    await expect(store.create(binding.characterId)).resolves.toBeUndefined()
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
  })

  it('同一 editor action 重复新建复用 in-flight Promise，只请求一次', async () => {
    const store = useConversationStore()
    mockApi.createConversation.mockResolvedValue({ id: 'once', title: 'x', updatedAt: '2026-08-31T00:00:00.000Z', character: binding })
    const first = store.create(binding.characterId)
    const second = store.create(binding.characterId)
    await Promise.all([first, second])
    expect(mockApi.createConversation).toHaveBeenCalledTimes(1)
  })

  it('连接世代切换后迟到创建结果被丢弃，不污染列表/缓存', async () => {
    const store = useConversationStore()
    let resolveCreated!: (value: unknown) => void
    mockApi.createConversation.mockReturnValue(new Promise((resolve) => { resolveCreated = resolve }))
    const pending = store.create(binding.characterId)
    await Promise.resolve()
    const connection = useConnectionStore()
    connection.setState({ status: 'reconnecting', connectionId: 'character-1', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    resolveCreated({ id: 'late', title: '迟到', updatedAt: '2026-08-31T00:00:00.000Z', character: binding })
    await expect(pending).resolves.toBeUndefined()
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
    expect(useCacheStore().conversations).toHaveLength(0)
  })

  it('safeList 期间连接跨代会清除已暂存的旧创建结果并释放 busy', async () => {
    const store = useConversationStore()
    let resolveList!: (value: unknown) => void
    mockApi.createConversation.mockResolvedValue({ id: 'stale-after-list', title: '旧连接', updatedAt: '2026-08-31T00:00:00.000Z', character: binding })
    mockApi.listConversations.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    const pending = store.create(binding.characterId)
    await vi.waitFor(() => expect(mockApi.listConversations).toHaveBeenCalled())
    const connection = useConnectionStore()
    connection.setState({ status: 'reconnecting', connectionId: 'character-1', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    resolveList({ items: [], hasMore: false })
    await expect(pending).resolves.toBeUndefined()
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
    expect(useCacheStore().conversations).toHaveLength(0)
    expect(store.busy).toBe(false)
  })

  it('safeList 失败不抹掉已确认的创建权威结果', async () => {
    const store = useConversationStore()
    const created = { id: 'authoritative', title: '已创建', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.createConversation.mockResolvedValue(created)
    mockApi.listConversations.mockRejectedValue(new Error('list temporarily unavailable'))
    const result = await store.create(binding.characterId)
    expect(result?.id).toBe('authoritative')
    expect(store.items.map((item) => item.id)).toEqual(['authoritative'])
    expect(store.currentId).toBe('authoritative')
    expect(store.error?.message).toContain('list temporarily unavailable')
  })

  it('profiles=true 首次 list 遇到缺 binding 的坏页时不覆盖既有 items/cache', async () => {
    const store = useConversationStore()
    const existing = { id: 'existing-bound', title: '既有', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.listConversations.mockResolvedValueOnce({ items: [existing], hasMore: false })
    expect(await store.list()).toBe(true)
    const cache = useCacheStore()
    expect(cache.conversations[0]?.id).toBe(existing.id)

    mockApi.listConversations.mockResolvedValueOnce({ items: [{ id: 'bad-page', title: '缺角色', updatedAt: '2026-08-31T00:00:01.000Z' }], hasMore: false })
    expect(await store.list()).toBe(false)
    expect(store.items.map((item) => item.id)).toEqual([existing.id])
    expect(cache.conversations.map((item) => item.id)).toEqual([existing.id])
    expect(store.error?.message).toContain('会话响应')
  })

  it('profiles=true getMore 遇到缺 binding 的坏页时保留原页/cursor/cache', async () => {
    const store = useConversationStore()
    const first = { id: 'page-1', title: '第一页', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.listConversations.mockResolvedValueOnce({ items: [first], hasMore: true, nextCursor: 'page-2' })
    expect(await store.list()).toBe(true)
    mockApi.listConversations.mockResolvedValueOnce({ items: [{ id: 'bad-page-2', title: '坏页', updatedAt: '2026-08-31T00:00:01.000Z' }], hasMore: false })
    await store.getMore()
    expect(store.items.map((item) => item.id)).toEqual([first.id])
    expect(store.hasMore).toBe(true)
    expect(store.nextCursor).toBe('page-2')
    expect(useCacheStore().conversations.map((item) => item.id)).toEqual([first.id])
  })

  it('create→safeList 返回同 id 的缺失/冲突 binding 时保留权威创建快照并公开协议错误', async () => {
    const store = useConversationStore()
    const created = { id: 'authoritative-binding', title: '权威', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.createConversation.mockResolvedValueOnce(created)
    mockApi.listConversations.mockResolvedValueOnce({ items: [{ id: created.id, title: created.title, updatedAt: created.updatedAt }], hasMore: false })
    const missing = await store.create(binding.characterId)
    expect(missing?.id).toBe(created.id)
    expect(store.items[0]?.character).toEqual(binding)
    expect(useCacheStore().conversations[0]?.character).toEqual(binding)
    expect(store.error?.message).toContain('会话响应')

    mockApi.createConversation.mockResolvedValueOnce({ ...created, id: 'conflicting-binding' })
    mockApi.listConversations.mockResolvedValueOnce({ items: [{ ...created, id: 'conflicting-binding', character: { ...binding, characterRevision: 99 } }], hasMore: false })
    const conflict = await store.create(binding.characterId)
    expect(conflict?.id).toBe('conflicting-binding')
    expect(store.items.find((item) => item.id === 'conflicting-binding')?.character?.characterRevision).toBe(binding.characterRevision)
    expect(store.error?.message).toContain('冲突')
  })

  it('连接世代变化会释放永不 settle 的旧 create，允许新世代立即创建且旧响应不污染', async () => {
    const store = useConversationStore()
    let resolveOld!: (value: unknown) => void
    mockApi.createConversation.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const old = store.create(binding.characterId)
    await Promise.resolve()
    expect(store.busy).toBe(true)

    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'character-2', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    expect(store.busy).toBe(false)

    const next = { id: 'new-generation', title: '新世代', updatedAt: '2026-08-31T00:00:02.000Z', character: binding }
    mockApi.createConversation.mockResolvedValueOnce(next)
    mockApi.listConversations.mockResolvedValueOnce({ items: [next], hasMore: false })
    const fresh = await store.create(binding.characterId)
    expect(fresh?.id).toBe(next.id)
    expect(mockApi.createConversation).toHaveBeenCalledTimes(2)

    resolveOld({ id: 'late-old-generation', title: '迟到', updatedAt: '2026-08-31T00:00:03.000Z', character: binding })
    await expect(old).resolves.toBeUndefined()
    expect(store.items.map((item) => item.id)).toEqual([next.id])
  })

  it('旧 create 卡在 safeList 时换代不会释放新 create 的 busy owner', async () => {
    const store = useConversationStore()
    let resolveOldList!: (value: unknown) => void
    let resolveNewList!: (value: unknown) => void
    const old = { id: 'owner-old', title: '旧任务', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    const next = { id: 'owner-new', title: '新任务', updatedAt: '2026-08-31T00:00:01.000Z', character: binding }
    mockApi.createConversation.mockResolvedValueOnce(old).mockResolvedValueOnce(next)
    mockApi.listConversations
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldList = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewList = resolve }))

    const oldTask = store.create(binding.characterId)
    await vi.waitFor(() => expect(mockApi.listConversations).toHaveBeenCalledTimes(1))

    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'character-owner-2', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    expect(store.busy).toBe(false)

    const newTask = store.create(binding.characterId)
    await vi.waitFor(() => expect(mockApi.listConversations).toHaveBeenCalledTimes(2))
    expect(store.busy).toBe(true)

    resolveOldList({ items: [], hasMore: false })
    await Promise.resolve()
    await Promise.resolve()
    // old list/create finally 只能释放自己的 owner，不能把新任务误判成空闲。
    expect(store.busy).toBe(true)

    resolveNewList({ items: [next], hasMore: false })
    await Promise.all([oldTask, newTask])
    expect(store.busy).toBe(false)
    expect(store.items.map((item) => item.id)).toEqual([next.id])
  })

  it('同一 backend URL 的重连仍保护 immutable binding 冲突', async () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'same-url-1', serverUrl: 'http://backend.test:80/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    const existing = { id: 'same-url-conversation', title: '原会话', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.listConversations.mockResolvedValueOnce({ items: [existing], hasMore: false })
    expect(await store.list()).toBe(true)

    connection.setState({ status: 'connected', connectionId: 'same-url-2', serverUrl: 'http://backend.test:80/api/', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    mockApi.listConversations.mockResolvedValueOnce({ items: [{ ...existing, character: { ...binding, displayName: '改名但同版本' } }], hasMore: false })
    expect(await store.list()).toBe(false)
    expect(store.items[0]?.character?.characterRevision).toBe(binding.characterRevision)
    expect(store.error?.message).toContain('冲突')
  })

  it('backend URL 改变时隔离旧会话/缓存/消息，同 id 的新 binding 可成为权威', async () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'backend-a', serverUrl: 'http://backend-a.test/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    const old = { id: 'shared-id', title: '旧后端会话', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.listConversations.mockResolvedValueOnce({ items: [old], hasMore: false })
    expect(await store.list()).toBe(true)
    store.$patch({ currentId: old.id })
    const message: Message = { messageId: 'old-message', conversationId: old.id, role: 'user', content: '旧正文', status: 'completed', createdAt: '2026-08-31T00:00:00.000Z' }
    useMessageStore().loadPage({ items: [message], hasMore: false })
    useCacheStore().hydrate({ drafts: [], scrollAnchors: {}, conversations: [old], messageSnapshots: { [old.id]: [message] } })

    connection.setState({ status: 'connected', connectionId: 'backend-b', serverUrl: 'http://backend-b.test/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
    expect(useCacheStore().conversations).toHaveLength(0)
    expect(useCacheStore().snapshotMessages(old.id)).toBeUndefined()
    expect(useMessageStore().order).toHaveLength(0)

    const fresh = { id: old.id, title: '新后端会话', updatedAt: '2026-08-31T00:00:02.000Z', character: { ...binding, characterId: 'builtin/cyrene', characterRevision: 8, displayName: 'Cyrene' } }
    mockApi.listConversations.mockResolvedValueOnce({ items: [fresh], hasMore: false })
    expect(await store.list()).toBe(true)
    expect(store.items).toEqual([fresh])
  })

  it('角色模式同一页出现重复 conversation id 即使 binding 相同也拒绝整页', async () => {
    const store = useConversationStore()
    const duplicate = { id: 'duplicate-page', title: '第一标题', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.listConversations.mockResolvedValueOnce({ items: [duplicate, { ...duplicate, title: '第二标题' }], hasMore: false })
    expect(await store.list()).toBe(false)
    expect(store.items).toHaveLength(0)
    expect(useCacheStore().conversations).toHaveLength(0)
    expect(store.error?.message).toContain('重复')
  })

  it('unknown connection A→B 不能把不同连接当作连续事实', () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    const old = { id: 'unknown-shared', title: '未知来源', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    connection.setState({ status: 'connected', connectionId: 'unknown-a', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    store.$patch({ items: [old], currentId: old.id })
    useCacheStore().syncConversations([old])
    const message: Message = { messageId: 'unknown-message', conversationId: old.id, role: 'user', content: 'unknown', status: 'completed', createdAt: '2026-08-31T00:00:00.000Z' }
    useMessageStore().loadPage({ items: [message], hasMore: false })

    connection.setState({ status: 'connected', connectionId: 'unknown-b', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
    expect(useCacheStore().conversations).toHaveLength(0)
    expect(useMessageStore().order).toHaveLength(0)

    // 非法 URL 走同一 non-authoritative fallback，不能借 connectionId
    // 变化继续沿用另一未知 backend 的事实。
    connection.setState({ status: 'connected', connectionId: 'invalid-a', serverUrl: 'not-a-valid-url', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    store.$patch({ items: [old], currentId: old.id })
    useCacheStore().syncConversations([old])
    connection.setState({ status: 'connected', connectionId: 'invalid-b', serverUrl: 'still-not-a-url', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
  })

  it('authoritative A→无 URL 中间态→B 会在 B 到达时隔离旧事实', () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    const old = { id: 'authoritative-shared', title: 'A 后端', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    connection.setState({ status: 'connected', connectionId: 'backend-a-1', serverUrl: 'https://backend-a.example/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    store.$patch({ items: [old], currentId: old.id })
    useCacheStore().syncConversations([old])

    connection.setState({ status: 'reconnecting', connectionId: 'intermediate-only' })
    store.setConnectionState(connection.state)
    expect(store.items).toEqual([old])
    expect(store.currentId).toBe(old.id)

    connection.setState({ status: 'connected', connectionId: 'backend-b-1', serverUrl: 'https://backend-b.example/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
    expect(useCacheStore().conversations).toHaveLength(0)
  })

  it('启动时无 provenance 的离线缓存首次进入 authoritative backend 前先隔离', () => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.resetAllMocks()
    const old = { id: 'startup-unknown', title: '启动缓存', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    const cache = useCacheStore()
    cache.hydrate({ drafts: [], scrollAnchors: {}, conversations: [old], messageSnapshots: {} })
    const store = useConversationStore()
    store.setOfflineCache(cache.conversations)
    expect(store.items).toHaveLength(1)
    const connection = useConnectionStore()
    connection.setState({ status: 'connected', connectionId: 'authoritative-first', serverUrl: 'https://new-backend.example/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    expect(store.items).toHaveLength(0)
    expect(store.currentId).toBeUndefined()
    expect(cache.conversations).toHaveLength(0)
  })

  it('same URL 断线重连保留会话事实，不因 transport id 变化清理', () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    const old = { id: 'same-url-retained', title: '保持会话', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    connection.setState({ status: 'connected', connectionId: 'same-url-1', serverUrl: 'https://same-backend.example/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    store.$patch({ items: [old], currentId: old.id })
    useCacheStore().syncConversations([old])

    connection.setState({ status: 'disconnected' })
    store.setConnectionState(connection.state)
    connection.setState({ status: 'connected', connectionId: 'same-url-2', serverUrl: 'https://same-backend.example/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    expect(store.items).toEqual([old])
    expect(store.currentId).toBe(old.id)
    expect(useCacheStore().conversations).toEqual([old])
  })

  it('已知 authoritative 后端进入无 URL 中间态时，列表不覆盖旧事实', async () => {
    const store = useConversationStore()
    const connection = useConnectionStore()
    const old = { id: 'authoritative-intermediate', title: 'A 后端会话', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    connection.setState({ status: 'connected', connectionId: 'authoritative-a', serverUrl: 'https://authoritative-a.example/api', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    mockApi.listConversations.mockResolvedValueOnce({ items: [old], hasMore: true, nextCursor: 'a-next' })
    expect(await store.list()).toBe(true)

    // A URL-less connected snapshot is a transport/intermediate identity,
    // not proof that a new connection id belongs to the old backend.
    connection.setState({ status: 'connected', connectionId: 'unknown-intermediate', features: { characterProfiles: true, characterStateStream: false } })
    store.setConnectionState(connection.state)
    mockApi.listConversations.mockResolvedValueOnce({
      items: [{ ...old, title: '不应覆盖 A', character: { ...binding, displayName: '未知后端角色' } }],
      hasMore: false
    })
    expect(await store.list()).toBe(false)
    expect(store.items).toEqual([old])
    expect(store.nextCursor).toBe('a-next')
    expect(useCacheStore().conversations).toEqual([old])
  })

  it('列表/缓存/离线水合保持 immutable 角色 binding 快照', async () => {
    const store = useConversationStore()
    const source = { id: 'snapshot-1', title: '历史会话', updatedAt: '2026-08-31T00:00:00.000Z', character: binding }
    mockApi.listConversations.mockResolvedValue({ items: [source], hasMore: false })
    await store.list()
    source.character.displayName = '被外部修改'
    expect(store.items[0]?.character?.displayName).toBe('Elysia')
    expect(useCacheStore().conversations[0]?.character?.displayName).toBe('Elysia')

    const cache = useCacheStore()
    const offlineSource = { ...source, character: { ...binding, displayName: 'Elysia' } }
    cache.hydrate({ drafts: [], scrollAnchors: {}, conversations: [offlineSource], messageSnapshots: {} })
    expect(cache.conversations[0]?.character?.displayName).toBe('Elysia')
    store.setOfflineCache(cache.conversations)
    const offlineConnection = useConnectionStore()
    offlineConnection.setState({ status: 'disconnected' })
    await store.activateLocal('snapshot-1')
    expect(store.currentCharacter?.displayName).toBe('Elysia')
    expect(cache.conversations[0]?.character?.characterId).toBe(binding.characterId)
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
    setDesktopApi(createDesktopApiMock({ activate: async () => ({ conversationId: 'c2' }), getMessages, getMessageContext: vi.fn() }))
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
    setDesktopApi(createDesktopApiMock({ activate: async () => ({ conversationId: 'c3' }) }))
    const cs = useConversationStore()
    await cs.activate('c3', { messageId: 'm9', segmentId: 'seg1' })
    expect(loadContextWindow).toHaveBeenCalledWith('m9')
    expect(setHighlight).toHaveBeenCalledWith('m9', 'seg1')
  })
  it('jumpToMessage 当前会话：直接 loadContextWindow + setHighlight；失败写 error', async () => {
    const ms = useMessageStore()
    ms.loadContextWindow = vi.fn(async () => false) as never
    ms.setHighlight = vi.fn() as never
    setDesktopApi(createDesktopApiMock({}))
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
    setDesktopApi(createDesktopApiMock({ activate: async () => ({ conversationId: 'c9' }) }))
    const cs = useConversationStore()
    cs.$patch({ currentId: 'c1' })
    await cs.jumpToMessage('c9', 'm1', 'seg1')
    expect(loadContextWindow).toHaveBeenCalledWith('m1')          // 经 activate(anchor) 分支
    expect(setHighlight).toHaveBeenCalledWith('m1', 'seg1')
    expect(cs.currentId).toBe('c9')
  })
})

describe('P4-B Task 13：D-P5 会话切换守卫（语音会话活跃时禁止切换/新建）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.resetAllMocks()
  })

  it('activate：voiceStore.mode≠idle → blockReason 置位 + 不调 api.activate + 不切换', async () => {
    useVoiceStore().$patch({ mode: 'recording' })
    const store = useConversationStore()
    store.$patch({ currentId: 'c1' })
    await store.activate('c2')
    expect(mockApi.activate).not.toHaveBeenCalled()
    expect(store.blockReason).toBe('请先结束当前语音会话')
    expect(store.currentId).toBe('c1')   // 不切换
  })

  it('create：voiceStore.mode≠idle → blockReason 置位 + 不调 api.createConversation + 不新建', async () => {
    useVoiceStore().$patch({ mode: 'realtime' })
    const store = useConversationStore()
    await store.create()
    expect(mockApi.createConversation).not.toHaveBeenCalled()
    expect(store.blockReason).toBe('请先结束当前语音会话')
    expect(store.currentId).toBeUndefined()
  })

  it('Minor-3：blockReason 置位后语音 mode 回 idle → 自动清除（停止/删除录音、实时结束、转写取消后横幅不残留）', async () => {
    useVoiceStore().$patch({ mode: 'recording' })
    const store = useConversationStore()
    store.$patch({ blockReason: '请先结束当前语音会话' })   // 陈旧横幅残留
    useVoiceStore().$patch({ mode: 'idle' })               // 语音会话结束
    await nextTick()                                        // watch 默认 flush:'pre'，微任务队列
    expect(store.blockReason).toBeUndefined()
  })

  it('activate：voiceStore.mode===idle → 放行 + 清 blockReason（同附件 canSend 短横幅语义）', async () => {
    useVoiceStore().$patch({ mode: 'idle' })
    const store = useConversationStore()
    store.$patch({ blockReason: '请先结束当前语音会话' })   // 陈旧提示残留
    mockApi.activate.mockResolvedValue({ conversationId: 'c1' })
    mockApi.getMessages.mockResolvedValue({ items: [], hasMore: false })
    await store.activate('c1')
    expect(mockApi.activate).toHaveBeenCalledWith('c1')
    expect(store.blockReason).toBeUndefined()   // 放行时清陈旧提示
    expect(store.currentId).toBe('c1')
  })
})
