// tests/unit/debounce-trailing.spec.ts —— 尾沿防抖（流式渲染 80ms 节流，spec §4.6.3）。
import { describe, expect, it, vi } from 'vitest'
import { createTrailingDebounce } from '../../src/renderer/src/utils/debounce-trailing'

describe('createTrailingDebounce', () => {
  it('连续调用合并到停顿后一次执行（尾沿）', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const env = { setTimeout: vi.fn((cb: () => void, ms: number) => setTimeout(cb, ms)), clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) }
    const d = createTrailingDebounce(fn, 80, env)
    d('a'); vi.advanceTimersByTime(40); d('b'); vi.advanceTimersByTime(80)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('b')
    vi.useRealTimers()
  })
  it('停顿后最终文本必渲染（防抖不吞末次调用）', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = createTrailingDebounce(fn, 80, { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms), clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) })
    d('final'); vi.advanceTimersByTime(80)
    expect(fn).toHaveBeenCalledWith('final')
    vi.useRealTimers()
  })
})
