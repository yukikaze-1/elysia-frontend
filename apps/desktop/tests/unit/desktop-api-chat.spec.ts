// tests/unit/desktop-api-chat.spec.ts
// Task 3:preload desktopApi chat 面——命令方法信封(unwrap)+ 事件订阅(onChatEvent/State/Replay)校验。
// env=node:mock 'electron' 模块的 ipcRenderer。invoke 由 vi.fn 注入返回值;on/removeListener 记录 handler,
// 测试通过 mockIpc.emit 触发(语义对齐真实 ipcRenderer.on 回调签名 (event, ...args))。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@shared/contracts'

// vi.hoisted:vi.mock 工厂被提升到文件顶部执行,须先在此定义可供工厂引用的 mock 值(变量名以 mock 开头)
const { mockIpc, mockHandlers } = vi.hoisted(() => {
  const mockHandlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const mockIpc = {
    invoke: vi.fn(),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void): void => {
      const list = mockHandlers.get(channel) ?? []
      list.push(handler)
      mockHandlers.set(channel, list)
    }),
    removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void): void => {
      const list = mockHandlers.get(channel) ?? []
      mockHandlers.set(channel, list.filter((h) => h !== handler))
    }),
    emit: (channel: string, ...args: unknown[]): void => {
      const event = { type: 'mock-ipc', channel }
      for (const handler of mockHandlers.get(channel) ?? []) handler(event, ...args)
    }
  }
  return { mockIpc, mockHandlers }
})

vi.mock('electron', () => ({ ipcRenderer: mockIpc }))

// 订阅对非法载荷会 console.warn;静音并便于断言
vi.spyOn(console, 'warn').mockImplementation(() => {})

async function importDesktopApi() {
  const mod = await import('../../src/preload/desktop-api')
  return { desktopApi: mod.desktopApi, mockIpc }
}

beforeEach(() => {
  mockIpc.invoke.mockReset()
  mockIpc.on.mockClear()
  mockIpc.removeListener.mockClear()
  mockHandlers.clear()
  vi.mocked(console.warn).mockClear()
})

describe('desktopApi chat 面', () => {
  // —— 事件订阅:合法送达 / 非法丢弃(warn)/ 取消后不再收 ——

  it('onChatEvent:合法 BackendEvent 送达,非法丢弃并 warn,unsub 后不再收', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const received: unknown[] = []
    const unsub = desktopApi.onChatEvent((e) => received.push(e))

    const valid: BackendEvent = {
      event: 'generation.started', generationId: 'g', messageId: 'm',
      responseId: 'g', conversationId: 'c', eventId: 'e1', sequence: 1
    }
    mockIpc.emit('chat:event', valid)
    mockIpc.emit('chat:event', { bogus: true })
    mockIpc.emit('chat:event', 'garbage')

    expect(received).toEqual([valid])
    expect(console.warn).toHaveBeenCalled()

    unsub()
    mockIpc.emit('chat:event', {
      event: 'generation.delta', generationId: 'g', segmentId: 's', segmentIndex: 0,
      channel: 'public_reply', kind: 'text', deltaSequence: 0, text: 'hi', eventId: 'e2', sequence: 2
    })
    expect(received).toEqual([valid])
  })

  it('onChatState:合法 ConnectionState 送达,非法丢弃,unsub 后不再收', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const received: unknown[] = []
    const unsub = desktopApi.onChatState((s) => received.push(s))

    mockIpc.emit('chat:state', { status: 'connected', connectionId: 'cid' })
    mockIpc.emit('chat:state', { status: 'bogus-status' })
    mockIpc.emit('chat:state', null)

    expect(received).toEqual([{ status: 'connected', connectionId: 'cid' }])

    unsub()
    mockIpc.emit('chat:state', { status: 'disconnected' })
    expect(received).toEqual([{ status: 'connected', connectionId: 'cid' }])
  })

  it('onChatReplay:合法 {conversationId, messages} 送达,非法丢弃,unsub 后不再收', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const received: unknown[] = []
    const unsub = desktopApi.onChatReplay((p) => received.push(p))

    mockIpc.emit('chat:replay', { conversationId: 'c1', messages: [] })
    mockIpc.emit('chat:replay', { conversationId: 'c1' })
    mockIpc.emit('chat:replay', { messages: [] })

    expect(received).toEqual([{ conversationId: 'c1', messages: [] }])

    unsub()
    mockIpc.emit('chat:replay', { conversationId: 'c2', messages: [] })
    expect(received).toEqual([{ conversationId: 'c1', messages: [] }])
  })

  // —— 命令方法:通道 + 载荷 + 信封解包 ——

  it('connect 无参 invoke(arity 0,只传 channel)', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const session = { sessionId: 's1', protocolVersion: '2.0', serverUrl: 'http://localhost:3000' }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: session })
    await expect(desktopApi.connect()).resolves.toEqual(session)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:connect')
  })

  it('setEndpoint invoke chat:set-endpoint 载荷 {serverUrl}', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { endpoint: 'https://a.example' } })
    await expect(desktopApi.setEndpoint('https://a.example/')).resolves.toEqual({ endpoint: 'https://a.example' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:set-endpoint', { serverUrl: 'https://a.example/' })
  })

  it('getEndpoint invoke chat:get-endpoint(0 参)', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { endpoint: 'https://a.example' } })
    await expect(desktopApi.getEndpoint()).resolves.toEqual({ endpoint: 'https://a.example' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:get-endpoint')
  })

  it('getRuntimeInfo invoke chat:get-runtime-info(0 参)', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { mode: 'mock', packaged: false } })
    await expect(desktopApi.getRuntimeInfo()).resolves.toEqual({ mode: 'mock', packaged: false })
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:get-runtime-info')
  })

  it('disconnect:调 chat:disconnect(void 信封)', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await expect(desktopApi.disconnect()).resolves.toBeUndefined()
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:disconnect')
  })

  it('listConversations:调 chat:list-conversations 并解包 Page<Conversation>', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const page = { items: [{ id: 'c1', title: '会话', updatedAt: '2026-08-11T00:00:00Z' }], hasMore: false }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: page })
    await expect(desktopApi.listConversations({ cursor: 'cur', limit: 10 })).resolves.toEqual(page)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:list-conversations', { cursor: 'cur', limit: 10 })
  })

  it('getMessages:调 chat:get-messages 并解包 MessagePage', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const page = { items: [], hasMore: false }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: page })
    await expect(desktopApi.getMessages({ conversationId: 'c1', limit: 20 })).resolves.toEqual(page)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:get-messages', { conversationId: 'c1', limit: 20 })
  })

  it('send:调 chat:send 并解包 ClientRequestRef', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const ref = { clientRequestId: 'cr1' }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: ref })
    await expect(desktopApi.send({ conversationId: 'c1', text: 'hi', clientRequestId: 'cr1' })).resolves.toEqual(ref)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:send', { conversationId: 'c1', text: 'hi', clientRequestId: 'cr1' })
  })

  it('cancel:调 chat:cancel(void 信封)', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await expect(desktopApi.cancel({ generationId: 'g1' })).resolves.toBeUndefined()
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:cancel', { generationId: 'g1' })
  })

  it('activate:调 chat:activate(conversationId 包裹)', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { conversationId: 'c1' } })
    await expect(desktopApi.activate('c1')).resolves.toEqual({ conversationId: 'c1' })
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:activate', { conversationId: 'c1' })
  })

  it('createConversation:调 chat:create 并解包 Conversation', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const conv = { id: 'c1', title: 't', updatedAt: '2026-08-11T00:00:00Z' }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: conv })
    await expect(desktopApi.createConversation({ title: 't' })).resolves.toEqual(conv)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:create', { title: 't' })
  })

  it('renameConversation:单对象载荷调 chat:rename 并解包 Conversation', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const conv = { id: 'c1', title: 'new', updatedAt: '2026-08-11T00:00:00Z' }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: conv })
    await expect(desktopApi.renameConversation({ conversationId: 'c1', title: 'new' })).resolves.toEqual(conv)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:rename', { conversationId: 'c1', title: 'new' })
  })

  it('deleteConversation:调 chat:delete(conversationId 包裹,void)', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await expect(desktopApi.deleteConversation('c1')).resolves.toBeUndefined()
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:delete', { conversationId: 'c1' })
  })

  it('getConnectionState:调 chat:get-state 并解包 ConnectionState', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const state = { status: 'connected', connectionId: 'cid1' }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: state })
    await expect(desktopApi.getConnectionState()).resolves.toEqual(state)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:get-state')
  })

  // —— 信封守卫:ok:false / 畸形 / IPC 异常 ——

  it('ok:false 信封 → 抛 [code] message', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: false, error: { code: 'AUTHENTICATION_FAILED', message: 'token 无效' } })
    await expect(desktopApi.getConnectionState()).rejects.toThrow('[AUTHENTICATION_FAILED] token 无效')
  })

  it('unwrap 错误 → message 含 [code] 与 [backendCode=..] [retryable=..] 前缀', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({
      ok: false, error: { code: 'BACKEND_REJECTED', message: '队列已满', backendCode: 'QUEUE_FULL', retryable: true }
    })
    await expect(desktopApi.getConnectionState()).rejects.toThrow('[BACKEND_REJECTED] [backendCode=QUEUE_FULL] [retryable=true] 队列已满')
  })

  it('unwrapStatus 错误同样带结构化前缀', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({
      ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE', message: '请先设置后端地址', requestId: 'r1' }
    })
    await expect(desktopApi.getCredentialStatus()).rejects.toThrow('[CREDENTIAL_UNAVAILABLE] [requestId=r1] 请先设置后端地址')
  })

  it('畸形信封(非 IpcResult)→ 抛 [IPC_ERROR] IPC 返回格式异常', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ bogus: true })
    await expect(desktopApi.disconnect()).rejects.toThrow('[IPC_ERROR] IPC 返回格式异常')
  })

  it('ipcRenderer.invoke 异常 → 抛 [IPC_ERROR] IPC 调用失败', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockRejectedValue(new Error('boom'))
    await expect(desktopApi.disconnect()).rejects.toThrow('[IPC_ERROR] IPC 调用失败')
  })
})
