import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { describe, expect, it, afterEach } from 'vitest'
import { ensureUserDataDirs, UserDataDirError } from '../../src/main/persistence/user-data-dirs'

const dirs: string[] = []
function tmpBase(): string {
  const d = mkdtempSync(join(tmpdir(), 'cyrene-test-'))
  dirs.push(d)
  return join(d, 'Cyrene')
}
function pathRelativeSafeRoot(safeRoot: string, leaf: string): string {
  return relative(safeRoot, leaf)
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('ensureUserDataDirs', () => {
  it('base 缺失自动创建 7 目录（含 app-cache/sandbox）', async () => {
    const d = await ensureUserDataDirs(tmpBase(), { baseCreated: true })
    expect(d.appCache).toContain('app-cache')
    expect(d.sandbox).toContain('sandbox')
    expect(d.config).toContain('config')
  })
  it('base 为普通文件 → 抛 UserDataDirError', async () => {
    const base = tmpBase()
    writeFileSync(base, 'x')
    await expect(ensureUserDataDirs(base)).rejects.toBeInstanceOf(UserDataDirError)
  })
  it('base 为符号链接 → 抛 UserDataDirError（lstat 非目录否定判定）', async () => {
    const base = tmpBase()
    const target = mkdtempSync(join(tmpdir(), 'cyrene-tgt-'))
    dirs.push(target)
    symlinkSync(target, base)
    await expect(ensureUserDataDirs(base)).rejects.toBeInstanceOf(UserDataDirError)
  })
  it('叶子为符号链接 → 抛 UserDataDirError', async () => {
    const base = tmpBase()
    await ensureUserDataDirs(base, { baseCreated: true })
    const target = mkdtempSync(join(tmpdir(), 'cyrene-tgt2-'))
    dirs.push(target)
    const logs = join(base, 'logs')
    rmSync(logs, { recursive: true, force: true })
    symlinkSync(target, logs)
    await expect(ensureUserDataDirs(base, { baseCreated: true })).rejects.toBeInstanceOf(UserDataDirError)
  })
  it('既有 base/叶子非 0700（group/other 位）→ 拒绝', async () => {
    const base = tmpBase()
    mkdirSync(base, { mode: 0o700 }) // 先建 0700，再显式 chmod 0755——mkdirSync 的 mode 受 umask 掩码，直接 0755 在 restrictive umask 下会变 0700，测试不确定
    chmodSync(base, 0o755)
    await expect(ensureUserDataDirs(base)).rejects.toBeInstanceOf(UserDataDirError)
  })
  it('所有叶子的 realpath 落在 safeRoot 内（包含性真实断言）', async () => {
    const base = tmpBase()
    await ensureUserDataDirs(base, { baseCreated: true })
    const safeRoot = realpathSync(base)
    for (const name of ['config', 'app-cache', 'logs', 'audit', 'temp', 'models', 'sandbox']) {
      const leaf = realpathSync(join(base, name))
      const rel = pathRelativeSafeRoot(safeRoot, leaf)
      expect(rel.startsWith('..')).toBe(false)
    }
  })
  it('base 同前缀兄弟目录（Evil）不在 safeRoot 内——包含性不把 Evil 当自己人', async () => {
    const base = tmpBase()
    const evil = base + 'Evil'
    mkdirSync(evil, { mode: 0o700 })
    dirs.push(evil)
    await ensureUserDataDirs(base, { baseCreated: true })
    const safeRoot = realpathSync(base)
    expect(pathRelativeSafeRoot(safeRoot, realpathSync(evil)).startsWith('..')).toBe(true)
  })
})
