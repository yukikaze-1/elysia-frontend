// src/main/attachments/media-service.ts
// 阶段 3 G3（spec D1/D6，§4.4/§4.5）：通用媒体代理——签名 URL 持有/缓存/过期重签（attachment 流式代理）、
// sticker 静态白名单代理（G4 复用）、checkStatus 分类。签名 URL 不落 Renderer；日志脱敏（只记 mediaType+id+status）。
import type { AttachmentCheckResult, AttachmentSignResult } from '@shared/contracts'
import type { BackendAdapter } from '../transport/backend-adapter'

export type MediaRouteType = 'attachment' | 'sticker'
export const MEDIA_PATH_PREFIX = '/__cyrene-media/'

const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]+$/
const STICKER_ID_PATTERN = /^st_[A-Za-z0-9-]+$/
const STICKER_MIME = 'image/png'
const STICKER_MAX_BYTES = 1024 * 1024   // P3-2：docs/07 行 101 大小上限；公开静态贴图免鉴权
const RE_SIGN_LEEWAY_MS = 5 * 60 * 1000

/** 解析协议路径 /__cyrene-media/{mediaType}/{id}；非法/未知 → null（spec §4.4） */
export function parseMediaPath(pathname: string): { mediaType: MediaRouteType; id: string } | null {
  if (!pathname.startsWith(MEDIA_PATH_PREFIX)) return null
  const rest = pathname.slice(MEDIA_PATH_PREFIX.length)
  const segs = rest.split('/')
  if (segs.length !== 2 || segs.some((s) => s.length === 0)) return null
  const [mt, id] = segs as [string, string]
  if (mt !== 'attachment' && mt !== 'sticker') return null
  return { mediaType: mt, id }
}

/** 拒绝媒体字节作顶层文档（spec §4.9 双保险之一） */
export function isDocumentRequest(request: Request): boolean {
  return request.headers.get('sec-fetch-dest') === 'document'
}

export interface ResolvedSignedUrl { url: string; expiresAt: number }

export class MediaService {
  private readonly cache = new Map<string, ResolvedSignedUrl>()
  private readonly backend: Pick<BackendAdapter, 'signAttachmentUrl'>
  private readonly baseUrl: () => string | undefined
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch

  constructor(deps: { backend: Pick<BackendAdapter, 'signAttachmentUrl'>; baseUrl: () => string | undefined; now?: () => number; fetchImpl?: typeof fetch }) {
    this.backend = deps.backend
    this.baseUrl = deps.baseUrl
    this.now = deps.now ?? Date.now
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  /** 签名缓存：exp−5min 视为过期经 /sign 重签（D6） */
  async resolveSignedUrl(attachmentId: string, opts: { force?: boolean } = {}): Promise<ResolvedSignedUrl> {
    const cached = this.cache.get(attachmentId)
    if (!opts.force && cached && cached.expiresAt - this.now() > RE_SIGN_LEEWAY_MS) return cached
    const sign: AttachmentSignResult = await this.backend.signAttachmentUrl(attachmentId)
    const entry: ResolvedSignedUrl = { url: sign.url, expiresAt: Date.parse(sign.expiresAt) }
    this.cache.set(attachmentId, entry)
    return entry
  }

  async stream(mediaType: MediaRouteType, id: string, request: Request): Promise<Response> {
    if (isDocumentRequest(request)) return new Response('Forbidden', { status: 403 })
    if (mediaType === 'sticker') return this.streamSticker(id)
    return this.streamAttachment(id, request)
  }

  private async proxyFetch(signedUrl: string, request: Request, headers: Record<string, string>): Promise<Response> {
    try {
      const res = await this.fetchImpl(signedUrl, { headers, signal: request.signal })
      const out = new Headers()
      const ct = res.headers.get('content-type')
      if (ct) out.set('Content-Type', ct)
      const cr = res.headers.get('content-range')
      if (cr) out.set('Content-Range', cr)
      const ar = res.headers.get('accept-ranges')
      if (ar) out.set('Accept-Ranges', ar)
      if (res.status >= 500) return new Response('Bad Gateway', { status: 502 })   // P2-4：5xx 上游视为 transient（加载失败），不当作 not_found
      return new Response(res.body, { status: res.status, headers: out })
    } catch {
      // P2-4：网络失败（DNS/连接/超时）→ 502 transient，区别于 404 not_found——避免占位误标「附件不存在」
      return new Response('Bad Gateway', { status: 502 })
    }
  }

  private async streamAttachment(attachmentId: string, request: Request): Promise<Response> {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return new Response('Forbidden', { status: 403 })
    const headers: Record<string, string> = {}
    const range = request.headers.get('range')
    if (range) headers['range'] = range
    const accept = request.headers.get('accept')
    if (accept) headers['accept'] = accept
    let signed = await this.resolveSignedUrl(attachmentId)
    let res = await this.proxyFetch(signed.url, request, headers)
    if (res.status === 401 || res.status === 403) {
      // 签名过期：重签一次重试（spec §4.8）
      signed = await this.resolveSignedUrl(attachmentId, { force: true })
      res = await this.proxyFetch(signed.url, request, headers)
    }
    if (res.status === 401 || res.status === 403) return new Response('Gone', { status: 410 })
    return res
  }

  /** 读响应体并计数；超上限返回 null（中止，回 404 占位，P3-2） */
  private async readBodyCapped(res: Response): Promise<Uint8Array | null> {
    const reader = res.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > STICKER_MAX_BYTES) { await reader.cancel(); return null }
        chunks.push(value)
      }
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { out.set(c, offset); offset += c.byteLength }
    return out
  }

  /** sticker 静态代理：stickerId 白名单 + MIME 白名单 image/png + 1MB 上限 + 无签名/不缓存签名 URL（G4 硬化，spec §4.6 P3-2/P3-4） */
  private async streamSticker(stickerId: string): Promise<Response> {
    if (!STICKER_ID_PATTERN.test(stickerId)) return new Response('Forbidden', { status: 403 })
    const base = this.baseUrl()
    if (!base) return new Response('Not Found', { status: 404 })
    const url = `${base.replace(/\/$/, '')}/static/stickers/${encodeURIComponent(stickerId)}.png`
    try {
      const res = await this.fetchImpl(url)
      // P3-4：MIME 剥参匹配（容忍 ; charset= 等参数，严格相等会误拒）
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim()
      if (res.status !== 200 || mime !== STICKER_MIME) return new Response('Unsupported Media Type', { status: 415 })
      const body = await this.readBodyCapped(res)
      if (body === null) return new Response('Not Found', { status: 404 })   // 超 1MB → 占位（P3-2）
      // readBodyCapped 产出新分配的 Uint8Array<ArrayBufferLike>；Response BodyInit 需 ArrayBufferView<ArrayBuffer>——cast 兼容（同 real-backend 上传纪律）
      return new Response(body as unknown as BodyInit, { status: 200, headers: { 'Content-Type': STICKER_MIME, 'Cache-Control': 'public, max-age=86400' } })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  }

  /** 媒体状态分类：重签后 Range-0 探测后端（仅 attachment 分支使用；sticker 无签名/无过期不查） */
  async checkStatus(attachmentId: string): Promise<AttachmentCheckResult> {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return { status: 'error', reason: 'invalid_id' }
    let signed: ResolvedSignedUrl
    try {
      signed = await this.resolveSignedUrl(attachmentId, { force: true })
    } catch {
      return { status: 'error', reason: 'sign_failed' }
    }
    try {
      const res = await this.fetchImpl(signed.url, { headers: { range: 'bytes=0-0' } })
      if (res.status === 200 || res.status === 206) return { status: 'ok' }
      if (res.status === 404) return { status: 'not_found' }
      if (res.status === 401 || res.status === 403) return { status: 'expired' }
      return { status: 'error' }
    } catch {
      return { status: 'error', reason: 'probe_failed' }
    }
  }
}
