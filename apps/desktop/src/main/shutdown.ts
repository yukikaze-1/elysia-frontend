export const SHUTDOWN_TIMEOUT_MS = 1500

export interface ShutdownStep { name: string; run(): Promise<void> }
export interface ShutdownDeps {
  steps: ShutdownStep[]
  quit(): void
  timeoutMs?: number // 默认 SHUTDOWN_TIMEOUT_MS
  onTimeout?(): void // 超时标记（main 装配写同步 audit + warn；持久记录）
  onError?(step: string, err: unknown): void
}

/**
 * before-quit 有序 flush（决策 A2 / 整改 FE-S1-P1-03）：
 * 每步独立 try/catch（onError 不阻断后续）；循环顶 timedOut 检查——超时后不再启动新 step；
 * race(runAll, timeout)：runAll 正常完成 → finally clearTimeout（无残留计时器）+ quit；
 * 超时先到 → timedOut=true + onTimeout() → finally quit（即使 step 挂起）；allowQuit 只放行一次 quit。
 */
export function createShutdownHandler(deps: ShutdownDeps): (e: { preventDefault(): void }) => void {
  let flushing = false
  let allowQuit = false
  return (e) => {
    if (allowQuit) return
    e.preventDefault()
    if (flushing) return
    flushing = true
    let timedOut = false
    let resolveTimeout: () => void = () => {}
    const timeoutPromise = new Promise<void>((r) => { resolveTimeout = r })
    const timer = setTimeout(() => {
      timedOut = true
      try { deps.onTimeout?.() } finally { resolveTimeout() } // try/finally：onTimeout 同步抛错也不阻断 quit
    }, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS)
    const runAll = async (): Promise<void> => {
      for (const s of deps.steps) {
        if (timedOut) return
        try { await s.run() } catch (err) { deps.onError?.(s.name, err) }
      }
    }
    void Promise.race([runAll(), timeoutPromise])
      .catch(() => {})
      .finally(() => { clearTimeout(timer); allowQuit = true; deps.quit() })
  }
}

export interface FatalDeps {
  showError(message: string): void
  closeAll?(): Promise<void>
  exit(code: number): void
  timeoutMs?: number // 默认 SHUTDOWN_TIMEOUT_MS
}

/** 统一 fatal：closeAll 存在则 race 超时后无条件 exit(1)（防 closeAll 挂起拖死启动失败路径） */
export function createFatalShutdown(deps: FatalDeps): (message: string) => void {
  return (message: string): void => {
    deps.showError(message)
    if (!deps.closeAll) { deps.exit(1); return }
    void Promise.race([deps.closeAll(), new Promise((r) => setTimeout(r, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS))])
      .catch(() => {})
      .finally(() => deps.exit(1))
  }
}
