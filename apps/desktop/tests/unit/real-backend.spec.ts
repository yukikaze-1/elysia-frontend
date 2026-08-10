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
  server = createServer((_req, res) => {
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
})
