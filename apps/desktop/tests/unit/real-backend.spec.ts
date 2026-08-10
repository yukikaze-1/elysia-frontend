import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { WebSocketServer } from 'ws'
import { AddressInfo } from 'net'
import { RealBackend } from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts'
import { CyreneErrorCode } from '@shared/errors'

let server: Server
let wss: WebSocketServer
let authServer: Server
let port: number
let authPort: number
let receivedHeaders: Record<string, string> = {}
let receivedClientFrames: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    // REST mock:activateConversation connected 路径走真实 HTTP(与 wss 同 server);Task 4 既有用例不依赖此 handler
    if (req.url === '/api/sessions/conv-2/activate' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ activeConversationId: 'conv-2' }))
      return
    }
    res.writeHead(404); res.end()
  })
  wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws, req) => {
    receivedHeaders = {}
    receivedClientFrames = []
    for (const k of Object.keys(req.headers)) receivedHeaders[k.toLowerCase()] = String(req.headers[k] ?? '')
    ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
    ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
    ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
    ws.send(JSON.stringify({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-g', conversationId: 'conv-1', model: 'm1' }))
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data))
      receivedClientFrames.push(frame.type)
      if (frame.type === 'text') {
        if (frame.clientRequestId === 'c-timeout') return // 不发 ack → 触发超时
        const ok = frame.clientRequestId === 'c-reject'
          ? { status: 'rejected', error: { code: 'CONTRACT_VALIDATION', message: 'bad', retryable: false } }
          : frame.clientRequestId === 'c-error'
            ? (ws.send(JSON.stringify({ type: 'error', message: '限流', code: 'RATE_LIMITED', requestId: 'req-1', retryable: true })), { status: 'accepted' })
            : { status: 'accepted' }
        ws.send(JSON.stringify({ type: 'user_message.ack', messageId: 'msg-ack', clientRequestId: frame.clientRequestId, receivedAt: '2026-08-11T00:00:00.000Z', ...ok }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  authServer = createServer((_req, res) => { res.writeHead(401); res.end() })
  await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve))
  authPort = (authServer.address() as AddressInfo).port
})

afterAll(async () => { wss.close(); server.close(); authServer.close() })

function makeBackend(): RealBackend { return new RealBackend({ now: () => Date.now() }) }

describe('RealBackend WS 连接', () => {
  it('握手头精确注入 X-Protocol-Version:"2"/X-Client-Platform/Authorization', async () => {
    const b = makeBackend()
    const session = await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    expect(session.protocolVersion).toBe('2.0')
    expect(session.sessionId).toBe('conn-1')
    expect(receivedHeaders['x-protocol-version']).toBe('2')
    expect(receivedHeaders['x-client-platform']).toBe('electron')
    expect(receivedHeaders['authorization']).toBe('Bearer sk-test')
    await b.disconnect()
  })

  it('连接状态 connected + activeConversationId 解析', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    expect(b.getConnectionState().status).toBe('connected')
    expect(b.getConnectionState().activeConversationId).toBe('conv-1')
    await b.disconnect()
  })

  it('sendMessage → ack accepted → ClientRequestRef', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    const ref = await b.sendMessage({ conversationId: 'conv-1', text: 'hi', clientRequestId: 'c1' })
    expect(ref.clientRequestId).toBe('c1')
    expect(ref.serverMessageId).toBe('msg-ack')
    await b.disconnect()
  })

  it('sendMessage → ack rejected → CyreneError', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await expect(b.sendMessage({ conversationId: 'conv-1', text: 'hi', clientRequestId: 'c-reject' })).rejects.toBeDefined()
    await b.disconnect()
  })

  it('sendMessage ack 超时 → CyreneError(TIMEOUT)', async () => {
    const b = new RealBackend({ now: () => Date.now(), ackTimeoutMs: 30 })
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await expect(b.sendMessage({ conversationId: 'conv-1', text: 'x', clientRequestId: 'c-timeout' })).rejects.toMatchObject({ code: CyreneErrorCode.TIMEOUT })
    await b.disconnect()
  })

  it('subscribe 收到 generation 事件(经 FrameMapper)', async () => {
    const b = makeBackend()
    const received: BackendEvent[] = []
    b.subscribe((e) => received.push(e))
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await new Promise((r) => setTimeout(r, 50))
    expect(received.some((e) => e.event === 'generation.started' && e.responseId === 'gen-1')).toBe(true)
    await b.disconnect()
  })

  it('cancelGeneration → interrupt 帧发出', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await b.cancelGeneration({ generationId: 'gen-1' })
    await new Promise((r) => setTimeout(r, 50)) // ws.send fire-and-forget,等伪后端收帧
    expect(receivedClientFrames).toContain('interrupt')
    await b.disconnect()
  })

  it('WS error 帧 → onError 回调', async () => {
    const errs: unknown[] = []
    const b = new RealBackend({ now: () => Date.now(), onError: (e) => errs.push(e) })
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await b.sendMessage({ conversationId: 'conv-1', text: 'x', clientRequestId: 'c-error' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    expect(errs.length).toBeGreaterThan(0)
    await b.disconnect()
  })

  it('server_info 版本非 2.0 → connect reject PROTOCOL_MISMATCH,状态 error', async () => {
    const fakeWs = {
      send: () => {}, close: () => {}, readyState: 1,
      on: (ev: string, cb: (arg?: unknown) => void) => {
        if (ev === 'open') cb()
        if (ev === 'message') {
          cb(Buffer.from(JSON.stringify({ type: 'session', conversationId: 'c', messages: [], token_stats: { total: 0, byModel: {} } })))
          setTimeout(() => cb(Buffer.from(JSON.stringify({ type: 'server_info', protocol_version: '1.0', server_version: 'v', features: {}, services: {} }))), 0)
        }
      }
    }
    const b = new RealBackend({ now: () => Date.now(), wsFactory: () => fakeWs as never })
    await expect(b.connect({ serverUrl: 'http://x', token: 't' })).rejects.toMatchObject({ code: CyreneErrorCode.PROTOCOL_MISMATCH })
    expect(b.getConnectionState().status).toBe('error')
  })

  it('unexpected-response(401) → fail-fast error 状态不重连', async () => {
    const b = makeBackend()
    await expect(b.connect({ serverUrl: `http://127.0.0.1:${authPort}`, token: 'bad' })).rejects.toBeDefined()
    expect(b.getConnectionState().status).toBe('error') // 不是 reconnecting
  })

  it('重连退避:close 后 reconnecting → 重连成功 connected(F2)', async () => {
    let call = 0
    const wsFactory = (_url: string, _headers: Record<string, string>) => {
      const id = call++
      let closeCb: (() => void) | undefined
      return {
        on: (ev: string, cb: (arg?: unknown) => void) => {
          if (ev === 'message') {
            cb(Buffer.from(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })))
            cb(Buffer.from(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: 'v', features: {}, services: {}, connectionId: `conn-${id}` })))
            if (id === 0) setTimeout(() => closeCb?.(), 0) // 首个连接握手完成后模拟掉线 → 触发退避重连
          }
          if (ev === 'close') closeCb = () => cb()
        },
        send: () => {}, close: () => {}, readyState: 1
      }
    }
    const b = new RealBackend({ now: () => Date.now(), wsFactory, reconnectBaseDelayMs: 100 })
    await b.connect({ serverUrl: 'http://x', token: 't' })
    expect(b.getConnectionState().status).toBe('connected')
    await new Promise((resolve) => setTimeout(resolve, 30)) // setTimeout(0) 掉线已触发 → reconnecting(100ms 退避未到)
    expect(b.getConnectionState().status).toBe('reconnecting')
    await new Promise((resolve) => setTimeout(resolve, 150)) // 退避 timer 触发 → ws#1 握手 → connected
    expect(b.getConnectionState().status).toBe('connected')
    await b.disconnect()
  })

  it('unexpected-response(429) → 瞬态走重连退避,不置 error(F3)', async () => {
    const wsFactory = () => ({
      on: (ev: string, cb: (arg?: unknown, arg2?: unknown) => void) => {
        if (ev === 'unexpected-response') {
          setTimeout(() => cb(null, { statusCode: 429 }), 0)
        }
      },
      send: () => {}, close: () => {}, readyState: 0
    })
    const b = new RealBackend({ now: () => Date.now(), wsFactory, reconnectBaseDelayMs: 100 })
    b.connect({ serverUrl: 'http://x', token: 't' }).catch(() => {}) // 不 await:无 server_info,connect promise 悬挂,disconnect 时 reject
    await new Promise((resolve) => setTimeout(resolve, 30)) // 429 → onSocketClosed → reconnecting(100ms 退避未到)
    expect(b.getConnectionState().status).toBe('reconnecting')
    await b.disconnect()
  })

  it('sendMessage 重复 clientRequestId → 旧 pending reject GENERATION_CONFLICT(F7)', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    const first = b.sendMessage({ conversationId: 'conv-1', text: 'hi', clientRequestId: 'c-dup' })
    const second = b.sendMessage({ conversationId: 'conv-1', text: 'hi', clientRequestId: 'c-dup' })
    await expect(first).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    const ref = await second
    expect(ref.clientRequestId).toBe('c-dup')
    await b.disconnect()
  })
})

// REST 用例的 ws mock:on('message') 同步投递握手帧(session + server_info),使 connect 可 resolve(connected 状态)
const fakeWs = () => ({
  on: (ev: string, cb: (arg?: unknown) => void) => {
    if (ev === 'message') {
      cb(Buffer.from(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })))
      cb(Buffer.from(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: 'v', features: {}, services: {}, connectionId: 'conn-1' })))
    }
  },
  send: () => {}, close: () => {}, readyState: 1
})

describe('RealBackend REST 方法', () => {
  function mockFetch(responses: Record<string, unknown>): { fetchImpl: typeof fetch; calls: { url: string; opts: RequestInit }[] } {
    const calls: { url: string; opts: RequestInit }[] = []
    const fetchImpl = async (url: string | URL | Request, opts?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, opts: opts ?? {} })
      const key = Object.keys(responses).find((k) => u.includes(k))
      if (!key) throw new Error(`no mock for ${u}`)
      return new Response(JSON.stringify(responses[key]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return { fetchImpl, calls }
  }

  it('listConversations 透传 limit/cursor + Bearer + 映射', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/sessions': { sessions: [{ conversationId: 'conv-1', title: 't', messageCount: 1, updatedAt: '2026-08-11T00:00:00.000Z', active: true }], has_more: false }
    })
    const b = new RealBackend({ fetchImpl, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.connect({ serverUrl: 'http://test.local', token: 'sk-token' })
    const page = await b.listConversations({ limit: 20 })
    expect(page.items[0]?.id).toBe('conv-1')
    expect(calls[0]?.url).toContain('/api/sessions')
    expect(calls[0]?.url).toContain('limit=20')
    expect((calls[0]?.opts.headers as Record<string, string>).authorization).toBe('Bearer sk-token')
  })

  it('getConversationMessages 透传 before + 400 CONTRACT_VALIDATION → CyreneError', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/sessions/conv-1/messages': { messages: [], has_more: false, total: 0 }
    })
    const b = new RealBackend({ fetchImpl, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.connect({ serverUrl: 'http://test.local', token: 'sk-token' })
    const page = await b.getConversationMessages({ conversationId: 'conv-1', before: '507f1f77bcf86cd799439011' })
    expect(calls[0]?.url).toContain('before=507f1f77bcf86cd799439011')
    expect(page.hasMore).toBe(false)

    const badFetch = async () => new Response(JSON.stringify({ code: 'CONTRACT_VALIDATION', message: '非法游标' }), { status: 400 })
    const b2 = new RealBackend({ fetchImpl: badFetch as never, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b2.connect({ serverUrl: 'http://test.local', token: 't' })
    await expect(b2.getConversationMessages({ conversationId: 'c', before: 'bad' })).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
  })

  it('getConversationMessages 透传 after/limit', async () => {
    const { fetchImpl, calls } = mockFetch({ '/api/sessions/conv-1/messages': { messages: [], has_more: false, total: 0 } })
    const b = new RealBackend({ fetchImpl, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.connect({ serverUrl: 'http://test.local', token: 't' })
    await b.getConversationMessages({ conversationId: 'conv-1', after: '507f1f77bcf86cd799439011', limit: 50 })
    expect(calls[0]?.url).toContain('after=507f1f77bcf86cd799439011')
    expect(calls[0]?.url).toContain('limit=50')
  })

  it('activateConversation → REST activate + WS activate_session', async () => {
    const { fetchImpl, calls } = mockFetch({ '/activate': { activeConversationId: 'conv-2' } })
    const b = new RealBackend({ fetchImpl, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.connect({ serverUrl: 'http://test.local', token: 'sk-token' })
    const r = await b.activateConversation('conv-2')
    expect(r.conversationId).toBe('conv-2')
    expect(calls[0]?.url).toContain('/api/sessions/conv-2/activate')
  })

  it('activateConversation connected → REST 完成即 resolve + WS activate_session 帧已发', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    const r = await b.activateConversation('conv-2')
    expect(r.conversationId).toBe('conv-2')
    await new Promise((resolve) => setTimeout(resolve, 50)) // ws.send fire-and-forget,等伪后端收帧
    expect(receivedClientFrames).toContain('activate_session')
    await b.disconnect()
  })

  it('REST 方法 connect 前调用 → NOT_CONNECTED guard(F1)', async () => {
    const b = new RealBackend({ now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.setToken('t')
    await expect(b.listConversations({ limit: 20 })).rejects.toMatchObject({ code: CyreneErrorCode.NOT_CONNECTED })
  })
})
