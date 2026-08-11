// tests/unit/connection.store.spec.ts
// Task 4:connectionStore——connect 成功/失败、setState(onChatState 推送)、disconnect、refreshState。
// env=node:store 经 stores/desktop-api 注入 mock api;pinia 用 createPinia + setActivePinia。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {})
}

describe('connectionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.resetAllMocks()
  })

  it('connect 成功:调 api.connect;等待期间乐观 connecting,成功后状态由 onChatState 推送决定', async () => {
    const store = useConnectionStore()
    let resolveConnect!: (v: { sessionId: string; protocolVersion: string; serverUrl: string }) => void
    mockApi.connect.mockImplementation(() => new Promise((res) => { resolveConnect = res }))
    const pending = store.connect('http://localhost:3000')
    expect(mockApi.connect).toHaveBeenCalledWith('http://localhost:3000')
    // 成功前乐观 connecting(P1-2:置位于 await 之前,不被 invoke reply 覆写)
    expect(store.state.status).toBe('connecting')
    expect(store.connecting).toBe(true)
    resolveConnect({ sessionId: 's1', protocolVersion: '2.0', serverUrl: 'http://localhost:3000' })
    await pending
    expect(store.connecting).toBe(false)
    expect(store.error).toBeUndefined()
    // connect 成功后状态由 onChatState 推送的 connected 决定(C-3 定死 push,不轮询)
    store.setState({ status: 'connected', connectionId: 'cid-1' })
    expect(store.state.status).toBe('connected')
    expect(store.state.connectionId).toBe('cid-1')
  })

  it('connect 失败:api.connect reject → error 置位,状态复位 disconnected', async () => {
    const store = useConnectionStore()
    mockApi.connect.mockRejectedValue(new Error('boom'))
    await store.connect('http://localhost:3000')
    expect(store.error).toBe('boom')
    expect(store.state.status).toBe('disconnected')
    expect(store.connecting).toBe(false)
  })

  it('setState 更新连接状态(onChatState 推送)', () => {
    const store = useConnectionStore()
    store.setState({ status: 'reconnecting', serverUrl: 'http://x' })
    expect(store.state.status).toBe('reconnecting')
    expect(store.state.serverUrl).toBe('http://x')
  })

  it('disconnect:调 api.disconnect', async () => {
    const store = useConnectionStore()
    await store.disconnect()
    expect(mockApi.disconnect).toHaveBeenCalled()
  })

  it('refreshState:getConnectionState 拉取覆盖 state', async () => {
    const store = useConnectionStore()
    mockApi.getConnectionState.mockResolvedValue({ status: 'connected', connectionId: 'cid-2' })
    await store.refreshState()
    expect(mockApi.getConnectionState).toHaveBeenCalled()
    expect(store.state.status).toBe('connected')
    expect(store.state.connectionId).toBe('cid-2')
  })
})
