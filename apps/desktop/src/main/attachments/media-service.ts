// src/main/attachments/media-service.ts
// 阶段 3 G3（spec D1/D6，§4.4/§4.5）：通用媒体代理——签名 URL 持有/缓存/过期重签（attachment 流式代理）、
// sticker 静态白名单代理（G4 复用）、checkStatus 分类。签名 URL 不落 Renderer；日志脱敏（只记 mediaType+id+status）。
import { isIP } from 'node:net'
import type { AttachmentCheckResult, AttachmentSignResult } from '@shared/contracts'
import type { AttachmentBackendPort } from '../transport/backend-ports'
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

/** IPv4：回环 / 私网 / 链路本地（含云元数据 169.254.169.254）/ CGNAT / 组播与保留段 */
function isForbiddenIPv4(ip: string): boolean {
  const parts = ip.split('.').map((s) => Number(s))
  const a = parts[0]
  const b = parts[1]
  if (a === undefined || b === undefined || parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

/** IPv6：未指定 / 回环 / 链路本地 fe80::/10 / ULA fc00::/7 / IPv4 映射形态递归判定 */
function isForbiddenIPv6(ip: string): boolean {
  const v = ip.toLowerCase()
  if (v === '::' || v === '::1') return true
  if (/^fe[89ab]/.test(v)) return true
  if (v.startsWith('fc') || v.startsWith('fd')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
  if (mapped) return isForbiddenIPv4(mapped[1])
  return false
}

/**
 * S1（2026-09-15 安全评审）：绝对签名 URL 的**目标地址策略**。
 *
 * 修复前：绝对 URL 只要 scheme 是 http(s) 就原样放行，Main 用**自己的身份** fetch 后把响应体作为
 * **同源** `cyrene://renderer/__cyrene-media/...` 资源交给页面 ⇒ 恶意/被篡改后端（doc 07 §2.2 明列
 * 威胁主体）可让它返回 `http://127.0.0.1:11434/...`、`169.254.169.254`、内网管理面，页面再
 * `fetch()` 同一路径即可**读到正文**（`corsEnabled:false` 只挡跨源，而这恰恰是同源）。
 *
 * 现策略（fail-closed）：
 *   1. 与后端**同源**（scheme + 主机名 + 端口一致）⇒ 放行——自建后端的签名 URL 正常指回自己；
 *      刻意**不**放宽到「同主机名任意端口」：那会让本地后端指向 `127.0.0.1:<其它端口>`（本机服务枚举）；
 *   2. 否则主机名必须是**公网字面 IP**（`net.isIP` ≠ 0 且不在上述保留段）；
 *   3. 否则拒绝——**包括公网域名**：域名可以解析到 127.0.0.1（攻击者自控域名即可绕过字面检查），
 *      而 Main 不做 DNS 预解析（预解析自身有 TOCTOU，还会给「已检查过」的错觉）。
 *
 * 代价（如实记录）：域名形式的对象存储/CDN 签名 URL，以及「后端与其媒体服务不同源」的部署形态，
 * 都会被拒。这是对阶段 3「D1 不强同源」的**收窄**——D1 的动机是兼容 CDN，但它没有覆盖
 * 「目标为回环/私网 + 正文可被同源读取」这一后果。将来若确实需要域名型 CDN 或跨源媒体服务，
 * 正确做法是显式配置允许的 origin 白名单，而不是放开本条。
 */
export function assertSignTargetAllowed(signUrl: string, baseUrl: string): string {
  let target: URL
  let base: URL
  try {
    target = new URL(signUrl)
    base = new URL(baseUrl)
  } catch {
    throw new SignedUrlResolveError('invalid signed URL (base or signUrl malformed)')
  }
  // 同源（scheme + host + port 全等）⇒ 后端自己的资源
  if (target.origin === base.origin) return target.toString()
  const host = target.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(host)
  if (family === 4 && !isForbiddenIPv4(host)) return target.toString()
  if (family === 6 && !isForbiddenIPv6(host)) return target.toString()
  // 日志脱敏契约：错误消息不得含签名 URL（签名永不离开 Main）
  throw new SignedUrlResolveError('signed URL host is not an allowed target')
}

/** P0-01：解析签名 URL。相对路径基于 backend baseUrl 解析为绝对（保留反代 path 前缀）；
 *  绝对 URL 经 `assertSignTargetAllowed` 的**地址策略**（S1）后放行；其余 scheme/畸形/baseUrl 缺失 → 抛 SignedUrlResolveError。 */
export function resolveSignUrl(signUrl: string, baseUrl: string | undefined): string {
  if (!baseUrl) throw new SignedUrlResolveError('backend base URL is not configured')
  if (/^https?:\/\//i.test(signUrl)) return assertSignTargetAllowed(signUrl, baseUrl)
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

/**
 * MediaService 声明的后端能力面（架构整改 Prompt 3）：签名 URL 签发与归档桌面截图字节读取，
 * 都是"附件/媒体字节只在 Main 内流转"这一能力（`AttachmentBackendPort` 的三个方法中的两个）。
 * `readToolAttachment` 保持可选：缺省时 `tool-capture` 路由回 404（保留本批之前的既有语义，不新增请求面）。
 */
type MediaServiceBackendPort = Pick<AttachmentBackendPort, 'signAttachmentUrl'> & Partial<Pick<AttachmentBackendPort, 'readToolAttachment'>>

export class MediaService {
  private readonly cache = new Map<string, ResolvedSignedUrl>()
  private readonly backend: MediaServiceBackendPort
  private readonly baseUrl: () => string | undefined
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly ttsPreviewCache = new Map<string, { bytes: Uint8Array; mime: string; createdAt: number }>()
  private readonly TTS_PREVIEW_TTL_MS = 60_000
  /** P4-B tts-live：实时朗读音频缓存——契约 TtsMediaSink.putTtsAudio 需返回 cyrene:// URL；TTL 缺省 5min（spec D-P13） */
  private readonly ttsLiveCache = new Map<string, { bytes: Uint8Array; mime: string; createdAt: number }>()
  private readonly TTS_LIVE_TTL_MS = 300_000

  constructor(deps: { backend: MediaServiceBackendPort; baseUrl: () => string | undefined; now?: () => number; fetchImpl?: typeof fetch }) {
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

  /** 桌面截图归档代理：调用 ID 白名单；字节只由附件/媒体端口的鉴权读取方法提供。 */
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
      // S2（2026-09-15）：媒体代理同样**不跟随重定向**——签名 URL 的目标由后端选择，
      // 跟随 `Location` 会把「后端指定的一个 URL」变成「后端指定的任意一串 URL」（理由同 real-backend restFetch）。
      const res = await this.fetchImpl(signedUrl, { headers, signal: request.signal, redirect: 'error' })
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
      const res = await this.fetchImpl(url, { redirect: 'error' })   // S2：不跟随重定向
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
      const res = await this.fetchImpl(signed.url, { headers: { range: 'bytes=0-0' }, redirect: 'error' })   // S2：不跟随重定向
      if (res.status === 200 || res.status === 206) return { status: 'ok' }
      if (res.status === 404) return { status: 'not_found' }
      if (res.status === 401 || res.status === 403) return { status: 'expired' }
      return { status: 'error' }
    } catch {
      return { status: 'error', reason: 'probe_failed' }
    }
  }
}
