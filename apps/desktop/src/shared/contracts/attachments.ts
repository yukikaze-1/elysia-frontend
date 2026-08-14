// src/shared/contracts/attachments.ts
// 阶段 3 G3（spec §4.2）：附件/队列/上传/媒体状态契约 + 限额单一事实来源（Renderer 预检与 Main 权威校验共用）。
// 队列联合含 G4 PendingSticker 分支（spec §2 G4 边界：贴图非附件，无上传/签名）。
import type { AttachmentKind, MessageAttachment } from './message'

export type AttachmentSource = 'picker' | 'drag_drop' | 'paste'
export type PendingAttachmentStatus = 'selected' | 'validating' | 'ready' | 'uploading' | 'failed' | 'cancelled'

/** G3 附件条目（状态机见 spec §4.3；省略 uploaded 瞬态，D4） */
export interface PendingAttachment {
  kind: 'attachment'
  localId: string
  name: string
  size: number
  mediaType: string
  source: AttachmentSource
  status: PendingAttachmentStatus
  reason?: string   // failed 的可解释原因
}

/** G4 表情包贴图挂入本队列的最小分支（sticker 非附件：无 attachmentId/上传/签名） */
export interface PendingSticker {
  kind: 'sticker'
  stickerId: string        // ^st_[A-Za-z0-9-]+$
  name?: string
  status: 'ready'          // 贴图无校验/上传阶段，入队即 ready
}

export type PendingSendItem = PendingAttachment | PendingSticker

/** 上传文件描述符（Renderer→Preload 携带 file?/bytes?；Preload 以 webUtils 注入 path；IPC 至 Main 时 path?/bytes? 二选一） */
export interface UploadFileDescriptor {
  localId: string
  name: string
  size: number
  mediaType: string
  source: AttachmentSource
  kind?: AttachmentKind      // 校验阶段魔数判定的每文件 kind（P2-3：批量上传按文件 kind；可省略由后端魔数判定）
  path?: string              // 仅 Preload 注入；Renderer 永不构造
  bytes?: Uint8Array         // 仅粘贴型（pathless）
}

/** 校验结果（per-file） */
export interface FileValidationResult { localId: string; ok: boolean; kind?: AttachmentKind; reason?: string; message?: string }

/** 上传响应（batch 原子，一次调用） */
export interface AttachmentsUploadResponse { uploadId: string; attachments: MessageAttachment[] }

/** 媒体状态分类（元素 error 后按需经 attachments:check 查询） */
export type AttachmentMediaStatus = 'ok' | 'expired' | 'not_found' | 'revoked' | 'error'
export interface AttachmentCheckResult { status: AttachmentMediaStatus; reason?: string }

/** 后端上传响应条目（契约 frontend_contract AttachmentInfo；kind 权威） */
export interface AttachmentInfo {
  attachmentId: string
  kind: string
  mime: string
  size: number
  url: string
  signedUrl?: string
  filename: string
}

/** 签发端点响应（GET /api/attachments/{id}/sign） */
export interface AttachmentSignResult { url: string; expiresAt: string }

// —— 限额（D-04 后端数值沿用；Renderer 预检与 Main 权威校验共用，单一事实来源）——
export const ATTACHMENT_MAX_FILES = 10
export const ATTACHMENT_AGGREGATE_BYTES = 64 * 1024 * 1024
export const ATTACHMENT_MAX_BYTES_BY_KIND: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  file: 20 * 1024 * 1024,
  link: 0
}

/** kind → 接受 MIME 白名单（D-03 播放矩阵参考表；列表外一律 file 图标卡） */
export const ATTACHMENT_KIND_MIME: Record<AttachmentKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'],
  video: ['video/mp4', 'video/webm', 'video/ogg'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'],
  file: [],
  link: []
}
