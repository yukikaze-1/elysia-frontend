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

  // —— 2026-09-15 修（代码侧疑点 2）：**单文件超过 limit 时保留的必须是最新 N 条** ——
  // 修前：循环「读满 limit 即停」是从文件**头部**（=当天最早）收集，末尾 ts 倒序只是把这 N 条陈旧条目
  // 内部排序 ⇒ 设置页显示「当日最早 200 条」。修后：逐文件日期倒序 + 文件内**逐行倒序**收集。
  //
  // 时间戳必须**合法且逐条递增**：原先此处用 `10:00:${i}` 拼秒位，i>59 时得到
  // `2026-09-15T10:00:259:00Z` 这种非法 ISO——`Date` 解不出、字符串比较也不按数值走，
  // 于是「留下的是哪一批」根本断言不了（本轮写这条用例时实测踩到）。
  // 下面的 `secAt` 用「分钟 = 10 + ⌊i/60⌋、秒 = i % 60」，对 i ≤ 3599 既有唯一值也保持字典序递增。
  const secAt = (daysAgo: number, i: number): string =>
    isoAt(daysAgo, `1${String(Math.floor(i / 60)).padStart(1, '0')}:${String(i % 60).padStart(2, '0')}`)

  it('单文件超过 limit → 保留**最新** N 条（不是最早的 N 条）', () => {
    const total = 260
    const limit = 200
    const lines = Array.from({ length: total }, (_, i) =>
      JSON.stringify({ ts: secAt(0, i), type: 'tool:decision', callId: `c${i}` }))
    writeFileSync(join(dir, auditFile(0)), lines.join('\n'))
    const rows = readAuditEvents(dir, { limit })
    expect(rows).toHaveLength(limit)
    expect(rows.at(0)!.ts, '首条应是最新一条').toBe(secAt(0, total - 1))
    expect(rows.at(-1)!.ts, '末条应是保留窗口里最旧的一条').toBe(secAt(0, total - limit))
    // 承重断言：修前最早的那条会**出现在结果里**（这正是缺陷的可观测形态）
    expect(rows.some((r) => r.ts === secAt(0, 0)), '不得包含全文件最早的那条（修前的缺陷形态）').toBe(false)
    expect(rows.every((r) => r.ts >= secAt(0, total - limit))).toBe(true)
  })
  it('多日窗口：跨文件仍取最新 N 条（新的一天优先，且不因旧文件先读而被截断）', () => {
    // 旧的一天 150 条、新的一天 150 条；limit 200 ⇒ 应留下「新的一天 150 条 + 旧的一天最新 50 条」
    const mk = (daysAgo: number, i: number): string => JSON.stringify({ ts: secAt(daysAgo, i), type: 'tool:decision' })
    writeFileSync(join(dir, auditFile(1)), Array.from({ length: 150 }, (_, i) => mk(1, i)).join('\n'))
    writeFileSync(join(dir, auditFile(0)), Array.from({ length: 150 }, (_, i) => mk(0, i)).join('\n'))
    const rows = readAuditEvents(dir, { limit: 200 })
    expect(rows).toHaveLength(200)
    const dayOld = isoAt(1, '00:00').slice(0, 10)
    const dayNew = isoAt(0, '00:00').slice(0, 10)
    expect(rows.filter((r) => r.ts.startsWith(dayNew)), '当天 150 条全部保留').toHaveLength(150)
    expect(rows.filter((r) => r.ts.startsWith(dayOld)), '前一天只保留最新的 50 条').toHaveLength(50)
    expect(rows.filter((r) => r.ts.startsWith(dayOld)).some((r) => r.ts === secAt(1, 0)), '前一天最早的条目应被截掉').toBe(false)
  })
})
