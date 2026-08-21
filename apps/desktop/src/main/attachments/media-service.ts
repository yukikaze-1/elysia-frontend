// src/main/attachments/media-service.ts
// 阶段 3 G3（spec D1/D6，§4.4/§4.5）：通用媒体代理——签名 URL 持有/缓存/过期重签（attachment 流式代理）、
// sticker 静态白名单代理（G4 复用）、checkStatus 分类。签名 URL 不落 Renderer；日志脱敏（只记 mediaType+id+status）。
import type { AttachmentCheckResult, AttachmentSignResult } from '@shared/contracts'
import type { BackendAdapter } from '../transport/backend-adapter'
import { STICKER_ID_PATTERN } from '../transport/protocol-v2/content-part'

export type MediaRouteType = 'attachment' | 'sticker' | 'tool-capture' | 'tts-preview' | 'tts-live'
export const MEDIA_PATH_PREFIX = '/__cyrene-media/'

const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]+$/
const DESKTOP_CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]+$/
const STICKER_MIME = 'image/png'
const STICKER_MAX_BYTES = 1024 * 1024   // P3-2：docs/07 行 101 大小上限；公开静态贴图免鉴权
const RE_SIGN_LEEWAY_MS = 5 * 60 * 1000
/** P2-6：非法 expiresAt（Date.parse NaN/非有限）的降级窗口——缓存不可信签名的短寿命，避免 NaN 恒重签放大后端负载 */
const INVALID_EXPIRY_FALLBACK_MS = RE_SIGN_LEEWAY_MS * 2

/** P0-01：签名 URL 解析失败（baseUrl 缺失/畸形/URL 非法）——与签发 fetch 失败区分（spec §4.1 错误分类） */
export class SignedUrlResolveError extends Error {}

/** P0-01：解析签名 URL。相对路径基于 backend baseUrl 解析为绝对（保留反代 path 前缀）；
 *  绝对 URL 仅 http(s) 原样放行（D1：兼容对象存储 CDN，不强同源）；其余 scheme/畸形/baseUrl 缺失 → 抛 SignedUrlResolveError。 */
export function resolveSignUrl(signUrl: string, baseUrl: string | undefined): string {
  if (!baseUrl) throw new SignedUrlResolveError('backend base URL is not configured')
  if (/^https?:\/\//i.test(signUrl)) return signUrl
  if (/^\/(?!\/)/.test(signUrl)) {
    try {
      return new URL(baseUrl.replace(/\/+$/, '') + signUrl).toString()   // 拼接再验证：保留 path 前缀，`new URL(signUrl, baseUrl)` 会丢反代 path
    } catch {
      // 日志脱敏契约：错误消息不得含签名 URL（签名永不离开 Main），只留 scheme/通用描述
      throw new SignedUrlResolveError('invalid signed URL (base or signUrl malformed)')
    }
  }
  throw new SignedUrlResolveError('unsupported signed URL scheme')
}

/** 解析协议路径 /__cyrene-media/{mediaType}/{id}；非法/未知 → null（spec §4.4） */
export function parseMediaPath(pathname: string): { mediaType: MediaRouteType; id: string } | null {
  if (!pathname.startsWith(MEDIA_PATH_PREFIX)) return null
  const rest = pathname.slice(MEDIA_PATH_PREFIX.length)
  const segs = rest.split('/')
  if (segs.length !== 2 || segs.some((s) => s.length === 0)) return null
  const [mt, id] = segs as [string, string]
  if (mt !== 'attachment' && mt !== 'sticker' && mt !== 'tool-capture' && mt !== 'tts-preview' && mt !== 'tts-live') return null
  return { mediaType: mt, id }
}

/** 拒绝媒体字节作顶层文档（spec §4.9 双保险之一） */
export function isDocumentRequest(request: Request): boolean {
  return request.headers.get('sec-fetch-dest') === 'document'
}

export interface ResolvedSignedUrl { url: string; expiresAt: number }

export class MediaService {
  private readonly cache = new Map<string, ResolvedSignedUrl>()
  private readonly backend: Pick<BackendAdapter, 'signAttachmentUrl'> & Partial<Pick<BackendAdapter, 'readToolAttachment'>>
  private readonly baseUrl: () => string | undefined
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly ttsPreviewCache = new Map<string, { bytes: Uint8Array; mime: string; createdAt: number }>()
  private readonly TTS_PREVIEW_TTL_MS = 60_000
  /** P4-B tts-live：实时朗读音频缓存——契约 TtsMediaSink.putTtsAudio 需返回 cyrene:// URL；TTL 缺省 5min（spec D-P13） */
  private readonly ttsLiveCache = new Map<string, { bytes: Uint8Array; mime: string; createdAt: number }>()
  private readonly TTS_LIVE_TTL_MS = 300_000

  constructor(deps: { backend: Pick<BackendAdapter, 'signAttachmentUrl'> & Partial<Pick<BackendAdapter, 'readToolAttachment'>>; baseUrl: () => string | undefined; now?: () => number; fetchImpl?: typeof fetch }) {
    this.backend = deps.backend
    this.baseUrl = deps.baseUrl
    this.now = deps.now ?? Date.now
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  /** 签名缓存：key 按 endpoint 身份分区（D2，baseUrl 含反代 path 前缀，origin 变化必然 baseUrl 变化）；exp−5min 视为过期经 /sign 重签（D6） */
  async resolveSignedUrl(attachmentId: string, opts: { force?: boolean } = {}): Promise<ResolvedSignedUrl> {
    const base = this.baseUrl()
    const cacheKey = `${(base ?? '').replace(/\/+$/, '')}:${attachmentId}`
    const cached = this.cache.get(cacheKey)
    if (!opts.force && cached && cached.expiresAt - this.now() > RE_SIGN_LEEWAY_MS) return cached
    if (!base) throw new SignedUrlResolveError('backend base URL is not configured')   // P0-01：不调签发表，先失败
    const sign: AttachmentSignResult = await this.backend.signAttachmentUrl(attachmentId)
    const url = resolveSignUrl(sign.url, base)
    const expires = Date.parse(sign.expiresAt)
    // P2-6：非法 expiresAt（NaN/非有限）→ 降级短窗口缓存（防 NaN 恒重签放大请求）；URL 实际过期由流 401/403 重签兜底
    const entry: ResolvedSignedUrl = { url, expiresAt: Number.isFinite(expires) ? expires : this.now() + INVALID_EXPIRY_FALLBACK_MS }
    this.cache.set(cacheKey, entry)
    return entry
  }

  async stream(mediaType: MediaRouteType, id: string, request: Request): Promise<Response> {
    if (isDocumentRequest(request)) return new Response('Forbidden', { status: 403 })
    if (mediaType === 'sticker') return this.streamSticker(id)
    if (mediaType === 'tool-capture') return this.streamToolCapture(id)
    if (mediaType === 'tts-preview') return this.streamTtsPreview(id)
    if (mediaType === 'tts-live') return this.streamTtsLive(id)
    return this.streamAttachment(id, request)
  }

  /** 桌面截图归档代理：调用 ID 白名单；字节只由 BackendAdapter 的鉴权读取方法提供。 */
  private async streamToolCapture(callId: string): Promise<Response> {
    if (!DESKTOP_CALL_ID_PATTERN.test(callId)) return new Response('Forbidden', { status: 403 })
    if (!this.backend.readToolAttachment) return new Response('Not Found', { status: 404 })
    try {
      const hit = await this.backend.readToolAttachment(callId)
      if (!hit) return new Response('Not Found', { status: 404 })
      return new Response(hit.bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'Content-Type': hit.mimeType, 'Cache-Control': 'no-store' }
      })
    } catch {
      return new Response('Bad Gateway', { status: 502 })
    }
  }

  /** 试听音频一次性缓存：放入后 60s 过期；put 时顺手清理过期项（时钟用现有 this.now = deps.now ?? Date.now） */
  putTtsPreview(id: string, bytes: Uint8Array, mime: string): void {
    const now = this.now()
    for (const [k, v] of this.ttsPreviewCache) if (now - v.createdAt > this.TTS_PREVIEW_TTL_MS) this.ttsPreviewCache.delete(k)
    this.ttsPreviewCache.set(id, { bytes, mime, createdAt: now })
  }

  private async streamTtsPreview(id: string): Promise<Response> {
    const hit = this.ttsPreviewCache.get(id)
    if (!hit) return new Response(null, { status: 404 })
    // 缓存字段 bytes 类型为 Uint8Array<ArrayBufferLike>；Response BodyInit 需 ArrayBufferView<ArrayBuffer>——cast 兼容（同 sticker readBodyCapped 纪律）
    return new Response(hit.bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': hit.mime, 'cache-control': 'no-store' } })
  }

  /** P4-B tts-live：实时朗读音频放缓存。`mime` 缺省 `audio/wav`（与 `TtsMediaSink` 契约声明一致，可满足接口可赋值性）。
   *  `ttlMs` 缺省 5min（300000）；put 时惰性清理过期项（同 putTtsPreview）。
   *  M5 修复：契约 `TtsMediaSink` 需返回 cyrene:// URL 供 `<audio src>` 使用——URL 组装同 model-handlers.ts 的 tts-preview。 */
  putTtsAudio(id: string, bytes: Uint8Array, mime?: string, opts: { ttlMs?: number } = {}): { url: string } {
    const now = this.now()
    const ttl = opts.ttlMs ?? this.TTS_LIVE_TTL_MS
    const resolvedMime = mime ?? 'audio/wav'
    for (const [k, v] of this.ttsLiveCache) if (now - v.createdAt > ttl) this.ttsLiveCache.delete(k)
    this.ttsLiveCache.set(id, { bytes, mime: resolvedMime, createdAt: now })
    return { url: `cyrene://renderer${MEDIA_PATH_PREFIX}tts-live/${id}` }
  }

  private async streamTtsLive(id: string): Promise<Response> {
    const hit = this.ttsLiveCache.get(id)
    if (!hit) return new Response(null, { status: 404 })
    return new Response(hit.bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': hit.mime, 'cache-control': 'no-store' } })
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
    let signed: ResolvedSignedUrl
    try {
      signed = await this.resolveSignedUrl(attachmentId)
    } catch (e) {
      // P0-01 错误分类：解析失败（baseUrl 缺失/URL 非法）→ 500 可诊断；签发表 fetch 失败 → 502 transient（P2-4）
      if (e instanceof SignedUrlResolveError) return new Response('Signed URL invalid', { status: 500 })
      return new Response('Bad Gateway', { status: 502 })
    }
    let res = await this.proxyFetch(signed.url, request, headers)
    if (res.status === 401 || res.status === 403) {
      // 签名过期：重签一次重试（spec §4.8）；重签解析失败同样按 P0-01 错误分类（500/502），不得逃逸到协议层兜底 502 且让 e.message 外泄
      try {
        signed = await this.resolveSignedUrl(attachmentId, { force: true })
      } catch (e) {
        if (e instanceof SignedUrlResolveError) return new Response('Signed URL invalid', { status: 500 })
        return new Response('Bad Gateway', { status: 502 })
      }
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
    } catch (e) {
      return { status: 'error', reason: e instanceof SignedUrlResolveError ? 'resolve_failed' : 'sign_failed' }
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
