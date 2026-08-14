// src/renderer/src/utils/media.ts
// 阶段 3 G3（spec §4.6，D9）：播放矩阵纯常量（D-03 参考表）——可播 MIME 白名单、isPlayable、formatFileSize、kindFromMime（Renderer 侧，与 Main attachment-policy 同源实现）。
import type { AttachmentKind } from '@shared/contracts'
import { ATTACHMENT_KIND_MIME } from '@shared/contracts/attachments'

/** 可播放 MIME 矩阵（视频 mp4/webm/ogv 可播；mkv/mov/h265 标「暂不支持播放」图标卡；列表外一律 file 图标卡） */
export const PLAYABLE_MEDIA: Record<AttachmentKind, readonly string[]> = {
  image: ATTACHMENT_KIND_MIME.image,
  video: ATTACHMENT_KIND_MIME.video,
  audio: ATTACHMENT_KIND_MIME.audio,
  file: [],
  link: []
}

export function isPlayable(kind: AttachmentKind, mime: string): boolean {
  return PLAYABLE_MEDIA[kind]?.includes(mime) ?? false
}

/** MIME → kind 白名单匹配，列表外一律 file（Renderer 侧同源实现，与 Main attachment-policy 一致） */
export function kindFromMime(mime: string): AttachmentKind {
  const k = (Object.keys(ATTACHMENT_KIND_MIME) as AttachmentKind[]).find((kk) => kk !== 'file' && kk !== 'link' && ATTACHMENT_KIND_MIME[kk].includes(mime))
  return k ?? 'file'
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
