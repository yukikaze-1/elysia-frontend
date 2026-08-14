export function buildRendererCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self'", // 阶段 3 G3（spec D1）：视频/音频经同源 cyrene://renderer 放行
    "font-src 'self' data:", // Vite 默认内联 <4KB 字体为 data: URI，须放行否则字体静默失效
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}
