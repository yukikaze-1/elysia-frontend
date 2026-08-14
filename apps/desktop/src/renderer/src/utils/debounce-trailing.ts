// 尾沿防抖（spec §4.6.3 流式渲染 80ms 节流）：可注入定时器便于单测。
export interface TimerEnv {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

export function createTrailingDebounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
  env?: TimerEnv
): (...args: TArgs) => void {
  const st = env?.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const ct = env?.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let timer: unknown
  return (...args: TArgs): void => {
    if (timer !== undefined) ct(timer)
    timer = st(() => { timer = undefined; fn(...args) }, delayMs)
  }
}
