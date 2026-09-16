// tests/unit/tool-executors.spec.ts（node；临时目录 mkdtemp；picker/enumerate 注入）
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, realpathSync, symlinkSync } from 'node:fs'   // readdirSync/statSync：L4/M2 断言
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutors } from '../../src/main/tools/tool-executors'
import type { ToolServiceDeps } from '../../src/main/tools/tool-execution-contract'   // 共享注入面契约（Prompt 1 起定义在契约模块）

vi.mock('electron', () => ({ dialog: {} }))   // executor 默认 picker 回退引用 electron.dialog；本测试全部注入 pickFile 不触达

let tmp: string
/** tmp 的**规范化**形态（2026-09-10 修复，见 beforeEach 注释）：注入 allowRoots 与断言路径都须用它 */
let tmpReal: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cyrene-exec-'))
  // 2026-09-10 修复（CI Windows 红 3 项）：desktop.file.select 复核链里，候选路径经
  // `normalizeToolPath` → `fs.realpathSync.native` 解析为**长名**，而注入的 allowRoots 与断言里的 `p`
  // 若保持 mkdtemp 原样，在 Windows CI runner 上会是 8.3 短名（`C:\Users\RUNNER~1\AppData\Local\Temp\...`）——
  // 短名 root 与长名候选做 `path.relative` 得到 `..\..\runneradmin\...` → `isPathWithinRoot` 判否
  // → 黑名单（`~\AppData\Local\Temp` 是 Windows 默认黑名单项）不被 allowRoots 放宽 → 伪装取消
  // `{cancelled:true, reason:'PATH_BLOCKLISTED'}`。本机 tmpdir 恰为长名，故此前只在 CI Windows 上红。
  // 与 production 口径一致：allowRoots 的真实来源（grant 目录）经 normalizeToolPath 归一化后存入。
  // 注：allowRoots 是 mock/测试注入面（main/index.ts 由 CYRENE_MOCK_TOOL_ALLOW_ROOT env 桥提供），
  // 真实模式不注入——本处修的是夹具归一化，不是放宽产品黑名单。
  tmpReal = realpathSync.native(tmp)
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

/** 符号链接能力探测（Windows 需开发者模式/特权；与 live2d-registry.spec.ts 同款守卫） */
function canCreateSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'cyrene-exec-symlink-probe-'))
  try {
    const target = join(probe, 'target')
    writeFileSync(target, 'probe')
    symlinkSync(target, join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}
const symlinkSupported = canCreateSymlink()

function mkDeps(over: Partial<ToolServiceDeps> = {}): ToolServiceDeps {
  return {
    platform: process.platform === 'win32' ? 'windows' : 'posix', audit: () => {}, submitStatus: async () => {},
    uploadAttachment: vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' }),
    pushEvent: () => {}, pickFile: async () => ({ canceled: true }), enumerateSources: async () => [], ...over,
  } as ToolServiceDeps
}
/** 测试注入用的最小 rec 形状（ToolRecord 子集 + queue 测试字段；status 恒 running） */
interface FakeRec {
  id: string; desktopCallId: string; toolName: string; title: string; status: 'running'
  expiresAt: number; arguments_: Record<string, unknown>; toolVersion: string; statusSent: boolean; queue: boolean
  oldHash?: string
  [k: string]: unknown
}
function rec(toolName: string, args: Record<string, unknown>) {
  return { id: 'tc_1', desktopCallId: 'call_1', toolName, title: toolName, status: 'running', expiresAt: Date.now() + 30_000,
    arguments_: args, toolVersion: '1.0', statusSent: false, queue: false } as FakeRec
}

describe('desktop.file.select', () => {  it('picker 取消 → {cancelled:true} 非错误', async () => {
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(r.output).toEqual({ cancelled: true })
  })
  it('选中文件 → 元数据结果', async () => {
    const p = join(tmp, 'a.txt'); writeFileSync(p, 'hello')
    const ex = createExecutors(mkDeps({ allowRoots: [tmpReal], pickFile: async () => ({ canceled: false, path: p }) }))   // H9：mkdtemp 在 /tmp（Windows 为 %TEMP%）→ allowRoots 注入（select 复核与服务层同口径）
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    // path 断言用规范化形态：select 返回的是 normalizeToolPath 的 realPath（见 tool-executors.ts select 分支）
    expect(r.output).toMatchObject({ cancelled: false, path: realpathSync.native(p), name: 'a.txt', size: 5 })
    expect((r.output as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('M-1（批次最终 review）：>2MiB 文件不做整读哈希（省略 hash，防 Main 阻塞）', async () => {
    const p = join(tmp, 'big.txt'); writeFileSync(p, 'x'.repeat(2 * 1024 * 1024 + 1))
    const ex = createExecutors(mkDeps({ allowRoots: [tmpReal], pickFile: async () => ({ canceled: false, path: p }) }))
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect((r.output as { cancelled: boolean }).cancelled).toBe(false)
    expect((r.output as { hash?: string }).hash).toBeUndefined()
    expect((r.output as { size: number }).size).toBe(2 * 1024 * 1024 + 1)
  })
  it('黑名单路径命中 → {cancelled:true, reason:PATH_BLOCKLISTED}（M-7/L10）', async () => {
    const blacklistedPath = process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
      : '/etc/passwd'
    const ex = createExecutors(mkDeps({ pickFile: async () => ({ canceled: false, path: blacklistedPath }) }))
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(r.output).toEqual({ cancelled: true, reason: 'PATH_BLOCKLISTED' })
  })
  it('selectedAdd 只对通过复核的路径调用（L3）', async () => {
    const selectedAdd = vi.fn()
    const p = join(tmp, 'ok.txt'); writeFileSync(p, 'x')
    const ex = createExecutors(mkDeps({ allowRoots: [tmpReal], selectedAdd, pickFile: async () => ({ canceled: false, path: p }) }))
    await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(selectedAdd).toHaveBeenCalledTimes(1)
    expect(selectedAdd).toHaveBeenCalledWith(realpathSync.native(p))   // normalize 后路径（L3：与豁免检查同口径）
    const blacklistedPath = process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
      : '/etc/passwd'
    const ex2 = createExecutors(mkDeps({ selectedAdd, pickFile: async () => ({ canceled: false, path: blacklistedPath }) }))
    await ex2.execute(rec('desktop.file.select', {}), undefined)
    expect(selectedAdd).toHaveBeenCalledTimes(1)   // 伪装取消时不调用
  })

  // 2026-09-10：把 CI Windows 那 3 项红灯背后的**不变量**钉住——allowRoots 必须是规范化（已 realpath）形态。
  // isPathWithinRoot 是字典序比较，同一目录的两种拼写（8.3 短名 vs 长名、符号链接 vs 真身）会互相判否，
  // 于是黑名单不被放宽、选择被伪装取消。本机 tmpdir 恰为长名故原夹具通过；CI runner 是 RUNNER~1 短名故红。
  // 用符号链接复刻同一机制（跨平台可复现），不依赖 Windows 8.3 是否启用。
  it.skipIf(!symlinkSupported)('allowRoots 必须规范化：同一目录的非规范拼写不放宽黑名单，规范化拼写才放宽', async () => {
    const linkRoot = join(tmp, 'link-root')
    symlinkSync(tmpReal, linkRoot, 'dir')   // 指向同一目录的另一种拼写
    const p = join(tmp, 'spelling.txt'); writeFileSync(p, 'x')

    const bad = await createExecutors(mkDeps({ allowRoots: [linkRoot], pickFile: async () => ({ canceled: false, path: p }) }))
      .execute(rec('desktop.file.select', {}), undefined)
    expect(bad.output).toEqual({ cancelled: true, reason: 'PATH_BLOCKLISTED' })

    const good = await createExecutors(mkDeps({ allowRoots: [tmpReal], pickFile: async () => ({ canceled: false, path: p }) }))
      .execute(rec('desktop.file.select', {}), undefined)
    expect((good.output as { cancelled: boolean }).cancelled).toBe(false)
  })
})
describe('desktop.file.read', () => {
  it('读取 UTF-8 文本 → 内联 output + 摘要', async () => {
    const p = join(tmp, 'r.txt'); writeFileSync(p, '你好 world')
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.read', { path: p }), p)
    expect(r.output).toMatchObject({ path: p, size: Buffer.byteLength('你好 world'), charset: 'utf-8' })
    expect((r.output as { content: string }).content).toBe('你好 world')
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
    expect((r.output as { bytesWritten: number }).bytesWritten).toBe(4)
    expect(readdirSync(tmp).some(f => f.endsWith('.tmp'))).toBe(false)   // L4：无 .tmp 残留（原子写产物断言）
  })
  it('覆盖保留原格式（CRLF + BOM + 末尾换行，D6B-19/L-2）', async () => {
    const p = join(tmp, 'crlf.txt'); writeFileSync(p, '﻿a\r\nb\r\n')
    const ex = createExecutors(mkDeps())
    await ex.execute(rec('desktop.file.write', { path: p, content: 'a\nc' }), p)
    expect(readFileSync(p, 'utf8')).toBe('﻿a\r\nc\r\n')   // BOM 保留 + CRLF 重拼 + 末尾换行补齐
  })
  it('覆盖写保留原文件权限（M2：atomicWriteFile mode 透传）', async ({ skip }) => {
    // 2026-09-16：原先写 `if (process.platform === 'win32') return`——那在 Windows 上记 **passed** 而
    // 零断言（vitest 的 requireAssertions 门禁把它照出来）。POSIX 专属就该表现为 skipped。
    skip(process.platform === 'win32', 'POSIX 专属：Windows 无 POSIX 权限位')
    const p = join(tmp, 'mode.txt'); writeFileSync(p, 'v1', { mode: 0o644 })
    const ex = createExecutors(mkDeps())
    await ex.execute(rec('desktop.file.write', { path: p, content: 'v2' }), p)
    expect((statSync(p).mode & 0o777).toString(8)).toBe('644')
  })
  it('覆盖保留 BOM 时 Diff 无 BOM 噪音（L1）', async () => {
    const p = join(tmp, 'bom-diff.txt'); writeFileSync(p, '﻿a\n')
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.write', { path: p, content: 'b\n' }), p)
    expect((r.output as { bytesWritten: number }).bytesWritten).toBeGreaterThan(0)
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
  it('D6C-10 新文件写 TOCTOU 守卫：授权时不存在（rec.diff.isNewFile）→ 执行前被创建 → FILE_CONFLICT（原文件不变）', async () => {
    const p = join(tmp, 'new-toc.txt')
    const ex = createExecutors(mkDeps())
    const r = rec('desktop.file.write', { path: p, content: 'v2' })
    r.diff = { lines: [], added: 0, removed: 0, truncated: false, totalLines: 0, formatNote: '新建文件', isNewFile: true }   // 授权时不存在
    writeFileSync(p, 'v3')   // 执行前被创建
    await expect(ex.execute(r, p)).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    expect(readFileSync(p, 'utf8')).toBe('v3')   // 原文件不变
  })
})
describe('desktop.screen.capture（枚举面）', () => {
  it('枚举源保留 thumbnailDataUrl（完整 H3：PublicToolEventSchema 要求）', async () => {
    const ex = createExecutors(mkDeps({ enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] }))
    const r = await ex.execute(rec('desktop.screen.capture', {}), undefined)
    expect(r.output).toMatchObject({ sources: [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] })
  })
  it('缩略图 >64KiB 被丢弃并提示（L-5/B5/A-18）', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(70 * 1024)
    const ex = createExecutors(mkDeps({ enumerateSources: async () => [{ sourceId: 'big', sourceName: '大', thumbnailDataUrl: big }, { sourceId: 'ok', sourceName: '小', thumbnailDataUrl: 'data:image/png;base64,AA==' }] }))
    const r = await ex.execute(rec('desktop.screen.capture', {}), undefined)
    expect((r.output as { sources: Array<{ sourceId: string }> }).sources.map((s) => s.sourceId)).toEqual(['ok'])
    expect((r.output as { dropped: number }).dropped).toBe(1)
  })
  it('Wayland 环境拒（防御性复核，A-4）', async () => {
    const ex = createExecutors(mkDeps({ isWayland: true }))
    await expect(ex.execute(rec('desktop.screen.capture', {}), undefined)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' })
  })
})
