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
import { LIVE2D_PATH_PREFIX, parseLive2dPath } from './live2d-path'
import { gateLive2dFile, gateHttpFailure, type Live2dResolverRegistry } from '../live2d/serve-gate'
import { getTrustedDevOrigins, isTrustedDevUrl } from '../config/trusted-renderer-origin'

const RENDERER_CSP = buildRendererCsp()

export type MediaResolver = (mediaType: MediaRouteType, id: string, request: Request) => Promise<Response>

export interface CyreneProtocolOptions {
  /** 渲染根（缺省时非媒体一律 404；media 分支不依赖 rendererRoot） */
  rendererRoot?: string
  /** 媒体分支分派器（Main 注入 MediaService.stream；缺省时媒体路径 404） */
  resolveMedia?: MediaResolver
  /** live2d 分支分派器（Main 注入 createLive2dResolver 组合闭包；缺省时 live2d 路径 404） */
  resolveLive2d?: (modelId: string, relPath: string, request: Request) => Promise<Response>
}

/** 闸门接口/判定自 live2d/serve-gate.ts 单一来源再导出（协议单测与 IPC 读取通道共用同一份判定） */
export type { Live2dResolverRegistry }

/**
 * 阶段 5 批次 A（A4）：live2d 供给分派闭包——registered+available 门禁 + fail-closed verify（首命中 await）+
 * resolveModelFile 白名单 + mime/no-store + dev CORS（受信 Origin 成功**与错误**响应均回补 ACAO + Vary）。
 *
 * 2026-09-10：门禁判定抽到 live2d/serve-gate.ts（gateLive2dFile），与 dev 形态的 IPC 供给通道共用——
 * 两条通道若各写一遍门禁，分叉的那一侧就是绕过入口。本闭包只剩「CORS 补头 + 读文件 + 状态码映射」。
 */
export function createLive2dResolver(registry: Live2dResolverRegistry): NonNullable<CyreneProtocolOptions['resolveLive2d']> {
  return async (modelId, relPath, request) => {
    const origin = request.headers.get('origin')
    let trustedOrigin: string | null = null
    if (origin) {
      try {
        // spec §3.4：回环 hostname 恒放任意端口 + allowlist 精确 origin 两条路径（getTrustedDevOrigins 记忆化）
        if (isTrustedDevUrl(new URL(origin), getTrustedDevOrigins())) trustedOrigin = origin
      } catch {
        trustedOrigin = null // 畸形 Origin（如 'null'/非 URL）→ 不视受信（fail-closed），不向上抛
      }
    }
    const withCors = (res: Response): Response => {
      if (!trustedOrigin) return res
      const headers = new Headers(res.headers)
      headers.set('Access-Control-Allow-Origin', trustedOrigin)
      headers.set('Vary', 'Origin')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }
    try {
      // 门禁判定（fail-closed verify → registered/available → containment 白名单）唯一实现在 serve-gate.ts
      const gate = await gateLive2dFile(registry, modelId, relPath)
      if (gate.kind !== 'ok') {
        const fail = gateHttpFailure(gate.kind)
        return withCors(new Response(fail.text, { status: fail.status }))
      }
      try {
        // 同 renderer-root 手法：local file 经 pathToFileURL + net.fetch 流式回传
        const res = await net.fetch(pathToFileURL(gate.absPath).toString())
        const headers = new Headers(res.headers)
        const mime = mimeOf(gate.absPath)
        if (mime) headers.set('Content-Type', mime)
        headers.set('Cache-Control', 'no-store') // Live2D 模型文件会话内一次性供给，禁用缓存（D5A-08）
        return withCors(new Response(res.body, { status: res.status, headers }))
      } catch {
        return withCors(new Response('Not Found', { status: 404 }))
      }
    } catch {
      // 封口：任何逃逸异常不越过本闭包（否则外层 handler 兜底会丢失 CORS 头）
      return withCors(new Response('Bad Gateway', { status: 502 }))
    }
  }
}

export async function registerCyreneProtocolHandler(opts: CyreneProtocolOptions): Promise<void> {
  const { rendererRoot, resolveMedia, resolveLive2d } = opts
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
    // 阶段 5 批次 A live2d 分支（spec §3.4/D5A-08）：/__cyrene-live2d/{modelId}/{relPath}——media 分支之后、renderer-root 之前。
    // 注册表 registered/available 门禁 + fail-closed verify + containment/白名单 + dev CORS 全部由 resolveLive2d 组合闭包执行。
    if (url.pathname.startsWith(LIVE2D_PATH_PREFIX)) {
      const parsed = parseLive2dPath(url.pathname)
      if (!parsed) return new Response('Forbidden', { status: 403 })
      if (!resolveLive2d) return new Response('Not Found', { status: 404 })
      if (isDocumentRequest(request)) return new Response('Forbidden', { status: 403 })
      try {
        return await resolveLive2d(parsed.modelId, parsed.relPath, request)
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
