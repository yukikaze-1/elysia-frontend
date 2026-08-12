import { describe, expect, it, vi } from 'vitest'
import { createShutdownHandler, createFatalShutdown, type ShutdownDeps } from '../../src/main/shutdown'

function makeDeps(over: Partial<ShutdownDeps> & { closeAll?: () => Promise<void> } = {}) {
  const steps = over.steps ?? [{ name: 'all', run: over.closeAll ?? (async () => {}) }]
  return { steps, quit: over.quit ?? vi.fn(), timeoutMs: over.timeoutMs, onTimeout: over.onTimeout, onError: over.onError } as ShutdownDeps
}
const ev = () => ({ preventDefault: vi.fn() })

describe('createShutdownHandler（before-quit）', () => {
  it('首次事件：preventDefault + 触发 flush，完成后 quit', async () => {
    const deps = makeDeps()
    const h = createShutdownHandler(deps)
    const e = ev()
    h(e)
    expect(e.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1))
  })
  it('flushing 期间二次事件：preventDefault 但不重复 flush', async () => {
    let resolveClose: () => void = () => {}
    const deps = makeDeps({ closeAll: vi.fn(() => new Promise<void>((r) => { resolveClose = r })) })
    const h = createShutdownHandler(deps)
    h(ev()); h(ev())
    expect(deps.steps[0].run).toHaveBeenCalledTimes(1)
    resolveClose()
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1))
  })
  it('flush 完成后最终 quit 的事件：不再 preventDefault（allowQuit 放行）', async () => {
    const deps = makeDeps()
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    const e2 = ev()
    h(e2)
    expect(e2.preventDefault).not.toHaveBeenCalled()
  })
  it('step 抛错仍 quit 且 onError 收到 step 名、后续 step 仍执行', async () => {
    const onError = vi.fn()
    const order: string[] = []
    const deps = makeDeps({
      steps: [
        { name: 'bad', run: async () => { throw new Error('boom') } },
        { name: 'good', run: async () => { order.push('good') } }
      ],
      onError
    })
    createShutdownHandler(deps)(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    expect(onError).toHaveBeenCalledWith('bad', expect.any(Error))
    expect(order).toEqual(['good'])
  })
  it('step 挂起 → 超时后仍 quit（race）', async () => {
    const onTimeout = vi.fn()
    const deps = makeDeps({ closeAll: vi.fn(() => new Promise<void>(() => {})), timeoutMs: 20, onTimeout })
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled(), { timeout: 200 })
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
  it('steps 按序执行', async () => {
    const order: string[] = []
    const deps = makeDeps({ steps: [{ name: 'a', run: async () => { order.push('a') } }, { name: 'b', run: async () => { order.push('b') } }] })
    createShutdownHandler(deps)(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    expect(order).toEqual(['a', 'b'])
  })
  it('慢但完成的 step + 短 timeout → onTimeout 不触发（无残留计时器）、quit 一次', async () => {
    const onTimeout = vi.fn()
    const deps = makeDeps({ steps: [{ name: 'slow', run: async () => { await new Promise((r) => setTimeout(r, 10)) } }], timeoutMs: 20, onTimeout })
    createShutdownHandler(deps)(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    expect(onTimeout).not.toHaveBeenCalled()
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })
  it('step 1 挂起 → onTimeout 触发、quit 一次、step 2 不启动、audit 写入被调用', async () => {
    const audit = vi.fn(async () => {})
    const onTimeout = vi.fn(() => { void audit() })
    const step2 = vi.fn(async () => {})
    const deps = makeDeps({
      steps: [{ name: 'hang', run: () => new Promise<void>(() => {}) }, { name: 'never', run: step2 }],
      timeoutMs: 20,
      onTimeout
    })
    createShutdownHandler(deps)(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled(), { timeout: 200 })
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(step2).not.toHaveBeenCalled()
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })
})

describe('createFatalShutdown', () => {
  it('无 closeAll → 直接 exit(1)', () => {
    const exit = vi.fn()
    createFatalShutdown({ showError: () => {}, exit })('boom')
    expect(exit).toHaveBeenCalledWith(1)
  })
  it('closeAll 完成 → 完成后 exit(1)', async () => {
    const exit = vi.fn()
    const closeAll = vi.fn(async () => {})
    createFatalShutdown({ showError: () => {}, closeAll, exit })('boom')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
  })
  it('closeAll 挂起 → 超时后仍 exit(1)', async () => {
    const exit = vi.fn()
    const closeAll = vi.fn(() => new Promise<void>(() => {}))
    createFatalShutdown({ showError: () => {}, closeAll, exit, timeoutMs: 20 })('boom')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 200 })
  })
})
