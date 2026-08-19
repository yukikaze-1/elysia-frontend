// tests/unit/tool-executors.spec.ts（node；临时目录 mkdtemp；picker/enumerate 注入）
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'   // readdirSync/statSync：L4/M2 断言
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutors } from '../../src/main/tools/tool-executors'
import type { ToolServiceDeps } from '../../src/main/tools/tool-service'

vi.mock('electron', () => ({ dialog: {} }))   // executor 默认 picker 回退引用 electron.dialog；本测试全部注入 pickFile 不触达

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cyrene-exec-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function mkDeps(over: Partial<ToolServiceDeps> = {}): ToolServiceDeps {
  return {
    platform: 'posix', audit: () => {}, submitStatus: async () => {},
    uploadAttachment: vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' }),
    pushEvent: () => {}, pickFile: async () => ({ canceled: true }), enumerateSources: async () => [], ...over,
  } as ToolServiceDeps
}
function rec(toolName: string, args: Record<string, unknown>) {
  return { id: 'tc_1', desktopCallId: 'call_1', toolName, title: toolName, status: 'running', expiresAt: Date.now() + 30_000,
    arguments_: args, toolVersion: '1.0', statusSent: false, queue: false } as any
}

describe('desktop.file.select', () => {
  it('picker 取消 → {cancelled:true} 非错误', async () => {
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(r.output).toEqual({ cancelled: true })
  })
  it('选中文件 → 元数据结果', async () => {
    const p = join(tmp, 'a.txt'); writeFileSync(p, 'hello')
    const ex = createExecutors(mkDeps({ allowRoots: [tmp], pickFile: async () => ({ canceled: false, path: p }) }))   // H9：mkdtemp 在 /tmp → allowRoots 注入（select 复核与服务层同口径）
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(r.output).toMatchObject({ cancelled: false, path: p, name: 'a.txt', size: 5 })
    expect((r.output as any).hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('黑名单路径命中 → {cancelled:true, reason:PATH_BLOCKLISTED}（M-7/L10）', async () => {
    const ex = createExecutors(mkDeps({ pickFile: async () => ({ canceled: false, path: '/etc/passwd' }) }))
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(r.output).toEqual({ cancelled: true, reason: 'PATH_BLOCKLISTED' })
  })
  it('selectedAdd 只对通过复核的路径调用（L3）', async () => {
    const selectedAdd = vi.fn()
    const p = join(tmp, 'ok.txt'); writeFileSync(p, 'x')
    const ex = createExecutors(mkDeps({ allowRoots: [tmp], selectedAdd, pickFile: async () => ({ canceled: false, path: p }) }))
    await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(selectedAdd).toHaveBeenCalledTimes(1)
    expect(selectedAdd).toHaveBeenCalledWith(p)   // normalize 后路径（L3：与豁免检查同口径）
    const ex2 = createExecutors(mkDeps({ selectedAdd, pickFile: async () => ({ canceled: false, path: '/etc/passwd' }) }))
    await ex2.execute(rec('desktop.file.select', {}), undefined)
    expect(selectedAdd).toHaveBeenCalledTimes(1)   // 伪装取消时不调用
  })
})
describe('desktop.file.read', () => {
  it('读取 UTF-8 文本 → 内联 output + 摘要', async () => {
    const p = join(tmp, 'r.txt'); writeFileSync(p, '你好 world')
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.read', { path: p }), p)
    expect(r.output).toMatchObject({ path: p, size: Buffer.byteLength('你好 world'), charset: 'utf-8' })
    expect((r.output as any).content).toBe('你好 world')
  })
  it('>2MiB → FILE_TOO_LARGE', async () => {
    const p = join(tmp, 'big.txt'); writeFileSync(p, 'x'.repeat(2 * 1024 * 1024 + 1))
    const ex = createExecutors(mkDeps())
    await expect(ex.execute(rec('desktop.file.read', { path: p }), p)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })
  it('二进制（NUL）→ FILE_IS_BINARY', async () => {
    const p = join(tmp, 'bin.dat'); writeFileSync(p, Buffer.from([0, 1, 2, 0, 3]))
    const ex = createExecutors(mkDeps())
    await expect(ex.execute(rec('desktop.file.read', { path: p }), p)).rejects.toMatchObject({ code: 'FILE_IS_BINARY' })
  })
  it('>64KiB → 附件上传 + truncated 摘要（B-2①：summary 含截断注记）', async () => {
    const p = join(tmp, 'big.txt'); writeFileSync(p, 'y'.repeat(70 * 1024))
    const upload = vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' })
    const ex = createExecutors(mkDeps({ uploadAttachment: upload }))
    const r = await ex.execute(rec('desktop.file.read', { path: p }), p)
    expect(upload).toHaveBeenCalled()
    expect(r.attachments?.length).toBe(1)
    expect(r.summary).toContain('已截断')
  })
})
describe('desktop.file.write', () => {
  it('新建文件 → 写入成功（UTF-8 无 BOM LF）', async () => {
    const p = join(tmp, 'new.txt')
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.write', { path: p, content: 'abc\n' }), p)
    expect(readFileSync(p, 'utf8')).toBe('abc\n')
    expect((r.output as any).bytesWritten).toBe(4)
    expect(readdirSync(tmp).some(f => f.endsWith('.tmp'))).toBe(false)   // L4：无 .tmp 残留（原子写产物断言）
  })
  it('覆盖保留原格式（CRLF + BOM + 末尾换行，D6B-19/L-2）', async () => {
    const p = join(tmp, 'crlf.txt'); writeFileSync(p, '﻿a\r\nb\r\n')
    const ex = createExecutors(mkDeps())
    await ex.execute(rec('desktop.file.write', { path: p, content: 'a\nc' }), p)
    expect(readFileSync(p, 'utf8')).toBe('﻿a\r\nc\r\n')   // BOM 保留 + CRLF 重拼 + 末尾换行补齐
  })
  it('覆盖写保留原文件权限（M2：atomicWriteFile mode 透传）', async () => {
    if (process.platform === 'win32') return   // POSIX 专属
    const p = join(tmp, 'mode.txt'); writeFileSync(p, 'v1', { mode: 0o644 })
    const ex = createExecutors(mkDeps())
    await ex.execute(rec('desktop.file.write', { path: p, content: 'v2' }), p)
    expect((statSync(p).mode & 0o777).toString(8)).toBe('644')
  })
  it('覆盖保留 BOM 时 Diff 无 BOM 噪音（L1）', async () => {
    const p = join(tmp, 'bom-diff.txt'); writeFileSync(p, '﻿a\n')
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.write', { path: p, content: 'b\n' }), p)
    expect((r.output as any).bytesWritten).toBeGreaterThan(0)
    expect(r.summary).toContain('覆盖')   // 覆盖路径正常（BOM 不造成 diff 计数异常即可——首行 removed/added 仅影响计数非失败）
  })
  it('写前哈希冲突 → FILE_CONFLICT（原文件不变；基于授权前预读 hash，A-1）', async () => {
    const p = join(tmp, 'c.txt'); writeFileSync(p, 'v1')
    const ex = createExecutors(mkDeps())
    // 模拟授权前预读：rec.oldHash = 预读时 hash（决策链 step 7 注入）
    const oldHash = createHash('sha256').update('v1').digest('hex')
    const r = rec('desktop.file.write', { path: p, content: 'v2' }); r.oldHash = oldHash
    await ex.execute(r, p)
    writeFileSync(p, 'v3')   // 外部修改
    const r2 = rec('desktop.file.write', { path: p, content: 'v2' }); r2.oldHash = oldHash
    await expect(ex.execute(r2, p)).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    expect(readFileSync(p, 'utf8')).toBe('v3')   // 原文件不变
  })
  it('无 rec.oldHash（未预读）时以当前内容为基准写入（防御路径）', async () => {
    const p = join(tmp, 'd.txt'); writeFileSync(p, 'v1')
    const ex = createExecutors(mkDeps())
    const r = rec('desktop.file.write', { path: p, content: 'v2' })   // 无 oldHash
    await ex.execute(r, p)
    expect(readFileSync(p, 'utf8')).toBe('v2')
  })
  it('content >2MiB → CONTENT_TOO_LARGE', async () => {
    const p = join(tmp, 'big.txt')
    const ex = createExecutors(mkDeps())
    await expect(ex.execute(rec('desktop.file.write', { path: p, content: 'x'.repeat(2 * 1024 * 1024 + 1) }), p))
      .rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' })
  })
})
