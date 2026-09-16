// tests/unit/real-backend-liveness.spec.ts
//
// 2026-09-16 审计 P1-3 / 立项 AUD-01（方案 B）：接线层的判别性用例。
//
// 纯模块的行为已由 `connection-liveness.spec.ts` 确定性覆盖；本 spec 只验**接线**是否真的成立。
// 两种承载各司其职：
//   · 真实 `http` + `WebSocketServer`（前 5 条）——最贴近生产的静默挂起形态；
//   · 假 socket（最后 1 条）——专门构造"本地 close() 得不到对端确认"的真 half-open，
//     真实 ws 在该场景下无法构造（服务端可达时 close 会正常完成）。
//
// ⚠️ 断言口径（本轮实测踩过一次）：**不能轮询 `getConnectionState().status` 去等 `reconnecting`**。
// 判死会立刻走既有退避重连，而真实夹具的重连是"立即成功"的（`reconnectBaseDelayMs=10` 且服务端照常握手），
// 于是 `reconnecting` 只存在几毫秒——轮询会完全错过它，让用例假红。故一律用 `onConnectionStateChange`
// **记录每一次跃迁**（不丢事件），再配"服务端是否被重连了一次"作交叉证据。
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { RealBackend, type WebSocketLike } from '../../src/main/transport/real-backend'
import { LIVENESS_REQUEST_GRACE_MS } from '../../src/main/transport/connection-liveness'
import type { ConnectionState } from '@shared/contracts/backend'

let server: Server
let wss: WebSocketServer
let port: number
/** 每次 ws 连接计数：判死 → 重连成功会让它 +1，是"确实走过重连"的交叉证据 */
let wsConnections = 0
let clientFrames = 0
/** 该连接是否持续推帧（模拟"后端正常流式输出"）。默认 false = 完全静默。 */
let streamingMode = false

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')   // 所有 REST（含探针 /api/me）都应答 ⇒ 宿主"可达"
  })
  wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws) => {
    wsConnections += 1
    clientFrames = 0
    streamingMode = false   // 每个新连接都从"静默"开始，由各用例显式打开
    // 握手：只发 server_info（让 connect/reconnect 能 settle），此后**一个字节都不主动发**
    ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: `conn-${wsConnections}` }))
    ws.on('message', () => { clientFrames += 1 })   // 收但不回——静默挂起
    const stream = setInterval(() => {
      if (!streamingMode) return
      try { ws.send(JSON.stringify({ type: 'state', state: 'thinking' })) } catch { /* 连接已关 */ }
    }, 200)
    ws.on('close', () => clearInterval(stream))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => { wss.close(); server.close() })

function makeBackend(extra: { logger?: { warn: (m: string, e?: Record<string, unknown>) => void } } = {}) {
  let t = 5_000_000
  const states: ConnectionState['status'][] = []
  const fetchCalls: string[] = []
  const backend = new RealBackend({
    now: () => t,
    reconnectBaseDelayMs: 10,
    random: () => 1,   // 全抖动口径：固定随机源让退避确定
    // 探针也走这里：既能判"宿主可达"，又能数出探针发了几次
    fetchImpl: async (url: unknown) => {
      fetchCalls.push(String(url))
      return new Response('{}', { status: 200 })
    },
    onConnectionStateChange: (s) => states.push(s.status),
    ...extra
  })
  return { backend, states, fetchCalls, advance: (ms: number) => { t += ms } }
}

async function waitFor(cond: () => boolean, timeoutMs = 8_000, what = ''): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitFor 超时：${what}`)
}

describe('RealBackend 存活检测接线（AUD-01）', () => {
  it('服务端静默 + 有在途请求未回执 ⇒ 判定该 socket 失效，走既有重连（不再停在假 connected）', async () => {
    const { backend, states, fetchCalls, advance } = makeBackend()
    await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tk' })
    expect(backend.getConnectionState().status).toBe('connected')

    // 发一条消息 → 注册 pendingAck；服务端收下但**永不回 ack**
    void backend.sendMessage({ conversationId: 'conv-1', text: '你好', clientRequestId: 'c-live' }).catch(() => { /* 收敛时被 reject */ })
    await waitFor(() => clientFrames > 0, 8_000, '服务端还没收到消息帧')
    expect(backend.getConnectionState().status, '发送后仍显示已连接——这正是缺陷的用户可见形态').toBe('connected')

    advance(LIVENESS_REQUEST_GRACE_MS + 1_000)   // 越过宽限期；真实 interval 会在下一 tick 命中
    await waitFor(() => states.includes('reconnecting'), 8_000, '未进入 reconnecting')

    await waitFor(() => wsConnections >= 2, 8_000, '未重新建立 socket')
    expect(fetchCalls.some((u) => u.endsWith('/api/me')), '探针确实发出过').toBe(true)
    await backend.disconnect()
  })

  it('服务端静默但**无在途请求**且宿主可达 ⇒ 不重连（空闲不是故障，避免连接抖动）', async () => {
    const { backend, states, fetchCalls, advance } = makeBackend()
    await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tk' })
    const connectionsAfterConnect = wsConnections

    // 不发任何东西 ⇒ outstanding = 0。推 30 倍宽限期，宿主可达 ⇒ 空闲分支什么都不做。
    advance(LIVENESS_REQUEST_GRACE_MS * 30)
    await new Promise((r) => setTimeout(r, 4_500))   // 真实等 ≥2 个 tick

    expect(fetchCalls.length, '空闲期仍会探测（用于发现宿主已死）').toBeGreaterThan(0)
    expect(states, '空闲 + 宿主可达绝不能触发重连').not.toContain('reconnecting')
    expect(wsConnections, 'socket 不得被重建').toBe(connectionsAfterConnect)
    await backend.disconnect()
  })

  it('后端持续推帧（但始终不回 ack）⇒ 绝不判死：静默必须被每一帧重置', async () => {
    // 这条专钉**接线层的 `noteFrame()`**：若它没接上，`lastFrame` 会停在建连时刻，
    // 于是一个正在正常流式输出的连接会在宽限期一到就被判死并重连——比原缺陷更糟。
    // 纯模块层的同名用例盖不到这一点（它直接调 noteFrame，验的是模块自己）。
    const { backend, states, advance } = makeBackend()
    await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tk' })
    streamingMode = true   // 服务端开始每 200ms 推一个 state 帧

    // 有在途请求（永远不回 ack）+ 注入时钟推过宽限期：只有"帧会重置静默"才不会被判死
    void backend.sendMessage({ conversationId: 'conv-1', text: '你好', clientRequestId: 'c-stream' }).catch(() => { /* never */ })
    await waitFor(() => clientFrames > 0, 8_000, '服务端还没收到消息帧')
    advance(LIVENESS_REQUEST_GRACE_MS + 5_000)
    await new Promise((r) => setTimeout(r, 3_000))   // 真实等 ≥1 个 tick，期间持续有帧到达

    expect(states, '正在流式输出的连接不得被判死').not.toContain('reconnecting')
    await backend.disconnect()
  })

  it('显式断开后检测表停摆：不得对已退役的 socket 判死并翻回重连', async () => {
    const { backend, states, fetchCalls, advance } = makeBackend()
    await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tk' })
    await backend.disconnect()
    expect(backend.getConnectionState().status).toBe('disconnected')
    const statesAtDisconnect = [...states]
    const probesAtDisconnect = fetchCalls.length

    advance(LIVENESS_REQUEST_GRACE_MS * 30)
    await new Promise((r) => setTimeout(r, 2_500))

    expect(backend.getConnectionState().status).toBe('disconnected')
    expect(states, '断开后不得再产生任何状态跃迁').toEqual(statesAtDisconnect)
    expect(fetchCalls.length, '断开后不得继续发探针').toBe(probesAtDisconnect)
  })

  it('判定失活时留一条可诊断的 warn（现场要能区分"连接被判失效"与"用户主动断开"）', async () => {
    const warn = vi.fn()
    const { backend, states, advance } = makeBackend({ logger: { warn } })
    await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tk' })
    void backend.sendMessage({ conversationId: 'conv-1', text: 'x', clientRequestId: 'c-live2' }).catch(() => { /* 见上 */ })
    await waitFor(() => clientFrames > 0, 8_000, '服务端还没收到消息帧')

    advance(LIVENESS_REQUEST_GRACE_MS + 1_000)
    await waitFor(() => states.includes('reconnecting'), 8_000, '未进入 reconnecting')

    expect(warn.mock.calls.map((c) => String(c[0]))).toContain('liveness:dead')
    await backend.disconnect()
  })

  it('真 half-open：本地 close() 得不到对端确认时仍必须收敛（不能只依赖 close 事件）', async () => {
    // 为什么必须单独测：前面几条的真实服务端是**可达**的，`ws.close()` 会正常走完关闭握手并触发 `close`，
    // 于是「handleLivenessDeath 里直接调 onSocketClosed」与「只靠 ws.close()」在断言上无法区分。
    // 但真正的 half-open 里 close 帧发进虚空，ws 库要等自己的 closeTimeout（默认 30s）才报关闭——
    // 只靠 close() 会把收敛拖后 30s。本用例的 fake socket 的 close() **故意不触发任何事件**。
    type Handler = (arg?: unknown, arg2?: unknown) => void
    type HandlerSet = Partial<Record<'open' | 'message' | 'close' | 'error' | 'unexpected-response', Handler>>
    const handlers: HandlerSet[] = []
    const sockets: WebSocketLike[] = []
    const wsFactory = (): WebSocketLike => {
      const current: HandlerSet = {}
      handlers.push(current)
      const ws: WebSocketLike = {
        on: (event, callback) => { current[event] = callback },
        send: vi.fn(),
        close: vi.fn(),          // 关键：什么都不做，永不触发 close/error
        readyState: 1
      }
      sockets.push(ws)
      return ws
    }
    let t = 5_000_000
    const states: ConnectionState['status'][] = []
    const backend = new RealBackend({
      now: () => t,
      wsFactory,
      fetchImpl: async () => new Response('{}', { status: 200 }),   // 宿主"可达"
      reconnectBaseDelayMs: 10,
      random: () => 1,
      onConnectionStateChange: (s) => states.push(s.status)
    })

    const connecting = backend.connect({ serverUrl: 'http://silent.example', token: 'tk' })
    expect(sockets).toHaveLength(1)
    handlers[0].message?.(Buffer.from(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: 'v', features: {}, services: {}, connectionId: 'c-half' })))
    await connecting
    expect(backend.getConnectionState().status).toBe('connected')

    void backend.sendMessage({ conversationId: 'conv-1', text: 'x', clientRequestId: 'c-half' }).catch(() => { /* never settles */ })
    t += LIVENESS_REQUEST_GRACE_MS + 1_000
    await waitFor(() => states.includes('reconnecting'), 8_000, 'close() 不报关闭时未能收敛')

    expect(sockets[0].close, '本地 close 仍应尽力调用（释放 fd）').toHaveBeenCalled()
    await backend.disconnect()
  })
})
