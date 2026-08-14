// tests/unit/attachment-validate.spec.ts
// Task 7:UploadService.validateFiles——数量/聚合/单文件限额、kind 矩阵、魔数嗅探、敏感范围/非普通文件拒（spec §2/§4.5）。
// env=node：注入假 UploadFs + posixPlatform，无真实 fs。
import { describe, expect, it } from 'vitest'
import { posixPlatform } from '../../src/main/persistence/safe-open'
import { UploadService, type UploadFs } from '../../src/main/attachments/upload-service'
import type { UploadFileDescriptor } from '@shared/contracts'

function fakeFs(over: Partial<UploadFs> = {}): UploadFs {
  return {
    realpath: async (p: string) => p,
    stat: async () => ({ size: 10, isFile: () => true }),
    readFile: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),  // PNG 头
    open: async () => ({
      close: async () => {},
      stat: async () => ({ size: 10, isFile: () => true }),
      read: async (b, _off, len) => { b.set([0x89, 0x50, 0x4e, 0x47]); return { bytesRead: Math.min(len, 4) } }
    }),
    ...over
  }
}

const desc = (p: Partial<UploadFileDescriptor>): UploadFileDescriptor => ({ localId: 'l1', name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', ...p })

function svc(fs: UploadFs = fakeFs(), userDataBase = '/home/u/.cyrene'): UploadService {
  return new UploadService({ backend: { uploadAttachments: async () => [] }, userDataBase: () => userDataBase, platform: posixPlatform, fs })
}

describe('UploadService.validateFiles', () => {
  it('数量 > 10 → 逐项 failed(too_many)', async () => {
    const files = Array.from({ length: 11 }, (_, i) => desc({ localId: `l${i}` }))
    const r = await svc().validateFiles(files)
    expect(r).toHaveLength(11)
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('too_many')
  })
  it('粘贴型（无 path，有 bytes）→ 魔数嗅探 kind + ok', async () => {
    const r = await svc().validateFiles([desc({ source: 'paste', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })])
    expect(r).toEqual([{ localId: 'l1', ok: true, kind: 'image' }])
  })
  it('路径型 → 打开失败（非普通文件）→ failed(not_readable)', async () => {
    const fs = fakeFs({ open: async () => { throw new Error('EISDIR') } })
    const r = await svc(fs).validateFiles([desc({ path: '/home/u/Documents' })])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('not_readable')
  })
  it('路径在 userData 敏感范围 → failed(forbidden_path)', async () => {
    const fs = fakeFs({ realpath: async () => '/home/u/.cyrene/credentials.json' })
    const r = await svc(fs).validateFiles([desc({ path: '/home/u/.cyrene/credentials.json' })])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('forbidden_path')
  })
  it('聚合超 64MB → failed(too_large_aggregate)', async () => {
    const big = 50 * 1024 * 1024
    const r = await svc().validateFiles([
      desc({ localId: 'a', size: big, mediaType: 'video/mp4', bytes: new Uint8Array(2) }),
      desc({ localId: 'b', size: big, mediaType: 'video/mp4', bytes: new Uint8Array(2) })
    ])
    expect(r.every((x) => !x.ok)).toBe(true)
    expect(r[0].reason).toBe('too_large_aggregate')
  })
})
