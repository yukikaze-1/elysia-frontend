// src/main/transport/protocol-v2/content-part.ts
// 阶段 3 G3（spec §4.4/§4.5，D7）：媒体 ContentPart 建模——schema 保持 content:unknown，
// 建模在映射层（两 schema content 为 z.unknown().optional()，媒体本可过 .strict() 解析，真实缺口是映射层丢媒体）。
import type { AttachmentKind, MessageAttachment } from '@shared/contracts/message'

const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]+$/

export interface MappedMedia {
  kind: 'image' | 'video' | 'audio' | 'file'
  attachmentId?: string
  url?: string
  mediaType?: string
  name?: string
  size?: number
  width?: number
  height?: number
  durationMs?: number
}

interface ContentPartShape {
  type?: string
  src?: string
  mime?: string
  attachment_id?: string
  filename?: string
  size_bytes?: number
  width?: number
  height?: number
  duration_ms?: number
}

/** src 稳定路径尾段解析 att_ ID；格式不匹配返回 undefined（spec §6：attachment_id 优先，src 兜底解析并校验格式） */
export function parseAttachmentIdFromSrc(src?: string): string | undefined {
  if (!src) return undefined
  const tail = src.split('/').pop() ?? ''
  const m = tail === src ? undefined : tail   // 纯 ID（无 '/'）也接受；其余经 '/api/attachments/{id}' 尾段
  const id = m ?? (/\/api\/attachments\/([^/]+)$/.exec(src)?.[1] ?? (ATTACHMENT_ID_PATTERN.test(src) ? src : undefined))
  if (id && ATTACHMENT_ID_PATTERN.test(id)) return id
  return undefined
}

function toMedia(part: ContentPartShape, kind: 'image' | 'video' | 'audio' | 'file'): MappedMedia {
  const attachmentId = part.attachment_id ?? parseAttachmentIdFromSrc(part.src)
  return {
    kind,
    ...(attachmentId ? { attachmentId } : {}),
    ...(part.src ? { url: part.src } : {}),
    ...(part.mime ? { mediaType: part.mime } : {}),
    ...(part.filename ? { name: part.filename } : {}),
    ...(part.size_bytes !== undefined ? { size: part.size_bytes } : {}),
    ...(part.width !== undefined ? { width: part.width } : {}),
    ...(part.height !== undefined ? { height: part.height } : {}),
    ...(part.duration_ms !== undefined ? { durationMs: part.duration_ms } : {})
  }
}

/** 有序文本/媒体条目（assemble 据此分配全局 segmentIndex；sticker/未知 type 忽略——G4 边界） */
export function mapContentToEntries(content: unknown): Array<{ type: 'text'; text: string } | { type: 'media'; media: MappedMedia }> {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const entries: Array<{ type: 'text'; text: string } | { type: 'media'; media: MappedMedia }> = []
  for (const p of content) {
    if (typeof p !== 'object' || p === null) continue
    const part = p as ContentPartShape
    if (part.type === 'text' && typeof (part as unknown as { text?: unknown }).text === 'string' && (part as unknown as { text: string }).text.length > 0) {
      entries.push({ type: 'text', text: (part as unknown as { text: string }).text })
    } else if (part.type === 'image' || part.type === 'video' || part.type === 'audio' || part.type === 'file') {
      entries.push({ type: 'media', media: toMedia(part, part.type) })
    }
    // sticker/status/未知：G4 贴图消费，本批不产媒体条目
  }
  return entries
}

/** 消息级附件（user/assistant 消息 content 中的媒体 → Message.attachments；无 attachmentId 不产） */
export function mapContentMedia(content: unknown): MessageAttachment[] {
  const attachments: MessageAttachment[] = []
  for (const entry of mapContentToEntries(content)) {
    if (entry.type !== 'media') continue
    const m = entry.media
    if (!m.attachmentId) continue
    attachments.push({
      attachmentId: m.attachmentId,
      kind: m.kind as AttachmentKind,
      mediaType: m.mediaType ?? 'application/octet-stream',
      ...(m.name ? { name: m.name } : {}),
      ...(m.size !== undefined ? { size: m.size } : {}),
      ...(m.width !== undefined ? { width: m.width } : {}),
      ...(m.height !== undefined ? { height: m.height } : {}),
      ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {})
    })
  }
  return attachments
}
