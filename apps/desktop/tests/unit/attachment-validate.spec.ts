// tests/unit/attachment-validate.spec.ts
// Task 7:UploadService.validateFiles——数量/聚合/单文件限额、kind 矩阵、魔数嗅探、敏感范围/非普通文件拒（spec §2/§4.5）。
// env=node：注入假 UploadFs + posixPlatform，无真实 fs。
import { describe, expect, it } from 'vitest'
import { homedir } from 'os'
import { posixPlatform } from '../../src/main/persistence/safe-open'
import { UploadService, type UploadFs } from '../../src/main/attachments/upload-service'
import type { UploadFileDescriptor } from '@shared/contracts'

// H-01（2026-09-11）后 fixture 必须落在**非黑名单**路径：`/home/u/...` 会命中「他人 home」规则、
// `/tmp/...` 会命中 `/tmp` 条目。用当前用户真实 home 下的路径，测试意图（not_readable / size_limit）不变。
const HOME_DOC = `${homedir()}/Documents`

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
    const r = await svc(fs).validateFiles([desc({ path: HOME_DOC })])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('not_readable')
  })
  it('路径在 userData 敏感范围 → failed(forbidden_path)', async () => {
    const fs = fakeFs({ realpath: async () => '/home/u/.cyrene/credentials.json' })
    const r = await svc(fs).validateFiles([desc({ path: '/home/u/.cyrene/credentials.json' })])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('forbidden_path')
  })

  // H-01（2026-09-11）：工具域既有的 PATH_BLACKLIST_DEFAULTS 此前在这条链上一次都没被调用
  it('路径在黑名单（/etc）→ failed(forbidden_path) + 明确文案', async () => {
    const fs = fakeFs({ realpath: async () => '/etc/passwd' })
    const r = await svc(fs).validateFiles([desc({ path: '/etc/passwd' })])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('forbidden_path')
    expect(r[0].message).toContain('敏感目录')
  })

  it('合法用户目录不被黑名单误伤（否则附件功能整体不可用）', async () => {
    const target = `${HOME_DOC}/a.png`
    const fs = fakeFs({ realpath: async () => target })
    const r = await svc(fs).validateFiles([desc({ path: target })])
    expect(r[0].ok, '普通用户目录必须仍然可用').toBe(true)
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
  it('P1-1：混合批次——单文件超限只 fail 该文件，其余合法文件 ok:true 继续（逐项校验，spec §4.3/§4.4）', async () => {
    const over = 11 * 1024 * 1024   // image 限 10MB
    const r = await svc().validateFiles([
      desc({ localId: 'a', size: over, mediaType: 'image/png', path: `${HOME_DOC}/a.png` }),
      desc({ localId: 'b', size: 10, mediaType: 'image/png', path: `${HOME_DOC}/b.png` })
    ])
    expect(r).toEqual([
      { localId: 'a', ok: false, reason: 'size_limit', message: '超过该类型大小上限' },
      { localId: 'b', ok: true, kind: 'image' }
    ])
  })
  it('P1-1：单文件超限只 fail 该文件——失败文件不阻断合法文件按 bytes 魔数嗅探（逐项）', async () => {
    const over = 11 * 1024 * 1024
    const r = await svc().validateFiles([
      desc({ localId: 'a', size: over, mediaType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
      desc({ localId: 'b', size: 10, mediaType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })
    ])
    expect(r[0]).toEqual({ localId: 'a', ok: false, reason: 'size_limit', message: '超过该类型大小上限' })
    expect(r[1]).toEqual({ localId: 'b', ok: true, kind: 'image' })
  })
})
