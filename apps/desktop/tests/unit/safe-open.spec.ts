import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openSafeFile, SafeOpenConflictError } from '../../src/main/persistence/safe-open'

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cy-safe-open-'))
  mkdirSync(join(root, 'sub'), { recursive: true })
  return root
}
const root = makeDir()
const safeRoot = root // 测试锚点 = 临时根

describe('openSafeFile', () => {
  it('create 模式：新文件 0600 首建（fchmod 修正 umask）', async () => {
    const p = join(root, 'sub', 'app.log')
    const r = await openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })
    expect(r.created).toBe(true)
    const st = await r.fd.stat()
    expect(st.mode & 0o777).toBe(0o600)
    await r.fd.close()
  })
  it('create 模式遇既有文件 → fallback 重开 existing（mode 复核）', async () => {
    const p = join(root, 'sub', 'exists.log')
    writeFileSync(p, 'x', { mode: 0o600 })
    const r = await openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })
    expect(r.created).toBe(false)
    await r.fd.close()
  })
  it('create 模式 onConflict:error 遇既有文件 → 抛 SafeOpenConflictError', async () => {
    const p = join(root, 'sub', 'conflict.log')
    writeFileSync(p, 'x', { mode: 0o600 })
    await expect(openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot, onConflict: 'error' })).rejects.toBeInstanceOf(SafeOpenConflictError)
  })
  it('existing 模式：既有文件 group/other 位 → 拒绝（write 模式 0600 复核）', async () => {
    const p = join(root, 'sub', 'loose.log')
    writeFileSync(p, 'x')
    chmodSync(p, 0o644) // writeFileSync mode 受 umask 掩码，chmod 固定权限后再断言
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot })).rejects.toThrow(/权限|mode/i)
  })
  it('existing 模式：0400 只读文件 append → 拒绝（write 需 owner 读+写）', async () => {
    const p = join(root, 'sub', 'ro.log')
    writeFileSync(p, 'x')
    chmodSync(p, 0o400)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it('read 模式：0400 只读文件通过（read 复核 0400）', async () => {
    const p = join(root, 'sub', 'ro2.log')
    writeFileSync(p, 'x')
    chmodSync(p, 0o400)
    const r = await openSafeFile(p, { mode: 'existing', purpose: 'read', safeRoot })
    expect(r.created).toBe(false)
    await r.fd.close()
  })
  it('symlink 文件 → 拒绝（O_NOFOLLOW）', async () => {
    const p = join(root, 'sub', 'link.log')
    const target = join(root, 'outside.log')
    writeFileSync(target, 'x', { mode: 0o600 })
    symlinkSync(target, p)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it('realpath 逃逸 safeRoot → 拒绝', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cy-outside-'))
    const p = join(root, 'sub', 'escape.log')
    symlinkSync(join(outside, 'f'), p) // 悬空 symlink → realpath 解析到 outside
    await expect(openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it('中间目录换链逃逸 safeRoot → 拒绝（realpath 包含性真正覆盖）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cy-escape-out-'))
    const linkDir = join(root, 'escape-sub')
    symlinkSync(outside, linkDir) // 中间组件 symlink→outside：open 跟随成功，realpath 逃逸
    const p = join(linkDir, 'f.log')
    await expect(openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })).rejects.toThrow(/逃逸/)
  })
})
