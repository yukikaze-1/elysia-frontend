// tests/unit/tool-history.spec.ts（node；mkdtemp 写假 audit JSONL）
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAuditEvents, HISTORY_DAYS, HISTORY_MAX } from '../../src/main/tools/tool-history'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cy-hist-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('tool-history', () => {
  it('HISTORY_DAYS=7 / HISTORY_MAX=200 常量存在', () => {
    expect(HISTORY_DAYS).toBe(7); expect(HISTORY_MAX).toBe(200)
  })
  it('回读：readdir 倒序 + 过滤 tool:*+grant:* + ts 倒序 + limit', () => {
    writeFileSync(join(dir, 'audit-2026-08-20.jsonl'), [
      JSON.stringify({ ts: '2026-08-20T10:00:00Z', type: 'tool:decision', callId: 'c1' }),
      JSON.stringify({ ts: '2026-08-20T11:00:00Z', type: 'chat:send', summary: 'x' }),   // 非 tool/grant 过滤
      JSON.stringify({ ts: '2026-08-20T12:00:00Z', type: 'grant:created', permissionGrantId: 'g1' }),
    ].join('\n'))
    writeFileSync(join(dir, 'audit-2026-08-19.jsonl'), JSON.stringify({ ts: '2026-08-19T10:00:00Z', type: 'tool:terminal', status: 'completed' }) + '\n')
    const rows = readAuditEvents(dir, { limit: 10 })
    expect(rows.map((r) => r.ts)).toEqual(['2026-08-20T12:00:00Z', '2026-08-20T10:00:00Z', '2026-08-19T10:00:00Z'])   // ts 倒序 + 过滤
    expect(rows.map((r) => r.type)).toEqual(['grant:created', 'tool:decision', 'tool:terminal'])
  })
  it('HISTORY_DAYS 边界：超 7 天文件不读', () => {
    writeFileSync(join(dir, 'audit-2026-08-20.jsonl'), JSON.stringify({ ts: '2026-08-20T10:00:00Z', type: 'tool:decision' }) + '\n')
    writeFileSync(join(dir, 'audit-2026-08-12.jsonl'), JSON.stringify({ ts: '2026-08-12T10:00:00Z', type: 'tool:decision' }) + '\n')   // 8 天前
    const rows = readAuditEvents(dir, { limit: 10 })
    expect(rows).toHaveLength(1)
  })
  it('HISTORY_MAX 合并总量上限 + 损坏行跳过不崩溃', () => {
    const lines: string[] = []
    for (let i = 0; i < 250; i++) lines.push(JSON.stringify({ ts: `2026-08-20T${String(i).padStart(2, '0')}:00:00Z`, type: 'tool:decision' }))
    lines.splice(100, 0, '{broken json')
    writeFileSync(join(dir, 'audit-2026-08-20.jsonl'), lines.join('\n'))
    const rows = readAuditEvents(dir, { limit: 500 })
    expect(rows).toHaveLength(HISTORY_MAX)
  })
  it('逐文件流式读满即停：大文件 + 小 limit', () => {
    writeFileSync(join(dir, 'audit-2026-08-20.jsonl'), Array.from({ length: 500 }, (_, i) => JSON.stringify({ ts: `2026-08-20T00:${String(i % 60).padStart(2, '0')}:00Z`, type: 'tool:decision' })).join('\n'))
    const rows = readAuditEvents(dir, { limit: 30 })
    expect(rows).toHaveLength(30)
  })
})
