// tests/unit/tool-history.spec.ts（node；mkdtemp 写假 audit JSONL）
// 夹具日期相对 Date.now() 派生（MED review 修复：原硬编码 2026-08-19/20 是 7 天时间炸弹——6 天后全红；
// 现以「-3 天在窗内 / -8 天在窗外」恒成立构造）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAuditEvents, HISTORY_DAYS, HISTORY_MAX } from '../../src/main/tools/tool-history'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cy-hist-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 相对日期的 audit 文件名：daysAgo 天前的 YYYY-MM-DD（UTC 当日零点基准，对齐实现 cutoff 语义） */
function auditFile(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  const y = d.getUTCFullYear(); const m = String(d.getUTCMonth() + 1).padStart(2, '0'); const day = String(d.getUTCDate()).padStart(2, '0')
  return `audit-${y}-${m}-${day}.jsonl`
}
/** 相对日期的 ISO ts（文件内行 ts，与文件名同日） */
function isoAt(daysAgo: number, hhmm: string): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  const y = d.getUTCFullYear(); const m = String(d.getUTCMonth() + 1).padStart(2, '0'); const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}T${hhmm}:00Z`
}

describe('tool-history', () => {
  it('HISTORY_DAYS=7 / HISTORY_MAX=200 常量存在', () => {
    expect(HISTORY_DAYS).toBe(7); expect(HISTORY_MAX).toBe(200)
  })
  it('回读：readdir 倒序 + 过滤 tool:*+grant:* + ts 倒序 + limit', () => {
    writeFileSync(join(dir, auditFile(0)), [
      JSON.stringify({ ts: isoAt(0, '10:00'), type: 'tool:decision', callId: 'c1' }),
      JSON.stringify({ ts: isoAt(0, '11:00'), type: 'chat:send', summary: 'x' }),   // 非 tool/grant 过滤
      JSON.stringify({ ts: isoAt(0, '12:00'), type: 'grant:created', permissionGrantId: 'g1' }),
    ].join('\n'))
    writeFileSync(join(dir, auditFile(1)), JSON.stringify({ ts: isoAt(1, '10:00'), type: 'tool:terminal', status: 'completed' }) + '\n')
    const rows = readAuditEvents(dir, { limit: 10 })
    expect(rows.map((r) => r.ts)).toEqual([isoAt(0, '12:00'), isoAt(0, '10:00'), isoAt(1, '10:00')])   // ts 倒序 + 过滤
    expect(rows.map((r) => r.type)).toEqual(['grant:created', 'tool:decision', 'tool:terminal'])
  })
  it('HISTORY_DAYS 边界：超 7 天文件不读', () => {
    writeFileSync(join(dir, auditFile(0)), JSON.stringify({ ts: isoAt(0, '10:00'), type: 'tool:decision' }) + '\n')
    writeFileSync(join(dir, auditFile(8)), JSON.stringify({ ts: isoAt(8, '10:00'), type: 'tool:decision' }) + '\n')   // 8 天前 → 出窗
    const rows = readAuditEvents(dir, { limit: 10 })
    expect(rows).toHaveLength(1)
  })
  it('HISTORY_MAX 合并总量上限 + 损坏行跳过不崩溃 + logger.warn（spec §3.4）', () => {
    const lines: string[] = []
    for (let i = 0; i < 250; i++) lines.push(JSON.stringify({ ts: isoAt(0, `10:${String(i % 60).padStart(2, '0')}`), type: 'tool:decision' }))
    lines.splice(100, 0, '{broken json')
    writeFileSync(join(dir, auditFile(0)), lines.join('\n'))
    const logger = { warn: vi.fn() }
    const rows = readAuditEvents(dir, { limit: 500 }, logger)
    expect(rows).toHaveLength(HISTORY_MAX)
    expect(logger.warn).toHaveBeenCalledWith('history:broken-line', expect.objectContaining({ file: auditFile(0) }))
  })
  it('逐文件流式读满即停：大文件 + 小 limit', () => {
    writeFileSync(join(dir, auditFile(0)), Array.from({ length: 500 }, (_, i) => JSON.stringify({ ts: isoAt(0, `10:${String(i % 60).padStart(2, '0')}`), type: 'tool:decision' })).join('\n'))
    const rows = readAuditEvents(dir, { limit: 30 })
    expect(rows).toHaveLength(30)
  })
})
