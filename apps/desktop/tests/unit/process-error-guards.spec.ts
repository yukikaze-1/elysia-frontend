// tests/unit/process-error-guards.spec.ts —— H-12（2026-09-11）：主进程未捕获异常兜底。
//
// 修复前的事实：`src/main` 全仓 0 处注册 `unhandledRejection`/`uncaughtException`。
// 本文件钉住三件事：① 两类异常都留痕（日志 + 审计）；② 文本经脱敏且被截断；
// ③ 装配幂等（重复调用不重复注册——否则同一条异常写两份审计）。
import { describe, expect, it, vi } from 'vitest'
import {
  describeThrown, handleUncaughtException, handleUnhandledRejection,
  installProcessErrorGuards, resetProcessErrorGuardsForTest, type ProcessLike
} from '../../src/main/app/process-error-guards'

// 不标注返回类型：保留 vi.fn() 的 Mock 类型以便断言调用（gpu-process.spec.ts 先例）；
// 形状仍受校验——传入 handler 处按 ProcessErrorDeps 结构检查。
function makeDeps() {
  return {
    logger: { error: vi.fn() },
    audit: vi.fn(),
    sanitize: (t: string) => t.replaceAll('/home/u', '<home>')
  }
}

describe('describeThrown（任意抛出值 → 单行文本）', () => {
  it('Error 取 message；字符串原样；null/undefined 字符串化', () => {
    expect(describeThrown(new Error('boom'))).toBe('boom')
    expect(describeThrown('plain')).toBe('plain')
    expect(describeThrown(null)).toBe('null')
    expect(describeThrown(undefined)).toBe('undefined')
  })
  it('不可序列化对象不抛错（降级文案）', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(describeThrown(cyclic)).toBe('[不可序列化的抛出值]')
  })
})

describe('handleUnhandledRejection / handleUncaughtException（H-12）', () => {
  it('未处理拒绝 → error 日志 + 审计 main:unhandled-rejection', () => {
    const deps = makeDeps()
    handleUnhandledRejection(new Error('openExternal failed'), deps)
    expect(deps.logger.error).toHaveBeenCalledWith('main:unhandled-rejection', { message: 'openExternal failed' })
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'main:unhandled-rejection' }))
  })

  it('未捕获异常 → error 日志 + 审计 main:uncaught-exception', () => {
    const deps = makeDeps()
    handleUncaughtException(new Error('boom'), deps)
    expect(deps.logger.error).toHaveBeenCalledWith('main:uncaught-exception', { message: 'boom' })
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'main:uncaught-exception' }))
  })

  it('异常文本经脱敏后落盘（不泄漏绝对路径）', () => {
    const deps = makeDeps()
    handleUncaughtException(new Error('failed at /home/u/secret/file'), deps)
    const logged = deps.logger.error.mock.calls[0][1] as { message: string }
    expect(logged.message).toContain('<home>')
    expect(logged.message).not.toContain('/home/u')
  })

  it('超长文本被截断（审计摘要不无限膨胀）', () => {
    const deps = makeDeps()
    handleUncaughtException(new Error('x'.repeat(5000)), deps)
    const audited = deps.audit.mock.calls[0][0] as { summary: string }
    expect(audited.summary.length).toBeLessThan(400)
    expect(audited.summary).toContain('…')
  })

  it('非 Error 抛出值（字符串/undefined）也能留痕而不抛错', () => {
    const deps = makeDeps()
    expect(() => handleUnhandledRejection('nope', deps)).not.toThrow()
    expect(() => handleUncaughtException(undefined, deps)).not.toThrow()
    expect(deps.audit).toHaveBeenCalledTimes(2)
  })
})

describe('installProcessErrorGuards（装配）', () => {
  function makeProcess(): ProcessLike & { fire(event: string, arg: unknown): void; count(event: string): number } {
    const listeners = new Map<string, Array<(a: unknown) => void>>()
    return {
      on(event: string, listener: (a: unknown) => void) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return this
      },
      fire(event: string, arg: unknown) { for (const l of listeners.get(event) ?? []) l(arg) },
      count(event: string) { return (listeners.get(event) ?? []).length }
    }
  }

  it('装配后两类事件都能到达处理器', () => {
    resetProcessErrorGuardsForTest()
    const deps = makeDeps()
    const proc = makeProcess()
    installProcessErrorGuards(deps, proc)
    proc.fire('unhandledRejection', new Error('r'))
    proc.fire('uncaughtException', new Error('e'))
    expect(deps.logger.error).toHaveBeenCalledWith('main:unhandled-rejection', expect.anything())
    expect(deps.logger.error).toHaveBeenCalledWith('main:uncaught-exception', expect.anything())
  })

  it('重复装配幂等——同一条异常不得写两份审计', () => {
    resetProcessErrorGuardsForTest()
    const deps = makeDeps()
    const proc = makeProcess()
    installProcessErrorGuards(deps, proc)
    installProcessErrorGuards(deps, proc)
    installProcessErrorGuards(deps, proc)
    expect(proc.count('unhandledRejection')).toBe(1)
    expect(proc.count('uncaughtException')).toBe(1)
  })
})
