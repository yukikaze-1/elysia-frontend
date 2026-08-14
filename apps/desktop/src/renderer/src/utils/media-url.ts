// src/renderer/src/utils/media-url.ts
// 阶段 3 G3（spec §4.4，D1）：Renderer 媒体 URL 构造——同源自定义协议 cyrene://renderer/__cyrene-media/{mediaType}/{id}。
// mediaType ∈ {attachment, sticker}（G4 贴图复用 sticker 分支）。
export type MediaRouteType = 'attachment' | 'sticker'
export const MEDIA_URL_BASE = 'cyrene://renderer/__cyrene-media'

export function mediaUrlFor(type: MediaRouteType, id: string): string {
  return `${MEDIA_URL_BASE}/${type}/${encodeURIComponent(id)}`
}
