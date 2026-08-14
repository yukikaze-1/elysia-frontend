// tests/integration/ipc-attachments.spec.ts
// Task 17:attachments 四通道经 MockBackend 往返（validate/upload/cancel/check）+ 结构化错误（spec §4.5/§4.10 集成）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
beforeAll(async () => { launched = await launchApp() })
afterAll(async () => { if (launched) await closeApp(launched) })

describe('attachments IPC 往返（MockBackend）', () => {
  it('attachmentsValidate 经 IPC 返回 per-file 结果（粘贴 bytes 型）', async () => {
    const res = await launched.page.evaluate(async () => {
      return window.desktopApi.attachmentsValidate({ files: [{ localId: 'l1', name: 'a.png', size: 4, mediaType: 'image/png', source: 'paste', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer }] })
    })
    expect(Array.isArray(res)).toBe(true)
    expect(res[0]).toMatchObject({ localId: 'l1', ok: true })
  })
  it('attachmentsUpload 经 IPC + MockBackend → AttachmentsUploadResponse（AttachmentInfo.kind 权威）', async () => {
    // MockBackend.uploadAttachments 需已 connect（uploadBatch 走 backend.uploadAttachments）；mock 模式免 token 但需 endpoint
    await launched.page.evaluate(async () => {
      await window.desktopApi.setEndpoint('http://127.0.0.1:8765')
      await window.desktopApi.connect()
    })
    const res = await launched.page.evaluate(async () => {
      return window.desktopApi.attachmentsUpload({ uploadId: 'u1', files: [{ localId: 'l1', name: 'a.png', size: 4, mediaType: 'image/png', source: 'paste', kind: 'image', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer }] })
    })
    expect(res.uploadId).toBe('u1')
    expect(res.attachments).toHaveLength(1)
    expect(res.attachments[0].attachmentId).toMatch(/^att_/)
    expect(res.attachments[0].kind).toBe('image')
    expect(res.attachments[0].mediaType).toBe('image/png')
  })
  it('attachmentsCheck 经 IPC 返回合法 AttachmentMediaStatus（不崩）', async () => {
    const res = await launched.page.evaluate(async () => window.desktopApi.attachmentsCheck('att_1'))
    expect(['ok', 'expired', 'not_found', 'revoked', 'error']).toContain(res.status)
  })
  it('attachmentsCancel 经 IPC 不抛（Mock 无在途上传时 no-op）', async () => {
    await expect(launched.page.evaluate(async () => window.desktopApi.attachmentsCancel('u-none'))).resolves.toBeUndefined()
  })
  it('request 非法 → 结构化错误（SCHEMA_VALIDATION_FAILED）', async () => {
    const err = await launched.page.evaluate(async () => {
      try { await window.desktopApi.attachmentsUpload({ uploadId: 'u', files: [] }); return null }
      catch (e) { return (e as Error).message }
    })
    expect(err).toMatch(/SCHEMA_VALIDATION_FAILED|IPC_ERROR/)
  })
})
