// apps/desktop/src/main/protocol/handler.ts
import { net, protocol } from 'electron'
import { realpath, stat } from 'fs/promises'
import { join, sep } from 'path'
import { pathToFileURL } from 'url'
import { PROTOCOL_SCHEME, RENDERER_HOST } from './scheme'
import { resolveRendererPath } from './path'
import { buildRendererCsp } from './csp'
import { mimeOf } from './mime'

const RENDERER_CSP = buildRendererCsp() // 模块级常量：全进程 CSP 头值恒定，不在每个请求重建

export async function registerCyreneProtocolHandler(rendererRoot: string): Promise<void> {
  const realRoot = await realpath(rendererRoot) // 注册时解析一次（渲染根固定），不在每个请求重算
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const rootLower = lower(realRoot)
  const rootPrefix = rootLower + sep
  protocol.handle(PROTOCOL_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    if (url.host !== RENDERER_HOST) return new Response('Not Found', { status: 404 })
    const candidate = resolveRendererPath(rendererRoot, url.pathname)
    if (!candidate) return new Response('Forbidden', { status: 403 })
    // realpath 包含性（symlink 逃逸防线）：仅对请求路径做一次 realpath
    let realCand: string
    try {
      realCand = await realpath(candidate)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    const inside = lower(realCand) === rootLower || lower(realCand).startsWith(rootPrefix)
    if (!inside) return new Response('Forbidden', { status: 403 })
    // 目录 → index.html：对 join 出的 index.html 再做 realpath + 包含性（防目录内 index.html 为 symlink 逃逸）
    let target = realCand
    const st = await stat(target).catch(() => null)
    if (st && st.isDirectory()) {
      const idxPath = join(realCand, 'index.html')
      let realIdx: string | null
      try {
        realIdx = await realpath(idxPath)
      } catch {
        return new Response('Not Found', { status: 404 }) // 目录内无 index.html → 资源缺失（404），非越权（403）
      }
      if (!(lower(realIdx) === rootLower || lower(realIdx).startsWith(rootPrefix))) {
        return new Response('Forbidden', { status: 403 }) // symlink 逃逸 → 403
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
