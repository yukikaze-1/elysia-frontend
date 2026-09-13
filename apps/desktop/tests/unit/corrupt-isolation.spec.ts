// tests/unit/corrupt-isolation.spec.ts —— Task 5: createCorruptIsolation 骨架。
// 契约 M-3：复用真实 Logger 接口；M-4/HIGH-1：.corrupt-<tag>-<ts> 隔离 + pruneCorrupt 有界保留只留最新一份。
// H-11b（2026-09-11）：隔离失败必须上抛（此前 `.catch(() => {})` 吞掉，构成静默数据销毁路径）。
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { createCorruptIsolation } from '../../src/main/persistence/corrupt-isolation'

// 只替换 rename（其余 fs 操作保持真实）：用可控失败确定性地覆盖「改名失败」这条路径，
// 不依赖平台权限语义（Windows 上只读目录并不会让 rename 失败）。
const { renameMode } = vi.hoisted(() => ({ renameMode: { value: 'real' } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameMode.value === 'eperm') {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      if (renameMode.value === 'enoent') {
        const err = new Error('ENOENT: no such file or directory, rename') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return actual.rename(from, to)
    }
  }
})

function makeDeps() {
  return { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }, countDiagnostic: vi.fn() }
}

describe('createCorruptIsolation 骨架', () => {
  it('isolate 正常隔离 → .corrupt-<tag>-<ts> 备份 + countDiagnostic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-corrupt-'))
    const f = join(dir, 'x.json')
    writeFileSync(f, 'bad')
    const deps = makeDeps()
    const iso = createCorruptIsolation(deps)
    const dest = await iso.isolate(f, 'settings', dir)
    expect(dest).toContain('x.json.corrupt-settings-')
    expect(existsSync(dest)).toBe(true)
    expect(existsSync(f)).toBe(false)
    expect(vi.mocked(deps.countDiagnostic).mock.calls.length).toBe(1)
  })

  it('isolate 带 safeRoot 负例——传安全根外路径应拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-corrupt-'))
    const iso = createCorruptIsolation(makeDeps())
    await expect(iso.isolate('/etc/passwd', 'x', dir)).rejects.toThrow()
  })

  it('isolate 同前缀兄弟目录——不在安全根内应拒绝（C-13：startsWith(safeRoot) 误判同前缀兄弟）', async () => {
    // C-13：#assertContained 原用 real.startsWith(safeRoot)，把 /tmp/foo 判作在 /tmp/foobar 内（同前缀兄弟误判）。
    // 修复对齐 safe-open.ts 用 relative(safeRootDir, fileReal) 判定——真实路径不在安全根下即拒。
    // 构造：dir = <tmpdir>/ci-XXX；safeRoot=dir，file = <tmpdir>/ci-XXX-bro/x.json（同前缀兄弟目录，非 dir 内）。
    // 若用 startsWith(dir)，<tmpdir>/ci-XXX-bro 会以 <tmpdir>/ci-XXX 开头 → 被误判"在内"——这是 C-13 要修的。
    const dir = mkdtempSync(join(tmpdir(), 'cy-corrupt-'))
    // 兄弟目录：dir 的字符串前缀 + '-bro' 后缀，realpath 后以 dir 开头但实际不在 dir 树内
    const bro = join(tmpdir(), `${basename(dir)}-bro`)
    mkdirSync(bro, { recursive: true })
    const broFile = join(bro, 'x.json')
    writeFileSync(broFile, 'bad')
    const iso = createCorruptIsolation(makeDeps())
    // bro/x.json 不在 dir 内（虽字符串前缀匹配）→ 应拒绝；若误放行则 isolate 了一个逃逸文件
    await expect(iso.isolate(broFile, 'x', dir)).rejects.toThrow()
  })

  it('isolate 安全根内路径正常通过（C-13 回归：不在内才拒）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-corrupt-'))
    const f = join(dir, 'y.json')
    writeFileSync(f, 'ok')
    const iso = createCorruptIsolation(makeDeps())
    const dest = await iso.isolate(f, 'settings', dir)
    expect(existsSync(dest)).toBe(true)
  })

  it('dropInvalid 计数', () => {
    const d = makeDeps()
    const iso = createCorruptIsolation(d)
    iso.dropInvalid('cache:drop-invalid')
    expect(d.countDiagnostic).toHaveBeenCalledWith('cache:drop-invalid')
  })

  it('pruneCorrupt 只留最新一份（HIGH-1）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-corrupt-'))
    const f = join(dir, 'x.json')
    writeFileSync(f + '.corrupt-settings-aaa', 'a')
    writeFileSync(f + '.corrupt-settings-bbb', 'b')
    writeFileSync(f + '.corrupt-settings-ccc', 'c')
    const iso = createCorruptIsolation(makeDeps())
    await iso.pruneCorrupt(f, 'settings')
    const left = readdirSync(dir).filter((n) => n.includes('.corrupt-settings-'))
    expect(left).toEqual(['x.json.corrupt-settings-ccc'])
  })
})

// —— H-11b（2026-09-11）：隔离失败不得被吞 ——
// 修复前 `await rename(file, dest).catch(() => {})`：改名失败（AV 占用/备份代理/只读目录）被静默丢弃，
// 调用方以为「已隔离」而重建空态，于是原文件留在磁盘上、内存态已空，下一次击键即覆写。
describe('isolate 失败语义（H-11b）', () => {
  it('改名失败（EPERM）→ 上抛，且原文件仍在磁盘上未被误判为已隔离', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-h11b-'))
    const f = join(dir, 'x.json')
    writeFileSync(f, 'bad')
    const deps = makeDeps()
    const iso = createCorruptIsolation(deps)
    renameMode.value = 'eperm'
    try {
      await expect(iso.isolate(f, 'settings', dir)).rejects.toThrow(/EPERM/)
      expect(existsSync(f), '原文件必须仍在——调用方据此进入降级态保现场').toBe(true)
      expect(deps.countDiagnostic, '失败不得计入「已隔离」').not.toHaveBeenCalled()
    } finally { renameMode.value = 'real' }
  })

  it('源文件已消失（ENOENT）→ 视为隔离完成（无物可保留、无物可覆写），不误报降级', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-h11b2-'))
    const f = join(dir, 'x.json')
    writeFileSync(f, 'bad')
    const deps = makeDeps()
    const iso = createCorruptIsolation(deps)
    renameMode.value = 'enoent'
    try {
      await expect(iso.isolate(f, 'settings', dir)).resolves.toContain('.corrupt-settings-')
      expect(deps.countDiagnostic).toHaveBeenCalledTimes(1)
    } finally { renameMode.value = 'real' }
  })
})
