// tests/unit/connection.store.spec.ts
// Task 4:connectionStore——connect 成功/失败、setState(onChatState 推送)、disconnect、refreshState。
// env=node:store 经 stores/desktop-api 注入 mock api;pinia 用 createPinia + setActivePinia。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectionStore } from '../../src/renderer/src/stores/connection.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`）。裸 mock 返回
// undefined，且 `as never` 让「镜像与真实契约漂移」无法被发现；工厂的默认值覆盖同一批键，
// 且各键都是**带真实签名**的 vi.fn，下面的 mockImplementation/mockResolvedValue 因此受检。
const mockApi = createDesktopApiMock()

describe('connectionStore', () => {
  beforeEach(() => {
    // 顺序有意为之：先清历史，再注入。工厂的默认实现来自 `vi.fn(impl)`，此处不依赖
    // reset 是否恢复原始实现——默认值在任何 reset 语义下都由注入之后的状态决定。
    vi.resetAllMocks()
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
  })

  it('connect 成功:调 api.connect(无参);等待期间乐观 connecting,成功后状态由 onChatState 推送决定', async () => {
    const store = useConnectionStore()
    let resolveConnect!: (v: { sessionId: string; protocolVersion: string; serverUrl: string }) => void
    mockApi.connect.mockImplementation(() => new Promise((res) => { resolveConnect = res }))
    const pending = store.connect()
    expect(mockApi.connect).toHaveBeenCalledWith()
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

  it('connect 失败:api.connect reject → error 结构化(parsePublicError 产出),状态保持 error(不回 disconnected)', async () => {
    const store = useConnectionStore()
    mockApi.connect.mockRejectedValue(new Error('[CREDENTIAL_UNAVAILABLE] 后端 Token 未设置'))
    await store.connect()
    expect(store.error).toEqual({ code: 'CREDENTIAL_UNAVAILABLE', message: '后端 Token 未设置' })
    expect(store.state.status).toBe('error')
    expect(store.state.lastError).toBe('后端 Token 未设置')
    expect(store.connecting).toBe(false)
  })

  it('connect 失败(无前缀)→ error code UNKNOWN,状态 error', async () => {
    const store = useConnectionStore()
    mockApi.connect.mockRejectedValue(new Error('boom'))
    await store.connect()
    expect(store.error).toEqual({ code: 'UNKNOWN', message: 'boom' })
    expect(store.state.status).toBe('error')
    expect(store.state.lastError).toBe('boom')
  })

  it('connect 失败 → state error(不回 disconnected) + lastError', async () => {
    const store = useConnectionStore()
    mockApi.connect.mockRejectedValue(new Error('[AUTHENTICATION_FAILED] 401'))
    await store.connect()
    expect(store.state.status).toBe('error')
    expect(store.error?.code).toBe('AUTHENTICATION_FAILED')
    expect(store.state.lastError).toBeDefined()
  })

  it('setState connected → 清 error', () => {
    const store = useConnectionStore()
    store.error = { code: 'X', message: 'x' }
    store.setState({ status: 'connected' })
    expect(store.error).toBeUndefined()
  })

  it('setError 设置公开错误', () => {
    const store = useConnectionStore()
    store.setError({ code: 'BACKEND_REJECTED', message: 'm', retryable: true })
    expect(store.error?.retryable).toBe(true)
  })

  it('D-P15：语音族错误码 → 不置连接错误态（不展示全局连接横幅）', () => {
    const store = useConnectionStore()
    store.error = { code: 'PREV', message: '旧错误' }
    store.setError({ code: 'VOICE_SESSION_CONFLICT', message: '已有语音会话' })
    expect(store.error?.code).toBe('PREV')           // 语音族错误不覆盖既有错误
    store.setError({ code: 'STT_UNAVAILABLE', message: 'STT 不可用' })
    expect(store.error?.code).toBe('PREV')           // 仍保持原错误
  })

  it('D-P15：真实路径形状（code=UNKNOWN + backendCode=STT_UNAVAILABLE）→ 同样抑制（不覆盖既有错误）', () => {
    const store = useConnectionStore()
    store.error = { code: 'PREV', message: '旧错误' }
    store.setError({ code: 'UNKNOWN', message: 'STT 不可用', backendCode: 'STT_UNAVAILABLE' })
    expect(store.error?.code).toBe('PREV')           // backendCode 命中语音族 → 不覆盖既有错误
  })

  it('D-P15：backendCode 非语音族 → 照旧 setError', () => {
    const store = useConnectionStore()
    store.setError({ code: 'UNKNOWN', message: 'm', backendCode: 'AUTHENTICATION_FAILED' })
    expect(store.error?.code).toBe('UNKNOWN')
  })

  it('D-P15：非语音族错误码 → 照旧 setError', () => {
    const store = useConnectionStore()
    store.setError({ code: 'BACKEND_REJECTED', message: 'm' })
    expect(store.error?.code).toBe('BACKEND_REJECTED')
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
