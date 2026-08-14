// tests/unit/real-backend-search.spec.ts
// Task 7:RealBackend 历史/上下文/表情 REST 映射（spec §4.3/§4.4，D2/D8）+ sendMessage wire stickerId。
// env=node：同一 http server 挂真实 WebSocketServer({path:'/ws'}) 握手 stub（既有惯例，避免 60s 挂起）。
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import { describe, expect, it } from 'vitest'
import { RealBackend } from '../../src/main/transport/real-backend'

/** 断言 search/context/stickers 请求参数后返回对应响应 */
function apiServer(opts: { onSearch?: (url: string) => void; onContext?: (url: string) => void; onStickers?: () => void }): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const send = (body: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.url?.startsWith('/api/search/messages')) {
        opts.onSearch?.(req.url)
        send({ items: [{ conversationId: 'c1', messageId: 'm1', timestamp: '2026-08-14T02:00:00.000Z', role: 'user', snippet: '命中' }], has_more: false })
      } else if (req.url?.startsWith('/api/messages/m1/context')) {
        opts.onContext?.(req.url)
        send({ anchor: { role: 'user', message_id: 'm1', timestamp: '2026-08-14T02:00:02.000Z' }, before: [{ role: 'user', message_id: 'm0', timestamp: '2026-08-14T02:00:01.000Z' }], after: [], conversationId: 'c1' })
      } else if (req.url === '/api/stickers') {
        opts.onStickers?.()
        send({ stickers: [{ stickerId: 'st_1', src: '/static/stickers/st_1.png' }] })
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

describe('RealBackend.queryChatHistory（spec §4.3/§4.4）', () => {
  it('URL 参数：query/conversationId/date_from 半开区间/timezone/category/cursor/limit', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onSearch: (u) => seen.push(u) })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.queryChatHistory({
        scope: { type: 'conversation', conversationId: 'c1' },
        query: '关键词', localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'sticker', limit: 50
      })
      expect(seen[0]).toContain('query=%E5%85%B3%E9%94%AE%E8%AF%8D')
      expect(seen[0]).toContain('conversationId=c1')
      expect(seen[0]).toContain('date_from=2026-08-13T16%3A00%3A00.000Z')   // 上海 UTC+8 本地日 → 前一日 16:00Z
      expect(seen[0]).toContain('date_to=2026-08-14T16%3A00%3A00.000Z')
      expect(seen[0]).toContain('timezone=Asia%2FShanghai')
      expect(seen[0]).toContain('category=sticker')
      expect(seen[0]).toContain('limit=50')
      expect(page.items[0]).toMatchObject({ messageId: 'm1', snippet: '命中' })   // P0-1：search item 仅文本，无 resource
      expect(page.items[0].resource).toBeUndefined()
      await backend.disconnect()
    } finally { close() }
  })
  it('scope=all 不传 conversationId；无 localDate 不传 date_from/date_to', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onSearch: (u) => seen.push(u) })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
      expect(seen[0]).not.toContain('conversationId=')
      expect(seen[0]).not.toContain('date_from=')
      await backend.disconnect()
    } finally { close() }
  })
})

describe('RealBackend.getMessageContext（spec §4.5）', () => {
  it('URL 参数 + MessagePage 归一化（before+anchor+after 合并稳定排序）', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onContext: (u) => seen.push(u) })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.getMessageContext({ conversationId: 'c1', messageId: 'm1', before: 5, after: 5 })
      expect(seen[0]).toContain('conversationId=c1')
      expect(seen[0]).toContain('before=5')
      expect(seen[0]).toContain('after=5')
      expect(page.items.map((m) => m.messageId)).toEqual(['m0', 'm1'])
      expect(page.hasMore).toBe(false)
      await backend.disconnect()
    } finally { close() }
  })
})

describe('RealBackend.listStickers（D8）', () => {
  it('GET /api/stickers → StickerManifest', async () => {
    const { port, close } = await apiServer({})
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const manifest = await backend.listStickers()
      expect(manifest.stickers[0]).toEqual({ stickerId: 'st_1', src: '/static/stickers/st_1.png' })   // P0-2
      await backend.disconnect()
    } finally { close() }
  })
})

describe('RealBackend.sendMessage wire stickerId（D8）', () => {
  it('payload 带 stickerId（content 可空）', async () => {
    const payloads: Array<Record<string, unknown>> = []
    const s = createServer(() => {})
    const wss = new WebSocketServer({ server: s, path: '/ws' })
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
      ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
      ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'text') {
          payloads.push(parsed)
          ws.send(JSON.stringify({ type: 'user_message.ack', status: 'accepted', messageId: 'm9', clientRequestId: parsed.clientRequestId, receivedAt: '2026-08-14T04:00:00.000Z' }))
        }
      })
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as AddressInfo).port
    try {
      const backend = new RealBackend({ now: () => Date.now(), ackTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.sendMessage({ conversationId: 'c1', text: '', clientRequestId: 'cr1', stickerId: 'st_1' })
      expect(payloads[0]).toMatchObject({ type: 'text', conversationId: 'c1', clientRequestId: 'cr1', stickerId: 'st_1' })
      await backend.disconnect()
    } finally { wss.close(); s.close() }
  })
})
