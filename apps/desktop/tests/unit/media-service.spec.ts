// tests/unit/media-service.spec.ts
// Task 8:MediaService（spec D1/D6，§4.4/§4.5）——签名缓存/过期重签、Range/206 透传、401/403 重签重试、410 映射、
// checkStatus 分类、attachmentId/stickerId 白名单、Sec-Fetch-Dest 拒绝、sticker 静态代理无签名。env=node。
import { describe, expect, it, vi } from 'vitest'
import { isDocumentRequest, MediaService, parseMediaPath } from '../../src/main/attachments/media-service'

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
