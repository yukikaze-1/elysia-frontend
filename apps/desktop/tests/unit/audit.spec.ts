import { describe, expect, it, vi } from 'vitest'
import { createAuditor, auditFilesToDelete } from '../../src/main/diagnostics/audit'
import type { FileWriter } from '../../src/main/diagnostics/file-writer'

function fakeWriter(): { writer: FileWriter; lines: string[] } {
  const lines: string[] = []
  return { writer: { append: vi.fn(async (l: string) => { lines.push(l) }), flush: vi.fn(async () => {}), close: vi.fn(async () => {}) }, lines }
}

describe('auditFilesToDelete（30 天清理纯函数）', () => {
  it('只删严格早于 today-retentionDays 的 audit-*.jsonl，不匹配不删', () => {
    const today = new Date(2026, 7, 10) // 2026-08-10
    const files = [
      'audit-2026-07-10.jsonl', // < cutoff(07-11) → 删
      'audit-2026-07-11.jsonl', // == cutoff → 保留
      'audit-2026-08-01.jsonl', // 近期 → 保留
      'notes.txt',              // 不匹配 → 不删
      'audit-bad-date.jsonl'    // 不匹配 → 不删
    ]
    expect(auditFilesToDelete(files, 30, today)).toEqual(['audit-2026-07-10.jsonl'])
  })
})

describe('createAuditor', () => {
  it('audit 事件 JSONL 落盘（summary 净化：路径+token 脱敏）', async () => {
    const { writer, lines } = fakeWriter()
    const sanitize = (m: string): string => m.replace(/\/home\/alice/g, '~')
    const a = createAuditor(writer, { sanitize, retentionDays: 30, dir: '/audit' })
    await a.audit({ ts: 't', type: 'tool:run', summary: 'read /home/alice/x with Bearer abc.def-ghi_123XYZ' })
    const parsed = JSON.parse(lines[0])
    expect(parsed.type).toBe('tool:run')
    expect(parsed.summary).toBe('read ~/x with Bearer [REDACTED]')
  })
  it('append-only：字段原样传递（file-writer 是 dumb append，净化只在此层）', async () => {
    const { writer, lines } = fakeWriter()
    const a = createAuditor(writer, { sanitize: (m) => m, retentionDays: 30, dir: '/audit' })
    await a.audit({ ts: 't', type: 'credential:set', toolId: 'tid', callId: 'cid', status: 'ok', durationMs: 12 })
    const parsed = JSON.parse(lines[0])
    expect(parsed.toolId).toBe('tid')
    expect(parsed.callId).toBe('cid')
    expect(parsed.durationMs).toBe(12)
  })
  it('扩展字段（riskLevel/permissionDecision/startedAt/errorCode/cancelSource）可选透传不破坏既有（Task 5）', async () => {
    const { writer, lines } = fakeWriter()
    const a = createAuditor(writer, { sanitize: (m) => m, retentionDays: 30, dir: '/audit' })
    await a.audit({ ts: 't', type: 'tool:decision', toolId: 'tid', callId: 'cid', status: 'awaiting_permission', summary: 'path=<str:8>', riskLevel: 'medium', permissionDecision: 'allow_once', startedAt: '2026-08-20T00:00:00.000Z', errorCode: 'TOOL_ERROR', cancelSource: 'user' })
    const parsed = JSON.parse(lines[0])
    expect(parsed).toMatchObject({ riskLevel: 'medium', permissionDecision: 'allow_once', startedAt: '2026-08-20T00:00:00.000Z', errorCode: 'TOOL_ERROR', cancelSource: 'user' })
    // 既有字段不受扩展影响
    expect(parsed.toolId).toBe('tid')
    expect(parsed.callId).toBe('cid')
    expect(parsed.status).toBe('awaiting_permission')
  })
  it('close 委托 writer.close', async () => {
    const { writer } = fakeWriter()
    const a = createAuditor(writer, { sanitize: (m) => m, retentionDays: 30, dir: '/audit' })
    await a.close()
    expect(writer.close).toHaveBeenCalled()
  })
})
