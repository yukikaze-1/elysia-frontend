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
    expect((await import('fs')).statSync(p).mode & 0o777).toBe(0o600)
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
})
