// tests/unit/desktop-api-chat.spec.ts
// Task 3:preload desktopApi chat 面——命令方法信封(unwrap)+ 事件订阅(onChatEvent/State/Replay)校验。
// env=node:mock 'electron' 模块的 ipcRenderer。invoke 由 vi.fn 注入返回值;on/removeListener 记录 handler,
// 测试通过 mockIpc.emit 触发(语义对齐真实 ipcRenderer.on 回调签名 (event, ...args))。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PushChannels, type BackendEvent, type Message } from '@shared/contracts'

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
    // 字段级校验(ConnectionStateSchema 升级后):optional 字段类型非法也丢弃
    mockIpc.emit('chat:state', { status: 'connected', connectionId: 123 })
    mockIpc.emit('chat:state', { status: 'error', lastError: 42 })

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

  it('onChatReplay:逐条过滤——非法消息丢弃 + warn(含 conversationId/index),合法保留达 handler', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const received: unknown[] = []
    const unsub = desktopApi.onChatReplay((p) => received.push(p))

    // C1 防误丢:assistant 无 content、assistantSegments 用 text?/completed 通过 MessageSchema
    const validAssistant = {
      messageId: 'm1', conversationId: 'c1', role: 'assistant', status: 'completed',
      createdAt: '2026-08-11T00:00:00Z',
      assistantSegments: [{ segmentId: 's1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: 'hi', completed: true }]
    }
    const invalidMissingRole = { messageId: 'm2', conversationId: 'c1', createdAt: '2026-08-11T00:00:00Z' } // 缺 role/status
    const validUser = { messageId: 'm3', conversationId: 'c1', role: 'user', content: 'hello', status: 'completed', createdAt: '2026-08-11T00:00:00Z' }

    mockIpc.emit('chat:replay', { conversationId: 'c1', messages: [validAssistant, invalidMissingRole, validUser] })

    expect(received).toEqual([{ conversationId: 'c1', messages: [validAssistant, validUser] }])
    expect(console.warn).toHaveBeenCalledWith('cyrene:replay:drop-invalid-message', { conversationId: 'c1', index: 1 })

    unsub()
  })

  it('onChatReplay:整批 messages 非法 → 全部丢弃但 payload 仍达 handler(messages: [])', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const received: unknown[] = []
    const unsub = desktopApi.onChatReplay((p) => received.push(p))

    mockIpc.emit('chat:replay', { conversationId: 'c1', messages: [{ bogus: true }] })

    expect(received).toEqual([{ conversationId: 'c1', messages: [] }])
    expect(console.warn).toHaveBeenCalledWith('cyrene:replay:drop-invalid-message', { conversationId: 'c1', index: 0 })

    unsub()
  })

  it('PushChannels.error = chat:error', () => {
    expect(PushChannels.error).toBe('chat:error')
  })

  it('onChatError 合法载荷送达 + PublicErrorShape 字段透传', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const handler = vi.fn()
    const unsub = desktopApi.onChatError(handler)
    const payload = { code: 'BACKEND_REJECTED', message: '队列满', backendCode: 'QUEUE_FULL', retryable: true, requestId: 'r1', clientRequestId: 'cr-1', retryAfterMs: 1000, idempotencyDurable: false }
    mockIpc.emit(PushChannels.error, payload)
    expect(handler).toHaveBeenCalledWith(payload)
    unsub()
  })

  it('onChatError 非法载荷(缺 code/message)丢弃 + unsub 后不再收', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const handler = vi.fn()
    const unsub = desktopApi.onChatError(handler)
    mockIpc.emit(PushChannels.error, { foo: 1 })
    unsub()
    mockIpc.emit(PushChannels.error, { code: 'X', message: 'x' })
    expect(handler).not.toHaveBeenCalled()
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

  it('unwrap 错误 → message 完整携带公开结构化字段前缀', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({
      ok: false, error: { code: 'BACKEND_REJECTED', message: '队列已满', backendCode: 'QUEUE_FULL', retryable: true, clientRequestId: 'cr-1', retryAfterMs: 1000, idempotencyDurable: false }
    })
    await expect(desktopApi.getConnectionState()).rejects.toThrow('[BACKEND_REJECTED] [backendCode=QUEUE_FULL] [retryable=true] [clientRequestId=cr-1] [retryAfterMs=1000] [idempotencyDurable=false] 队列已满')
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

  // —— unwrap(res, schema) 防御性解析:ok:true data 形状校验 / 畸形信封兜底(M1) ——

  it('unwrap 响应 schema 校验失败 → 抛 [SCHEMA_VALIDATION_FAILED] IPC 响应校验失败', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { status: 'bogus-status' } })
    await expect(desktopApi.getConnectionState()).rejects.toThrow('[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败')
  })

  it('unwrap schema 校验:getMessages 返回缺 hasMore → [SCHEMA_VALIDATION_FAILED]', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { items: [] } })
    await expect(desktopApi.getMessages({ conversationId: 'c1' })).rejects.toThrow('[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败')
  })

  it('unwrap 畸形信封:ok:true 缺 data → 抛 [IPC_ERROR] IPC 返回格式异常', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true })
    await expect(desktopApi.getConnectionState()).rejects.toThrow('[IPC_ERROR] IPC 返回格式异常')
  })

  it('unwrap 畸形信封:ok:false 缺 error → 抛 [IPC_ERROR] IPC 返回格式异常', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: false })
    await expect(desktopApi.disconnect()).rejects.toThrow('[IPC_ERROR] IPC 返回格式异常')
  })
})

describe('阶段 3 G2 新通道（persistSession/cacheMessages/hydratePersistence/openExternal）', () => {
  it('persistSession 调 chat:persist-session 并解包 PersistSessionResult（含 evictedConversationIds）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { evictedConversationIds: ['old'] } })
    await expect(desktopApi.persistSession({ conversationId: 'c1', draft: { text: '草稿', updatedAt: 't' }, scrollAnchor: null }))
      .resolves.toEqual({ evictedConversationIds: ['old'] })
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:persist-session', { conversationId: 'c1', draft: { text: '草稿', updatedAt: 't' }, scrollAnchor: null })
  })
  it('cacheMessages 调 chat:cache-messages（void 信封）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    const msg: Message = { messageId: 'm1', conversationId: 'c1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' }
    const input = { conversationId: 'c1', messages: [msg], updatedAt: 't' }
    await expect(desktopApi.cacheMessages(input)).resolves.toBeUndefined()
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:cache-messages', input)
  })
  it('hydratePersistence 调 chat:hydrate-persistence（0 参）并解包 SessionPersistenceState', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const state = { drafts: [{ conversationId: 'c1', text: '草稿', attachmentLocalIds: [], updatedAt: 't' }], scrollAnchors: {}, conversations: [], messageSnapshots: {} }
    mockIpc.invoke.mockResolvedValue({ ok: true, data: state })
    await expect(desktopApi.hydratePersistence()).resolves.toEqual(state)
    expect(mockIpc.invoke).toHaveBeenCalledWith('chat:hydrate-persistence')
  })
  it('openExternal 调 app:open-external（{url} 包裹, void）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await expect(desktopApi.openExternal('https://example.com/')).resolves.toBeUndefined()
    expect(mockIpc.invoke).toHaveBeenCalledWith('app:open-external', { url: 'https://example.com/' })
  })
  it('hydratePersistence 失败信封 → 抛 [code] message', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: false, error: { code: 'LOAD_FAILED', message: '水合失败' } })
    await expect(desktopApi.hydratePersistence()).rejects.toThrow('[LOAD_FAILED] 水合失败')
  })
  it('persistSession 响应 schema 校验失败（evictedConversationIds 非数组）→ [SCHEMA_VALIDATION_FAILED]', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { evictedConversationIds: 'oops' } })
    await expect(desktopApi.persistSession({ conversationId: 'c1', draft: { text: '', updatedAt: 't' }, scrollAnchor: null }))
      .rejects.toThrow('[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败')
  })
})

describe('desktopApi 历史/上下文/表情方法（G4）', () => {
  it('queryChatHistory 解包 ChatHistoryPage（响应校验失败抛 SCHEMA_VALIDATION_FAILED）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { items: [{ hitId: 'c1:m1:', conversationId: 'c1', messageId: 'm1', senderLabel: 'user', createdAt: 't', sortKey: 't|m1' }], hasMore: false } })
    const page = await desktopApi.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
    expect(Array.isArray(page.items)).toBe(true)
    expect(typeof page.hasMore).toBe('boolean')
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { items: 'bad', hasMore: false } })
    await expect(desktopApi.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })).rejects.toThrow('[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败')
  })
  it('listStickers 解包 StickerManifest{stickers}（P0-2）', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] } })
    const manifest = await desktopApi.listStickers()
    expect(Array.isArray(manifest.stickers)).toBe(true)
    expect(manifest.stickers[0].stickerId).toBe('st_1')
  })
  it('getMessageContext 解包 MessagePage', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    mockIpc.invoke.mockResolvedValueOnce({ ok: true, data: { items: [{ messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't', content: 'x' }], hasMore: false } })
    const page = await desktopApi.getMessageContext({ conversationId: 'c1', messageId: 'm1' })
    expect(Array.isArray(page.items)).toBe(true)
  })
})
