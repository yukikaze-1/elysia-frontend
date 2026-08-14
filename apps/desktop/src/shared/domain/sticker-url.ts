// src/shared/domain/sticker-url.ts
// 阶段 3 G4（spec §4.6 P3-3）：历史资源 URL → stickerId 解析 + 渲染 URL 构造。
// stickerId 白名单 ^st_[A-Za-z0-9-]+$（D-07 st_ 前缀 + 安全字符）；校验失败回 undefined，绝不注入任意 URL。
export const STICKER_ID_PATTERN = /^st_[A-Za-z0-9-]+$/

/** 历史项 resource.url（后端路径，如 /static/stickers/st_xxx.png）→ stickerId；非法回 undefined。
 *  相对路径以固定占位 origin 解析取 pathname 末段（等价 new URL(url, 配置后端 origin).pathname 的末段，URL 归一化已处理 `..`）。 */
export function stickerIdFromResourceUrl(url: string): string | undefined {
  if (!url) return undefined
  let pathname: string
  try {
    pathname = new URL(url, 'http://cyrene.invalid').pathname
  } catch {
    return undefined
  }
  const tail = pathname.split('/').filter(Boolean).pop() ?? ''
  const id = tail.replace(/\.png$/i, '')
  return STICKER_ID_PATTERN.test(id) ? id : undefined
}

/** 渲染 URL 构造（复用 G3 通用媒体代理，无新 scheme） */
export function stickerRenderUrl(stickerId: string): string {
  return `cyrene://renderer/__cyrene-media/sticker/${encodeURIComponent(stickerId)}`
}
