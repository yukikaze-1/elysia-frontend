import { describe, expect, it, vi } from 'vitest'
import { createChatService } from '../../src/main/chat/chat-service'
import { MockBackend } from '../../src/main/transport/mock-backend'
import type { Message } from '@shared/contracts/message'
import { CyreneErrorCode } from '@shared/errors'
import type { ConnectionConfig, NormalizedEndpoint } from '../../src/main/connection/connection-config'
import type { StickerManifest } from '../../src/shared/contracts/sticker'

function makeDeps(overrides: Partial<Parameters<typeof createChatService>[0]> = {}) {
  const adapter = new MockBackend()
  const sent: { channel: string; payload: unknown }[] = []
  const connectionConfig = {
    getEndpoint: vi.fn<() => NormalizedEndpoint | undefined>(() => undefined),
    getTokenBinding: vi.fn<() => Promise<{ origin: string } | undefined>>(async () => undefined),
    setEndpoint: vi.fn(async (u: string) => ({ origin: u, baseUrl: u.replace(/\/$/, ''), wsUrl: u.replace(/^http/, 'ws') + '/ws' }))
  }
  const deps = {
    adapter,
    send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
    getToken: () => 'sk-test',
    requireToken: false,   // mock 免 token 演示
    // 只暴露 chat-service 消费的窄面；类型收窄到 ConnectionConfig 以满足 ChatServiceDeps（多余方法不在此 mock）
    connectionConfig: connectionConfig as unknown as ConnectionConfig,
    ...overrides
  }
  vi.spyOn(deps.adapter, 'connect')
  return { deps, sent, connectionConfig }
}

describe('chat-service', () => {
  it('connect 无参转发 Adapter 并广播连接状态（Mock 占位 mock://local）', async () => {
    const { deps, sent } = makeDeps()
    const svc = createChatService(deps)
    const session = await svc.connect()
    expect(deps.adapter.connect).toHaveBeenCalledWith({ serverUrl: 'mock://local' })
    expect(session.serverUrl).toBe('mock://local')
    // MockBackend connect 触发 onConnectionStateChange? —— 需 chat-service 在 connect 后主动推一次状态
    // 简化:chat-service 的 connect 调用后调 send('chat:state', adapter.getConnectionState())
    expect(sent.some((s) => s.channel === 'chat:state' && (s.payload as { status: string }).status === 'connected')).toBe(true)
    svc.dispose()
  })

  it('subscribe 的领域事件转发 chat:event', async () => {
    const { deps, sent } = makeDeps()
    const svc = createChatService(deps)
    await svc.connect()
    const ref = await svc.send({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c1' })
    expect(ref.clientRequestId).toBe('c1')
    await new Promise((r) => setTimeout(r, 35))   // P1-1:MockBackend 回放用 setTimeout 宏任务,须等待再断言
    expect(sent.some((s) => s.channel === 'chat:event')).toBe(true)
    svc.dispose()
  })

  it('connect 无参且 Real 未设 endpoint → CREDENTIAL_UNAVAILABLE', async () => {
    const { deps } = makeDeps({ requireToken: true })   // connectionConfig.getEndpoint 默认 () => undefined
    const svc = createChatService(deps)
    await expect(svc.connect()).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
  })

  it('connect 绑定 origin 不匹配 → CREDENTIAL_UNAVAILABLE', async () => {
    const { deps, connectionConfig } = makeDeps({ requireToken: true })
    connectionConfig.getEndpoint.mockReturnValue({ origin: 'https://a.example', baseUrl: 'https://a.example', wsUrl: 'wss://a.example/ws' })
    connectionConfig.getTokenBinding.mockResolvedValue({ origin: 'https://b.example' })
    const svc = createChatService(deps)
    await expect(svc.connect()).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
  })

  it('connect 缺 token 且 requireToken=true → CREDENTIAL_UNAVAILABLE', async () => {
    const { deps, connectionConfig } = makeDeps({ getToken: () => undefined, requireToken: true })
    connectionConfig.getEndpoint.mockReturnValue({ origin: 'https://a.example', baseUrl: 'https://a.example', wsUrl: 'wss://a.example/ws' })
    connectionConfig.getTokenBinding.mockResolvedValue({ origin: 'https://a.example' })
    const svc = createChatService(deps)
    await expect(svc.connect()).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  })

  it('connect Mock（requireToken=false）用 mock://local 占位且跳过校验', async () => {
    const { deps } = makeDeps()   // requireToken: false, connectionConfig.getEndpoint: () => undefined
    const svc = createChatService(deps)
    const session = await svc.connect()
    expect(deps.adapter.connect).toHaveBeenCalledWith({ serverUrl: 'mock://local' })
    expect(session.serverUrl).toBe('mock://local')
  })

  it('setEndpoint → 返回规范化 baseUrl', async () => {
    const { deps } = makeDeps()
    const svc = createChatService(deps)
    const r = await svc.setEndpoint('https://a.example/')
    expect(r).toEqual({ endpoint: 'https://a.example' })
  })

  it('setEndpoint endpoint 变化 → adapter.disconnect 被调', async () => {
    const adapter = { subscribe: () => () => {}, disconnect: vi.fn(async () => {}) }
    const connConfig = {
      getEndpoint: () => ({ origin: 'http://a', baseUrl: 'http://a' }),
      setEndpoint: vi.fn(async () => ({ origin: 'http://b', baseUrl: 'http://b' }))
    }
    const svc = createChatService({ adapter: adapter as never, send: () => {}, getToken: () => undefined, connectionConfig: connConfig as never })
    await svc.setEndpoint('http://b')
    expect(connConfig.setEndpoint).toHaveBeenCalledWith('http://b')
    expect(adapter.disconnect).toHaveBeenCalled()
  })

  it('setEndpoint 同 endpoint → 不 disconnect(幂等)', async () => {
    const adapter = { subscribe: () => () => {}, disconnect: vi.fn(async () => {}) }
    const connConfig = { getEndpoint: () => ({ origin: 'http://a', baseUrl: 'http://a' }), setEndpoint: async () => ({ origin: 'http://a', baseUrl: 'http://a' }) }
    const svc = createChatService({ adapter: adapter as never, send: () => {}, getToken: () => undefined, connectionConfig: connConfig as never })
    await svc.setEndpoint('http://a')
    expect(adapter.disconnect).not.toHaveBeenCalled()
  })

  it('getEndpoint → 当前已设 endpoint 的 baseUrl（未设则 endpoint 缺省）', async () => {
    const { deps, connectionConfig } = makeDeps()
    connectionConfig.getEndpoint.mockReturnValue({ origin: 'https://a.example', baseUrl: 'https://a.example', wsUrl: 'wss://a.example/ws' })
    const svc = createChatService(deps)
    expect(svc.getEndpoint()).toEqual({ endpoint: 'https://a.example' })
    expect(connectionConfig.getEndpoint).toHaveBeenCalled()
  })

  it('getRuntimeInfo 依 requireToken 返回 mode', async () => {
    const { deps } = makeDeps({ requireToken: true })
    const svc = createChatService(deps)
    expect(await svc.getRuntimeInfo()).toEqual({ mode: 'real', packaged: false })
  })

  it('getRuntimeInfo Mock 模式 → mode mock', async () => {
    const { deps } = makeDeps()   // requireToken: false
    const svc = createChatService(deps)
    expect(await svc.getRuntimeInfo()).toEqual({ mode: 'mock', packaged: false })
  })

  it('pushReplay 转发 chat:replay(会话回放生产侧桥)', () => {
    const { deps, sent } = makeDeps()
    const svc = createChatService(deps)
    const messages: Message[] = [{
      messageId: 'm-1',
      conversationId: 'conv-1001',
      role: 'assistant',
      status: 'completed',
      createdAt: '2026-08-10T00:00:00.000Z'
    }]
    svc.pushReplay('conv-1001', messages)
    const replay = sent.find((s) => s.channel === 'chat:replay')
    expect(replay).toBeDefined()
    expect((replay?.payload as { conversationId: string; messages: Message[] }).conversationId).toBe('conv-1001')
    expect((replay?.payload as { conversationId: string; messages: Message[] }).messages).toHaveLength(1)
    svc.dispose()
  })

  it('connect 成功 → audit connection:connect connected', async () => {
    const { deps } = makeDeps({ audit: vi.fn() })
    const svc = createChatService(deps)
    await svc.connect()
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection:connect', status: 'connected', summary: 'mode=mock' }))
    svc.dispose()
  })
  it('connect 失败 → audit connection:connect failed + rethrow', async () => {
    const { deps } = makeDeps({ requireToken: true, audit: vi.fn() })
    const svc = createChatService(deps)
    await expect(svc.connect()).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection:connect', status: 'failed' }))
  })
  it('disconnect → audit connection:disconnect', async () => {
    const { deps } = makeDeps({ audit: vi.fn() })
    const svc = createChatService(deps)
    await svc.disconnect()
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection:disconnect', summary: 'mode=mock' }))
    svc.dispose()
  })
})

describe('ChatService 历史/上下文/表情透传（G4）', () => {
  it('queryChatHistory/getMessageContext/listStickers 透传到 adapter', async () => {
    const adapter = {
      queryChatHistory: vi.fn(async () => ({ items: [], hasMore: false })),
      getMessageContext: vi.fn(async () => ({ items: [], hasMore: false })),
      listStickers: vi.fn(async (): Promise<StickerManifest> => ({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] })),   // P0-2
      subscribe: vi.fn(() => () => {})
    }
    const svc = createChatService({ adapter, send: vi.fn(), getToken: async () => 'tok', connectionConfig: undefined as never, requireToken: false } as never)
    await svc.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
    await svc.getMessageContext({ conversationId: 'c1', messageId: 'm1' })
    await svc.listStickers()
    expect(adapter.queryChatHistory).toHaveBeenCalledTimes(1)
    expect(adapter.getMessageContext).toHaveBeenCalledTimes(1)
    expect(adapter.listStickers).toHaveBeenCalledTimes(1)
  })
})
