// tests/unit/attachment.store.spec.ts
// Task 14:attachmentStore（spec §4.3/§4.4）——addFiles→validateAll→send 编排（upload→messageStore.send→清出）、
// 取消、失败逐项 failed、uploading 禁移除。env=node：注入 mock desktopApi（DesktopApiLike）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAttachmentStore } from '../../src/renderer/src/stores/attachment.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { AttachmentsUploadResponse, FileValidationResult, MessageAttachment } from '@shared/contracts'
import type { DesktopAttachmentInputFile } from '../../src/renderer/src/stores/desktop-api.types'

// I-06 / P2-10：原为手搓的 DesktopApiLike 全契约镜像（每个键裸 `vi.fn()`）。
const mockApi = createDesktopApiMock()

vi.spyOn(console, 'warn').mockImplementation(() => {})

beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.clearAllMocks() })

describe('attachmentStore', () => {
  it('addFiles 建 selected 条目 + 自动 validateAll → ready（附 kind）', async () => {
    // localId 由 store 生成（loc-<uuid>）——mock 需回显真实 localId，硬编码 'l1' 不会命中队列条目
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: true, kind: 'image' })))
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'drag_drop', bytes: new ArrayBuffer(2) }])
    expect(store.order[0]).toBeDefined()
    expect(store.pendingById[store.order[0]]?.status).toBe('validating')   // addFiles 同步置 validating（预检通过后）
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    expect(store.kindByLocalId[store.order[0]]).toBe('image')
  })

  it('validate 失败 → failed(reason) 可解释', async () => {
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: false, reason: 'too_large', message: '超过大小上限' })))
    const store = useAttachmentStore()
    store.addFiles([{ name: 'big.png', size: 999, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('failed') })
    expect((store.pendingById[store.order[0]] as { reason?: string }).reason).toBe('too_large')
  })

  it('send 编排：ready → upload → messageStore.send({attachments}) → 清出队列', async () => {
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: true, kind: 'image' })))
    const uploadResponse: AttachmentsUploadResponse = { uploadId: 'u1', attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }] }
    mockApi.attachmentsUpload.mockResolvedValue(uploadResponse)
    const messageStore = { send: vi.fn(async (_text: string, _opts?: { attachments?: MessageAttachment[] }) => true) }
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    await store.send('hi', messageStore)
    // `expect.objectContaining`/`expect.any` 的返回类型被 vitest 声明成 `any`；改为按调用序取实参断言，
    // 语义等价（upload 被调用且 uploadId 为非空字符串），且实参类型来自 DesktopApiLike 的真实签名
    const uploadArgs: Parameters<typeof mockApi.attachmentsUpload>[0] = mockApi.attachmentsUpload.mock.calls[0][0]
    expect(typeof uploadArgs.uploadId).toBe('string')
    expect(uploadArgs.uploadId.length).toBeGreaterThan(0)
    expect(messageStore.send).toHaveBeenCalledWith('hi', { attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }] })
    expect(store.order).toHaveLength(0)   // 已发送清出
  })

  it('上传失败 → 逐文件 failed(reason)；发送未触发', async () => {
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: true, kind: 'image' })))
    mockApi.attachmentsUpload.mockRejectedValue(new Error('[BACKEND_REJECTED] 上传失败'))
    const messageStore = { send: vi.fn(async (_text: string, _opts?: { attachments?: MessageAttachment[] }) => true) }
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    await store.send('hi', messageStore)
    expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('failed')
    expect(messageStore.send).not.toHaveBeenCalled()
  })

  it('P2-4：cancelUpload → 条目从队列移除（spec §4.8 置 cancelled 移除，不再滞留需手动移除）+ api.attachmentsCancel(uploadId)', async () => {
    // P2-8：deferred 手动 reject 消除竞态——固定 5ms 定时 vs cancel 并发时，vi.waitFor 轮询 >5ms 可能先触发 reject 使旧版挂
    let rejectUpload!: (e: Error) => void
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: true, kind: 'video' })))
    mockApi.attachmentsUpload.mockImplementation(() => new Promise((_res, rej) => { rejectUpload = rej }))
    mockApi.attachmentsCancel.mockResolvedValue(undefined)
    const messageStore = { send: vi.fn(async (_text: string, _opts?: { attachments?: MessageAttachment[] }) => true) }
    const store = useAttachmentStore()
    store.addFiles([{ name: 'v.mp4', size: 10, mediaType: 'video/mp4', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    const p = store.send('hi', messageStore)
    await vi.waitFor(() => { expect(store.uploading).toBe(true) })
    await store.cancelUpload()
    expect(mockApi.attachmentsCancel).toHaveBeenCalledWith(expect.any(String))
    rejectUpload(new Error('[CANCELLED] 已取消'))   // 确定性时序：手动 reject 触发 send 取消分支（cancelUpload 已置 uploading=false）
    await p
    expect(store.order).toHaveLength(0)   // 取消后条目直接移除，不再滞留 cancelled
    expect(messageStore.send).not.toHaveBeenCalled()
  })

  it('P1-1：混合批次——单文件超限只 fail 该文件，其余合法文件继续 selected→validateAll→ready', async () => {
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: true, kind: 'image' })))
    const store = useAttachmentStore()
    store.addFiles([
      { name: 'big.png', size: 11 * 1024 * 1024, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) },
      { name: 'ok.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }
    ])
    const [bigId, okId] = store.order
    expect((store.pendingById[bigId] as { status: string }).status).toBe('failed')          // 超限文件 clientPrecheck 逐项拒
    expect((store.pendingById[bigId] as { reason?: string }).reason).toBe('precheck')
    await vi.waitFor(() => { expect((store.pendingById[okId] as { status: string }).status).toBe('ready') })   // 合法文件继续 ready
    expect(mockApi.attachmentsValidate).toHaveBeenCalledTimes(1)
    const payload = mockApi.attachmentsValidate.mock.calls[0][0] as { files: Array<{ localId: string }> }
    expect(payload.files.map((f) => f.localId)).not.toContain(bigId)   // 失败文件不进入 validateAll
  })

  it('P2-3：upload 成功但 messageStore.send 返回 false → 队列保留（回 ready 可重试/移除），不清除', async () => {
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: true, kind: 'image' })))
    const uploadResponse: AttachmentsUploadResponse = { uploadId: 'u1', attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }] }
    mockApi.attachmentsUpload.mockResolvedValue(uploadResponse)
    const messageStore = { send: vi.fn(async (_text: string, _opts?: { attachments?: MessageAttachment[] }) => false) }
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    await store.send('hi', messageStore)
    // `expect.any(Array)` 的返回类型被 vitest 声明成 `any`；改为按调用序取实参断言 attachments 存在，等价且类型真实
    const sendOpts = messageStore.send.mock.calls[0][1]
    expect(sendOpts?.attachments).toHaveLength(1)
    expect(store.order).toHaveLength(1)                                                        // 失败保留条目
    expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready')     // 回 ready 可重试/移除
  })

  it('remove：非 uploading 可移除；uploading 期间禁止', async () => {
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    const id = store.order[0]
    store.remove(id)
    expect(store.order).not.toContain(id)
    store.addFiles([{ name: 'b.png', size: 10, mediaType: 'image/png', source: 'paste', bytes: new ArrayBuffer(2) }])
    const id2 = store.order[0]
    ;(store.pendingById[id2] as { status: string }).status = 'uploading'
    store.uploading = true
    store.remove(id2)
    expect(store.pendingById[id2]).toBeDefined()   // 上传中禁止移除
  })

  it('remove：非上传中清 kindByLocalId/fileByLocalId（单个移除即时释放强引用）', async () => {
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: true, kind: 'image' })))
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    store.addFiles([{ name: 'b.png', size: 10, mediaType: 'image/png', source: 'paste', bytes: new ArrayBuffer(2) }])
    const id = store.order[0]
    await vi.waitFor(() => { expect(store.kindByLocalId[id]).toBe('image') })   // validateAll → kind
    expect(store.fileByLocalId[id]).toBeDefined()   // bytes 引用存在
    store.remove(id)
    expect(store.pendingById[id]).toBeUndefined()   // 队列清
    expect(store.kindByLocalId[id]).toBeUndefined() // 新增：kind 清
    expect(store.fileByLocalId[id]).toBeUndefined() // 新增：file/bytes 引用清
    // 不清其它 localId —— 关键：b 与 a 同时驻留再 remove(id)，断言 b 的引用仍 defined。
    // 旧写法 b 在 remove 之后 add，remove 时刻 fileByLocalId 只有 a 一项，即便实现退化为整表 `= {}` 该断言仍 pass（结构性空转）。
    const id2 = store.order.find((x) => x !== id)!
    expect(store.kindByLocalId[id2]).toBeDefined()
    expect(store.fileByLocalId[id2]).toBeDefined()
  })

  it('hasFailed 阻断发送（canSend.blockReason）', async () => {
    mockApi.attachmentsValidate.mockImplementation(async ({ files }: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]> =>
      files.map((f) => ({ localId: f.localId, ok: false, reason: 'too_large', message: '超限' })))
    const store = useAttachmentStore()
    store.addFiles([{ name: 'big.png', size: 999, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect(store.hasFailed).toBe(true) })
    expect(store.canSend.canSend).toBe(false)
    expect(store.canSend.blockReason).toContain('失败')
  })
})
