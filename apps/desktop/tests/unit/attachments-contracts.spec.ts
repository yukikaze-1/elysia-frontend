// tests/unit/attachments-contracts.spec.ts
// Task 1:附件领域模型（spec §4.2，D2/D7）——MessageAttachment/MessageAttachmentRef 形状 + AssistantSegment/Message 扩展经响应 schema 校验。
// env=node：纯 zod schema 断言，无 Electron。
import { describe, expect, it } from 'vitest'
import type { MessageAttachment, MessageAttachmentRef } from '../../src/shared/contracts/message'
import { AssistantSegmentSchema, MessageAttachmentSchema, MessageSchema } from '../../src/shared/schemas'

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
