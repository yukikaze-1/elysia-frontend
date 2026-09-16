// src/main/attachments/upload-service.ts
// 阶段 3 G3（spec §4.4/§4.5/§4.8）：Main 附件校验链 + 批量上传 + 取消。
// 路径只在 Main 流转（D5）；上传 IPC 日志脱敏（不记 path/name 原文，spec §4.5/§4.8）。
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { FileValidationResult, MessageAttachment, UploadFileDescriptor } from '@shared/contracts'
import type { AttachmentInfo, AttachmentKind } from '@shared/contracts'
import { ATTACHMENT_AGGREGATE_BYTES } from '@shared/contracts/attachments'
import type { AttachmentBackendPort, UploadContent } from '../transport/backend-ports'
import type { SafeOpenPlatform } from '../persistence/safe-open'
import { precheckFiles, sniffKind, sizeLimitFor, wireKindHint } from './attachment-policy'
import { isPathBlacklisted } from '../tools/tool-policy'
import type { FileRefRegistry } from './file-ref'

export interface UploadFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ size: number; isFile(): boolean }>
  readFile(p: string): Promise<Uint8Array>
  open(p: string, flags: number): Promise<{ close(): Promise<void>; stat(): Promise<{ size: number; isFile(): boolean }>; read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }> }>
}

export interface UploadServiceDeps {
  /** 只需"上传字节"这一项能力（`AttachmentBackendPort` 的窄视图；签名 URL 与归档读取属于 MediaService） */
  backend: Pick<AttachmentBackendPort, 'uploadAttachments'>
  userDataBase: () => string
  platform: SafeOpenPlatform
  /**
   * S5-B2（2026-09-15）：不可猜文件引用表（Main 签发 token → 路径）。
   * 缺省不提供 ⇒ 任何带 `fileRef` 的描述符一律 fail-closed（`forbidden_path`）：这条链**永远不接受裸路径**。
   */
  fileRefs?: FileRefRegistry
  fs?: UploadFs
  /**
   * S5-B2 复核修正（2026-09-15）：被拒的**具体**原因只进 Main 日志。
   * 公开面（`FileValidationResult` / 抛出的 `CyreneError`）一律不可区分——见 `PATH_REFUSED_MESSAGE`。
   */
  logger?: { warn: (event: string, fields?: Record<string, string | number | boolean>) => void }
}

const HEAD_LEN = 16

/**
 * S5-B2 复核修正（2026-09-15）：**路径类失败的唯一公开文案**。
 *
 * 背景（安全评审 S7）：本链的失败文案此前分四种——「引用无效或已过期」「拒绝上传应用数据目录内的文件」
 * 「拒绝读取系统或凭据敏感目录内的文件」「无法读取文件」。而对端可以**登记任意字符串**再 `validate`，
 * 于是四种文案的差异构成一个**文件存在性/敏感性 oracle**：命中敏感目录黑名单意味着 `realpath` 成功
 * ⇒ 该路径**存在**；`无法读取` 则意味着不存在或不可读。被攻陷的 Renderer 本拿不到本地文件信息，
 * 这条于是是**新增信息面**——S5-B2 决策记录 §2.1「即便对端直调也无收益」的表述因此不成立（就读取成立、
 * 就信息面不成立）。
 *
 * 修法：四种情形对外合成同一句话（reason 也统一为 `forbidden_path`），具体是哪一种只经 `logger.warn`
 * 落 Main 日志（诊断能力不损失，因为诊断从来不该依赖公开面）。
 */
export const PATH_REFUSED_MESSAGE = '文件不可用：引用无效、位置受限或无法读取'

/**
 * 描述符的**真实**字节数（安全评审 S4，2026-09-15）。
 *
 * `size` 是**对端自报**的字段，任何限额用它判定都等于没有限额：伪造 `{ size: 1, bytes: <数百 MB> }`
 * 可以同时穿过 schema、预检与上传前复核。`bytes` 分支一律改用 `byteLength`；
 * `fileRef` 分支没有 `bytes`，其真值由 Main 自己的 `stat` 给出（见 `uploadBatch`）。
 */
function descriptorSize(d: UploadFileDescriptor): number {
  return d.bytes !== undefined ? d.bytes.byteLength : d.size
}

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + '/') || (process.platform === 'win32' && p.toLowerCase().startsWith(root.toLowerCase() + '\\'))
}

/**
 * 敏感路径黑名单（H-01，2026-09-11）。
 *
 * 背景：附件链此前的唯一边界是「排除 userData 一个目录」+「须为普通文件」+「按魔数嗅探的大小上限」。
 * 工具域早就有 `PATH_BLACKLIST_DEFAULTS`（`~/.ssh`、`~/.aws`、`~/.gnupg`、`.env`、`.git-credentials`…），
 * 但它**在这条链上一次都没被调用**——于是「Renderer 被攻陷 → 读任意文件 → POST 到任意 HTTPS 主机」
 * 这条链条成立（违反 CLAUDE.md 的进程边界不变量：Renderer 不得指认本地路径）。
 *
 * 本条为**止血**：只把既有黑名单接进来。
 * **结构性修法已于 2026-09-15 落地（S5-B2）**：`UploadFileDescriptor.path` 已从 IPC 面移除，改由 Main 签发的
 * 不可猜 `fileRef`（`file-ref.ts`）解析 ⇒ 对端再也无法在本通道上命名主机路径。
 * 传入的必须是 realpath 后的路径——黑名单按 realpath 段边界匹配，符号链接已在此之前解开。
 */
function blacklistMessage(realPath: string, platformKind: 'posix' | 'windows'): string | undefined {
  return isPathBlacklisted(realPath, undefined, { platform: platformKind })
    ? '拒绝读取系统或凭据敏感目录内的文件'
    : undefined
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
  private readonly fileRefs?: FileRefRegistry
  private readonly logger?: { warn: (event: string, fields?: Record<string, string | number | boolean>) => void }
  private readonly active = new Map<string, AbortController>()

  constructor(deps: UploadServiceDeps) {
    this.backend = deps.backend
    this.userDataBase = deps.userDataBase
    this.platform = deps.platform
    this.fileRefs = deps.fileRefs
    this.logger = deps.logger
    this.fs = deps.fs ?? realFs()
  }

  /** 路径类拒绝的唯一出口：公开面不可区分，原因只进 Main 日志（见 `PATH_REFUSED_MESSAGE`） */
  private refuse(localId: string, detail: string): FileValidationResult {
    this.logger?.warn('attachments:refused', { code: 'forbidden_path', detail, localId })
    return { localId, ok: false, reason: 'forbidden_path', message: PATH_REFUSED_MESSAGE }
  }

  /** 同上，但用于会抛出错误的 `uploadBatch` 路径——文案与 `refuse` 一致，原因同样只进日志 */
  private refuseUpload(localId: string, detail: string): CyreneError {
    this.logger?.warn('attachments:refused', { code: 'forbidden_path', detail, localId })
    return new CyreneError(CyreneErrorCode.INVALID_INPUT, `${PATH_REFUSED_MESSAGE}: ${localId}`)
  }

  /**
   * S5-B2：把 `fileRef` 解析回路径。**这是本文件里唯一的「token → 路径」入口**，也是结构性修法的承重点。
   *
   * fail-closed 三态：未提供 registry / token 未知 / token 已过期 ⇒ 一律 `undefined`，
   * 由调用方转成 `forbidden_path`（**不是**「无法读取文件」——那是"路径合法但读不到"，
   * 两者混在一起会让伪造 token 与真实 IO 故障在日志里无法区分）。
   */
  private resolveFileRef(fileRef: string): string | undefined {
    return this.fileRefs?.resolve(fileRef)
  }

  async validateFiles(descriptors: UploadFileDescriptor[]): Promise<FileValidationResult[]> {
    // S4（2026-09-15）：预检的 size 一律取**真实**字节数——`bytes` 分支用 `byteLength`，
    // 绝不采信对端自报的 `size`（自报值只用于 UI 展示，不构成任何约束）。
    const pre = precheckFiles(descriptors.map((d) => ({ name: d.name, size: descriptorSize(d), mediaType: d.mediaType })))
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
      const source = d.fileRef !== undefined ? this.resolveFileRef(d.fileRef) : undefined
      if (d.fileRef !== undefined && source === undefined) {
        results.push(this.refuse(d.localId, 'unknown_or_expired_file_ref'))
        continue
      }
      if (source !== undefined) {
        try {
          const real = await this.fs.realpath(source)
          if (isInside(this.userDataBase(), real)) {
            results.push(this.refuse(d.localId, 'inside_user_data'))
            continue
          }
          // H-01：工具域既有黑名单在这条链上此前从未被调用
          const blocked = blacklistMessage(real, this.platform.kind)
          if (blocked) {
            results.push(this.refuse(d.localId, 'blacklisted_path'))
            continue
          }
          const fd = await this.fs.open(source, this.platform.existingReadFlags)
          let st
          try { st = await fd.stat() } finally { await fd.close() }
          if (!st.isFile()) {
            results.push(this.refuse(d.localId, 'not_a_regular_file'))
            continue
          }
          const head = new Uint8Array(HEAD_LEN)
          const hfd = await this.fs.open(source, this.platform.existingReadFlags)
          let bytesRead = 0
          try { bytesRead = (await hfd.read(head, 0, HEAD_LEN)).bytesRead } finally { await hfd.close() }
          const kind = sniffKind(head.subarray(0, bytesRead))
          const fsStat = await this.fs.stat(source)
          if (fsStat.size > sizeLimitFor(kind)) {
            results.push({ localId: d.localId, ok: false, reason: 'size_limit', message: '超过该类型大小上限' })
            continue
          }
          results.push({ localId: d.localId, ok: true, kind })
        } catch (e) {
          // 与「不存在」同类：realpath/open 失败的原因（ENOENT/EACCES/其他）不对外区分
          results.push(this.refuse(d.localId, `unreadable:${e instanceof Error ? e.name : 'unknown'}`))
        }
      } else if (d.bytes) {
        // S4：bytes 分支同样按**真实**字节数判限（此前只看对端自报 `size`，等于没有上限）
        const kind = sniffKind(d.bytes.subarray(0, HEAD_LEN))
        if (d.bytes.byteLength > sizeLimitFor(kind)) {
          results.push({ localId: d.localId, ok: false, reason: 'size_limit', message: '超过该类型大小上限' })
          continue
        }
        results.push({ localId: d.localId, ok: true, kind })
      } else {
        results.push({ localId: d.localId, ok: false, reason: 'invalid', message: '缺少 bytes/fileRef' })
      }
    }
    return results
  }

  async uploadBatch(uploadId: string, descriptors: UploadFileDescriptor[]): Promise<MessageAttachment[]> {
    const controller = new AbortController()
    this.active.set(uploadId, controller)
    try {
      // S4（2026-09-15）：上传批次此前**没有**聚合/数量复核（只有 validate 有，而当对端直调 upload 时等于没有）。
      // 数量上界已由 `attachmentsUploadSchema.files.max(10)` 在 schema 层保证；聚合按**真实**字节数在这里补。
      const aggregateBytes = descriptors.reduce((sum, d) => sum + descriptorSize(d), 0)
      if (aggregateBytes > ATTACHMENT_AGGREGATE_BYTES) {
        this.logger?.warn('attachments:refused', { code: 'too_large_aggregate', bytes: aggregateBytes })
        throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '附件合计超过上限')
      }
      const uploads: UploadContent[] = []
      for (const d of descriptors) {
        const source = d.fileRef !== undefined ? this.resolveFileRef(d.fileRef) : undefined
        if (d.fileRef !== undefined && source === undefined) {
          throw this.refuseUpload(d.localId, 'unknown_or_expired_file_ref')
        }
        if (source !== undefined) {
          // P2-2：敏感范围复验（realpath+isInside，与 validateFiles 同级防御）
          const real = await this.fs.realpath(source)
          if (isInside(this.userDataBase(), real)) throw this.refuseUpload(d.localId, 'inside_user_data')
          // H-01：与 validateFiles 同级复验（防对端绕过校验直接 upload）
          const blocked = blacklistMessage(real, this.platform.kind)
          if (blocked) throw this.refuseUpload(d.localId, 'blacklisted_path')
          // 上传前 fs.stat 复验：实际大小与普通文件（防描述符/队列状态漂移，spec §4.5）
          const st = await this.fs.stat(source)
          if (!st.isFile()) throw this.refuseUpload(d.localId, 'not_a_regular_file')
          // P2-1：kind 复验与 validateFiles 统一用 sniffKind（魔数），不用 kindFromMime（MIME 可伪造）——查限一致
          const head = new Uint8Array(HEAD_LEN)
          const hfd = await this.fs.open(source, this.platform.existingReadFlags)
          let bytesRead = 0
          try { bytesRead = (await hfd.read(head, 0, HEAD_LEN)).bytesRead } finally { await hfd.close() }
          const kind = sniffKind(head.subarray(0, bytesRead))
          if (st.size > sizeLimitFor(kind)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件超过大小上限: ${d.localId}`)
          // H-01 结构性修法（S5-B2，2026-09-15）：路径来自 **Main 自己的 `fileRef` 表**（对端无从命名），
          // 且这里读成 bytes 后路径到此为止（`UploadContent.bytes` 必填）⇒「path → fs」全仓只剩本文件一处。
          uploads.push({ name: d.name, mediaType: d.mediaType, size: st.size, kind: wireKindHint(kind, d.mediaType), bytes: new Uint8Array(await this.fs.readFile(source)) })
        } else if (d.bytes) {
          // P2-1：bytes 分支按魔数嗅探 kind 复验大小；S4：尺寸取 **byteLength**，不采信对端自报的 `size`
          const kind = sniffKind(d.bytes.subarray(0, HEAD_LEN))
          if (d.bytes.byteLength > sizeLimitFor(kind)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件超过大小上限: ${d.localId}`)
          uploads.push({ name: d.name, mediaType: d.mediaType, size: d.bytes.byteLength, kind: wireKindHint(kind, d.mediaType), bytes: d.bytes })
        } else {
          throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件缺少 bytes/fileRef: ${d.localId}`)
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
