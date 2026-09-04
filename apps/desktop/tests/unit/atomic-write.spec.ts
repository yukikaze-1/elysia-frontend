import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWriteFile } from '../../src/main/credentials/atomic-write'
import { SafeOpenConflictError } from '../../src/main/persistence/safe-open'

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
  it('陈旧 temp（EEXIST）→ unlink 重试成功', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    writeFileSync(join(root, 'config', 'credentials.json.tmp'), 'stale', { mode: 0o600 })
    await atomicWriteFile(p, 'fresh', { safeRoot: root })
    expect(readFileSync(p, 'utf8')).toBe('fresh')
    expect(existsSync(join(root, 'config', 'credentials.json.tmp'))).toBe(false)
  })
  it('陈旧 temp 仍 EEXIST（tmp 为目录，unlink 失败）→ 抛 SafeOpenConflictError（上抛不静默）', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    mkdirSync(join(root, 'config', 'credentials.json.tmp')) // tmp 是目录：unlink EISDIR 被吞，重试仍 EEXIST → 上抛
    await expect(atomicWriteFile(p, 'x', { safeRoot: root })).rejects.toBeInstanceOf(SafeOpenConflictError)
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
