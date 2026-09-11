// tests/unit/generation-watchdog.spec.ts
// H-10（2026-09-11）：生成静默看门狗。
//
// 本模块的存在理由（评审核实）：流式生命周期在 Renderer 侧原本**没有任何出口**——
// `message.store.ts` 里 `activeGenerationId` 与 `status:'streaming'` 一旦置位就永不过期
// （该文件当时零个 `setTimeout`），Main 的超时全部键在别处而没有一条键在 generation 上，
// 且 IPC invoke 两端都没有超时。于是 WS 仍连着（不触发唯一那条自动恢复路径）而后端卡住时，
// 气泡永久显示「生成中…」。
//
// 这里用**注入的假定时器**确定性驱动到期：不用 sleep，也不依赖真实时钟——真实时钟会让
// 「到期只触发一次」「touch 续命」这类断言变得不可复现。
import { describe, expect, it, vi } from 'vitest'
import {
  createGenerationWatchdog,
  GENERATION_SILENCE_TIMEOUT_MS,
  type WatchdogTimers
} from '../../src/renderer/src/utils/generation-watchdog'

/** 手动驱动的定时器：记录所有待触发回调，可精确推进到到期 */
function fakeTimers() {
  let nextHandle = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const cleared: number[] = []
  const timers: WatchdogTimers = {
    set: (fn, ms) => {
      const h = nextHandle++
      pending.set(h, { fn, ms })
      return h
    },
    clear: (handle) => {
      const h = handle as number
      cleared.push(h)
      pending.delete(h)
    }
  }
  return {
    timers,
    pendingCount: () => pending.size,
    clearedCount: () => cleared.length,
    /** 触发当前唯一待触发的回调（模拟窗口到期） */
    fireAll(): void {
      for (const [h, entry] of [...pending.entries()]) {
        pending.delete(h)
        entry.fn()
      }
    },
    /** 所有待触发回调声明的超时值（断言 arm/touch 用的确实是配置窗口） */
    delays: () => [...pending.values()].map((e) => e.ms)
  }
}

function setup(timeoutMs = 1000) {
  const onSilence = vi.fn()
  const clock = fakeTimers()
  const watchdog = createGenerationWatchdog({ timeoutMs, onSilence, timers: clock.timers })
  return { watchdog, onSilence, clock }
}

describe('generation-watchdog（H-10）', () => {
  it('arm 后到期恰好回调一次，并带上被监视那一代的 id', () => {
    const { watchdog, onSilence, clock } = setup()
    watchdog.arm('gen-1')
    expect(watchdog.armedGenerationId()).toBe('gen-1')
    expect(clock.pendingCount()).toBe(1)

    clock.fireAll()

    expect(onSilence).toHaveBeenCalledTimes(1)
    expect(onSilence).toHaveBeenCalledWith('gen-1')
    expect(watchdog.armedGenerationId()).toBeUndefined()
  })

  it('到期后窗口不复活：再触发一次也不会二次回调（定时器回调内重新 touch 也不行）', () => {
    // 防的是「一个定时器句柄被复用/残留」导致同一代被反复打断。到期路径先清 armed 再回调，
    // 因此回调里若有人 touch（armed 已 undefined）不会被重新武装。
    const onSilence = vi.fn()
    const clock = fakeTimers()
    const watchdog = createGenerationWatchdog({
      timeoutMs: 1000,
      onSilence: (gid) => { onSilence(gid); watchdog.touch(gid) },
      timers: clock.timers
    })
    watchdog.arm('gen-1')
    clock.fireAll()
    expect(onSilence).toHaveBeenCalledTimes(1)
    expect(clock.pendingCount(), '回调内 touch 不得重新武装已到期的窗口').toBe(0)
    expect(watchdog.armedGenerationId()).toBeUndefined()
  })

  it('touch 重置窗口，且不累积并行定时器（防 disarm 只清掉最后一个）', () => {
    const { watchdog, onSilence, clock } = setup()
    watchdog.arm('gen-1')
    watchdog.touch('gen-1')
    watchdog.touch('gen-1')
    // 每次 touch 都是「清旧句柄 + 建新句柄」，故任意时刻只有一个待触发回调
    expect(clock.pendingCount()).toBe(1)
    expect(clock.clearedCount()).toBe(2)
    expect(clock.delays()).toEqual([1000])

    clock.fireAll()
    expect(onSilence).toHaveBeenCalledTimes(1)
  })

  it('touch 只对已武装的那一代生效：别的 generation 不得给这一代续命', () => {
    // 承重语义：若任意事件都能重置，一条持续推送的**旧代**事件会让新代永不超时，
    // watchdog 反而变成「永远不会响」。
    const { watchdog, onSilence, clock } = setup()
    watchdog.arm('gen-2')
    watchdog.touch('gen-1') // 旧代事件
    watchdog.touch('gen-other')
    expect(clock.clearedCount(), '跨代 touch 不得动当前窗口').toBe(0)
    expect(watchdog.armedGenerationId()).toBe('gen-2')

    clock.fireAll()
    expect(onSilence).toHaveBeenCalledWith('gen-2')
  })

  it('disarm 后到期不再回调，且 armedGenerationId 清空', () => {
    const { watchdog, onSilence, clock } = setup()
    watchdog.arm('gen-1')
    watchdog.disarm()
    expect(watchdog.armedGenerationId()).toBeUndefined()
    expect(clock.pendingCount(), 'disarm 必须真正清掉定时器（否则泄漏的定时器仍会触发）').toBe(0)

    clock.fireAll()
    expect(onSilence).not.toHaveBeenCalled()
  })

  it('切换代（arm 新代）会顶掉旧窗口，旧代不再可能触发', () => {
    const { watchdog, onSilence, clock } = setup()
    watchdog.arm('gen-1')
    watchdog.arm('gen-2')
    expect(watchdog.armedGenerationId()).toBe('gen-2')
    expect(clock.pendingCount()).toBe(1)

    clock.fireAll()
    expect(onSilence).toHaveBeenCalledTimes(1)
    expect(onSilence).toHaveBeenCalledWith('gen-2')
  })

  it('onSilence 抛出不会从定时器回调逃逸（renderer 侧无人兜底未捕获异常）', () => {
    // 该教训来自 H-04：persist-flush 的 onTimeout 抛错曾从定时器回调逃逸成未捕获异常。
    const clock = fakeTimers()
    const watchdog = createGenerationWatchdog({
      timeoutMs: 1000,
      onSilence: () => { throw new Error('callback blew up') },
      timers: clock.timers
    })
    watchdog.arm('gen-1')
    expect(() => clock.fireAll()).not.toThrow()
    expect(watchdog.armedGenerationId()).toBeUndefined()
  })

  it('未 arm 时 touch/disarm 是安全的空操作', () => {
    const { watchdog, onSilence, clock } = setup()
    watchdog.touch('gen-1')
    watchdog.disarm()
    expect(clock.pendingCount()).toBe(0)
    clock.fireAll()
    expect(onSilence).not.toHaveBeenCalled()
  })

  it('默认窗口在评审建议的 45–60s 区间内（容忍慢首 token，又能给用户明确等待上限）', () => {
    expect(GENERATION_SILENCE_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000)
    expect(GENERATION_SILENCE_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})
