// tests/unit/renderer-console-sink.spec.ts
// P1-12 / M-01（2026-09-11）：renderer 控制台错误 → Main 日志。
//
// 背景：renderer 侧 JS 错误**从不进入诊断导出**——`main.ts` 三个错误源只做 `console.error`，
// 而 Main 没有订阅 `console-message`。诊断包因此完全缺失"最常出问题的那一侧"。
//
// 本 spec 钉住 sink 的三条性质：级别过滤、滑窗限流（且**抑制本身可见**）、单条截断。
// 其中"级别归一"是本轮实测踩到的真坑：Electron 43 给的是**字符串** level，若按数字比较
// （`'error' >= 3` → false），会**一条都不转发**——正好重演本缺陷的"静默无痕"形态。
import { describe, expect, it, vi } from 'vitest'
import {
  createRendererConsoleSink,
  normalizeConsoleLevel,
  RENDERER_CONSOLE_MAX_CHARS,
  RENDERER_CONSOLE_MAX_PER_WINDOW,
  RENDERER_CONSOLE_WINDOW_MS
} from '../../src/main/windows/renderer-console'
import type { LogFields } from '../../src/main/diagnostics/logger'

function makeSink(over: Partial<Parameters<typeof createRendererConsoleSink>[0]> = {}) {
  // logger 按 renderer-console 的真实依赖 `Pick<Logger,'warn'>` 标注——裸 `vi.fn()` 的调用实参是 `any`
  // （原写法 `warn.mock.calls.map((c) => c[0])` 因此命中 no-unsafe-return）
  const warn = vi.fn<(code: string, fields?: LogFields) => void>()
  let clock = 1_000_000
  const sink = createRendererConsoleSink({
    logger: { warn },
    now: () => clock,
    ...over
  })
  return { sink, warn, advance: (ms: number) => { clock += ms } }
}

describe('normalizeConsoleLevel（数字与字符串两种形态）', () => {
  it('字符串形态（Electron 43 的实际形态）原样识别', () => {
    expect(normalizeConsoleLevel('error')).toBe('error')
    expect(normalizeConsoleLevel('warning')).toBe('warning')
    expect(normalizeConsoleLevel('info')).toBe('info')
    expect(normalizeConsoleLevel('debug')).toBe('debug')
  })

  it('数字形态（废弃位置参数）按 0–3 映射', () => {
    expect(normalizeConsoleLevel(3)).toBe('error')
    expect(normalizeConsoleLevel(2)).toBe('warning')
    expect(normalizeConsoleLevel(1)).toBe('info')
    expect(normalizeConsoleLevel(0)).toBe('debug')
  })

  it('无法识别的值返回 undefined（调用方据此忽略，而不是当成 error 误报）', () => {
    expect(normalizeConsoleLevel('verbose')).toBeUndefined()
    expect(normalizeConsoleLevel('')).toBeUndefined()
  })
})

describe('renderer 控制台 sink（P1-12）', () => {
  it('error 级被转发，且字段带 message/level（字符串 level 必须能通过——这是实测踩过的坑）', () => {
    const { sink, warn } = makeSink()
    sink.handle({ level: 'error', message: 'boom', sourceId: 'app://index.js', lineNumber: 42 })

    expect(warn).toHaveBeenCalledTimes(1)
    const [code, fields] = warn.mock.calls[0]
    expect(code).toBe('renderer:console-error')
    expect(fields).toMatchObject({ message: 'boom', level: 'error', sourceId: 'app://index.js', line: 42 })
    // 若 level 按数字比较，这里会是 0 次调用——本断言就是那个坑的守卫
    expect(sink.stats().forwarded).toBe(1)
  })

  it('数字形态的 error（3）同样转发（两种 Electron 形态都覆盖）', () => {
    const { sink, warn } = makeSink()
    sink.handle({ level: 3, message: 'numeric level' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(sink.stats().forwarded).toBe(1)
  })

  it('info/warning 默认不转发（避免把 renderer 普通日志搬进主日志），计入 ignored', () => {
    const { sink, warn } = makeSink()
    sink.handle({ level: 'info', message: 'i' })
    sink.handle({ level: 'warning', message: 'w' })
    sink.handle({ level: 1, message: 'n' })
    expect(warn).not.toHaveBeenCalled()
    expect(sink.stats()).toMatchObject({ forwarded: 0, ignored: 3 })
  })

  it('滑窗限流：窗口内超出上限的条目被抑制，不逐条落盘', () => {
    const { sink, warn } = makeSink({ maxPerWindow: 3, windowMs: 1000 })
    for (let i = 0; i < 10; i++) sink.handle({ level: 'error', message: `e${i}` })

    expect(warn).toHaveBeenCalledTimes(3)
    expect(sink.stats()).toMatchObject({ forwarded: 3, suppressed: 7 })
  })

  it('**抑制必须可见**：窗口滚动时补记一条被抑制条数（静默丢弃会重演"看不见"这个原始缺陷）', () => {
    const { sink, warn, advance } = makeSink({ maxPerWindow: 2, windowMs: 1000 })
    for (let i = 0; i < 5; i++) sink.handle({ level: 'error', message: `e${i}` })   // 2 转发 + 3 抑制

    advance(1001)
    sink.handle({ level: 'error', message: 'next window' })   // 触发窗口滚动

    const codes = warn.mock.calls.map((c) => c[0])
    expect(codes).toContain('renderer:console-suppressed')
    const suppressedCall = warn.mock.calls.find((c) => c[0] === 'renderer:console-suppressed')!
    expect(suppressedCall[1]).toMatchObject({ count: 3, windowMs: 1000 })
  })

  it('窗口内无抑制时不补记（不得凭空产出噪声）', () => {
    const { sink, warn, advance } = makeSink({ maxPerWindow: 5, windowMs: 1000 })
    sink.handle({ level: 'error', message: 'a' })
    advance(1001)
    sink.handle({ level: 'error', message: 'b' })
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['renderer:console-error', 'renderer:console-error'])
  })

  it('限流按窗口重置：下一窗口恢复转发额度', () => {
    const { sink, warn, advance } = makeSink({ maxPerWindow: 1, windowMs: 1000 })
    sink.handle({ level: 'error', message: 'a' })
    sink.handle({ level: 'error', message: 'b' })   // 抑制
    advance(1001)
    sink.handle({ level: 'error', message: 'c' })   // 新窗口，可转发

    expect(warn.mock.calls.filter((c) => c[0] === 'renderer:console-error')).toHaveLength(2)
  })

  it('单条超长消息被截断并标注原长度（防一条巨型消息撑爆日志）', () => {
    const { sink, warn } = makeSink()
    const long = 'x'.repeat(RENDERER_CONSOLE_MAX_CHARS + 500)
    sink.handle({ level: 'error', message: long })

    const fields = warn.mock.calls[0][1] as { message: string }
    expect(fields.message.length).toBeLessThan(long.length)
    expect(fields.message).toContain('已截断')
    expect(fields.message).toContain(String(long.length))
  })

  it('缺省参数即生产默认值（窗口/上限/截断长度可被诊断核对）', () => {
    expect(RENDERER_CONSOLE_WINDOW_MS).toBe(10_000)
    expect(RENDERER_CONSOLE_MAX_PER_WINDOW).toBe(20)
    expect(RENDERER_CONSOLE_MAX_CHARS).toBe(500)
  })

  it('logger 缺失时不抛（sink 在 setCrashSink 之前可能已被窗口创建调用）', () => {
    const sink = createRendererConsoleSink()
    expect(() => sink.handle({ level: 'error', message: 'no logger' })).not.toThrow()
    expect(sink.stats().forwarded).toBe(1)
  })
})
