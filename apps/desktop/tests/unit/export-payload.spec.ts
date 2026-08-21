// tests/unit/export-payload.spec.ts（node）
// 阶段 7 批次 A（Task 4）：诊断导出纯函数——readTailLines（行对齐尾部读取）+ buildExportPayload
// （逐行脱敏/超长行丢弃/截断标志/sha256 确定性）+ tailLinesAligned（审计段整集合截尾保最新端）。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildExportPayload, readTailLines, tailLinesAligned } from '../../src/main/diagnostics/export-payload'
import type { ExportPayloadInput } from '../../src/main/diagnostics/export-payload'
import { redactSensitiveValues } from '../../src/main/diagnostics/redact'

describe('readTailLines（行对齐尾部读取）', () => {
  it('短文件（≤maxBytes）全量返回；maxBytes 落在行边界则首行保留（含行边界）', async () => {
    // 文件 = "aaa\nbbb\nccc\nddd\neee\n"（20B）：maxBytes=12 → 从偏移 8 读起（file[7]='\n' 行边界 → 首行 ccc 完整保留）
    const dir = mkdtempSync(join(tmpdir(), 'cy-tail-'))
    try {
      const p = join(dir, 'x.log')
      writeFileSync(p, 'aaa\nbbb\nccc\nddd\neee\n', { mode: 0o600 })
      expect(await readTailLines(p, 12)).toEqual(['ccc', 'ddd', 'eee'])
      expect(await readTailLines(p, 256)).toEqual(['aaa', 'bbb', 'ccc', 'ddd', 'eee'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maxBytes 截断中间行 → 首段丢弃（行对齐：尾 2 行）+ 尾随换行空段忽略', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-tail-'))
    try {
      const p = join(dir, 'x.log')
      writeFileSync(p, 'aaa\nbbb\nccc\nddd\neee\n', { mode: 0o600 })
      // maxBytes=10 → 偏移 10：读 "c\nddd\neee\n"——首段 'c' 为中间行截断 → 丢 → 完整尾 2 行
      expect(await readTailLines(p, 10)).toEqual(['ddd', 'eee'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空文件 → 空数组（不抛错）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-tail-'))
    try {
      const p = join(dir, 'empty.log')
      writeFileSync(p, '', { mode: 0o600 })
      expect(await readTailLines(p, 5)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tailLinesAligned（整集合截尾保最新端）', () => {
  it('总长 ≤ maxBytes：全量返回 + dropped=false；超限：丢最旧保留最新端', () => {
    const lines = ['a'.repeat(8), 'b'.repeat(8), 'c'.repeat(8)] // 每行 9B（含虚拟分隔符）
    expect(tailLinesAligned(lines, 4096)).toEqual({ lines, dropped: false })
    // 19B：c(9) + b(9) = 18 ≤ 19；a 加不进 → 丢 a
    expect(tailLinesAligned(lines, 19)).toEqual({ lines: ['b'.repeat(8), 'c'.repeat(8)], dropped: true })
  })
})

describe('buildExportPayload（逐行脱敏 / 超长行丢弃 / sha / manifest 标志）', () => {
  function input(overrides: Partial<ExportPayloadInput> = {}): ExportPayloadInput {
    return {
      manifest: { schemaVersion: 1, generatedAt: '2026-08-22T00:00:00.000Z' },
      summary: { origin: 'https://127.0.0.1:9009', status: 'connected', protocolVersion: '2.0' },
      logFiles: [{ name: 'app.log', lines: ['ok line', 'Bearer sk-1234567890abc', 'plain'] }],
      auditLines: ['{"ts":"2026-08-21T00:00:00Z","type":"tool:done","summary":"Bearer abc12345"}'],
      truncatedLog: false,
      truncatedAudit: false,
      ...overrides,
    }
  }
  const identity = { sanitize: (s: string) => s }

  it('逐行脱敏：Bearer/sk- 输出 [REDACTED] 且黑名单 0 命中（复用 redact RULES 断言）', () => {
    const doc = buildExportPayload(input(), identity)
    expect(doc.logFiles[0].lines).toEqual(['ok line', 'Bearer [REDACTED]', 'plain'])
    expect(doc.audit[0]).toBe('{"ts":"2026-08-21T00:00:00Z","type":"tool:done","summary":"Bearer [REDACTED]"}')
    const all = JSON.stringify(doc)
    expect(all).not.toContain('sk-1234567890abc')
    expect(all).not.toContain('Bearer abc12345')
    expect(all).toContain('[REDACTED]')
    // 逐行结果与 redact 规则函数（同一 RULES）输出一致（复用断言：黑名单零命中由 RULES 语义背书）
    expect(redactSensitiveValues('Bearer sk-1234567890abc')).toBe('Bearer [REDACTED]')
  })

  it('超长单行（>1MiB）整行丢弃 + droppedLines 计数 + truncated 记数（输出不含原始行）', () => {
    const big = 'x'.repeat(1024 * 1024 + 64)
    const doc = buildExportPayload(
      input({ logFiles: [{ name: 'app.log', lines: ['small', big, 'tail'] }] }),
      identity,
    )
    expect(doc.logFiles[0].lines).toEqual(['small', '<line-too-long-truncated>', 'tail'])
    expect(JSON.stringify(doc)).not.toContain(big)
    expect(doc.manifest.droppedLines).toBe(1)
    expect(doc.manifest.truncated).toBe(true) // 超长行丢弃 → 截断记数（即便输入标志 false）
    expect(doc.manifest.truncatedLog).toBe(true)
    expect(doc.audit[0]).toBe('{"ts":"2026-08-21T00:00:00Z","type":"tool:done","summary":"Bearer [REDACTED]"}') // audit 段不受日志段影响
  })

  it('sha 确定性：同 input 两次 sha 相等；不同 input sha 不同且只变化对应段', () => {
    const a = buildExportPayload(input(), identity)
    const b = buildExportPayload(input(), identity)
    expect(a.logSha256).toBe(b.logSha256)
    expect(a.auditSha256).toBe(b.auditSha256)
    expect(/^[0-9a-f]{64}$/.test(a.logSha256)).toBe(true)
    expect(/^[0-9a-f]{64}$/.test(a.auditSha256)).toBe(true)

    const c = buildExportPayload(
      input({ auditLines: ['{"ts":"x","type":"conn:error","summary":"err"}'] }),
      identity,
    )
    expect(c.auditSha256).not.toBe(a.auditSha256)
    expect(c.logSha256).toBe(a.logSha256) // 日志段不变 → sha 不变（段独立）
  })

  it('manifest/truncated 标志进入 payload；schemaVersion=1；双段 sha 存在于 manifest', () => {
    const doc = buildExportPayload(
      input({ truncatedLog: true, auditLines: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      identity,
    )
    expect(doc.schemaVersion).toBe(1)
    expect(doc.manifest.schemaVersion).toBe(1)
    expect(doc.manifest.truncatedLog).toBe(true)
    expect(doc.manifest.truncatedAudit).toBe(false)
    expect(doc.manifest.truncated).toBe(true)
    expect(doc.manifest.logSha256).toBe(doc.logSha256)
    expect(doc.manifest.auditSha256).toBe(doc.auditSha256)
    expect(doc.summary).toEqual({ origin: 'https://127.0.0.1:9009', status: 'connected', protocolVersion: '2.0' })
    expect(doc.logFiles[0].name).toBe('app.log')
  })

  it('F-C1（D7A-08）：input.manifest 上下文溯源字段逐项透传到输出 manifest（字符串经双净化、布尔直传、缺失不落键）', () => {
    const doc = buildExportPayload(
      input({
        manifest: {
          schemaVersion: 1,
          generatedAt: '2026-08-22T00:00:00.000Z',
          exportedAt: '2026-08-22T00:00:01.000Z',
          appName: 'Cyrene',
          appVersion: '0.1.0+abc',
          platform: 'linux',
          electron: '43.3.0',
          chrome: '140.0.0.0',
          node: '22.23.0',
          arch: 'x64',
          os: 'Linux 6.8.0',
          packaged: false,
          mode: 'test',
        },
      }),
      identity,
    )
    expect(doc.manifest.generatedAt).toBe('2026-08-22T00:00:00.000Z')
    expect(doc.manifest.exportedAt).toBe('2026-08-22T00:00:01.000Z')
    expect(doc.manifest.appName).toBe('Cyrene')
    expect(doc.manifest.appVersion).toBe('0.1.0+abc')
    expect(doc.manifest.platform).toBe('linux')
    expect(doc.manifest.electron).toBe('43.3.0')
    expect(doc.manifest.chrome).toBe('140.0.0.0')
    expect(doc.manifest.node).toBe('22.23.0')
    expect(doc.manifest.arch).toBe('x64')
    expect(doc.manifest.os).toBe('Linux 6.8.0')
    expect(doc.manifest.packaged).toBe(false)
    expect(doc.manifest.mode).toBe('test')
  })

  it('F-C1：字符串字段经双净化（sanitize+redact）；缺失字段不落键（JSON.stringify 省略）', () => {
    const doc = buildExportPayload(
      input({
        manifest: { schemaVersion: 1, appName: 'Cyrene', os: 'Bearer sk-abcdef' },
      }),
      { sanitize: (s) => s.replace(/\//g, '').replace(/\s+/g, ' ') },
    )
    expect(doc.manifest.appName).toBe('Cyrene')
    expect(doc.manifest.os).toBe('Bearer [REDACTED]') // redact 打标（sanitize 恒等——无路径/替换面）
    // 缺失字段不落键：以实际序列化 payload 为准（对象内 undefined 值键经 JSON.stringify 省略）
    const round = JSON.parse(JSON.stringify(doc)) as { manifest: Record<string, unknown> }
    expect(round.manifest.packaged).toBeUndefined()
    expect(round.manifest.mode).toBeUndefined()
    expect(round.manifest.generatedAt).toBeUndefined() // 未传 generatedAt → 不落键（F-C1：无空时间戳占位）
  })

  it('F-C1：summary.classify 语义——双净化不改变既有段（回归：日志/审计段不受 manifest 字段影响）', () => {
    const doc = buildExportPayload(
      input({ manifest: { schemaVersion: 1, appName: 'Cyrene' } }),
      { sanitize: (s) => s },
    )
    expect(doc.logFiles[0].lines).toEqual(['ok line', 'Bearer [REDACTED]', 'plain'])
    expect(doc.audit[0]).toContain('Bearer [REDACTED]')
    expect(doc.logSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
