// tests/unit/media-service.spec.ts
// Task 8:MediaService（spec D1/D6，§4.4/§4.5）——签名缓存/过期重签、Range/206 透传、401/403 重签重试、410 映射、
// checkStatus 分类、attachmentId/stickerId 白名单、Sec-Fetch-Dest 拒绝、sticker 静态代理无签名。env=node。
import { describe, expect, it, vi } from 'vitest'
import { isDocumentRequest, MediaService, parseMediaPath, resolveSignUrl, SignedUrlResolveError } from '../../src/main/attachments/media-service'

const now = () => 1_752_000_000_000   // 固定时钟（2026-07 起）

function mkService(opts: {
  sign?: (id: string) => Promise<{ url: string; expiresAt: string }>
  fetchImpl?: typeof fetch
  baseUrl?: () => string | undefined
} = {}): MediaService {
  return new MediaService({
    backend: { signAttachmentUrl: opts.sign ?? (async (id) => ({ url: `https://cdn.x/${id}?sig=s`, expiresAt: new Date(now() + 60 * 60 * 1000).toISOString() })) },
    baseUrl: opts.baseUrl ?? (() => 'http://127.0.0.1:9'),
    now,
    fetchImpl: opts.fetchImpl
  })
}

describe('parseMediaPath / isDocumentRequest', () => {
  it('解析 /__cyrene-media/{mediaType}/{id}', () => {
    expect(parseMediaPath('/__cyrene-media/attachment/att_1')).toEqual({ mediaType: 'attachment', id: 'att_1' })
    expect(parseMediaPath('/__cyrene-media/sticker/st_1')).toEqual({ mediaType: 'sticker', id: 'st_1' })
  })
  it('非媒体路径/缺段/未知 mediaType → null', () => {
    expect(parseMediaPath('/index.html')).toBeNull()
    expect(parseMediaPath('/__cyrene-media/')).toBeNull()
    expect(parseMediaPath('/__cyrene-media/bogus/att_1')).toBeNull()
    expect(parseMediaPath('/__cyrene-media/attachment/att_1/x')).toBeNull()
  })
  it('Sec-Fetch-Dest: document → 拒绝（防媒体字节作顶层文档，spec §4.9）', () => {
    expect(isDocumentRequest(new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'document' } }))).toBe(true)
    expect(isDocumentRequest(new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))).toBe(false)
  })
})

describe('resolveSignUrl（P0-01：相对签名 URL 基于 endpoint 解析，spec §4.1）', () => {
  it('相对 /api/... → 基于 baseUrl 解析为绝对（保留 query）', () => {
    expect(resolveSignUrl('/api/attachments/att_1?sig=s&exp=1', 'http://127.0.0.1:18765'))
      .toBe('http://127.0.0.1:18765/api/attachments/att_1?sig=s&exp=1')
  })
  it('baseUrl 含 path 前缀（反代/SSH 转发）→ 保留前缀不吞路径', () => {
    expect(resolveSignUrl('/api/attachments/att_1?sig=s', 'http://127.0.0.1:18765/backend-proxy'))
      .toBe('http://127.0.0.1:18765/backend-proxy/api/attachments/att_1?sig=s')
  })
  it('baseUrl 尾斜杠 → 不双斜杠', () => {
    expect(resolveSignUrl('/api/attachments/att_1?sig=s', 'http://127.0.0.1:18765/'))
      .toBe('http://127.0.0.1:18765/api/attachments/att_1?sig=s')
  })
  it('绝对 http(s) URL → 原样放行（D1：兼容对象存储 CDN）', () => {
    expect(resolveSignUrl('https://cdn.x/att_1?sig=s', 'http://127.0.0.1:18765')).toBe('https://cdn.x/att_1?sig=s')
  })
  it('异 scheme（javascript:/file:/data:）与协议相对 // → SignedUrlResolveError', () => {
    expect(() => resolveSignUrl('javascript:alert(1)', 'http://127.0.0.1:18765')).toThrow(SignedUrlResolveError)
    expect(() => resolveSignUrl('file:///etc/passwd', 'http://127.0.0.1:18765')).toThrow(SignedUrlResolveError)
    expect(() => resolveSignUrl('//evil.com/x', 'http://127.0.0.1:18765')).toThrow(SignedUrlResolveError)
  })
  it('baseUrl 缺失 → SignedUrlResolveError', () => {
    expect(() => resolveSignUrl('/api/attachments/att_1?sig=s', undefined)).toThrow(SignedUrlResolveError)
  })
  it('畸形 baseUrl → SignedUrlResolveError（不抛裸 TypeError）', () => {
    expect(() => resolveSignUrl('/api/x', 'not a url')).toThrow(SignedUrlResolveError)
  })
})

describe('MediaService.resolveSignedUrl（缓存/重签）', () => {
  it('首次签发入缓存；5min 内命中不重签', async () => {
    const sign = vi.fn(async (id: string) => ({ url: `https://cdn.x/${id}?sig=s`, expiresAt: new Date(now() + 60 * 60 * 1000).toISOString() }))
    const svc = mkService({ sign })
    const a = await svc.resolveSignedUrl('att_1')
    const b = await svc.resolveSignedUrl('att_1')
    expect(a.url).toBe(b.url)
    expect(sign).toHaveBeenCalledTimes(1)
  })
  it('到期前 5min 内视为过期 → 重签（force 或自然过期）', async () => {
    let count = 0
    const sign = vi.fn(async (id: string) => ({ url: `https://cdn.x/${id}?sig=${++count}`, expiresAt: new Date(now() + 4 * 60 * 1000).toISOString() }))  // 距过期 <5min
    const svc = mkService({ sign })
    await svc.resolveSignedUrl('att_1')
    await svc.resolveSignedUrl('att_1')
    expect(sign).toHaveBeenCalledTimes(2)
  })
  it('P2-6：非法 expiresAt（Date.parse NaN）→ 降级短窗口缓存，不放大重签请求', async () => {
    const sign = vi.fn(async (id: string) => ({ url: `https://cdn.x/${id}?sig=s`, expiresAt: 'not-a-date' }))
    const svc = mkService({ sign })
    const a = await svc.resolveSignedUrl('att_1')
    const b = await svc.resolveSignedUrl('att_1')
    expect(a.url).toBe(b.url)
    expect(sign).toHaveBeenCalledTimes(1)   // 第二调用命中降级缓存，不再重签（避免恒重签放大）
  })
  it('P2-6：非法 expiresAt 降级窗口用尽后仍可重签（非死缓存）', async () => {
    let clock = now()
    const sign = vi.fn(async (id: string) => ({ url: `https://cdn.x/${id}?sig=s`, expiresAt: 'not-a-date' }))
    const svc = new MediaService({
      backend: { signAttachmentUrl: sign },
      baseUrl: () => 'http://127.0.0.1:9',
      now: () => clock
    })
    await svc.resolveSignedUrl('att_1')          // 降级缓存 expiresAt = clock + 2*leeway
    clock = now() + 11 * 60 * 1000               // 推进 11min > 10min 降级窗口 → 缓存失效重签
    await svc.resolveSignedUrl('att_1')
    expect(sign).toHaveBeenCalledTimes(2)
  })
})

describe('MediaService.stream attachment 分支', () => {
  it('Range 请求 → 透传 Range/Accept，后端 206 直通', async () => {
    const fetchImpl = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = String(u)
      expect(url).toBe('https://cdn.x/att_1?sig=s')
      expect(init?.headers).toMatchObject({ range: 'bytes=0-1023' })
      return new Response(new Uint8Array(64), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-63/1024', 'accept-ranges': 'bytes' } })
    })
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { range: 'bytes=0-1023', 'sec-fetch-dest': 'video' } }))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-63/1024')
  })
  it('后端 403 → 重签一次重试 → 仍 403 → 410（Gone）', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => { calls++; return new Response('denied', { status: calls === 1 ? 403 : 403 }) })
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(fetchImpl).toHaveBeenCalledTimes(2)   // 初次 + 重签重试
    expect(res.status).toBe(410)
  })
  it('attachmentId 格式不符 → 403（白名单）', async () => {
    const svc = mkService()
    const res = await svc.stream('attachment', 'evil', new Request('cyrene://renderer/__cyrene-media/attachment/evil', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(403)
  })
  it('Sec-Fetch-Dest: document → 403', async () => {
    const svc = mkService()
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'document' } }))
    expect(res.status).toBe(403)
  })
  it('后端网络失败/5xx → 502（transient，非 404，避免占位误标 not_found，P2-4）', async () => {
    const svcNet = mkService({ fetchImpl: async () => { throw new Error('net down') } })
    expect((await svcNet.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(502)
    const svc5xx = mkService({ fetchImpl: async () => new Response('boom', { status: 500 }) })
    expect((await svc5xx.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(502)
  })
})

describe('MediaService P0-01 相对签名 URL 全链路（spec §4.1）', () => {
  it('相对 sign.url → stream 请求绝对 URL（Range/206 透传）', async () => {
    const sign = vi.fn(async (id: string) => ({ url: `/api/attachments/${id}?sig=s`, expiresAt: new Date(now() + 3600_000).toISOString() }))
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toBe('http://127.0.0.1:9/api/attachments/att_1?sig=s')
      return new Response(new Uint8Array(64), { status: 206, headers: { 'content-type': 'video/mp4' } })
    })
    const svc = mkService({ sign, fetchImpl })
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'video' } }))
    expect(res.status).toBe(206)
  })
  it('相对 sign.url → checkStatus 请求绝对 URL → ok', async () => {
    const sign = vi.fn(async (id: string) => ({ url: `/api/attachments/${id}?sig=s`, expiresAt: new Date(now() + 3600_000).toISOString() }))
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toBe('http://127.0.0.1:9/api/attachments/att_1?sig=s')
      return new Response('', { status: 200 })
    })
    const svc = mkService({ sign, fetchImpl })
    expect((await svc.checkStatus('att_1')).status).toBe('ok')
  })
  it('baseUrl 缺失 → 不调签发表、stream 500、checkStatus resolve_failed', async () => {
    const sign = vi.fn(async () => ({ url: '/api/attachments/att_1?sig=s', expiresAt: 'x' }))
    const svc = new MediaService({ backend: { signAttachmentUrl: sign }, baseUrl: () => undefined, now })
    const streamRes = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(streamRes.status).toBe(500)
    const cs = await svc.checkStatus('att_1')
    expect(cs.status).toBe('error')
    expect(cs.reason).toBe('resolve_failed')
    expect(sign).not.toHaveBeenCalled()
  })
  it('P0-01：401/403 触发重签时 baseUrl 失效 → 重签解析失败按 500 分类（不逃逸为协议层 502）', async () => {
    let baseCalls = 0
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 403 }))
    const svc = new MediaService({
      backend: { signAttachmentUrl: async (id) => ({ url: `/api/attachments/${id}?sig=s`, expiresAt: new Date(now() + 3600_000).toISOString() }) },
      baseUrl: () => (baseCalls++ === 0 ? 'http://127.0.0.1:9' : undefined),   // 首次签发可用，重签时 endpoint 已失效
      now,
      fetchImpl
    })
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(fetchImpl).toHaveBeenCalledTimes(1)   // 首次 fetch 403 → 重签解析失败，不再发起二次 fetch
    expect(res.status).toBe(500)                 // 解析失败（SignedUrlResolveError）→ 500，而非 502
  })
  it('签发表 fetch 失败（非解析问题）→ stream 502、checkStatus sign_failed', async () => {
    const sign = vi.fn(async () => { throw new Error('net down') })
    const svc = mkService({ sign })
    const streamRes = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(streamRes.status).toBe(502)
    const cs = await svc.checkStatus('att_1')
    expect(cs.status).toBe('error')
    expect(cs.reason).toBe('sign_failed')
  })
  it('endpoint 变化（baseUrl 变化）→ 不复用旧缓存、重签且新 base 生效（D2 分区）', async () => {
    let base = 'http://127.0.0.1:9'
    let count = 0
    const sign = vi.fn(async (id: string) => ({ url: `/api/attachments/${id}?sig=${++count}`, expiresAt: new Date(now() + 3600_000).toISOString() }))
    const svc = new MediaService({ backend: { signAttachmentUrl: sign }, baseUrl: () => base, now })
    const a = await svc.resolveSignedUrl('att_1')
    base = 'http://127.0.0.1:9999'
    const b = await svc.resolveSignedUrl('att_1')
    expect(a.url).not.toBe(b.url)
    expect(b.url).toBe('http://127.0.0.1:9999/api/attachments/att_1?sig=2')
    expect(sign).toHaveBeenCalledTimes(2)
  })
})

describe('MediaService.stream sticker 分支（G4 边界，spec §4.4/§2）', () => {
  it('stickerId 白名单 + MIME 白名单 + 静态代理（无签名）', async () => {
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u)
      expect(url).toBe('http://127.0.0.1:9/static/stickers/st_1.png')
      return new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })
  it('stickerId 非法（非 ^st_[A-Za-z0-9-]+$）→ 403', async () => {
    const svc = mkService()
    expect((await svc.stream('sticker', '../st_1', new Request('cyrene://renderer/__cyrene-media/sticker/x', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(403)
    expect((await svc.stream('sticker', 'ST_1', new Request('cyrene://renderer/__cyrene-media/sticker/x', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(403)
  })
})

describe('MediaService.checkStatus（D6 分类）', () => {
  it('Range-0 探测 200/206 → ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
    const svc = mkService({ fetchImpl })
    expect((await svc.checkStatus('att_1')).status).toBe('ok')
  })
  it('404 → not_found；403（重签后仍）→ expired；其他 → error', async () => {
    const svc404 = mkService({ fetchImpl: async () => new Response('', { status: 404 }) })
    expect((await svc404.checkStatus('att_1')).status).toBe('not_found')
    const svc403 = mkService({ fetchImpl: async () => new Response('', { status: 403 }) })
    expect((await svc403.checkStatus('att_1')).status).toBe('expired')
    const svcErr = mkService({ fetchImpl: async () => { throw new Error('net') } })
    expect((await svcErr.checkStatus('att_1')).status).toBe('error')
  })
  it('签发表失败 → error（reason sign_failed）；格式非法 → error', async () => {
    const svc = mkService({ sign: async () => { throw new Error('boom') } })
    expect((await svc.checkStatus('att_1')).status).toBe('error')
    const svcBad = mkService()
    expect((await svcBad.checkStatus('evil')).status).toBe('error')
  })
})

describe('MediaService.streamSticker G4 硬化（spec §4.6 P3-2/P3-4）', () => {
  it('MIME 带参数容忍：image/png; charset=utf-8 通过（剥参 trim 匹配）', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'content-type': 'image/png; charset=utf-8' } }))
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })
  it('响应体超 1MB → 404 占位（中止注入，P3-2）', async () => {
    const big = new Uint8Array(1024 * 1024 + 1)
    const fetchImpl = vi.fn(async () => new Response(big, { status: 200, headers: { 'content-type': 'image/png' } }))
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(404)
  })
  it('恰好 1MB 通过；MIME 不匹配 → 415', async () => {
    const exact = new Uint8Array(1024 * 1024)
    const svcExact = mkService({ fetchImpl: async () => new Response(exact, { status: 200, headers: { 'content-type': 'image/png' } }) })
    expect((await svcExact.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(200)
    const svcBad = mkService({ fetchImpl: async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'text/html' } }) })
    expect((await svcBad.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(415)
  })
})

describe('MediaService.stream tts-preview 分支（阶段 4 批次 A：试听音频一次性路由）', () => {
  it('tts-preview 路由：put 后 stream 返回 bytes；未知 id → 404', async () => {
    const svc = mkService()
    svc.putTtsPreview('ttsp-1', new Uint8Array([1, 2, 3]), 'audio/wav')
    const res = await svc.stream('tts-preview', 'ttsp-1', new Request('cyrene://renderer/__cyrene-media/tts-preview/ttsp-1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(res.headers.get('content-type')).toBe('audio/wav')
    const miss = await svc.stream('tts-preview', 'nope', new Request('cyrene://renderer/__cyrene-media/tts-preview/nope', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(miss.status).toBe(404)
  })
})
