// tests/unit/renderer-bootstrap.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createRendererBootstrap } from '../../src/renderer/src/bootstrap'
import type { ConnectionState, SessionPersistenceState } from '@shared/contracts'

function makeFake() {
  const stateHandlers: Array<(s: ConnectionState) => void> = []
  let resolveSnapshot: ((s: ConnectionState) => void) | undefined
  let rejectSnapshot: ((e: Error) => void) | undefined
  const api = {
    onChatEvent: vi.fn(() => () => {}),
    onChatState: vi.fn((h: (s: ConnectionState) => void) => { stateHandlers.push(h); return () => {} }),
    onChatReplay: vi.fn(() => () => {}),
    onChatError: vi.fn(() => () => {}),
    getConnectionState: vi.fn(() => new Promise<ConnectionState>((res, rej) => { resolveSnapshot = res; rejectSnapshot = rej })),
    hydratePersistence: vi.fn(async () => ({ drafts: [], scrollAnchors: {}, conversations: [], messageSnapshots: {} })), // G2 新增
    fireState: (s: ConnectionState) => stateHandlers.forEach((h) => h(s)),
    resolveSnapshot: (s: ConnectionState) => resolveSnapshot?.(s),
    rejectSnapshot: (e: Error) => rejectSnapshot?.(e)
  }
  return api
}
function makeStores() {
  return {
    connection: { setState: vi.fn(), setError: vi.fn() },
    message: { applyEvent: vi.fn(), handleConnectionStateChange: vi.fn(), loadReplay: vi.fn() },
    conversation: { onConnected: vi.fn(async () => {}), onActiveConversationAppeared: vi.fn(async () => {}), setOfflineCache: vi.fn(), activateLocal: vi.fn(async () => {}) },
    draft: { hydrate: vi.fn() },                    // G2 新增
    cache: { hydrate: vi.fn() }                     // G2 新增
  }
}

describe('createRendererBootstrap（P0-01 水合编排）', () => {
  it('register 注册 4 订阅（onChatEvent/onChatState/onChatReplay/onChatError）', () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    expect(api.onChatEvent).toHaveBeenCalled()
    expect(api.onChatState).toHaveBeenCalled()
    expect(api.onChatReplay).toHaveBeenCalled()
    expect(api.onChatError).toHaveBeenCalled()
  })
  it('connected snapshot → applyChatState 完整编排（setState+handleConnectionStateChange+onConnected+onActiveConversationAppeared）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve() // G2：getConnectionState 在 hydratePersistence.then 内异步调用，需先冲刷微任务
    api.resolveSnapshot({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    await Promise.resolve()
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    expect(stores.message.handleConnectionStateChange).toHaveBeenCalled()
    expect(stores.conversation.onConnected).toHaveBeenCalledWith('c1')
    expect(stores.conversation.onActiveConversationAppeared).toHaveBeenCalledWith('conv1')
  })
  it('disconnected snapshot → 不触发 onConnected/onActiveConversationAppeared（不制造假 connected）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'disconnected' })
    expect(stores.conversation.onConnected).not.toHaveBeenCalled()
    expect(stores.conversation.onActiveConversationAppeared).not.toHaveBeenCalled()
  })
  it('启动代次守卫：snapshot 等待期间收到 push → 迟到 snapshot 丢弃', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.fireState({ status: 'connected', connectionId: 'c2', activeConversationId: 'conv2' }) // push 先到
    api.resolveSnapshot({ status: 'disconnected' }) // 迟到旧 snapshot
    await Promise.resolve()
    // 只应用了 push 的 connected；迟到 snapshot 被丢弃
    expect(stores.connection.setState).toHaveBeenCalledTimes(1)
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'connected', connectionId: 'c2', activeConversationId: 'conv2' })
  })
  it('snapshot 拒绝 → setError(UNKNOWN) 且不调用 disconnect', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.rejectSnapshot(new Error('ipc failed'))
    await new Promise((r) => setTimeout(r, 0)) // .then().catch() 链需 2 个微任务冲刷（实测 1 次 flush 不够）
    expect(stores.connection.setError).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNKNOWN' }))
  })
})

const offlineState: SessionPersistenceState = {
  drafts: [{ conversationId: 'c1', text: '草稿', attachmentLocalIds: [], updatedAt: 't' }],
  scrollAnchors: {}, lastActiveConversationId: 'c1',
  conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }],
  messageSnapshots: { c1: [] }
}

describe('G2 持久化水合 + 离线视图（spec §4.5.3 P1-1/P2-2）', () => {
  function makeG2Stores() {
    const stores = makeStores()
    return {
      ...stores,
      conversation: { ...stores.conversation, setOfflineCache: vi.fn(), activateLocal: vi.fn(async () => {}) }
    }
  }
  it('register 调 hydratePersistence 并水合 draft/cache store', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    expect(api.hydratePersistence).toHaveBeenCalled()
    expect(stores.draft.hydrate).toHaveBeenCalledWith(offlineState)
    expect(stores.cache.hydrate).toHaveBeenCalledWith(offlineState)
  })
  it('disconnected snapshot → setOfflineCache + activateLocal(lastActive)（离线视图可读，消息快照进 messageStore）', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.conversation.setOfflineCache).toHaveBeenCalledWith(offlineState.conversations)
    expect(stores.conversation.activateLocal).toHaveBeenCalledWith('c1')
  })
  it('disconnected 且 lastActive 不在缓存 → 退化到 updatedAt 最近会话', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue({ ...offlineState, lastActiveConversationId: 'gone', conversations: [{ id: 'c2', title: 'B', updatedAt: 'z' }] })
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.conversation.activateLocal).toHaveBeenCalledWith('c2')
  })
  it('connected snapshot → 不激活离线视图、不把快照写进 messageStore（P2-2 缓存不进入 Store）', async () => {
    const api = makeFake(); const stores = makeG2Stores()
    ;(api.hydratePersistence as ReturnType<typeof vi.fn>).mockResolvedValue(offlineState)
    createRendererBootstrap(api as never, stores as never).register()
    await Promise.resolve()
    api.resolveSnapshot({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    await Promise.resolve()
    expect(stores.conversation.setOfflineCache).not.toHaveBeenCalled()
    expect(stores.conversation.activateLocal).not.toHaveBeenCalled()
    expect(stores.conversation.onConnected).toHaveBeenCalledWith('c1')
  })
})
