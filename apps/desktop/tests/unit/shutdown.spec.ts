import { describe, expect, it, vi } from 'vitest'
import { createShutdownHandler } from '../../src/main/shutdown'

function makeDeps(over: Partial<{ closeAll: () => Promise<void>; quit: () => void; timeoutMs: number }> = {}) {
  return {
    closeAll: over.closeAll ?? vi.fn(async () => {}),
    quit: over.quit ?? vi.fn(),
    timeoutMs: over.timeoutMs
  }
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
  it('flushing 期间二次事件：preventDefault 但不重复 flush（防二次 quit 绕过 finish）', async () => {
    let resolveClose: () => void = () => {}
    const deps = makeDeps({ closeAll: vi.fn(() => new Promise<void>((r) => { resolveClose = r })) })
    const h = createShutdownHandler(deps)
    h(ev()); h(ev()) // 第二次在 flush 中
    expect(deps.closeAll).toHaveBeenCalledTimes(1)
    resolveClose()
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1))
  })
  it('flush 完成后最终 quit 的事件：不再 preventDefault（allowQuit 放行，防挂死）', async () => {
    const deps = makeDeps()
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    const e2 = ev()
    h(e2) // 模拟 quit 触发的二次 before-quit
    expect(e2.preventDefault).not.toHaveBeenCalled()
  })
  it('closeAll 抛错仍 quit（finally 恒执行）', async () => {
    const deps = makeDeps({ closeAll: vi.fn(async () => { throw new Error('disk full') }) })
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
  })
  it('closeAll 挂起 → 超时后仍 quit（1.5s race）', async () => {
    const deps = makeDeps({ closeAll: vi.fn(() => new Promise<void>(() => {})), timeoutMs: 20 })
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled(), { timeout: 200 })
  })
})
