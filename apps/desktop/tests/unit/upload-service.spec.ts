// tests/unit/upload-service.spec.ts
// Task 7:UploadService.uploadBatch/cancel——fs.stat 复验、batch 原子、AbortController 取消（spec §4.5/§4.8/§5）。
import { describe, expect, it, vi } from 'vitest'
import { posixPlatform } from '../../src/main/persistence/safe-open'
import { UploadService, type UploadFs } from '../../src/main/attachments/upload-service'
import type { AttachmentInfo } from '@shared/contracts'

function fakeFs(): UploadFs {
  return {
    realpath: async (p: string) => p,
    stat: async () => ({ size: 4, isFile: () => true }),
    readFile: async () => new Uint8Array([1, 2, 3, 4]),
    open: async () => ({ close: async () => {}, stat: async () => ({ size: 4, isFile: () => true }), read: async (b, _o, len) => { b.set([1, 2, 3]); return { bytesRead: Math.min(len, 3) } } })
  }
}

describe('UploadService.uploadBatch / cancel', () => {
  it('成功批量 → MessageAttachment[]（AttachmentInfo.kind 权威）', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [
      { attachmentId: 'att_1', kind: 'image', mime: 'image/png', size: 4, url: '/api/attachments/att_1', filename: 'a.png' }
    ])
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    const out = await svc.uploadBatch('u1', [{ localId: 'l1', name: 'a.png', size: 4, mediaType: 'image/png', source: 'picker', kind: 'image', bytes: new Uint8Array([1, 2, 3, 4]) }])
    expect(out).toEqual([{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png', size: 4 }])
    expect(uploadAttachments).toHaveBeenCalledTimes(1)
  })
  it('batch 失败 → 整体 reject（原子，不部分成功）', async () => {
    const uploadAttachments = vi.fn(async () => { throw new Error('upload failed') })
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    await expect(svc.uploadBatch('u1', [{ localId: 'l1', name: 'a', size: 1, mediaType: 'x', source: 'paste', bytes: new Uint8Array(1) }])).rejects.toThrow('upload failed')
  })
  it('cancel 中止在途上传（controller.signal 已接入 backend → abort 触发 reject，取消闭环，P1-1）', async () => {
    const uploadAttachments = vi.fn(async (_files: unknown, opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]> => {
      // 等价于真实 backend：经 AbortSignal.any 组合信号，abort 事件触发上传 reject（不再「尚不可见」，P1-1）
      return new Promise((_res, rej) => {
        opts?.signal?.addEventListener('abort', () => rej(new Error('cancelled')))
      })
    })
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    const p = svc.uploadBatch('u1', [{ localId: 'l1', name: 'a', size: 1, mediaType: 'x', source: 'paste', bytes: new Uint8Array(1) }])
    await vi.waitFor(() => expect(uploadAttachments).toHaveBeenCalledTimes(1))   // 已进入 in-flight（bytes 型不经 fs）
    svc.cancel('u1')                                                              // 批量终止（IPC attachments:cancel 同路径）
    await expect(p).rejects.toThrow('cancelled')                                  // uploadBatch reject → IPC 层 → 条目 cancelled
  })
  it('webm：UploadContent.kind 为 wireKindHint 消歧值（audio/webm→audio；大小限额仍魔数）', async () => {
    const calls: Array<{ kind?: string }> = []
    const uploadAttachments = vi.fn(async (files: Array<{ kind?: string }>) => {
      calls.push(...files)
      return files.map((f, i) => ({ attachmentId: `att_${i}`, kind: f.kind ?? 'file', mime: 'application/octet-stream', size: 1, url: `/api/attachments/${i}`, filename: `f${i}` }))
    })
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    // audio/webm：EBML 魔数 → sniffKind='video'，wireKindHint('video','audio/webm')='audio'
    await svc.uploadBatch('u1', [
      { localId: 'l1', name: 'a.webm', size: 4, mediaType: 'audio/webm', source: 'picker', bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]) }
    ])
    expect(calls[0].kind).toBe('audio')
  })
})

// —— H-01（2026-09-11）：附件链此前完全没调用工具域既有的 PATH_BLACKLIST_DEFAULTS ——
// `path` 是 Renderer 可传的裸字符串，唯一边界只有「排除 userData 一个目录」，
// 于「~/.ssh、~/.aws、.env、.git-credentials」这类最敏感文件上没有任何拦截。
// 本组用例钉住止血：黑名单在 validate 与 upload 两条链上都生效，且按 **realpath** 匹配。
describe('UploadService 敏感路径黑名单（H-01 止血）', () => {
  it('uploadBatch 路径落在黑名单 → 拒绝（renderer 绕过 validate 直接 upload 也拦得住）', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [])
    const fs = fakeFs()
    fs.realpath = async () => '/etc/shadow'
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs })
    await expect(svc.uploadBatch('u1', [{ localId: 'l1', name: 'x', size: 4, mediaType: 'text/plain', source: 'picker', path: '/tmp/looks-benign' }]))
      .rejects.toThrow(/敏感目录/)
    expect(uploadAttachments, '黑名单命中必须在上传前拦下').not.toHaveBeenCalled()
  })

  it('uploadBatch 按 realpath 匹配——原始字符串无害但真实路径在敏感目录，同样拒绝', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [])
    const fs = fakeFs()
    fs.realpath = async () => '/root/.ssh/id_rsa'
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs })
    await expect(svc.uploadBatch('u1', [{ localId: 'l1', name: 'x', size: 4, mediaType: 'text/plain', source: 'picker', path: '/home/me/Desktop/innocent.txt' }]))
      .rejects.toThrow(/敏感目录/)
    expect(uploadAttachments).not.toHaveBeenCalled()
  })

  it('正常用户目录不被误伤（黑名单只拦敏感范围）', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [
      { attachmentId: 'att_1', kind: 'image', mime: 'image/png', size: 4, url: '/api/attachments/att_1', filename: 'a.png' }
    ])
    const fs = fakeFs()
    const home = (await import('os')).homedir()
    fs.realpath = async () => `${home}/Documents/a.png`
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs })
    const out = await svc.uploadBatch('u1', [{ localId: 'l1', name: 'a.png', size: 4, mediaType: 'image/png', source: 'picker', path: `${home}/Documents/a.png` }])
    expect(out).toHaveLength(1)
    expect(uploadAttachments).toHaveBeenCalledTimes(1)
  })
})
