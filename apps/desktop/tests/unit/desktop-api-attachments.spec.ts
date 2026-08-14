// tests/unit/desktop-api-attachments.spec.ts
// Task 11:preload attachments 面（spec §4.2/§3.2，D5）——webUtils.getPathForFile 注入 path、pathless 走 bytes、
// path 不入返回面。env=node：mock 'electron' 的 ipcRenderer + webUtils。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/contracts'

const { mockIpc, mockWebUtils } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    mockIpc: {
      invoke: vi.fn(),
      on: vi.fn((c: string, h: (...a: unknown[]) => void) => { handlers.set(c, [...(handlers.get(c) ?? []), h]) }),
      removeListener: vi.fn(),
      emit: (c: string, ...args: unknown[]): void => { for (const h of handlers.get(c) ?? []) h({}, ...args) }
    },
    mockWebUtils: { getPathForFile: vi.fn() }
  }
})

vi.mock('electron', () => ({ ipcRenderer: mockIpc, webUtils: mockWebUtils }))
vi.spyOn(console, 'warn').mockImplementation(() => {})

async function importApi() {
  const mod = await import('../../src/preload/desktop-api')
  return mod.desktopApi
}

beforeEach(() => {
  mockIpc.invoke.mockReset()
  mockWebUtils.getPathForFile.mockReset()
})

describe('desktopApi attachments 面', () => {
  it('attachmentsValidate：真实文件经 webUtils 注入 path（path 在 invoke 入参，不在返回面）', async () => {
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('/tmp/a.png')
    mockIpc.invoke.mockResolvedValue({ ok: true, data: [{ localId: 'l1', ok: true, kind: 'image' }] })
    const res = await api.attachmentsValidate({ files: [{ localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'picker', file: {} as File }] })
    expect(res).toEqual([{ localId: 'l1', ok: true, kind: 'image' }])
    expect(mockWebUtils.getPathForFile).toHaveBeenCalledTimes(1)
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.attachmentsValidate, {
      files: [{ localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'picker', path: '/tmp/a.png' }]
    })
  })
  it('attachmentsValidate：pathless 文件（getPathForFile 返回空串）→ 走 bytes，path 缺省', async () => {
    // P1-2：f.file 为 JS 构造 File（粘贴项）时 getPathForFile 返 ''，但 bytes 必须保留（两个独立 if）——
    // 断言 bytes 为 Uint8Array 且 length 正确；旧 else-if 实现下此断言必挂（descriptor 无 path 无 bytes）
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('')
    mockIpc.invoke.mockResolvedValue({ ok: true, data: [{ localId: 'l1', ok: true, kind: 'file' }] })
    const bytes = new ArrayBuffer(2)
    await api.attachmentsValidate({ files: [{ localId: 'l1', name: 'a.bin', size: 2, mediaType: 'application/octet-stream', source: 'paste', file: {} as File, bytes }] })
    const payload = mockIpc.invoke.mock.calls[0][1] as { files: Array<{ path?: string; bytes?: Uint8Array }> }
    expect(payload.files[0].path).toBeUndefined()
    expect(payload.files[0].bytes).toBeInstanceOf(Uint8Array)
    expect((payload.files[0].bytes as Uint8Array).length).toBe(2)
  })
  it('attachmentsUpload：invoke 带 uploadId + files（path/bytes 二选一）', async () => {
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('/tmp/v.mp4')
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { uploadId: 'u1', attachments: [{ attachmentId: 'att_1', kind: 'video', mediaType: 'video/mp4' }] } })
    const res = await api.attachmentsUpload({ uploadId: 'u1', files: [{ localId: 'l1', name: 'v.mp4', size: 1, mediaType: 'video/mp4', source: 'picker', file: {} as File }] })
    expect(res.attachments).toHaveLength(1)
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.attachmentsUpload, expect.objectContaining({ uploadId: 'u1' }))
  })
  it('attachmentsCancel / attachmentsCheck 单参数', async () => {
    const api = await importApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await api.attachmentsCancel('u1')
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.attachmentsCancel, { uploadId: 'u1' })
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { status: 'expired' } })
    const r = await api.attachmentsCheck('att_1')
    expect(r).toEqual({ status: 'expired' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.attachmentsCheck, { attachmentId: 'att_1' })
  })
  it('ok:false → 抛 [code] message（结构化错误）', async () => {
    const api = await importApi()
    mockIpc.invoke.mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: '附件不存在' } })
    await expect(api.attachmentsCheck('att_1')).rejects.toThrow('[NOT_FOUND] 附件不存在')
  })
})
