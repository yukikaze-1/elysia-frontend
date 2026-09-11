// 节流（首沿立即 + 尾沿必达），可注入定时器便于单测。
//
// 为什么不是防抖（H-03，2026-09-11）：本文件前身 `debounce-trailing.ts` 是**纯防抖**——
// 每次调用都 `clearTimeout` 重排定时器。流式 token 间隔小于窗口（>12.5 delta/s，即常态）时
// 定时器被无限后移，回调**永不触发**，助手气泡整段一次性蹦出，「流式」名不副实。
// 节流不重排冷却窗口，因此保证「至少每 delayMs 渲染一次」，高频输入下仍持续输出中间态。
//
// 语义边界（三性，均由 tests/unit/throttle.spec.ts 钉住）：
// - 首沿立即：首次调用当场执行（首 token 不等待，保证响应感）。
// - 冷却窗口固定：窗口从上次执行起算，**不因新调用而后移**（这正是与防抖的分水岭）。
// - 尾沿必达：冷却期内若有调用，窗口结束时用**最后一次实参**补执行；停顿后终态一定会渲染。
export interface TimerEnv {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

export interface Throttled<TArgs extends unknown[]> {
  call: (...args: TArgs) => void
  /** 取消待执行的尾沿调用（组件卸载时调用，避免泄漏与卸载后回调） */
  cancel: () => void
}

export function createThrottle<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
  env?: TimerEnv
): Throttled<TArgs> {
  const st = env?.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const ct = env?.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let timer: unknown
  let pending: TArgs | undefined

  const schedule = (): void => {
    timer = st(() => {
      timer = undefined
      if (pending === undefined) return
      const next = pending
      pending = undefined
      run(next)
    }, delayMs)
  }
  const run = (args: TArgs): void => {
    fn(...args)
    schedule() // 冷却窗口从「本次执行」起算，而非从「最后一次调用」起算
  }

  return {
    call(...args: TArgs): void {
      if (timer === undefined) run(args)          // 空闲 → 首沿立即
      else pending = args                          // 冷却中 → 只记最新一次，不重排定时器
    },
    cancel(): void {
      if (timer !== undefined) ct(timer)
      timer = undefined
      pending = undefined
    }
  }
}
