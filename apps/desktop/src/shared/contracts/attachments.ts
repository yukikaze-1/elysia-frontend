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

/** 上传文件描述符（Renderer→Preload 携带 file?/bytes?；Preload 以 webUtils 注入**不可猜 fileRef**；IPC 至 Main 时 fileRef?/bytes? 二选一） */
export interface UploadFileDescriptor {
  localId: string
  name: string
  size: number
  mediaType: string
  source: AttachmentSource
  kind?: AttachmentKind      // 校验阶段魔数判定的每文件 kind（P2-3：批量上传按文件 kind；可省略由后端魔数判定）
  /**
   * **S5-B2（2026-09-15）：不可猜文件引用**——Main 签发的会话内 token，由 Main 自己维护的
   * `fileRef → realpath` 表解析。Preload 是**唯一**铸造点（`webUtils.getPathForFile` 的产物立刻登记换 token），
   * `fileRef` 本身不含路径信息。
   *
   * **为什么要有它**：原设计此处是 Renderer 可传的裸 `path` 字符串。虽然实测证明 Renderer **伪造不出**
   * 指向任意主机路径的 `File`（合成 File 的 `getPathForFile` 恒返空串，见
   * `tests/integration/h01-fileref-probe.spec.ts`），但「路径由对端命名」这件事本身就是边界上的弱点：
   * 它把安全性寄托在 Chromium 的 `getPathForFile` 行为上，且 Main 侧无从区分「用户真的选了这个文件」
   * 与「对端说它选了」。改为 token 后，**Main 自己的表**成为信任锚——Renderer 只能引用 Main 登记过的文件。
   */
  fileRef?: string           // 仅 Preload 注入（Main 签发）；Renderer 永不构造，也无从构造
  bytes?: Uint8Array         // 仅粘贴型（无文件句柄）
}

/** 文件引用登记响应（Preload → Main：递上 preload 解析出的真实路径，换回不可猜 token） */
export interface FileRefRegisterResponse { fileRef: string }

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
/**
 * 单文件**全局**上限（= 各 kind 上限的最大值，当前为 video 的 50 MiB）。
 *
 * 安全评审 S4（2026-09-15）：`attachments:upload` 的 `bytes` 分支此前只按**对端自报**的 `size` 判限，
 * `byteLength` 从不校验 ⇒ 限额对不可信对端等于不存在。现在两处按**真实**字节数复核：
 *   · `fileRef` 分支（真实拖入/选择）——Main 自己 `stat` 得真值，按本表的 kind 上限判；
 *   · `bytes` 分支（粘贴型）——按 `byteLength` 判，且**先**受 IPC 全局不变量 `MAX_IPC_MESSAGE_BYTES`（4 MiB）约束。
 * 即：本常量只对**不经 IPC 传载荷**的 `fileRef` 分支构成实际上限。
 */
export const ATTACHMENT_MAX_SINGLE_BYTES = Math.max(...Object.values(ATTACHMENT_MAX_BYTES_BY_KIND))

/** kind → 接受 MIME 白名单（D-03 播放矩阵参考表；列表外一律 file 图标卡） */
export const ATTACHMENT_KIND_MIME: Record<AttachmentKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'],
  video: ['video/mp4', 'video/webm', 'video/ogg'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm'],
  file: [],
  link: []
}
