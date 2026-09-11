import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWriteFile } from '../../src/main/credentials/atomic-write'

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cy-atomic-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  return root
}

describe('atomicWriteFile', () => {
  it('写新文件：内容正确且 0600', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    await atomicWriteFile(p, '{"version":1}', { safeRoot: root })
    expect(readFileSync(p, 'utf8')).toBe('{"version":1}')
    if (process.platform !== 'win32') expect((await import('fs')).statSync(p).mode & 0o777).toBe(0o600) // Windows stat.mode 报 0666，0600 仅 POSIX 有意义
  })
  it('覆盖既有文件（rename 原子，无 .tmp 残留）', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    writeFileSync(p, 'old', { mode: 0o600 })
    await atomicWriteFile(p, 'new', { safeRoot: root })
    expect(readFileSync(p, 'utf8')).toBe('new')
    expect(existsSync(join(root, 'config', 'credentials.json.tmp'))).toBe(false)
  })
  // H-11a（2026-09-11）：临时名从固定的 `<name>.tmp` 改为 `<name>.<uuid>.tmp`，故下面两条用例的
  // **前提**（同名 temp 相撞 → EEXIST）已不存在——它们此前保护的是「陈旧 temp 不把写入变成砖」，
  // 现在这条性质由「名字根本不会相撞」更强地保证。此处改写为断言**新契约**，而不是删掉了事：
  // 陈旧 temp 仍会被回收（主动 sweep），且回收失败不影响写入。
  it('陈旧（早于阈值）temp 被回收，且不阻塞本次写入', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    const stale = join(root, 'config', 'credentials.json.00000000-0000-4000-8000-000000000000.tmp')
    writeFileSync(stale, 'stale', { mode: 0o600 })
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)   // 2 小时前 > 1 小时阈值
    utimesSync(stale, old, old)

    await atomicWriteFile(p, 'fresh', { safeRoot: root })

    expect(readFileSync(p, 'utf8')).toBe('fresh')
    expect(existsSync(stale), '早于阈值的陈旧 temp 应被回收').toBe(false)
  })
  it('名字像 temp 的目录不会被回收误伤，且写入照常成功', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    const dirLikeTemp = join(root, 'config', 'credentials.json.00000000-0000-4000-8000-000000000001.tmp')
    mkdirSync(dirLikeTemp)
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(dirLikeTemp, old, old)

    await atomicWriteFile(p, 'x', { safeRoot: root })

    expect(readFileSync(p, 'utf8')).toBe('x')
    expect(existsSync(dirLikeTemp), 'sweep 只回收普通文件，不得删目录').toBe(true)
  })
  it('父目录逃逸 safeRoot → 拒绝', async () => {
    const root = makeDir()
    const outside = mkdtempSync(join(tmpdir(), 'cy-atomic-out-'))
    const p = join(outside, 'credentials.json')
    await expect(atomicWriteFile(p, 'x', { safeRoot: root })).rejects.toThrow(/逃逸|安全根/i)
  })
  it('安全根内目录名含两个点仍可原子写', async () => {
    const root = makeDir()
    const legal = join(root, 'cache..valid')
    mkdirSync(legal)
    const p = join(legal, 'state.json')
    await atomicWriteFile(p, 'legal', { safeRoot: root })
    expect(readFileSync(p, 'utf8')).toBe('legal')
  })
  it('真正的 parent 与 sibling escape 均拒绝', async () => {
    const root = makeDir()
    const safe = join(root, 'config')
    await expect(atomicWriteFile(join(root, 'parent.json'), 'x', { safeRoot: safe })).rejects.toThrow(/逃逸|安全根/i)
    const sibling = join(root, 'sibling')
    mkdirSync(sibling)
    await expect(atomicWriteFile(join(sibling, 'sibling.json'), 'x', { safeRoot: safe })).rejects.toThrow(/逃逸|安全根/i)
  })
})
