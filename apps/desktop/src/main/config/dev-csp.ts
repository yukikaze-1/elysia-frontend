// src/main/config/dev-csp.ts
// 纯函数（electron-free）：electron.vite.config.ts 的 dev CSP 插件与单测共用。
// ws 源用 hostname（不含 port）+ :* 通配——u.host 含 port 会产出 ws://host:5173:* 非法。
// IPv6（hostname 以 [ 开头）跳过：Chromium 拒绝 ws://[::1]:*（invalid source），同源 ws 由 'self' 覆盖（verify:artifact 冒烟实测回归）。
export function buildDevCsp(trusted: ReadonlySet<string>): string {
  const wsSources: string[] = []
  for (const origin of trusted) {
    const u = new URL(origin)
    if (u.hostname.startsWith('[')) continue
    wsSources.push(`ws://${u.hostname}:*`, `wss://${u.hostname}:*`)
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: cyrene:",   // 阶段 3 G3（spec D1）：dev 页面在 http://localhost，媒体经 cyrene://renderer/__cyrene-media 放行
    "media-src 'self' cyrene:",             // 阶段 3 G3：视频/音频同源 cyrene: 放行（connect-src 不动）
    "font-src 'self' data:",
    `connect-src 'self' ${wsSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}
