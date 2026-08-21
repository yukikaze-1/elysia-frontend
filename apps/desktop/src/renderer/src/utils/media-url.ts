// src/renderer/src/utils/media-url.ts
// 阶段 3 G3（spec §4.4，D1）：Renderer 媒体 URL 构造——同源自定义协议 cyrene://renderer/__cyrene-media/{mediaType}/{id}。
// mediaType ∈ {attachment, sticker, tool-capture}（工具截图由 Main 鉴权代理）。
export type MediaRouteType = 'attachment' | 'sticker' | 'tool-capture'
export const MEDIA_URL_BASE = 'cyrene://renderer/__cyrene-media'

export function mediaUrlFor(type: MediaRouteType, id: string, nonce?: number): string {
  const base = `${MEDIA_URL_BASE}/${type}/${encodeURIComponent(id)}`
  // P1-2：nonce 追加 ?t= 缓存破坏——占位重试重挂载时换 URL 强制重新请求协议，Main 重新 resolve/重签签名
  return nonce === undefined ? base : `${base}?t=${nonce}`
}
