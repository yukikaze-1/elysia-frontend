// src/main/attachments/attachment-policy.ts
// 阶段 3 G3（spec §4.5/§3.2 D-04）：纯校验策略——kind 矩阵、魔数嗅探、限额预检。
// 与 Renderer 共用 ATTACHMENT_* 常量（shared/contracts/attachments.ts 单一事实来源）；本模块无 fs 依赖。
import { ATTACHMENT_AGGREGATE_BYTES, ATTACHMENT_KIND_MIME, ATTACHMENT_MAX_BYTES_BY_KIND, ATTACHMENT_MAX_FILES } from '@shared/contracts/attachments'
import type { AttachmentKind } from '@shared/contracts/message'

/** 白名单 MIME → kind；列表外一律 file（spec §4.6 播放矩阵） */
export function kindFromMime(mime: string): AttachmentKind {
  const k = (Object.keys(ATTACHMENT_KIND_MIME) as AttachmentKind[]).find((kk) => kk !== 'file' && kk !== 'link' && ATTACHMENT_KIND_MIME[kk].includes(mime))
  return k ?? 'file'
}

export function isKindAcceptable(kind: AttachmentKind, mime: string): boolean {
  if (kind === 'file') return true
  return ATTACHMENT_KIND_MIME[kind].includes(mime)
}

export function sizeLimitFor(kind: AttachmentKind): number {
  return ATTACHMENT_MAX_BYTES_BY_KIND[kind]
}

/** 轻量魔数嗅探表（小表：常见 image/video/audio 签名；后端魔数为权威，本表用于客户端校验提示） */
function sniff(bytes: Uint8Array): 'image' | 'video' | 'audio' | null {
  const at = (off: number): number => bytes[off] ?? 0
  if (bytes.length < 4) return null
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image'   // PNG
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image'                       // JPEG
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image'     // GIF
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46) {
    if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image'  // WEBP
    if (bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return 'audio'  // WAV
    return null
  }
  if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0x00 && bytes[3] !== undefined && at(3) >= 0x08 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video'  // MP4 ftyp
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'video'      // EBML(webm)
  if (at(0) === 0x4f && at(1) === 0x67 && at(2) === 0x67 && at(3) === 0x53) return 'audio'      // OggS
  if (at(0) === 0x49 && at(1) === 0x44 && at(2) === 0x33) return 'audio'                       // ID3(mp3)
  if (at(0) === 0x66 && at(1) === 0x4c && at(2) === 0x61 && at(3) === 0x43) return 'audio'      // fLaC
  return null
}

/** 魔数嗅探 → kind（未知 → file，最终以后端魔数真值为准） */
export function sniffKind(head: Uint8Array): AttachmentKind {
  return sniff(head) ?? 'file'
}

export interface PrecheckIssue {
  name: string
  reason: 'too_many' | 'too_large_aggregate' | 'size_limit' | 'unsupported_type'
}

/** 客户端/权威共用的预检：数量 ≤10 / 聚合 ≤64MB / 单文件按 kind 限额（D-04 沿用后端数值） */
export function precheckFiles(files: Array<{ name: string; size: number; mediaType: string }>): { ok: boolean; issues: PrecheckIssue[] } {
  const issues: PrecheckIssue[] = []
  if (files.length > ATTACHMENT_MAX_FILES) issues.push({ name: files[0]?.name ?? '', reason: 'too_many' })
  const aggregate = files.reduce((s, f) => s + f.size, 0)
  if (aggregate > ATTACHMENT_AGGREGATE_BYTES) issues.push({ name: files[0]?.name ?? '', reason: 'too_large_aggregate' })
  for (const f of files) {
    const kind = kindFromMime(f.mediaType)
    if (!isKindAcceptable(kind, f.mediaType) && kind !== 'file') {
      issues.push({ name: f.name, reason: 'unsupported_type' })
    }
    if (f.size > sizeLimitFor(kind)) issues.push({ name: f.name, reason: 'size_limit' })
  }
  return { ok: issues.length === 0, issues }
}
