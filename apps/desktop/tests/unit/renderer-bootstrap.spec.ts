// tests/unit/renderer-bootstrap.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createRendererBootstrap } from '../../src/renderer/src/bootstrap'
import type { ConnectionState } from '@shared/contracts'

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
    conversation: { onConnected: vi.fn(async () => {}), onActiveConversationAppeared: vi.fn(async () => {}) }
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
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'disconnected' })
    expect(stores.conversation.onConnected).not.toHaveBeenCalled()
    expect(stores.conversation.onActiveConversationAppeared).not.toHaveBeenCalled()
  })
  it('启动代次守卫：snapshot 等待期间收到 push → 迟到 snapshot 丢弃', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
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
    api.rejectSnapshot(new Error('ipc failed'))
    await new Promise((r) => setTimeout(r, 0)) // .then().catch() 链需 2 个微任务冲刷（实测 1 次 flush 不够）
    expect(stores.connection.setError).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNKNOWN' }))
  })
})
