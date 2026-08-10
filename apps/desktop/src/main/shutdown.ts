export interface ShutdownDeps {
  closeAll(): Promise<void>
  quit(): void
  timeoutMs?: number
}

/**
 * before-quit flush 处理器（可测工厂）：
 * allowQuit 放行标志——finish 完成后最终 app.quit() 不再被 preventDefault 拦截（否则进程永不退出）；
 * 每次事件 preventDefault（flushing 期间二次 quit 被拦，防绕过 finish）；
 * finish 每步独立 try/catch；1.5s race 超时只「放弃等待」不「与在途写竞速」；finally(quit) 恒执行。
 */
export function createShutdownHandler(deps: ShutdownDeps): (e: { preventDefault(): void }) => void {
  let flushing = false
  let allowQuit = false
  return (e) => {
    if (allowQuit) return // 最终 quit 放行
    e.preventDefault()
    if (flushing) return
    flushing = true
    const finish = async (): Promise<void> => {
      try { await deps.closeAll() } catch { /* 不阻断 */ }
    }
    const quit = (): void => { allowQuit = true; deps.quit() }
    void Promise.race([finish(), new Promise((r) => setTimeout(r, deps.timeoutMs ?? 1500))])
      .catch(() => {})
      .finally(quit)
  }
}
