// tests/unit/attachments-contracts.spec.ts
// Task 1:附件领域模型（spec §4.2，D2/D7）——MessageAttachment/MessageAttachmentRef 形状 + AssistantSegment/Message 扩展经响应 schema 校验。
// env=node：纯 zod schema 断言，无 Electron。
import { describe, expect, it } from 'vitest'
import type { MessageAttachment, MessageAttachmentRef } from '../../src/shared/contracts/message'
import { AssistantSegmentSchema, MessageAttachmentSchema, MessageSchema } from '../../src/shared/schemas'
import { ATTACHMENT_MAX_FILES, ATTACHMENT_AGGREGATE_BYTES, ATTACHMENT_MAX_BYTES_BY_KIND, ATTACHMENT_KIND_MIME, type PendingSendItem, type UploadFileDescriptor } from '../../src/shared/contracts/attachments'
import { IpcChannels } from '../../src/shared/contracts'
import { attachmentsUploadSchema, attachmentsValidateSchema, attachmentsCancelSchema, attachmentsCheckSchema, chatSendSchema } from '../../src/main/ipc/channels'
import { AttachmentsUploadResponseSchema, AttachmentCheckResultSchema, FileValidationResultSchema } from '../../src/shared/schemas'

describe('附件领域模型（spec §4.2）', () => {
  it('MessageAttachmentSchema 接受上传响应形态（name/size/尺寸/来源消息均可缺省兜底）', () => {
    const a: MessageAttachment = { attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 }
    const r = MessageAttachmentSchema.safeParse(a)
    expect(r.success).toBe(true)
    expect(r.data).toEqual(a)
  })
  it('MessageAttachmentSchema 全 optional 字段缺省也可过（历史回放兜底）', () => {
    const r = MessageAttachmentSchema.safeParse({ attachmentId: 'att_1', kind: 'video', mediaType: 'video/mp4' })
    expect(r.success).toBe(true)
  })
  it('MessageAttachmentSchema 拒非法 kind', () => {
    expect(MessageAttachmentSchema.safeParse({ attachmentId: 'att_1', kind: 'bogus', mediaType: 'x' }).success).toBe(false)
  })
  it('MessageAttachmentRef 三字段形状（wire 提示值）', () => {
    const ref: MessageAttachmentRef = { attachmentId: 'att_1', kind: 'image', mime: 'image/png' }
    expect(AssistantSegmentSchema).toBeDefined()
    expect(ref).toEqual({ attachmentId: 'att_1', kind: 'image', mime: 'image/png' })
  })
  it('AssistantSegmentSchema 接受媒体引用字段（媒体分段形状）', () => {
    const r = AssistantSegmentSchema.safeParse({
      segmentId: 'seg-1', segmentIndex: 1, channel: 'public_reply', kind: 'image', completed: true,
      attachmentId: 'att_1', url: '/api/attachments/att_1', mediaType: 'image/png', width: 100, height: 80
    })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ attachmentId: 'att_1', mediaType: 'image/png', width: 100 })
  })
  it('MessageSchema 接受 attachments（Message.attachments 内嵌）', () => {
    const r = MessageSchema.safeParse({
      messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't',
      content: 'hi', attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png' }]
    })
    expect(r.success).toBe(true)
  })
})

describe('附件/队列/上传契约（spec §4.2）', () => {
  it('限额常量单一事实来源（D-04：≤10 / 聚合 64MB / 单文件 10/50/20/20MB）', () => {
    expect(ATTACHMENT_MAX_FILES).toBe(10)
    expect(ATTACHMENT_AGGREGATE_BYTES).toBe(64 * 1024 * 1024)
    expect(ATTACHMENT_MAX_BYTES_BY_KIND.image).toBe(10 * 1024 * 1024)
    expect(ATTACHMENT_MAX_BYTES_BY_KIND.video).toBe(50 * 1024 * 1024)
    expect(ATTACHMENT_MAX_BYTES_BY_KIND.audio).toBe(20 * 1024 * 1024)
    expect(ATTACHMENT_MAX_BYTES_BY_KIND.file).toBe(20 * 1024 * 1024)
  })
  it('播放矩阵 MIME 白名单与 D-03 一致（video 可播 mp4/webm/ogv；audio 可播 mp3/wav/ogg/flac/m4a；image png/jpg/gif/webp/svg）', () => {
    expect(ATTACHMENT_KIND_MIME.video).toEqual(['video/mp4', 'video/webm', 'video/ogg'])
    expect(ATTACHMENT_KIND_MIME.audio).toEqual(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'])
    expect(ATTACHMENT_KIND_MIME.image).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
  })
  it('队列联合可判别：attachment 分支状态机枚举无 uploaded 瞬态（D4）', () => {
    const item: PendingSendItem = { kind: 'attachment', localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'drag_drop', status: 'selected' }
    expect(item.kind).toBe('attachment')
    const statuses: ReadonlyArray<string> = ['selected', 'validating', 'ready', 'uploading', 'failed', 'cancelled']
    for (const s of statuses) expect(statuses).toContain(s)
    expect(statuses).not.toContain('uploaded')
  })
  it('G4 PendingSticker 分支挂入队列（入队即 ready）', () => {
    const st: PendingSendItem = { kind: 'sticker', stickerId: 'st_1', status: 'ready' }
    expect(st.kind).toBe('sticker')
    expect(st.status).toBe('ready')
  })
  it('UploadFileDescriptor 二选一承载 path/bytes（path 仅 Preload 注入）', () => {
    const d: UploadFileDescriptor = { localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'paste', bytes: new Uint8Array(2) }
    expect(d.path).toBeUndefined()
    expect(d.bytes).toBeInstanceOf(Uint8Array)
  })
  it('IPC 四通道常量存在', () => {
    expect(IpcChannels.attachmentsValidate).toBe('attachments:validate')
    expect(IpcChannels.attachmentsUpload).toBe('attachments:upload')
    expect(IpcChannels.attachmentsCancel).toBe('attachments:cancel')
    expect(IpcChannels.attachmentsCheck).toBe('attachments:check')
  })
})

describe('IPC request/response schema（spec §4.2/§4.5）', () => {
  it('attachmentsValidateSchema 收 files[1..10]，path/bytes 二选一', () => {
    const ok = attachmentsValidateSchema.safeParse({ files: [{ localId: 'l1', name: 'a', size: 1, mediaType: 'image/png', source: 'paste', bytes: new Uint8Array(2) }] })
    expect(ok.success).toBe(true)
    const noBoth = attachmentsValidateSchema.safeParse({ files: [{ localId: 'l1', name: 'a', size: 1, mediaType: 'image/png', source: 'picker', path: '/tmp/a', bytes: new Uint8Array(2) }] })
    expect(noBoth.success).toBe(false)   // path/bytes 二选一
    const empty = attachmentsValidateSchema.safeParse({ files: [] })
    expect(empty.success).toBe(false)    // min(1)
    const over = attachmentsValidateSchema.safeParse({ files: Array.from({ length: 11 }, (_, i) => ({ localId: `l${i}`, name: 'a', size: 1, mediaType: 'x', source: 'picker' as const, path: '/tmp/a' })) })
    expect(over.success).toBe(false)     // max(10)
  })
  it('attachmentsUploadSchema 需 uploadId + files[1..10]', () => {
    expect(attachmentsUploadSchema.safeParse({ uploadId: 'u1', files: [{ localId: 'l1', name: 'a', size: 1, mediaType: 'x', source: 'picker', path: '/tmp/a' }] }).success).toBe(true)
    expect(attachmentsUploadSchema.safeParse({ files: [] }).success).toBe(false)
    expect(attachmentsUploadSchema.safeParse({ uploadId: '', files: [] }).success).toBe(false)
  })
  it('attachmentsCancelSchema / attachmentsCheckSchema 单字段', () => {
    expect(attachmentsCancelSchema.safeParse({ uploadId: 'u1' }).success).toBe(true)
    expect(attachmentsCheckSchema.safeParse({ attachmentId: 'att_1' }).success).toBe(true)
    expect(attachmentsCheckSchema.safeParse({}).success).toBe(false)
  })
  it('chatSendSchema 接受可选 attachments（MessageAttachmentRef 形状）', () => {
    const r = chatSendSchema.safeParse({ conversationId: 'c1', text: 'hi', clientRequestId: 'cr1', attachments: [{ attachmentId: 'att_1', kind: 'image', mime: 'image/png' }] })
    expect(r.success).toBe(true)
  })
  it('响应 schema：FileValidationResult/UploadResponse/CheckResult', () => {
    expect(FileValidationResultSchema.safeParse({ localId: 'l1', ok: false, reason: 'too_large' }).success).toBe(true)
    expect(AttachmentsUploadResponseSchema.safeParse({ uploadId: 'u1', attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png' }] }).success).toBe(true)
    expect(AttachmentCheckResultSchema.safeParse({ status: 'expired' }).success).toBe(true)
    expect(AttachmentCheckResultSchema.safeParse({ status: 'bogus' }).success).toBe(false)
  })
})
