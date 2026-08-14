// apps/desktop/src/main/protocol/handler.ts
import { net, protocol } from 'electron'
import { realpath, stat } from 'fs/promises'
import { join, sep } from 'path'
import { pathToFileURL } from 'url'
import { PROTOCOL_SCHEME, RENDERER_HOST } from './scheme'
import { resolveRendererPath } from './path'
import { buildRendererCsp } from './csp'
import { mimeOf } from './mime'
import { isDocumentRequest, MEDIA_PATH_PREFIX, parseMediaPath, type MediaRouteType } from '../attachments/media-service'

const RENDERER_CSP = buildRendererCsp()

export type MediaResolver = (mediaType: MediaRouteType, id: string, request: Request) => Promise<Response>

export interface CyreneProtocolOptions {
  /** 渲染根（缺省时非媒体一律 404；media 分支不依赖 rendererRoot） */
  rendererRoot?: string
  /** 媒体分支分派器（Main 注入 MediaService.stream；缺省时媒体路径 404） */
  resolveMedia?: MediaResolver
}

export async function registerCyreneProtocolHandler(opts: CyreneProtocolOptions): Promise<void> {
  const { rendererRoot, resolveMedia } = opts
  let realRoot: string | undefined
  let rootLower = ''
  let rootPrefix = ''
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  if (rendererRoot) {
    // P1-5：realpath 失败（如 dev 下 out/renderer 未构建）→ 置 realRoot=undefined，非媒体一律 404，不向上抛错阻断 main()
    try {
      realRoot = await realpath(rendererRoot)
      rootLower = lower(realRoot)
      rootPrefix = rootLower + sep
    } catch {
      realRoot = undefined
    }
  }
  protocol.handle(PROTOCOL_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    if (url.host !== RENDERER_HOST) return new Response('Not Found', { status: 404 })
    // G3：媒体分支（spec D1）——/__cyrene-media/{mediaType}/{id}；mediaType 白名单 + id 格式 + Sec-Fetch-Dest 由 MediaService 执行
    if (url.pathname.startsWith(MEDIA_PATH_PREFIX)) {
      const parsed = parseMediaPath(url.pathname)
      if (!parsed) return new Response('Forbidden', { status: 403 })
      if (!resolveMedia) return new Response('Not Found', { status: 404 })
      if (isDocumentRequest(request)) return new Response('Forbidden', { status: 403 })
      // P2-5：MediaService 抛错（如签名端点失败）不得成为 rejected promise——映射 502 transient 干净状态
      try {
        return await resolveMedia(parsed.mediaType, parsed.id, request)
      } catch {
        return new Response('Bad Gateway', { status: 502 })
      }
    }
    if (!realRoot) return new Response('Not Found', { status: 404 })
    const candidate = resolveRendererPath(realRoot, url.pathname)
    if (!candidate) return new Response('Forbidden', { status: 403 })
    let realCand: string
    try {
      realCand = await realpath(candidate)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    const inside = lower(realCand) === rootLower || lower(realCand).startsWith(rootPrefix)
    if (!inside) return new Response('Forbidden', { status: 403 })
    let target = realCand
    const st = await stat(target).catch(() => null)
    if (st && st.isDirectory()) {
      const idxPath = join(realCand, 'index.html')
      let realIdx: string | null
      try {
        realIdx = await realpath(idxPath)
      } catch {
        return new Response('Not Found', { status: 404 })
      }
      if (!(lower(realIdx) === rootLower || lower(realIdx).startsWith(rootPrefix))) {
        return new Response('Forbidden', { status: 403 })
      }
      target = realIdx
    }
    try {
      const res = await net.fetch(pathToFileURL(target).toString())
      const headers = new Headers(res.headers)
      const mime = mimeOf(target)
      if (mime) headers.set('Content-Type', mime)
      headers.set('Content-Security-Policy', RENDERER_CSP)
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
