// src/main/attachments/upload-service.ts
// 阶段 3 G3（spec §4.4/§4.5/§4.8）：Main 附件校验链 + 批量上传 + 取消。
// 路径只在 Main 流转（D5）；上传 IPC 日志脱敏（不记 path/name 原文，spec §4.5/§4.8）。
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { FileValidationResult, MessageAttachment, UploadFileDescriptor } from '@shared/contracts'
import type { AttachmentInfo, AttachmentKind } from '@shared/contracts'
import type { BackendAdapter, UploadContent } from '../transport/backend-adapter'
import type { SafeOpenPlatform } from '../persistence/safe-open'
import { precheckFiles, sniffKind, sizeLimitFor } from './attachment-policy'

export interface UploadFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ size: number; isFile(): boolean }>
  readFile(p: string): Promise<Uint8Array>
  open(p: string, flags: number): Promise<{ close(): Promise<void>; stat(): Promise<{ size: number; isFile(): boolean }>; read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }> }>
}

export interface UploadServiceDeps {
  backend: Pick<BackendAdapter, 'uploadAttachments'>
  userDataBase: () => string
  platform: SafeOpenPlatform
  fs?: UploadFs
}

const HEAD_LEN = 16

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + '/') || (process.platform === 'win32' && p.toLowerCase().startsWith(root.toLowerCase() + '\\'))
}

function toDomainAttachment(a: AttachmentInfo, messageId?: string): MessageAttachment {
  const kind = (['image', 'video', 'audio', 'file'].includes(a.kind) ? a.kind : 'file') as AttachmentKind
  const out: MessageAttachment = { attachmentId: a.attachmentId, kind, mediaType: a.mime, ...(a.filename ? { name: a.filename } : {}), ...(a.size !== undefined ? { size: a.size } : {}) }
  if (messageId) out.messageId = messageId
  return out
}

/** 真实 fs 实现（node 环境；测试注入假 UploadFs） */
function realFs(): UploadFs {
  // fs/promises 动态 import（仅在构造时解析一次）
  return {
    realpath: async (p: string) => (await import('fs/promises')).realpath(p),
    stat: async (p: string) => {
      const s = await (await import('fs/promises')).stat(p)
      return { size: s.size, isFile: () => s.isFile() }
    },
    readFile: async (p: string) => new Uint8Array(await (await import('fs/promises')).readFile(p)),
    open: async (p: string, flags: number) => {
      const fh = await (await import('fs/promises')).open(p, flags)
      return {
        close: async () => { await fh.close() },
        stat: async () => {
          const s = await fh.stat()
          return { size: s.size, isFile: () => s.isFile() }
        },
        read: async (buffer: Uint8Array, offset: number, length: number) => {
          const r = await fh.read(buffer, offset, length, -1)
          return { bytesRead: r.bytesRead }
        }
      }
    }
  }
}

export class UploadService {
  private readonly fs: UploadFs
  private readonly platform: SafeOpenPlatform
  private readonly backend: UploadServiceDeps['backend']
  private readonly userDataBase: () => string
  private readonly active = new Map<string, AbortController>()

  constructor(deps: UploadServiceDeps) {
    this.backend = deps.backend
    this.userDataBase = deps.userDataBase
    this.platform = deps.platform
    this.fs = deps.fs ?? realFs()
  }

  async validateFiles(descriptors: UploadFileDescriptor[]): Promise<FileValidationResult[]> {
    const pre = precheckFiles(descriptors.map((d) => ({ name: d.name, size: d.size, mediaType: d.mediaType })))
    // P1-1：逐项校验（spec §4.3/§4.4）——聚合级（数量/聚合大小）整批 failed；单文件超限/类型问题只 fail 该文件，
    // 其余合法文件继续 path/bytes 校验（batch 原子仅指上传不指校验，D3）
    const aggregate = pre.issues.find((i) => i.reason === 'too_large_aggregate' || i.reason === 'too_many')
    const results: FileValidationResult[] = []
    for (let index = 0; index < descriptors.length; index++) {
      const d = descriptors[index]
      if (aggregate) {
        results.push({ localId: d.localId, ok: false, reason: aggregate.reason })
        continue
      }
      // 逐项 issue 按位置匹配（index），避免同名文件被首个匹配误判
      const perFile = pre.issues.find((i) => i.reason !== 'too_large_aggregate' && i.reason !== 'too_many' && i.index === index)
      if (perFile) {
        results.push({ localId: d.localId, ok: false, reason: perFile.reason, message: perFile.reason === 'size_limit' ? '超过该类型大小上限' : '不支持的文件类型' })
        continue
      }
      if (d.path) {
        try {
          const real = await this.fs.realpath(d.path)
          if (isInside(this.userDataBase(), real)) {
            results.push({ localId: d.localId, ok: false, reason: 'forbidden_path', message: '拒绝上传应用数据目录内的文件' })
            continue
          }
          const fd = await this.fs.open(d.path, this.platform.existingReadFlags)
          let st
          try { st = await fd.stat() } finally { await fd.close() }
          if (!st.isFile()) {
            results.push({ localId: d.localId, ok: false, reason: 'not_readable', message: '不是普通文件（目录/管道/设备）' })
            continue
          }
          const head = new Uint8Array(HEAD_LEN)
          const hfd = await this.fs.open(d.path, this.platform.existingReadFlags)
          let bytesRead = 0
          try { bytesRead = (await hfd.read(head, 0, HEAD_LEN)).bytesRead } finally { await hfd.close() }
          const kind = sniffKind(head.subarray(0, bytesRead))
          const fsStat = await this.fs.stat(d.path)
          if (fsStat.size > sizeLimitFor(kind)) {
            results.push({ localId: d.localId, ok: false, reason: 'size_limit', message: '超过该类型大小上限' })
            continue
          }
          results.push({ localId: d.localId, ok: true, kind })
        } catch {
          results.push({ localId: d.localId, ok: false, reason: 'not_readable', message: '无法读取文件' })
        }
      } else if (d.bytes) {
        results.push({ localId: d.localId, ok: true, kind: sniffKind(d.bytes.subarray(0, HEAD_LEN)) })
      } else {
        results.push({ localId: d.localId, ok: false, reason: 'invalid', message: '缺少 bytes/path' })
      }
    }
    return results
  }

  async uploadBatch(uploadId: string, descriptors: UploadFileDescriptor[]): Promise<MessageAttachment[]> {
    const controller = new AbortController()
    this.active.set(uploadId, controller)
    try {
      const uploads: UploadContent[] = []
      for (const d of descriptors) {
        if (d.path) {
          // P2-2：敏感范围复验（realpath+isInside，与 validateFiles 同级防御，防 Renderer 伪造 path）
          const real = await this.fs.realpath(d.path)
          if (isInside(this.userDataBase(), real)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `拒绝上传应用数据目录内的文件: ${d.localId}`)
          // 上传前 fs.stat 复验：实际大小与普通文件（防 Renderer 伪造描述符/队列状态漂移，spec §4.5）
          const st = await this.fs.stat(d.path)
          if (!st.isFile()) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件不是普通文件: ${d.localId}`)
          // P2-1：kind 复验与 validateFiles 统一用 sniffKind（魔数），不用 kindFromMime（MIME 可伪造）——查限一致
          const head = new Uint8Array(HEAD_LEN)
          const hfd = await this.fs.open(d.path, this.platform.existingReadFlags)
          let bytesRead = 0
          try { bytesRead = (await hfd.read(head, 0, HEAD_LEN)).bytesRead } finally { await hfd.close() }
          const kind = sniffKind(head.subarray(0, bytesRead))
          if (st.size > sizeLimitFor(kind)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件超过大小上限: ${d.localId}`)
          uploads.push({ name: d.name, mediaType: d.mediaType, size: st.size, kind, path: d.path, bytes: new Uint8Array(await this.fs.readFile(d.path)) })
        } else if (d.bytes) {
          // P2-1：bytes 分支也按魔数嗅探 kind 复验大小（此前无大小复验）
          const kind = sniffKind(d.bytes.subarray(0, HEAD_LEN))
          if (d.size > sizeLimitFor(kind)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件超过大小上限: ${d.localId}`)
          uploads.push({ name: d.name, mediaType: d.mediaType, size: d.size, kind, bytes: d.bytes })
        } else {
          throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件缺少 bytes/path: ${d.localId}`)
        }
      }
      // P1-1：把 active controller 的 signal 传给 backend——cancel(uploadId) abort 后，RealBackend 经
      // AbortSignal.any 组合信号令 fetch 终止并以 cancelled 错误 reject（IPC 层 → 条目 cancelled，spec §4.1 D10/§5 验收#4）
      const infos = await this.backend.uploadAttachments(uploads, { signal: controller.signal })   // batch 原子（全成或全不成）
      return infos.map((a) => toDomainAttachment(a))
    } finally {
      this.active.delete(uploadId)
    }
  }

  cancel(uploadId: string): void {
    const c = this.active.get(uploadId)
    if (c) c.abort()
  }

  dispose(): void {
    for (const c of this.active.values()) c.abort()
    this.active.clear()
  }
}
