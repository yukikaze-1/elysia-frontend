// apps/desktop/src/main/windows/navigation.ts
import { RENDERER_HOST } from '../protocol/constants'

export function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host
}

// 'app' → 应用自身导航；'external' → 系统浏览器；其余 deny（fail-closed）
// devOrigin / usingDevServer 由 createMainWindow 解析一次传入（启动后恒定，不在每次导航重算）。
// usingDevServer = shouldUseViteDevServer（未打包 && 有 ELECTRON_RENDERER_URL）：无 dev server（test/production 构建、
// --mode development 直启、打包）都是 cyrene:// 形态——导航谓词与加载谓词同源，避免直启加载 cyrene:// 但导航被 deny。
// 已知怪癖：dev 下以 127.0.0.1 别名访问同一 Vite 服务（localhost）会被判 external 走系统浏览器（host 含端口比较），dev 独有、可接受。
export function classifyNavigation(
  targetUrl: string,
  devOrigin: URL | undefined,
  usingDevServer: boolean
): 'app' | 'external' | 'deny' {
  try {
    const url = new URL(targetUrl)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (usingDevServer && devOrigin && sameOrigin(url, devOrigin)) {
        // dev 同源：@fs/@vite 文件代理前缀拒绝（先解码 pathname，防 %40fs 编码绕过；不开外部浏览器）
        let decodedPath = url.pathname
        try { decodedPath = decodeURIComponent(url.pathname) } catch { /* 畸形编码按原样 */ }
        return decodedPath.startsWith('/@fs/') || decodedPath.startsWith('/@vite/') ? 'deny' : 'app'
      }
      return 'external'
    }
    if (!usingDevServer && url.protocol === 'cyrene:' && url.host === RENDERER_HOST) {
      return 'app' // 路径包含性已由 protocol handler 强制（handler 对越界 403）
    }
    return 'deny'
  } catch {
    return 'deny'
  }
}
