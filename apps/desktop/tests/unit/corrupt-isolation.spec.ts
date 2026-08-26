// tests/unit/corrupt-isolation.spec.ts —— Task 5: createCorruptIsolation 骨架。
// 契约 M-3：复用真实 Logger 接口；M-4/HIGH-1：.corrupt-<tag>-<ts> 隔离 + pruneCorrupt 有界保留只留最新一份。
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCorruptIsolation } from '../../src/main/persistence/corrupt-isolation'

function makeDeps() {
  return { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }, countDiagnostic: vi.fn() }
}

describe('createCorruptIsolation 骨架', () => {
  it('isolate 正常隔离 → .corrupt-<tag>-<ts> 备份 + countDiagnostic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'ci-'))
    const iso = createCorruptIsolation(makeDeps())
    await expect(iso.isolate('/etc/passwd', 'x', dir)).rejects.toThrow()
  })

  it('dropInvalid 计数', () => {
    const d = makeDeps()
    const iso = createCorruptIsolation(d)
    iso.dropInvalid('cache:drop-invalid')
    expect(d.countDiagnostic).toHaveBeenCalledWith('cache:drop-invalid')
  })

  it('pruneCorrupt 只留最新一份（HIGH-1）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-'))
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
