import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { WebSocketServer } from 'ws'
import { AddressInfo } from 'net'
import { RealBackend, type RealBackendOptions } from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { CyreneErrorCode } from '@shared/errors'
import type { UploadContent } from '../../src/main/transport/backend-adapter'

let server: Server
let wss: WebSocketServer
let authServer: Server
let port: number
let authPort: number
let receivedHeaders: Record<string, string> = {}
let receivedClientFrames: string[] = []
let receivedClientPayloads: Record<string, unknown>[] = []   // M1：完整载荷（tool.status 形状断言）

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
    receivedClientPayloads = []
    for (const k of Object.keys(req.headers)) receivedHeaders[k.toLowerCase()] = String(req.headers[k] ?? '')
    ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
    ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
    ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
    ws.send(JSON.stringify({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-g', conversationId: 'conv-1', model: 'm1' }))
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data))
      receivedClientFrames.push(frame.type)
      receivedClientPayloads.push(frame)
      if (frame.type === 'text') {
        if (frame.clientRequestId === 'c-timeout') return // 不发 ack → 触发超时
        if (frame.clientRequestId === 'r1') { // rejected + 空 messageId + QUEUE_FULL（即时结构化）
          ws.send(JSON.stringify({ type: 'user_message.ack', messageId: '', clientRequestId: frame.clientRequestId, receivedAt: '2026-08-11T00:00:00.000Z', status: 'rejected', error: { code: 'QUEUE_FULL', message: '队列已满', retryable: true, retryAfterMs: 1000, details: { idempotency_durable: false } } }))
          return
        }
        if (frame.clientRequestId === 'r2') { // rejected 缺 error（走退化分支）
          ws.send(JSON.stringify({ type: 'user_message.ack', messageId: '', clientRequestId: frame.clientRequestId, receivedAt: '2026-08-11T00:00:00.000Z', status: 'rejected' }))
          return
        }
        const ok = frame.clientRequestId === 'c-reject'
          ? { status: 'rejected', error: { code: 'CONTRACT_VALIDATION', message: 'bad', retryable: false } }
          : frame.clientRequestId === 'c-error'
            ? (ws.send(JSON.stringify({ type: 'error', message: '限流', code: 'RATE_LIMITED', requestId: 'req-1', clientRequestId: frame.clientRequestId, retryable: true, retryAfterMs: 1200, details: { scope: 'command' } })), { status: 'accepted' })
            : { status: 'accepted' }
        ws.send(JSON.stringify({ type: 'user_message.ack', messageId: ok.status === 'rejected' ? '' : 'msg-ack', clientRequestId: frame.clientRequestId, receivedAt: '2026-08-11T00:00:00.000Z', ...ok }))
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

/** T2 夹具:内联 { now, wsFactory }(无 baseOpts);测试覆盖 wsFactory/handshakeTimeoutMs 等 */
function makeOpts(o: Partial<RealBackendOptions> = {}): RealBackendOptions {
  return { now: () => Date.now(), wsFactory: () => fakeWs(), ...o }
}

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

  it('默认连接不协商 permessage-deflate，避免 aiohttp 保留位帧兼容性故障', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    expect(receivedHeaders['sec-websocket-extensions']).toBeUndefined()
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

  it('rejected ACK（空 messageId + QUEUE_FULL）→ BACKEND_REJECTED + backendCode/retryable 保留（不超时）', async () => {
    const b = new RealBackend({ now: () => Date.now(), ackTimeoutMs: 200 })
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    try {
      await b.sendMessage({ conversationId: 'conv-1', text: 'x', clientRequestId: 'r1' })
      expect.unreachable()
    } catch (e: unknown) {
      const err = e as { code?: string; details?: { backendCode?: string; retryable?: boolean; retryAfterMs?: number; idempotencyDurable?: boolean; backendDetails?: unknown } }
      expect(err.code).toBe(CyreneErrorCode.BACKEND_REJECTED)
      expect(err.details?.backendCode).toBe('QUEUE_FULL')
      expect(err.details?.retryable).toBe(true)
      expect(err.details?.retryAfterMs).toBe(1000)
      expect(err.details?.idempotencyDurable).toBe(false)
      expect(err.details?.backendDetails).toEqual({ idempotency_durable: false })
    }
    await b.disconnect()
  })

  it('非法 rejected ACK 缺 error → raw 层丢弃，pending 按 TIMEOUT 收口', async () => {
    const b = new RealBackend({ now: () => Date.now(), ackTimeoutMs: 30 })
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await expect(b.sendMessage({ conversationId: 'conv-1', text: 'x', clientRequestId: 'r2' }))
      .rejects.toMatchObject({ code: CyreneErrorCode.TIMEOUT })
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
    expect(errs[0]).toMatchObject({
      details: {
        code: 'RATE_LIMITED', requestId: 'req-1', clientRequestId: 'c-error',
        retryable: true, retryAfterMs: 1200, backendDetails: { scope: 'command' }
      }
    })
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

  // —— T2:握手超时 + connect 清旧 timer ——
  it('握手超时:建连但不发 server_info → connect reject TIMEOUT + state error', async () => {
    const noFrameWs = () => ({ // 只触发 open,不推任何帧 → 握手永远不完成
      on: (ev: string, cb: (arg?: unknown) => void) => { if (ev === 'open') cb() },
      send: () => {}, close: () => {}, readyState: 1
    })
    const b = new RealBackend(makeOpts({ handshakeTimeoutMs: 20, wsFactory: noFrameWs }))
    const p = b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })
    await expect(p).rejects.toMatchObject({ code: CyreneErrorCode.TIMEOUT })
    expect(b.getConnectionState().status).toBe('error')
  })

  it('正常 server_info 到达 → 握手 timer 清除,不超时(I3 正向)', async () => {
    const b = new RealBackend(makeOpts({ handshakeTimeoutMs: 50 }))
    await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' }) // fakeWs 同步推 session + server_info → resolve
    expect(b.getConnectionState().status).toBe('connected')
    await b.disconnect()
  })

  it('disconnect 清除握手 timer,不再触发超时回调', async () => {
    const noFrameWs = () => ({
      on: (ev: string, cb: (arg?: unknown) => void) => { if (ev === 'open') cb() },
      send: () => {}, close: () => {}, readyState: 1
    })
    const b = new RealBackend(makeOpts({ handshakeTimeoutMs: 200, wsFactory: noFrameWs }))
    const p = b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })
    await b.disconnect()
    await expect(p).rejects.toMatchObject({ code: CyreneErrorCode.NOT_CONNECTED }) // 由 disconnect 取消,非 TIMEOUT
  })

  it('重连挂起时手动 connect 清旧 reconnect/handshake timer(无双 socket)', async () => {
    let wsCreateCount = 0
    const b = new RealBackend(makeOpts({
      wsFactory: () => {
        wsCreateCount++
        const id = wsCreateCount
        return {
          on: (ev: string, cb: (arg?: unknown) => void) => {
            if (ev === 'message') {
              cb(Buffer.from(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })))
              cb(Buffer.from(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: 'v', features: {}, services: {}, connectionId: `conn-${id}` })))
            }
            if (ev === 'close' && id === 1) setTimeout(() => cb(), 0) // 首个 socket 握手完成后掉线 → 进入退避重连
          },
          send: () => {}, close: () => {}, readyState: 1
        }
      },
      reconnectBaseDelayMs: 30, // 缩短退避:让旧 reconnectTimer 先排好,若未被清则会二次建 socket
      handshakeTimeoutMs: 100
    }))
    await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' }) // #1 握手成功
    expect(wsCreateCount).toBe(1)
    await new Promise((r) => setTimeout(r, 15)) // close 已触发 → reconnecting,旧 reconnectTimer(30ms)已排
    expect(b.getConnectionState().status).toBe('reconnecting')
    await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' }) // 手动 connect:清旧 reconnect/handshake timer → 只建 #2
    expect(wsCreateCount).toBe(2)
    await new Promise((r) => setTimeout(r, 60)) // 越过旧 reconnectTimer 截止点:未被清则会再建 #3
    expect(wsCreateCount).toBe(2)
    expect(b.getConnectionState().status).toBe('connected')
    await b.disconnect()
  })

  it('state/typing 帧不 emit、不 warn、不断连（FE-INT-P1-01）', async () => {
    const warnings: ProtocolWarning[] = []
    const b = new RealBackend({ now: () => Date.now(), onProtocolWarning: (w) => warnings.push(w) })
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    const events: BackendEvent[] = []
    const unsub = b.subscribe((e) => events.push(e))
    const send = (payload: unknown) => { wss.clients.forEach((c) => c.send(JSON.stringify(payload))) }
    send({ type: 'state', state: 'thinking' })
    send({ type: 'typing', typing: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toEqual([]) // 不 emit
    expect(warnings).toEqual([]) // 不 warn
    expect(b.getConnectionState().status).toBe('connected') // 不断连
    unsub()
    await b.disconnect()
  })
  it('未知 type 帧仍 RAW_FRAME_INVALID warn（fail-closed）', async () => {
    const warnings: ProtocolWarning[] = []
    const b = new RealBackend({ now: () => Date.now(), onProtocolWarning: (w) => warnings.push(w) })
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    wss.clients.forEach((c) => c.send(JSON.stringify({ type: 'totally_unknown' })))
    await new Promise((r) => setTimeout(r, 50))
    expect(warnings.map((w) => w.code)).toEqual(['RAW_FRAME_INVALID'])
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

// T3:abort-aware fetch 挂起直到 signal abort(真实实现靠它触发 TIMEOUT/disconnect 取消)
const abortAwareFetch = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
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

  // —— T3:REST 超时 + AbortController + disconnect abort ——
  it('REST 超时:fetchImpl 挂起且 abort-aware → TIMEOUT', async () => {
    const b = new RealBackend(makeOpts({ fetchImpl: abortAwareFetch as never, restTimeoutMs: 20 }))
    await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })
    await expect(b.listConversations({})).rejects.toMatchObject({ code: CyreneErrorCode.TIMEOUT })
  })

  it('disconnect 主动 abort → NOT_CONNECTED 而非 TIMEOUT', async () => {
    const b = new RealBackend(makeOpts({ fetchImpl: abortAwareFetch as never, restTimeoutMs: 10000 }))
    await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })
    const p = b.listConversations({})   // 挂起
    await b.disconnect()                // abort 全部 activeControllers
    await expect(p).rejects.toMatchObject({ code: CyreneErrorCode.NOT_CONNECTED })
  })
})

describe('RealBackend uploadAttachments / signAttachmentUrl（spec §4.5/§3.2）', () => {
  // P1-3：既有惯例（real-backend.spec.ts 同款）——同一 http server 上挂真实 WebSocketServer({path:'/ws'}) 握手 stub，
  // 使 backend.connect 在 server_info 后 resolve；否则普通 http server 对 /ws 返 404 → 重连退避 ~61s 挂起。
  function uploadServer(handler: (req: import('http').IncomingMessage, chunks: Buffer[]) => void): Promise<{ port: number; close(): void }> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => handler(req, chunks))
        if (req.url === '/api/uploads') {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ attachments: [{ attachmentId: 'att_up1', kind: 'image', mime: 'image/png', size: 2, url: '/api/attachments/att_up1', filename: 'a.png' }] }))
          }, 5)
        } else if (req.url === '/api/attachments/att_up1/sign') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ attachmentId: 'att_up1', url: 'https://cdn.example/att_up1?sig=abc&exp=2030-01-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00.000Z' }))
        } else { res.writeHead(404); res.end() }
      })
      const wss = new WebSocketServer({ server: s, path: '/ws' })
      wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
        ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
        ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
      })
      s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as AddressInfo).port, close: () => { wss.close(); s.close() } }))
    })
  }

  it('multipart POST /api/uploads（每文件 kind + bytes 型），响应映射 AttachmentInfo', async () => {
    const { port, close } = await uploadServer((req, chunks) => {
      expect(req.method).toBe('POST')
      expect(req.url).toBe('/api/uploads')
      expect(req.headers['content-type']).toMatch(/multipart\/form-data; boundary=/)
      expect(req.headers['content-type']).not.toMatch(/application\/json/)
      const body = Buffer.concat(chunks).toString('utf8')
      expect(body).toContain('name="files"')
      expect(body).toContain('filename="a.png"')
      expect(body).toContain('name="kind"')
      expect(body).toContain('image')   // 每文件 kind 提示值
    })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const files: UploadContent[] = [{ name: 'a.png', mediaType: 'image/png', size: 2, kind: 'image', bytes: new Uint8Array([0x89, 0x50]) }]
      const infos = await backend.uploadAttachments(files)
      expect(infos).toEqual([{ attachmentId: 'att_up1', kind: 'image', mime: 'image/png', size: 2, url: '/api/attachments/att_up1', filename: 'a.png' }])
      await backend.disconnect()
    } finally { close() }
  })

  it('signAttachmentUrl 带 Bearer 调 /sign 解析 AttachmentSignResult', async () => {
    const { port, close } = await uploadServer((_req, _chunks) => {})
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const r = await backend.signAttachmentUrl('att_up1')
      expect(r.url).toContain('sig=abc')
      expect(r.expiresAt).toBe('2030-01-01T00:00:00.000Z')
      await backend.disconnect()
    } finally { close() }
  })

  it('opts.signal 已中止 → 上传立即 reject（取消经 signal 接入，P1-1）', async () => {
    const { port, close } = await uploadServer((_req, _chunks) => {})
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const controller = new AbortController()
      controller.abort()   // 预中止：AbortSignal.any 组合后 fetch 立即 abort → catch 走取消分支
      const files: UploadContent[] = [{ name: 'a.png', mediaType: 'image/png', size: 2, bytes: new Uint8Array([0x89, 0x50]) }]
      await expect(backend.uploadAttachments(files, { signal: controller.signal })).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
      await backend.disconnect()
    } finally { close() }
  })
})

describe('RealBackend 工具接线（Task 6，M1 补直测）', () => {
  it('tool.request 帧 → onToolRequest 收到 DesktopToolRequest（含 paramHash/arguments/expiresAt）+ 不再 emit 事件', async () => {
    const toolServer = createServer()
    const toolWss = new WebSocketServer({ server: toolServer, path: '/ws' })
    await new Promise<void>((resolve) => toolServer.listen(0, '127.0.0.1', resolve))
    const toolPort = (toolServer.address() as AddressInfo).port
    toolWss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-tool' }))
      ws.send(JSON.stringify({ type: 'tool.request', callId: 'call_real_1', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', sourceCallId: 'tc_real_1', arguments: { path: '/tmp/x.txt' }, reason: 'r', riskLevel: 'medium', permissionRequired: true, approvalAuthority: 'client', paramHash: 'a'.repeat(64), expiresAt: '2026-08-20T00:00:00.000Z', requestId: 'req-1' }))
    })
    const events: BackendEvent[] = []
    const requests: unknown[] = []
    const b = new RealBackend({ now: () => Date.now() })
    b.subscribe((e) => events.push(e))
    b.onToolRequest = (req) => requests.push(req)
    await b.connect({ serverUrl: `http://127.0.0.1:${toolPort}`, token: 'sk-test' })
    await new Promise((r) => setTimeout(r, 50))   // 帧处理异步
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ callId: 'call_real_1', sourceCallId: 'tc_real_1', toolName: 'desktop.file.read', runtime: 'desktop', arguments: { path: '/tmp/x.txt' }, paramHash: 'a'.repeat(64) })
    expect((requests[0] as { expiresAt: number }).expiresAt).toBe(Date.parse('2026-08-20T00:00:00.000Z'))
    expect(events.some((e) => e.event === 'tool.request')).toBe(false)   // D6B-08：不再 emit 给 renderer
    await b.disconnect()
    toolWss.close(); toolServer.close()
  })

  it('submitToolResult → wire 发送 tool.status 帧（六态 + runtime str + paramHash 原样）', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await b.submitToolResult({ callId: 'call_1', status: 'result', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'a'.repeat(64), output: 'ok' })
    await new Promise((r) => setTimeout(r, 50))   // WS 消息异步送达
    expect(receivedClientFrames).toContain('tool.status')
    const payload = receivedClientPayloads.find((p) => p['type'] === 'tool.status')
    expect(payload).toMatchObject({ callId: 'call_1', status: 'result', toolName: 'desktop.file.read', runtime: 'desktop', paramHash: 'a'.repeat(64), output: 'ok' })
    await b.disconnect()
  })
})
