// tests/unit/throttle.spec.ts —— 流式渲染节流（H-03；取代 tests/unit/debounce-trailing.spec.ts）。
//
// 本文件替换了一份**保护了 bug 的测试**：旧 `debounce-trailing.spec.ts:11-13` 把
// 「40ms 后再调用 → 只触发 1 次」断言为正确行为，而那正是纯防抖的语义——流式 token 间隔
// 小于窗口时回调永不触发，助手气泡整段一次蹦出。因此这里的核心断言刻意与旧断言相反：
// **持续高频输入下回调必须被反复执行**。若实现退回防抖，本文件必红（已做变异验证）。
import { describe, expect, it, vi } from 'vitest'
import { createThrottle } from '../../src/renderer/src/utils/throttle'

const env = (): { setTimeout: (cb: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void } => ({
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
})

describe('createThrottle', () => {
  it('首沿立即执行：首次调用不等冷却窗口（首 token 即时可见）', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    createThrottle(fn, 80, env()).call('a')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('a')
    vi.useRealTimers()
  })

  it('冷却窗口不因新调用后移——与防抖的分水岭', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createThrottle(fn, 80, env())
    t.call('a'); vi.advanceTimersByTime(40); t.call('b'); vi.advanceTimersByTime(80)
    // 节流：t=0 执行、t=80 冷却到期补执行 → 2 次
    // 防抖（旧实现）：t=40 把窗口重排到 t=120 → 此处只有 1 次，故该断言会红
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('b')
    vi.useRealTimers()
  })

  it('持续高频输入下反复渲染中间态（流式可达）——H-03 的回归断言', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createThrottle(fn, 80, env())
    // 模拟 25 delta/s（40ms 间隔）持续 240ms：旧实现下回调 0 次（整段一次蹦出）
    for (let elapsed = 0; elapsed <= 200; elapsed += 40) {
      t.call(`d${elapsed}`)
      vi.advanceTimersByTime(40)
    }
    vi.advanceTimersByTime(80)
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3)
    vi.useRealTimers()
  })

  it('尾沿必达：停顿后一定用最后一次实参补渲染终态', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createThrottle(fn, 80, env())
    t.call('a'); t.call('b'); t.call('c')       // 冷却期内连续三次，只有最后一次该被补上
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(80)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('c')
    vi.useRealTimers()
  })

  it('空闲后下一次调用回到首沿语义（不会永久滞留在冷却态）', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createThrottle(fn, 80, env())
    t.call('a')
    vi.advanceTimersByTime(80)                  // 冷却结束且无 pending → 定时器自然结束
    t.call('b')                                 // 应立即可见
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('b')
    vi.useRealTimers()
  })

  it('cancel 丢弃待执行的尾沿调用（卸载后不再回调）', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createThrottle(fn, 80, env())
    t.call('a')
    t.call('b')                                 // 记为 pending
    t.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('a')
    vi.useRealTimers()
  })
})
