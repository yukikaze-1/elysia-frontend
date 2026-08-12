import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createServer } from 'net'
import { openSafeFile, SafeOpenConflictError, windowsPlatform } from '../../src/main/persistence/safe-open'

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cy-safe-open-'))
  mkdirSync(join(root, 'sub'), { recursive: true })
  return root
}
const root = makeDir()
const safeRoot = root // 测试锚点 = 临时根

describe.skipIf(process.platform === 'win32')('openSafeFile', () => {
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

describe('openSafeFile（非普通文件拒绝 / 平台注入）', () => {
  it.skipIf(process.platform === 'win32')('0600 FIFO existing+read 立即拒绝不阻塞', async () => {
    const p = join(root, 'sub', 'fifo.log')
    spawnSync('mkfifo', [p])
    chmodSync(p, 0o600)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'read', safeRoot })).rejects.toThrow()
  })
  it.skipIf(process.platform === 'win32')('0600 FIFO existing+append 立即拒绝不阻塞', async () => {
    const p = join(root, 'sub', 'fifo2.log')
    spawnSync('mkfifo', [p])
    chmodSync(p, 0o600)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it.skipIf(process.platform === 'win32')('Unix socket 立即拒绝', async () => {
    const p = join(root, 'sub', 'sock.sock')
    await new Promise<void>((resolve, reject) => {
      const srv = createServer()
      srv.on('error', reject)
      srv.listen(p, () => { srv.close(); resolve() })
    })
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'read', safeRoot })).rejects.toThrow()
  })
  it('目录立即拒绝（open 成功但 isFile false）', async () => {
    await expect(openSafeFile(join(root, 'sub'), { mode: 'existing', purpose: 'read', safeRoot })).rejects.toThrow()
  })
  it.skipIf(process.platform === 'win32')('/dev/null（char device）立即拒绝', async () => {
    await expect(openSafeFile('/dev/null', { mode: 'existing', purpose: 'read', safeRoot: '/dev' })).rejects.toThrow()
  })
  it.skipIf(process.platform === 'win32')('create 遇既有 FIFO → fallback 重开 existing → 拒绝不阻塞', async () => {
    const p = join(root, 'sub', 'fifo3.log')
    spawnSync('mkfifo', [p])
    chmodSync(p, 0o600)
    await expect(openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it('windowsPlatform 注入：create+ENOENT 成功首建', async () => {
    const p = join(root, 'sub', 'win-new.log')
    const r = await openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot }, windowsPlatform)
    expect(r.created).toBe(true)
    const st = await r.fd.stat()
    expect(st.isFile()).toBe(true)
    if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600) // Windows stat.mode 报 0666，0600 仅 POSIX 有意义
    await r.fd.close()
  })
  it('windowsPlatform 注入：existing+ENOENT 原样抛 ENOENT', async () => {
    const p = join(root, 'sub', 'win-missing.log')
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'read', safeRoot }, windowsPlatform))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('windowsPlatform 注入：symlink 被 lstat 拒', async () => {
    const p = join(root, 'sub', 'win-link.log')
    const target = join(root, 'outside.log')
    writeFileSync(target, 'x', { mode: 0o600 })
    symlinkSync(target, p)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot }, windowsPlatform)).rejects.toThrow()
  })
  it('windowsPlatform 注入：目录被 isFile 拒', async () => {
    await expect(openSafeFile(join(root, 'sub'), { mode: 'existing', purpose: 'read', safeRoot }, windowsPlatform)).rejects.toThrow()
  })
  it('windowsPlatform 注入：create 遇既有文件 fallback 返回 created:false', async () => {
    const p = join(root, 'sub', 'win-exists.log')
    writeFileSync(p, 'x', { mode: 0o600 })
    const r = await openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot }, windowsPlatform)
    expect(r.created).toBe(false)
    await r.fd.close()
  })
})
