// tests/unit/real-backend-search.spec.ts
// Task 7:RealBackend 历史/上下文/表情 REST 映射（spec §4.3/§4.4，D2/D8）+ sendMessage wire stickerId。
// env=node：同一 http server 挂真实 WebSocketServer({path:'/ws'}) 握手 stub（既有惯例，避免 60s 挂起）。
import { createServer } from 'http'
import { WebSocketServer, type RawData } from 'ws'
import type { AddressInfo } from 'net'
import { describe, expect, it } from 'vitest'
import { RealBackend } from '../../src/main/transport/real-backend'
import { CyreneErrorCode } from '../../src/shared/errors'

/** ws 文本帧 → utf8 文本：RawData 是 Buffer | ArrayBuffer | Buffer[]，只有 Buffer（及 Buffer[]）能按 utf8 解码。 */
function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/** 解析客户端 → 服务器 WS 帧为 JSON 对象（帧形状由后端契约保证；非 JSON 对象直接抛错，不静默吞帧）。 */
function parseClientFrame(data: RawData): Record<string, unknown> {
  const parsed: unknown = JSON.parse(rawDataToText(data))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('客户端帧不是 JSON 对象')
  return { ...parsed }
}

/** 断言 search/context/stickers 请求参数后返回对应响应
 *
 *  `Connection: close`（2026-09-13）：本文件每个用例起一台夹具 server 再关掉，而 Node 的 fetch（undici）
 *  的**连接池是进程级全局的**——池里可能留着上一台（已关闭的）夹具 server 的 keep-alive 连接；
 *  在重负载下 OS 复用同一临时端口时，新请求就可能落在那条死连接上并失败（表现为
 *  `无法连接后端：网络请求失败`，且与超时无关：把 `restTimeoutMs` 提到 30s 无效）。
 *  让夹具显式要求关闭连接，池里就不会留下跨用例/跨文件的条目。**断言未改、夹具语义未改**。 */
function apiServer(opts: { onSearch?: (url: string) => void; onContext?: (url: string) => void; onStickers?: () => void; searchBody?: (url: string) => unknown }): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const send = (body: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify(body)) }
      if (req.url?.startsWith('/api/search/messages')) {
        opts.onSearch?.(req.url)
        send(opts.searchBody ? opts.searchBody(req.url) : { items: [{ conversationId: 'c1', messageId: 'm1', timestamp: '2026-08-14T02:00:00.000Z', role: 'user', snippet: '命中' }], has_more: false })
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

const REST_TIMEOUT_MS = 30_000

/**
 * 本文件所有用例都打在**本机夹具 HTTP server** 上（`listen(0)` 起的临时端口）。
 *
 * 为什么显式给 `restTimeoutMs`（2026-09-13 实测）：产品默认 10s（`real-backend.ts:151`，**本轮未改产品值**），
 * 而"全量单测连跑 + 并行负载"下这条**本机请求**会因为事件循环被挤压而撞上 10s 预算，
 * 报成 `无法连接后端：网络请求失败`（`restFetch` 的 abort 分支）——红的用例与超时语义毫无关系。
 * 夹具是本机的、且本文件没有用例在测"默认 10s 生效"，故给足预算；**断言一字未改**。
 */
function makeBackend(extra: Record<string, unknown> = {}): RealBackend {
  return new RealBackend({ now: () => Date.now(), restTimeoutMs: REST_TIMEOUT_MS, ...extra })
}

describe('RealBackend.queryChatHistory（spec §4.3/§4.4）', () => {
  it('URL 参数：query/conversationId/date_from 自然日/timezone/category/cursor/limit', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onSearch: (u) => seen.push(u) })
    try {
      const backend = makeBackend()
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.queryChatHistory({
        scope: { type: 'conversation', conversationId: 'c1' },
        query: '关键词', localDate: '2026-08-14', timeZone: 'Asia/Shanghai', category: 'sticker', limit: 50
      })
      expect(seen[0]).toContain('query=%E5%85%B3%E9%94%AE%E8%AF%8D')
      expect(seen[0]).toContain('conversationId=c1')
      expect(seen[0]).toContain('date_from=2026-08-14&date_to=2026-08-14')   // 自然日契约（P0-01：连续参数对，杜绝 T 后缀回归；URLSearchParams 保序）
      expect(seen[0]).toContain('timezone=Asia%2FShanghai')
      expect(seen[0]).toContain('category=sticker')
      expect(seen[0]).toContain('limit=50')
      expect(page.items[0]).toMatchObject({ messageId: 'm1', snippet: '命中' })   // P0-1：search item 仅文本，无 resource
      expect(page.items[0].resource).toBeUndefined()
      await backend.disconnect()
    } finally { close() }
  })
  it('DST 时区（America/New_York）：date_from/date_to 仍为自然日，不随时区变化', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onSearch: (u) => seen.push(u) })
    try {
      const backend = makeBackend()
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.queryChatHistory({ scope: { type: 'all_conversations' }, localDate: '2026-01-15', timeZone: 'America/New_York', category: 'all', limit: 50 })
      expect(seen[0]).toContain('date_from=2026-01-15&date_to=2026-01-15')
      expect(seen[0]).toContain('timezone=America%2FNew_York')
      await backend.disconnect()
    } finally { close() }
  })
  it('scope=all 不传 conversationId；无 localDate 不传 date_from/date_to', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onSearch: (u) => seen.push(u) })
    try {
      const backend = makeBackend()
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'all', limit: 50 })
      expect(seen[0]).not.toContain('conversationId=')
      expect(seen[0]).not.toContain('date_from=')
      await backend.disconnect()
    } finally { close() }
  })
  it('单流（all）首屏按 sortKey 升序：后端 DESC [newer, older] → 领域 [older, newer]；cursor 原样（P1-01 §6.4）', async () => {
    const { port, close } = await apiServer({
      searchBody: () => ({
        items: [
          { conversationId: 'c1', messageId: 'm2', timestamp: '2026-08-14T02:00:02.000Z', role: 'user', snippet: '新' },
          { conversationId: 'c1', messageId: 'm1', timestamp: '2026-08-14T02:00:01.000Z', role: 'user', snippet: '旧' }
        ],
        has_more: true, cursor: 'cur-2'
      })
    })
    try {
      const backend = makeBackend()
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.queryChatHistory({ scope: { type: 'all_conversations' }, query: 'x', timeZone: 'Asia/Shanghai', category: 'all', limit: 50 })
      expect(page.items.map((i) => i.messageId)).toEqual(['m1', 'm2'])   // 领域升序
      expect(page.nextCursor).toBe('cur-2')                               // cursor 原样透传
      await backend.disconnect()
    } finally { close() }
  })
  it('单流第二页（更旧）同样升序；cursor 参数原样发给后端', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({
      onSearch: (u) => seen.push(u),
      searchBody: () => ({ items: [{ conversationId: 'c1', messageId: 'm0', timestamp: '2026-08-14T02:00:00.000Z', role: 'user', snippet: '更旧' }], has_more: false })
    })
    try {
      const backend = makeBackend()
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.queryChatHistory({ scope: { type: 'all_conversations' }, query: 'x', timeZone: 'Asia/Shanghai', category: 'all', limit: 50, cursor: 'cur-2' })
      expect(seen[0]).toContain('cursor=cur-2')
      expect(page.items.map((i) => i.messageId)).toEqual(['m0'])
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeUndefined()
      await backend.disconnect()
    } finally { close() }
  })
})

describe('RealBackend.queryChatHistory image_video 分页（P1-3）', () => {
  it('两子流独立游标编码进不透明游标；loadMore 各子流用自己游标续页（不再共用单一游标 → 第二页异流/跳漏）', async () => {
    const seen: string[] = []
    const searchResp = (u: string): { items: unknown[]; has_more: boolean; cursor?: string } => {
      const q = new URL(u, 'http://localhost')   // req.url 是相对路径，URL 构造需基准
      const category = q.searchParams.get('category')
      const cursor = q.searchParams.get('cursor')
      if (category === 'image') {
        if (!cursor) return { items: [{ conversationId: 'c1', messageId: 'img1', timestamp: '2026-08-14T01:00:00.000Z' }], has_more: true, cursor: 'img-c1' }
        return { items: [{ conversationId: 'c1', messageId: 'img2', timestamp: '2026-08-14T03:00:00.000Z' }], has_more: false }
      }
      if (category === 'video') {
        if (!cursor) return { items: [{ conversationId: 'c1', messageId: 'vid1', timestamp: '2026-08-14T02:00:00.000Z' }], has_more: true, cursor: 'vid-c1' }
        return { items: [{ conversationId: 'c1', messageId: 'vid2', timestamp: '2026-08-14T04:00:00.000Z' }], has_more: false }
      }
      return { items: [], has_more: false }
    }
    // 独立 server：按 category/cursor 返回有状态响应（apiServer 默认只回 has_more:false 单条，不适用分页用例）
    const s = await (async () => {
      const { createServer } = await import('http')
      const { WebSocketServer } = await import('ws')
      const server = createServer((req, res) => {
        const send = (body: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
        if (req.url?.startsWith('/api/search/messages')) {
          seen.push(req.url)
          send(searchResp(req.url))
        } else { res.writeHead(404); res.end() }
      })
      const wss = new WebSocketServer({ server, path: '/ws' })
      wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
        ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
        ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      return { port: (server.address() as { port: number }).port, close: () => { wss.close(); server.close() } }
    })()
    try {
      const backend = makeBackend()
      await backend.connect({ serverUrl: `http://127.0.0.1:${s.port}`, token: 'tok' })
      const first = await backend.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'image_video', limit: 50 })
      // 首页：image+video 两子查询各自无游标 → 返回编码两游标的复合不透明游标
      const c1 = JSON.parse(first.nextCursor!) as { image: string; video: string }
      expect(c1).toEqual({ image: 'img-c1', video: 'vid-c1' })
      expect(first.hasMore).toBe(true)
      expect(first.items.map((i) => i.messageId)).toEqual(['img1', 'vid1'])   // 按 sortKey(createdAt) 升序合并
      // 第二页：把复合游标回传 → 两子流各自用自己的游标续页
      const second = await backend.queryChatHistory({ scope: { type: 'all_conversations' }, timeZone: 'UTC', category: 'image_video', limit: 50, cursor: first.nextCursor })
      expect(second.hasMore).toBe(false)
      expect(second.nextCursor).toBeUndefined()
      expect(second.items.map((i) => i.messageId)).toEqual(['img2', 'vid2'])
      // 验证：image 子查询带 cursor=img-c1，video 子查询带 cursor=vid-c1（各用各的，不共用）
      const secondUrls = seen.slice(2)
      expect(secondUrls).toHaveLength(2)
      const imgUrl = secondUrls.find((u) => u.includes('category=image'))
      const vidUrl = secondUrls.find((u) => u.includes('category=video'))
      expect(imgUrl).toContain('cursor=img-c1')
      expect(vidUrl).toContain('cursor=vid-c1')
      await backend.disconnect()
    } finally { s.close() }
  })
})

describe('RealBackend.getMessageContext（spec §4.5）', () => {
  it('URL 参数 + MessagePage 归一化（before+anchor+after 合并稳定排序）', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onContext: (u) => seen.push(u) })
    try {
      const backend = makeBackend()
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
      const backend = makeBackend()
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
        const parsed = parseClientFrame(data)
        if (parsed['type'] === 'text') {
          payloads.push(parsed)
          ws.send(JSON.stringify({ type: 'user_message.ack', status: 'accepted', messageId: 'm9', clientRequestId: parsed['clientRequestId'], receivedAt: '2026-08-14T04:00:00.000Z' }))
        }
      })
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as AddressInfo).port
    try {
      const backend = makeBackend({ ackTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.sendMessage({ conversationId: 'c1', text: '', clientRequestId: 'cr1', stickerId: 'st_1' })
      expect(payloads[0]).toMatchObject({ type: 'text', conversationId: 'c1', clientRequestId: 'cr1', stickerId: 'st_1' })
      await backend.disconnect()
    } finally { wss.close(); s.close() }
  })
})

describe('RealBackend 搜索错误映射（P0-01：后端日期/时区 fail-fast）', () => {
  it('400 INVALID_TIMEZONE → INVALID_INPUT（不落 UNKNOWN）', async () => {
    const { createServer } = await import('http')
    const { WebSocketServer } = await import('ws')
    const s = createServer((req, res) => {
      if (req.url?.startsWith('/api/search/messages')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 'INVALID_TIMEZONE', message: '未知时区: Bad/Zone' }))
      } else { res.writeHead(404); res.end() }
    })
    const wss = new WebSocketServer({ server: s, path: '/ws' })
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
      ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
      ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as { port: number }).port
    try {
      const backend = makeBackend()
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await expect(backend.queryChatHistory({ scope: { type: 'all_conversations' }, localDate: '2026-08-14', timeZone: 'Bad/Zone', category: 'all', limit: 50 }))
        .rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
      await backend.disconnect()
    } finally { wss.close(); s.close() }
  })
})
