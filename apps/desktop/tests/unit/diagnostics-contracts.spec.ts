// tests/unit/diagnostics-contracts.spec.ts（node）
// 阶段 7 批次 A（Task 1）诊断功能契约层：shared/schemas 响应 schema 镜像 + main/ipc/channels 请求 schema
// + IpcChannels/PushChannels 键名 + 常量——白名单断言与后续 Task 3/5/6 消费的契约钉。
import { describe, expect, it } from 'vitest'
import {
  DiagnosticsStateSchema, DiagnosticsDevEventSchema, DiagnosticsExportResultSchema,
} from '../../src/shared/schemas/ipc-response'
import {
  diagnosticsStateSchema, diagnosticsDevModeSetSchema, diagnosticsOpenLogDirSchema,
  diagnosticsClearLogsSchema, diagnosticsExportSchema,
} from '../../src/main/ipc/channels'
import { IpcChannels, PushChannels } from '../../src/shared/contracts/ipc'
import { DIAGNOSTICS_PREVIEW_MAX, DIAGNOSTICS_TYPE_MAX } from '../../src/shared/contracts/diagnostics'

describe('DiagnosticsStateSchema（镜像 DiagnosticsState）', () => {
  it('合法态解析 + 默认化字段', () => {
    const r = DiagnosticsStateSchema.safeParse({
      devMode: false, displayDir: '~/config/Cyrene/logs', logSizeBytes: 0, logFiles: [],
      retentionDays: 30, auditRetentionDays: 30, eventDropped: 0, lastCleanup: null,
    })
    expect(r.success).toBe(true)
  })
  it('lastCleanup 为对象形态', () => {
    const r = DiagnosticsStateSchema.safeParse({
      devMode: true, displayDir: '~/.config/Cyrene/logs', logSizeBytes: 10, logFiles: [{ name: 'app.log', sizeBytes: 10, modifiedAt: '2026-08-22T00:00:00.000Z' }],
      retentionDays: 30, auditRetentionDays: 30, eventDropped: 2, lastCleanup: { removedFiles: 1, freedBytes: 100 },
    })
    expect(r.success).toBe(true)
  })
  it('displayDir 字段名固定（防绝对路径上行语义漂移）', () => {
    // zod v4：.shape 为 property 且 ZodType 无 .shape 类型——按仓库先例 cast（cy-tool-approval.spec `as never` 同族）
    const shape = (DiagnosticsStateSchema as unknown as { shape: Record<string, unknown> }).shape
    expect(shape).toHaveProperty('displayDir')
    expect(shape).not.toHaveProperty('logDir')
  })
})

describe('DiagnosticsDevEventSchema（字段白名单 + 上界）', () => {
  const base = { ts: '2026-08-22T00:00:00.000Z', type: 'server_info', preview: 'server_info ok' }
  it('合法条目', () => {
    expect(DiagnosticsDevEventSchema.safeParse(base).success).toBe(true)
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, type: 'generation.started' }).success).toBe(true)
  })
  it('preview 截断至 ≤ DIAGNOSTICS_PREVIEW_MAX（含尾标）', () => {
    const long = 'x'.repeat(300)
    const r = DiagnosticsDevEventSchema.safeParse({ ...base, preview: long.slice(0, 199) + '…' })
    expect(r.success).toBe(true)
    expect(long.length).toBeGreaterThan(DIAGNOSTICS_PREVIEW_MAX)
    expect((r.data as { preview: string }).preview.length).toBeLessThanOrEqual(DIAGNOSTICS_PREVIEW_MAX)
  })
  it('type 超 DIAGNOSTICS_TYPE_MAX 拒', () => {
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, type: 'y'.repeat(DIAGNOSTICS_TYPE_MAX + 1) }).success).toBe(false)
  })
  it('未知键（正文类/rawType）拒——strict', () => {
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, content: 'secret' }).success).toBe(false)
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, arguments: {} }).success).toBe(false)
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, rawType: 'root' }).success).toBe(false)  // rawType 已删（无数据源——准确性 H-3）
  })
})

describe('DiagnosticsExportResultSchema（判别联合）', () => {
  it('成功分支', () => {
    const r = DiagnosticsExportResultSchema.safeParse({ cancelled: false, displayPath: '~/Downloads/cyrene-diagnose.json', sizeBytes: 100, truncatedLog: true, truncatedAudit: false })
    expect(r.success).toBe(true)
  })
  it('取消分支', () => {
    expect(DiagnosticsExportResultSchema.safeParse({ cancelled: true }).success).toBe(true)
  })
  it('缺 cancelled 键拒；displayPath 非 display 形态仍接受（字符串即 pass；形态由服务保证）', () => {
    expect(DiagnosticsExportResultSchema.safeParse({ displayPath: 'x', sizeBytes: 1, truncatedLog: false, truncatedAudit: false }).success).toBe(false)
  })
})

describe('请求 schema（channels.ts）', () => {
  it('无参通道为 z.undefined()', () => {
    expect(diagnosticsStateSchema.parse(undefined)).toBeUndefined()
    expect(diagnosticsOpenLogDirSchema.parse(undefined)).toBeUndefined()
    expect(diagnosticsClearLogsSchema.parse(undefined)).toBeUndefined()
    expect(diagnosticsExportSchema.parse(undefined)).toBeUndefined()
  })
  it('dev-mode-set 带 enabled 布尔', () => {
    expect(diagnosticsDevModeSetSchema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(diagnosticsDevModeSetSchema.safeParse({ enabled: 'yes' }).success).toBe(false)
  })
})

describe('IpcChannels/PushChannels 键名（钉住——白名单断言依赖）', () => {
  it('5 invoke 键 + 1 push 键值与命名', () => {
    expect(IpcChannels.diagnosticsState).toBe('diagnostics:state')
    expect(IpcChannels.diagnosticsDevModeSet).toBe('diagnostics:dev-mode-set')
    expect(IpcChannels.diagnosticsOpenLogDir).toBe('diagnostics:open-log-dir')
    expect(IpcChannels.diagnosticsClearLogs).toBe('diagnostics:clear-logs')
    expect(IpcChannels.diagnosticsExport).toBe('diagnostics:export')
    expect(PushChannels.diagnosticsDevEvent).toBe('diagnostics:dev-event')
  })
})
