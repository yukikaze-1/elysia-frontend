// tests/unit/diagnostics-service.spec.ts（node）
// 阶段 7 批次 A（Task 3）：诊断服务骨架——getState/setDevMode/dispose + devTap
// （{ts,type,preview} ring + 100ms 节流 push + devMode 门控 + 回调体异常隔离）。
// deps 注入式（F-08）：adapter 构造期订阅、dispose 退订——测试经捕获 tap 回调驱动事件流。
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDiagnosticsService } from '../../src/main/diagnostics/diagnostics-service'
import type { DiagnosticsService } from '../../src/main/diagnostics/diagnostics-service'
import type { BackendAdapter, BackendEventHandler } from '../../src/main/transport/backend-adapter'
import type { Auditor } from '../../src/main/diagnostics/audit'
import type { FileWriter } from '../../src/main/diagnostics/file-writer'
import type { Logger } from '../../src/main/diagnostics/logger'
import type { BackendEvent } from '@shared/contracts/events'
import type { DiagnosticsDevEvent } from '@shared/contracts'
import { DIAGNOSTICS_PREVIEW_MAX } from '@shared/contracts'

/** 事件源 mock：捕获 tap 供测试驱动；subscribe 返回带 spy 的退订函数（dispose 断言） */
function makeAdapter(): { adapter: BackendAdapter; tap: (ev: unknown) => void; unsub: ReturnType<typeof vi.fn>; subscribeSpy: ReturnType<typeof vi.fn> } {
  let handler: BackendEventHandler | undefined
  const unsub = vi.fn()
  const subscribeSpy = vi.fn((h: BackendEventHandler) => {
    handler = h
    return () => { unsub(); if (handler === h) handler = undefined } // 退订后不再交付（真实语义）
  })
  const adapter = { subscribe: subscribeSpy } as unknown as BackendAdapter
  return { adapter, tap: (ev) => handler?.(ev as BackendEvent), unsub, subscribeSpy }
}

interface Ctx {
  svc: DiagnosticsService
  adapter: ReturnType<typeof makeAdapter>
  logger: Logger
  auditor: Auditor
  logWriter: FileWriter
  onDevEvent: ReturnType<typeof vi.fn>
  onDevModeChange: ReturnType<typeof vi.fn>
  advance: (ms: number) => void
}

/** 夹具工厂：固定时钟（测试确定性）+ 可注入 sanitize/mock 目录 */
function makeCtx(opts: { dirs?: { logs: string; audit: string; temp: string }; sanitize?: (s: string) => string } = {}): Ctx {
  const adapter = makeAdapter()
  const logger: Logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
  const auditor = { audit: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as Auditor
  const logWriter: FileWriter = { append: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const onDevEvent = vi.fn()
  const onDevModeChange = vi.fn()
  let t = 10_000
  const svc = createDiagnosticsService({
    dirs: opts.dirs ?? { logs: '/home/u/.config/Cyrene/logs', audit: '/home/u/.config/Cyrene/audit', temp: '/tmp' },
    logger,
    auditor,
    logWriter,
    sanitize: opts.sanitize ?? ((s) => (s === '/home/u/.config/Cyrene/logs' ? '~/.../logs' : '<path>')),
    adapter: adapter.adapter,
    getConnectionSummary: () => ({}),
    onDevEvent,
    onDevModeChange,
    now: () => t,
  })
  return {
    svc, adapter, logger, auditor, logWriter, onDevEvent, onDevModeChange,
    advance: (ms) => { t += ms },
  }
}

/** 最小事件工厂（BackendEvent 判别联合加字段——测试以 unknown 形状驱动，服务侧按白名单消费） */
function deltaEvent(text: string, extra: Record<string, unknown> = {}): unknown {
  return { event: 'generation.delta', generationId: 'g1', segmentId: 's1', segmentIndex: 1, channel: 'public_reply', kind: 'markdown', deltaSequence: 0, text, ...extra }
}

describe('getState（初始态 + sanitize 展示形态）', () => {
  it('初始 devMode=false；displayDir 为 sanitize 后形态；dropped=0；lastCleanup=null', () => {
    const { svc } = makeCtx()
    const s = svc.getState()
    expect(s.devMode).toBe(false)
    expect(s.displayDir).toBe('~/.../logs')
    expect(s.eventDropped).toBe(0)
    expect(s.lastCleanup).toBeNull()
    expect(s.retentionDays).toBeGreaterThan(0)
    expect(s.auditRetentionDays).toBeGreaterThan(0)
  })

  it('日志目录存在时列出文件与总大小（目录缺失兜底空清单）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyrene-diag-'))
    try {
      writeFileSync(join(dir, 'app.log'), 'hello')
      writeFileSync(join(dir, 'app.log.1'), 'world!')
      const { svc } = makeCtx({ dirs: { logs: dir, audit: join(dir, 'audit'), temp: join(dir, 'tmp') }, sanitize: (s) => (s === dir ? '<sanitized>' : '<path>') })
      const s = svc.getState()
      expect(s.logSizeBytes).toBe(11)
      expect(s.logFiles.map((f) => f.name).sort()).toEqual(['app.log', 'app.log.1'])
      expect(s.logFiles.every((f) => typeof f.modifiedAt === 'string' && f.modifiedAt.length > 0)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('setDevMode（幂等 + 审计 + 副作用出口）', () => {
  it('true 后 state.devMode=true + audit dev:mode-changed（含 ts）+ onDevModeChange(true)；重复 true 不重复', () => {
    const { svc, auditor, onDevModeChange } = makeCtx()
    svc.setDevMode(true)
    expect(svc.getState().devMode).toBe(true)
    expect(onDevModeChange).toHaveBeenCalledTimes(1)
    expect(onDevModeChange).toHaveBeenCalledWith(true)
    expect(auditor.audit).toHaveBeenCalledTimes(1)
    const evt = (auditor.audit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { type: string; ts: string; summary: string }
    expect(evt.type).toBe('dev:mode-changed')
    expect(typeof evt.ts).toBe('string')
    expect(evt.ts.length).toBeGreaterThan(0) // ts 必填（AuditEvent 形状以 audit.ts 为准）
    expect(evt.summary).toContain('开启')
    svc.setDevMode(true) // 幂等：同值 no-op 不重复审计
    expect(auditor.audit).toHaveBeenCalledTimes(1)
    expect(onDevModeChange).toHaveBeenCalledTimes(1)
  })

  it('true→false 关闭再审计一次（summary 关闭）', () => {
    const { svc, auditor } = makeCtx()
    svc.setDevMode(true)
    svc.setDevMode(false)
    expect(svc.getState().devMode).toBe(false)
    expect(auditor.audit).toHaveBeenCalledTimes(2)
    const evt = (auditor.audit as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as { summary: string }
    expect(evt.summary).toContain('关闭')
  })
})

describe('devTap（devMode 门控 / 白名单 / redact / 截断）', () => {
  it('devMode=false 时不入 ring 不推送（关闭即停）', () => {
    const { svc, adapter, onDevEvent } = makeCtx()
    adapter.tap(deltaEvent('SECRET'))
    expect(onDevEvent).not.toHaveBeenCalled()
    expect(svc.getState().eventDropped).toBe(0)
  })

  it('preview 白名单：排除 text 正文（仅派生 textLen 计数）', () => {
    const { svc, adapter, onDevEvent } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    adapter.tap(deltaEvent('SECRET_BODY_BEARER'))
    expect(onDevEvent).toHaveBeenCalledTimes(1)
    const entry = onDevEvent.mock.calls[0]?.[0] as DiagnosticsDevEvent
    expect(entry.type).toBe('generation.delta')
    expect(entry.preview).toContain('textLen=') // 长度计数（派生、零正文）
    expect(entry.preview).not.toContain('SECRET_BODY_BEARER')
    expect(entry.preview).toContain('channel=public_reply')
  })

  it('preview 白名单字段内经 redact（token 形值 → [REDACTED]）', () => {
    const { svc, adapter, onDevEvent } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    const token = `sk-${'Q'.repeat(120)}`
    // 白名单字段 model 承载 token 形值（不透明 id 面——redact 必须兜底）
    adapter.tap({ event: 'generation.completed', generationId: 'g1', responseId: 'r1', model: token, conversationId: 'c1' })
    expect(onDevEvent).toHaveBeenCalledTimes(1)
    const entry = onDevEvent.mock.calls[0]?.[0] as DiagnosticsDevEvent
    expect(entry.preview).toContain('[REDACTED]')
    expect(entry.preview).not.toContain(token)
    expect(entry.preview).not.toContain('QQQQ') // 清除前检查：token 片段零残留
    expect(entry.preview).toContain('conversationId=c1')
  })

  it('preview 超长（净化后仍 >200）截断至 ≤200 含尾标', () => {
    const { svc, adapter, onDevEvent } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    // 带连字符长 id（纯 40+ base64 字符会被 redact 长串规则替换——长度可控性差），确保净化后仍超 200 触发截断
    adapter.tap({ event: 'generation.completed', generationId: 'g1', responseId: 'r1', conversationId: `c1-${'id-'.repeat(80)}` })
    expect(onDevEvent).toHaveBeenCalledTimes(1)
    const entry = onDevEvent.mock.calls[0]?.[0] as DiagnosticsDevEvent
    expect(entry.preview.length).toBe(DIAGNOSTICS_PREVIEW_MAX) // 截 199 + 尾标 = 200（含尾标语义）
    expect(entry.preview.endsWith('…')).toBe(true)
  })

  it('preview 不含 inputSummary 等摘要字段序列化（tool 元数据均非原始参数）', () => {
    const { svc, adapter, onDevEvent } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    adapter.tap({ event: 'tool.started', callId: 'tc-1', toolName: 'desktop.file.read', runtime: 'desktop', inputSummary: 'args=secret-arg-b64', generationId: 'g2', conversationId: 'c2' })
    const entry = onDevEvent.mock.calls[0]?.[0] as DiagnosticsDevEvent
    expect(entry.preview).toContain('toolName=desktop.file.read')
    expect(entry.preview).not.toContain('secret-arg-b64') // inputSummary 不在白名单（摘要含参数字符串面，宁缺毋滥）
  })
})

describe('推送节流（100ms 窗口 + dropped 计数）', () => {
  it('连续 30 条 100ms 窗口内仅推 1 条；dropped=29；窗口未到仍节流', () => {
    const { svc, adapter, onDevEvent } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    for (let i = 0; i < 30; i++) adapter.tap(deltaEvent(`t${i}`))
    expect(onDevEvent).toHaveBeenCalledTimes(1)
    expect(svc.getState().eventDropped).toBe(29)
    adapter.tap(deltaEvent('x')) // 时钟未动：仍节流（30 条窗口边界）
    expect(onDevEvent).toHaveBeenCalledTimes(1)
    expect(svc.getState().eventDropped).toBe(30)
  })

  it('推进时钟越过窗口后恢复推送（mock now 控制）', () => {
    const { svc, adapter, onDevEvent, advance } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    adapter.tap(deltaEvent('t0'))
    expect(onDevEvent).toHaveBeenCalledTimes(1)
    for (let i = 1; i < 30; i++) adapter.tap(deltaEvent(`t${i}`))
    expect(svc.getState().eventDropped).toBe(29)
    advance(150)
    adapter.tap(deltaEvent('t30'))
    expect(onDevEvent).toHaveBeenCalledTimes(2)
    expect(svc.getState().eventDropped).toBe(29)
  })
})

describe('ring 容量与 dispose', () => {
  it('205 条事件（时钟推进全部推送）不崩溃不丢计数——ring 溢出路径可用', () => {
    const { svc, adapter, onDevEvent, advance } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    for (let i = 0; i < 205; i++) {
      advance(200)
      adapter.tap(deltaEvent(`t${i}`))
    }
    expect(onDevEvent).toHaveBeenCalledTimes(205)
    expect(svc.getState().eventDropped).toBe(0)
  })

  it('devTap 回调体异常隔离：坏事件（null）仅 warn 不中断', () => {
    const { svc, adapter, logger } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    adapter.tap(null as unknown as BackendEvent) // 取字段抛错 → 单条丢弃 + warn（不外抛，防断事件流）
    expect(logger.warn).toHaveBeenCalledWith('diagnostics:dev-event-error', expect.anything())
  })

  it('dispose 退订：后续事件不再消费', () => {
    const { svc, adapter, onDevEvent } = makeCtx({ sanitize: (s) => s })
    svc.setDevMode(true)
    svc.dispose()
    expect(adapter.unsub).toHaveBeenCalledTimes(1)
    adapter.tap(deltaEvent('after-dispose'))
    expect(onDevEvent).not.toHaveBeenCalled()
  })
})
