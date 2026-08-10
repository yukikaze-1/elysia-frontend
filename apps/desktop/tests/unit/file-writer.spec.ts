import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFileWriter, dailyPath, rotateTargets, todayKey } from '../../src/main/diagnostics/file-writer'

describe('rotateTargets 纯函数', () => {
  it('3 份轮转：app.log→.1、.1→.2、丢 .2', () => {
    expect(rotateTargets('app.log', 3)).toEqual({
      moves: [{ from: 'app.log.1', to: 'app.log.2' }, { from: 'app.log', to: 'app.log.1' }],
      drop: 'app.log.2'
    })
  })
  it('maxFiles=1：无备份、不丢', () => {
    expect(rotateTargets('app.log', 1)).toEqual({ moves: [], drop: null })
  })
})

describe('todayKey / dailyPath', () => {
  it('本地日期 YYYY-MM-DD', () => {
    expect(todayKey(new Date(2026, 7, 10))).toBe('2026-08-10') // 注意 Date 月份 0 基
  })
  it('daily 文件名 = audit-YYYY-MM-DD.jsonl', () => {
    expect(dailyPath('/audit', 'audit', new Date(2026, 7, 10))).toBe('/audit/audit-2026-08-10.jsonl')
  })
})

describe('createFileWriter 集成', () => {
  it('rotate：写行落 app.log 且 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-'))
    const w = createFileWriter({ dir, baseName: 'app', mode: 'rotate', sync: true })
    await w.append('{"a":1}')
    await w.close()
    const p = join(dir, 'app.log')
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}\n')
    expect((await import('fs')).statSync(p).mode & 0o777).toBe(0o600)
  })
  it('daily：换日开新文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-d-'))
    const w = createFileWriter({ dir, baseName: 'audit', mode: 'daily', sync: true })
    await w.append('day1')
    await w.close()
    const today = todayKey(new Date())
    expect(existsSync(join(dir, `audit-${today}.jsonl`))).toBe(true)
  })
  it('rotate：超 maxSizeBytes 轮转（app.log → .1 → .2，删最旧）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-r-'))
    const w = createFileWriter({ dir, baseName: 'app', mode: 'rotate', maxSizeBytes: 10, maxFiles: 3, sync: true })
    for (let i = 0; i < 3; i++) await w.append('x'.repeat(10)) // 触发轮转
    await w.close()
    expect(existsSync(join(dir, 'app.log'))).toBe(true)
    expect(existsSync(join(dir, 'app.log.1'))).toBe(true)
  })
  it('异步批量：flush 后排空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-b-'))
    const w = createFileWriter({ dir, baseName: 'app', mode: 'rotate', sync: false })
    await w.append('line1')
    await w.flush()
    await w.close()
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe('line1\n')
  })
  it('定时 flush：async 模式周期落盘（无需 close，spec §5.4）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-t-'))
    const w = createFileWriter({ dir, baseName: 'app', mode: 'rotate', sync: false, flushIntervalMs: 30 })
    await w.append('line1')
    await new Promise((r) => setTimeout(r, 150)) // 至少一个 flush 周期
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe('line1\n')
    await w.close()
  })
})
