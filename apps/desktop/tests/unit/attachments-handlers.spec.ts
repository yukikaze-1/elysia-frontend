// tests/unit/attachments-handlers.spec.ts
// Task 10:attachments 四通道 handler 接线——request 校验、响应 schema、结构化错误（沿用 createIpcHandler 模式）。
// env=node：直接调用注册的 handler 函数（不经 ipcMain）。
import { describe, expect, it, vi } from 'vitest'
import type { MessageSanitizer } from '../../src/main/diagnostics/sanitize'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { attachmentsCheckSchema, attachmentsUploadSchema } from '../../src/main/ipc/channels'
import { AttachmentCheckResultSchema, AttachmentsUploadResponseSchema } from '../../src/shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'

const sanitize: MessageSanitizer = (m) => m
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never

describe('attachments handler（createIpcHandler 接线）', () => {
  it('attachments:check 成功 → ok:true 带 AttachmentCheckResult', async () => {
    const h = createIpcHandler(attachmentsCheckSchema, AttachmentCheckResultSchema, async () => ({ status: 'ok' }), { sanitize, channel: 'attachments:check', logger })
    const res = await h({ attachmentId: 'att_1' })
    expect(res).toEqual({ ok: true, data: { status: 'ok' } })
  })
  it('attachments:upload 成功 → ok:true 带 AttachmentsUploadResponse', async () => {
    const h = createIpcHandler(attachmentsUploadSchema, AttachmentsUploadResponseSchema, async () => ({ uploadId: 'u1', attachments: [] }), { sanitize, channel: 'attachments:upload', logger })
    const res = await h({ uploadId: 'u1', files: [{ localId: 'l1', name: 'a', size: 1, mediaType: 'x', source: 'picker', fileRef: 'fileref_x' }] })
    expect(res.ok).toBe(true)
  })
  it('request 非法 → ok:false SCHEMA_VALIDATION_FAILED', async () => {
    const h = createIpcHandler(attachmentsUploadSchema, AttachmentsUploadResponseSchema, async () => ({ uploadId: 'u1', attachments: [] }), { sanitize, channel: 'attachments:upload', logger })
    const res = await h({ files: [] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('服务层 CyreneError → ok:false 结构化错误（code/message 公开白名单）', async () => {
    const h = createIpcHandler(attachmentsCheckSchema, AttachmentCheckResultSchema, async () => { throw new CyreneError(CyreneErrorCode.NOT_FOUND, '附件不存在') }, { sanitize, channel: 'attachments:check', logger })
    const res = await h({ attachmentId: 'att_missing' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toEqual({ code: 'NOT_FOUND', message: '附件不存在' })
  })
})
