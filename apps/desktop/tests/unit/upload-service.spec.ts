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
// 唯一边界只有「排除 userData 一个目录」，于「~/.ssh、~/.aws、.env、.git-credentials」这类最敏感文件上
// 没有任何拦截。本组用例钉住止血：黑名单在 validate 与 upload 两条链上都生效，且按 **realpath** 匹配。
//
// S5-B2（2026-09-15）：描述符上的 `path` 已换成 Main 签发的 `fileRef`（`file-ref.ts` 的表）。
// 本组用例的**意图一字未变**（黑名单仍按 realpath 拦），只是入口从「裸路径」变成「token → 路径」。
describe('UploadService 敏感路径黑名单（H-01 止血）', () => {
  /** 桩 registry：把固定 token 映射到固定路径，等价于「Main 登记过一次这个文件」 */
  const refsFor = (path: string) => ({
    issue: () => 'fileref_stub',
    resolve: (r: string) => (r === 'fileref_stub' ? path : undefined),
    clear: () => {}, size: () => 1,
  })

  it('uploadBatch 路径落在黑名单 → 拒绝（绕过 validate 直接 upload 也拦得住）', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [])
    const fs = fakeFs()
    fs.realpath = async () => '/etc/shadow'
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs, fileRefs: refsFor('/tmp/looks-benign') })
    await expect(svc.uploadBatch('u1', [{ localId: 'l1', name: 'x', size: 4, mediaType: 'text/plain', source: 'picker', fileRef: 'fileref_stub' }]))
      .rejects.toThrow(/文件不可用/)
    expect(uploadAttachments, '黑名单命中必须在上传前拦下').not.toHaveBeenCalled()
  })

  it('uploadBatch 按 realpath 匹配——登记时无害、真实路径在敏感目录，同样拒绝', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [])
    const fs = fakeFs()
    fs.realpath = async () => '/root/.ssh/id_rsa'
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs, fileRefs: refsFor('/home/me/Desktop/innocent.txt') })
    await expect(svc.uploadBatch('u1', [{ localId: 'l1', name: 'x', size: 4, mediaType: 'text/plain', source: 'picker', fileRef: 'fileref_stub' }]))
      .rejects.toThrow(/文件不可用/)
    expect(uploadAttachments).not.toHaveBeenCalled()
  })

  it('正常用户目录不被误伤（黑名单只拦敏感范围）', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [
      { attachmentId: 'att_1', kind: 'image', mime: 'image/png', size: 4, url: '/api/attachments/att_1', filename: 'a.png' }
    ])
    const fs = fakeFs()
    const home = (await import('os')).homedir()
    fs.realpath = async () => `${home}/Documents/a.png`
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs, fileRefs: refsFor(`${home}/Documents/a.png`) })
    const out = await svc.uploadBatch('u1', [{ localId: 'l1', name: 'a.png', size: 4, mediaType: 'image/png', source: 'picker', fileRef: 'fileref_stub' }])
    expect(out).toHaveLength(1)
    expect(uploadAttachments).toHaveBeenCalledTimes(1)
  })

  // —— S5-B2 新增：token 是本链路的信任锚，未知/过期/缺表一律 fail-closed ——
  it('未知 fileRef → 拒绝且不上传（伪造 token 拿不到任何文件）', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [])
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs(), fileRefs: refsFor('/home/me/ok.txt') })
    await expect(svc.uploadBatch('u1', [{ localId: 'l1', name: 'x', size: 4, mediaType: 'text/plain', source: 'picker', fileRef: 'fileref_forged' }]))
      .rejects.toThrow(/文件不可用/)
    expect(uploadAttachments).not.toHaveBeenCalled()
  })

  it('未装配 fileRefs（缺表）→ 同样 fail-closed，不放行任何 fileRef', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [])
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    await expect(svc.uploadBatch('u1', [{ localId: 'l1', name: 'x', size: 4, mediaType: 'text/plain', source: 'picker', fileRef: 'fileref_any' }]))
      .rejects.toThrow(/文件不可用/)
    expect(uploadAttachments).not.toHaveBeenCalled()
  })
})
