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
    // P1-2：f.file 为 JS 构造 File（粘贴项）时 getPathForFile 返 ''，但 bytes 必须保留——
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
  it('P2-7：path 与 bytes 同时存在 → 优先 path，不填 bytes（保证二选一，zod refine 不整条拒）', async () => {
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('/tmp/a.png')   // 真实路径
    mockIpc.invoke.mockResolvedValue({ ok: true, data: [{ localId: 'l1', ok: true, kind: 'image' }] })
    await api.attachmentsValidate({ files: [{ localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'paste', file: {} as File, bytes: new ArrayBuffer(2) }] })
    const payload = mockIpc.invoke.mock.calls[0][1] as { files: Array<{ path?: string; bytes?: Uint8Array }> }
    expect(payload.files[0].path).toBe('/tmp/a.png')
    expect(payload.files[0].bytes).toBeUndefined()   // path 非空时不再填 bytes
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

// —— H-01 结构性守护（2026-09-14）——
//
// 威胁模型：附件链是**唯一**必须让"本地路径"从 UI 侧跨到 Main 的地方（Main 得自己读文件再上传）。
// 不变量是"Renderer 不得指认本地路径"。整条防线压在**两件事**上：
//   ① `AttachmentInputFile` 这一面向 Renderer 的类型里**没有** path 字段；
//   ② `toIpcDescriptor` 按字段**逐个抄**（不是 `{...f}` 展开）⇒ Renderer 塞进输入对象的 path 不会被复制。
// 此前这两件事**都没有门禁**：schema 层面 `attachments:validate/upload` 明确接受自由 `path` 字符串，
// 于是"安全"只体现为一行实现细节，谁改成展开就静默破防。
//
// 下面两条把①②钉死。**变异验证**：把 `toIpcDescriptor` 的第一条改成 `const out = { ...f }` ⇒ 用例 A 立即红。
describe('H-01：Renderer 无法把 path 注入 IPC 边界', () => {
  it('类型级：AttachmentInputFile 不含 path 字段（加了即编译失败）', () => {
    // 若有人给 AttachmentInputFile 加 `path`，条件类型翻成 false，下面赋值报 TS2322 ⇒ typecheck 红。
    // （用类型位置的 import(...)，因为 interface 不是值，`typeof mod.X` 取不到。）
    const noPathField: 'path' extends keyof import('../../src/preload/desktop-api').AttachmentInputFile ? false : true = true
    expect(noPathField).toBe(true)
  })

  it('行为级 A：只给伪造 path（无 file/bytes）⇒ 不抵达 invoke（会被整条丢弃）', async () => {
    const api = await importApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: [] })
    const forged = { localId: 'l1', name: 'x', size: 1, mediaType: 'text/plain', source: 'picker', path: '/etc/passwd' }
    await api.attachmentsValidate({ files: [forged as never] })
    const payload = mockIpc.invoke.mock.calls[0][1] as { files: Array<Record<string, unknown>> }
    expect('path' in payload.files[0], '伪造 path 竟然抵达了 IPC —— preload 的字段白名单被改坏了').toBe(false)
    expect(payload.files[0]).toEqual({ localId: 'l1', name: 'x', size: 1, mediaType: 'text/plain', source: 'picker' })
  })

  it('行为级 B：伪造 path ＋ 真实 file ⇒ getPathForFile 赢（伪造值被覆盖）', async () => {
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('/real/a.png')
    mockIpc.invoke.mockResolvedValue({ ok: true, data: [] })
    const forged = { localId: 'l1', name: 'x', size: 1, mediaType: 'image/png', source: 'picker', file: {} as File, path: '/etc/shadow' }
    await api.attachmentsValidate({ files: [forged as never] })
    const payload = mockIpc.invoke.mock.calls[0][1] as { files: Array<Record<string, unknown>> }
    expect(payload.files[0].path).toBe('/real/a.png')
  })

  it('行为级 C：upload 通道同样吃不到伪造 path', async () => {
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('')
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { uploadId: 'u1', attachments: [] } })
    const forged = { localId: 'l1', name: 'x', size: 1, mediaType: 'text/plain', source: 'paste', file: {} as File, path: '/etc/passwd' }
    await api.attachmentsUpload({ uploadId: 'u1', files: [forged as never] })
    const payload = mockIpc.invoke.mock.calls[0][1] as { files: Array<Record<string, unknown>> }
    expect('path' in payload.files[0], 'upload 通道的伪造 path 竟然抵达').toBe(false)
  })
})
