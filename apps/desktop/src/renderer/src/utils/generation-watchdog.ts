// apps/desktop/src/renderer/src/utils/generation-watchdog.ts
//
// H-10（2026-09-11）：生成静默看门狗。
//
// 背景（评审核实）：流式生命周期在 Renderer 侧**没有任何出口**——
//   · `message.store.ts` 里 `activeGenerationId` / `status:'streaming'` 一旦置位就**永不过期**，
//     该文件当时完全没有 `setTimeout`/`setInterval`；
//   · Main 的超时全部键在别处（ack 15s / handshake 10s / REST 10s / upload 60s），
//     **没有**任何一条键在 generation 的开始或结束上；
//   · `stream-accumulator.ts` 的 `hasGap()` 分支会把状态置为 `completing`，而 `completing`
//     同样没有任何本地出口，于是**永久滞留**；
//   · 取消在 `await api.cancel(...)` **之后**才改本地状态，而 IPC invoke 两端都没有超时
//     （`ipc/executor.ts` 无定时器、preload 裸 `await ipcRenderer.invoke`）。
//
// 后果：WS 仍连着（因此不会触发唯一那条自动恢复路径），但后端卡住或丢终态时，气泡永久显示
// 「生成中…」，唯一出口是手动停止按钮——而它要等一个可能永不返回的 IPC 往返。
//
// 本模块只做一件事：**给「正在生成」这件事加一个会到期的窗口**。判据取「静默」而不是总时长——
// 任何属于当前 generation 的事件都重置窗口，所以到期意味着后端在整整一个窗口内**一个事件都没发**。
// 这同时覆盖 `completing` 滞留：段没有完成就不会有后续事件，静默到期即视同中断。
//
// 之所以抽成独立纯模块（而不是把定时器塞进 store）：沿用本仓库既有的
// 「纯函数/工厂 + deps 注入 + 单测」先例（`utils/throttle.ts`、`main/persistence/persist-flush.ts`、
// `main/app/process-error-guards.ts`），使「到期是否只触发一次」「touch 能否跨代续命」
// 「disarm 后是否还会回调」这些边界可以由单测直接钉住，不必起整棵 store。

/** 可注入定时器：单测注入假定时器以确定性驱动到期，不必 sleep */
export interface WatchdogTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface GenerationWatchdog {
  /** 开始监视某一代（在 generation.started 落地后调用）。重复调用会重启窗口并改绑到新代 */
  arm(generationId: string): void
  /**
   * 重置窗口。**只对当前武装的那一代生效**——别的 generation 的事件不得给这一代续命，
   * 否则一条持续推送的旧代事件会让新代永不超时。
   */
  touch(generationId: string): void
  /** 解除监视（终态/取消/断线/会话切换）。解除后到期的回调不会再触发 */
  disarm(): void
  /** 当前武装的 generationId（无则 undefined）——供单测与诊断断言 */
  armedGenerationId(): string | undefined
}

/**
 * 静默窗口长度。取 50s 的理由：
 *   · 评审建议 45–60s；窗口必须**容忍慢首 token**（后端冷启 + 长 prompt 可能十几秒无 delta），
 *     否则会把正常生成误判为卡死——那比不判更糟；
 *   · 它同时是用户等待上限：超过这个时长仍零事件，界面停在「生成中…」已构成明确的故障信号，
 *     释放并说明原因远好于无限等待。
 */
export const GENERATION_SILENCE_TIMEOUT_MS = 50_000

/**
 * 创建看门狗。
 *
 * `onSilence` 在窗口到期时**至多被调用一次**，且入参是到期那一代的 id——
 * 调用方必须据此再校验一次「它是否仍是当前活动代」（见 store 内的二次校验）：
 * 本模块的 disarm 覆盖若干终态与切换路径，漏掉任一处也只应导致回调空转，绝不能误伤新一代。
 */
export function createGenerationWatchdog(opts: {
  timeoutMs: number
  onSilence: (generationId: string) => void
  timers?: WatchdogTimers
}): GenerationWatchdog {
  const timers: WatchdogTimers = opts.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
  let handle: unknown
  let armed: string | undefined

  function stopTimer(): void {
    if (handle === undefined) return
    timers.clear(handle)
    handle = undefined
  }

  function startTimer(generationId: string): void {
    stopTimer() // 先清旧句柄：否则 arm/touch 会累积多个并行定时器，disarm 只能清掉最后一个
    armed = generationId
    handle = timers.set(() => {
      handle = undefined
      const fired = armed
      armed = undefined // 先解除再回调：回调内若再 touch 不应复活已到期的窗口
      if (fired === undefined) return
      try {
        opts.onSilence(fired)
      } catch {
        // 定时器回调内抛出会变成未捕获异常（renderer 侧无人兜底）。回调的失败不该逃逸到这里：
        // 留痕与 UI 收敛是调用方的职责，本模块只负责「按时通知一次」。
      }
    }, opts.timeoutMs)
  }

  return {
    arm: startTimer,
    touch(generationId) {
      if (armed !== generationId) return
      startTimer(generationId)
    },
    disarm() {
      stopTimer()
      armed = undefined
    },
    armedGenerationId: () => armed
  }
}
