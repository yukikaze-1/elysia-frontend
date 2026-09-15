// tests/unit/attachment-validate.spec.ts
// Task 7:UploadService.validateFiles——数量/聚合/单文件限额、kind 矩阵、魔数嗅探、敏感范围/非普通文件拒（spec §2/§4.5）。
// env=node：注入假 UploadFs + posixPlatform，无真实 fs。
import { describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'
import { posixPlatform } from '../../src/main/persistence/safe-open'
import { PATH_REFUSED_MESSAGE, UploadService, type UploadFs } from '../../src/main/attachments/upload-service'
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

// S5-B2（2026-09-15）：描述符不再带裸 `path`，改带 Main 签发的 `fileRef`。本组用例的**意图一字未变**
// （userData 范围 / 黑名单 / 非普通文件 / 大小限额），只是把「路径」从描述符字段移到桩 registry 里——
// 这正对应改造后的真实结构：路径只存在于 Main 的表里。
const REF = 'fileref_test'
const refs = (path: string) => ({ issue: () => REF, resolve: (r: string) => (r === REF ? path : undefined), clear: () => {}, size: () => 1 })

function svc(fs: UploadFs = fakeFs(), userDataBase = '/home/u/.cyrene', logger?: { warn: (event: string, fields?: Record<string, string | number | boolean>) => void }): UploadService {
  // 桩表指向一个中性路径：具体读什么由注入的假 fs 决定（realpath 覆写是各用例的实际判据入口）。
  // 默认值必须落在**非黑名单**范围（同 HOME_DOC 的理由：`/home/u/...` 会命中「他人 home」规则）。
  return new UploadService({ backend: { uploadAttachments: async () => [] }, userDataBase: () => userDataBase, platform: posixPlatform, fs, fileRefs: refs(`${HOME_DOC}/neutral.png`), ...(logger ? { logger } : {}) })
}

/** 把「路径型描述符」写成 fileRef 形态（用例可读性用；具体路径由假 fs 的 realpath 决定） */
const byRef = (p: Partial<UploadFileDescriptor>): UploadFileDescriptor => desc({ fileRef: REF, ...p })

describe('UploadService.validateFiles', () => {
  it('数量 > 10 → 逐项 failed(too_many)', async () => {
    const files = Array.from({ length: 11 }, (_, i) => desc({ localId: `l${i}` }))
    const r = await svc().validateFiles(files)
    expect(r).toHaveLength(11)
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('too_many')
  })
  it('粘贴型（无 fileRef，有 bytes）→ 魔数嗅探 kind + ok', async () => {
    const r = await svc().validateFiles([desc({ source: 'paste', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })])
    expect(r).toEqual([{ localId: 'l1', ok: true, kind: 'image' }])
  })
  // S7（2026-09-15 安全评审）：**路径类失败一律同一公开面**。
  // 修复前四种文案各不相同，而对端可以登记任意字符串再 validate ⇒ 文案差异构成
  // 「文件存在性/敏感性 oracle」（命中黑名单意味着 realpath 成功 ⇒ 路径存在）。
  // 现在 reason 与 message 都不可区分，**具体原因只进 Main 日志**——故每条都断言日志里拿得到原因。
  it('路径型 → 打开失败 → failed(forbidden_path)（公开面与"不存在"不可区分）', async () => {
    const logger = { warn: vi.fn() }
    const fs = fakeFs({ open: async () => { throw new Error('EISDIR') } })
    const r = await svc(fs, '/home/u/.cyrene', logger).validateFiles([byRef({})])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('forbidden_path')
    expect(r[0].message).toBe(PATH_REFUSED_MESSAGE)
    expect(logger.warn).toHaveBeenCalledWith('attachments:refused', expect.objectContaining({ detail: expect.stringContaining('unreadable') as unknown as string }))
  })
  it('路径在 userData 敏感范围 → failed(forbidden_path)', async () => {
    const fs = fakeFs({ realpath: async () => '/home/u/.cyrene/credentials.json' })
    const r = await svc(fs).validateFiles([byRef({})])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('forbidden_path')
  })

  // S5-B2：未知/过期 token 走 forbidden_path；S7 起与其余路径类失败**共用同一句话**
  it('未知/过期 fileRef → failed(forbidden_path)，公开文案与其它路径类失败一致', async () => {
    const logger = { warn: vi.fn() }
    const r = await svc(fakeFs(), '/home/u/.cyrene', logger).validateFiles([desc({ fileRef: 'fileref_forged' })])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('forbidden_path')
    expect(r[0].message).toBe(PATH_REFUSED_MESSAGE)
    expect(logger.warn).toHaveBeenCalledWith('attachments:refused', expect.objectContaining({ detail: 'unknown_or_expired_file_ref' }))
  })

  // H-01（2026-09-11）：工具域既有的 PATH_BLACKLIST_DEFAULTS 此前在这条链上一次都没被调用
  it('路径在黑名单（/etc）→ failed(forbidden_path)，且**公开面与"文件不存在"逐字相同**（去 oracle）', async () => {
    const logger = { warn: vi.fn() }
    const fs = fakeFs({ realpath: async () => '/etc/passwd' })
    const r = await svc(fs, '/home/u/.cyrene', logger).validateFiles([byRef({})])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('forbidden_path')
    // 判别力：这里必须与「未知 token」「不存在」「非普通文件」三种情形**完全一致**——否则 oracle 复活
    expect(r[0].message).toBe(PATH_REFUSED_MESSAGE)
    expect(logger.warn).toHaveBeenCalledWith('attachments:refused', expect.objectContaining({ detail: 'blacklisted_path' }))
  })

  it('合法用户目录不被黑名单误伤（否则附件功能整体不可用）', async () => {
    const target = `${HOME_DOC}/a.png`
    const fs = fakeFs({ realpath: async () => target })
    const r = await svc(fs).validateFiles([byRef({})])
    expect(r[0].ok, '普通用户目录必须仍然可用').toBe(true)
  })
  it('聚合超 64MB → failed(too_large_aggregate)（路径型：预检按描述符 size，权威复核在 uploadBatch 用真值）', async () => {
    const big = 50 * 1024 * 1024
    const r = await svc().validateFiles([
      byRef({ localId: 'a', size: big, mediaType: 'video/mp4' }),
      byRef({ localId: 'b', size: big, mediaType: 'video/mp4' })
    ])
    expect(r.every((x) => !x.ok)).toBe(true)
    expect(r[0].reason).toBe('too_large_aggregate')
  })
  it('P1-1：混合批次——单文件超限只 fail 该文件，其余合法文件 ok:true 继续（逐项校验，spec §4.3/§4.4）', async () => {
    const over = 11 * 1024 * 1024   // image 限 10MB
    const r = await svc().validateFiles([
      desc({ localId: 'a', size: over, mediaType: 'image/png', fileRef: REF }),
      desc({ localId: 'b', size: 10, mediaType: 'image/png', fileRef: REF })
    ])
    expect(r).toEqual([
      { localId: 'a', ok: false, reason: 'size_limit', message: '超过该类型大小上限' },
      { localId: 'b', ok: true, kind: 'image' }
    ])
  })
  // S4（2026-09-15 安全评审）：`bytes` 分支的限额按**真实** `byteLength` 判定。
  // 修复前只看对端自报的 `size` ⇒ 伪造 `{size: 10, bytes: <11MB>}` 可以穿过全部限额。
  // 判别力：把判据换回 `d.size` ⇒ 本条红（描述符里的 size 故意写小）。
  it('P1-1：单文件超限只 fail 该文件——bytes 分支按**真实字节数**判限（自报 size 不参与）', async () => {
    const over = 11 * 1024 * 1024   // image 限 10MB
    const r = await svc().validateFiles([
      desc({ localId: 'a', size: 10, mediaType: 'image/png', bytes: new Uint8Array(over) }),
      desc({ localId: 'b', size: 10, mediaType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })
    ])
    expect(r[0]).toEqual({ localId: 'a', ok: false, reason: 'size_limit', message: '超过该类型大小上限' })
    expect(r[1]).toEqual({ localId: 'b', ok: true, kind: 'image' })
  })
})
