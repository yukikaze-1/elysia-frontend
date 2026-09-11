// src/main/persistence/persist-flush.ts —— 退出前驱动 Renderer flush 防抖持久化（H-04，2026-09-11）。
//
// 问题：Renderer 侧草稿 800ms / 设置 500ms / 布局 200ms / 角色草稿各自防抖落盘，
// 且**没有任何退出 flush**（`flush()` 全仓只有「切会话」与「断线」两个调用点）。
// 用户在键入后立刻关窗，定时器尚未到期，内容无提示消失——而工程其余部分对持久化相当谨慎
// （原子写 + 序列化队列），这是遗漏而非取舍。
//
// 为什么由 Main 发起：window 的 `beforeunload` 无法 await 异步 IPC，而持久化必须经 invoke 到 Main
// （Main 才是磁盘所有者）。因此由 Main 在 `before-quit` 发一条下行请求、等 Renderer 回 ack，
// 复用既有 `createShutdownHandler.steps` 的有序 await 与超时兜底。
//
// fail-open 纪律（与 shutdown.ts 同款）：无窗口、投递抛错、超时、Renderer 侧 flush 失败——
// 一律不阻断退出，也绝不静默谎报成功（超时经 onTimeout 记诊断）。
export const PERSIST_FLUSH_TIMEOUT_MS = 700

export interface PersistFlushRequester {
  /** 请求 Renderer flush 并等待 ack；无窗口/超时/投递失败均 resolve（fail-open） */
  request(): Promise<void>
  /** Renderer 的 ack（由 IPC handler 调用）；无在途请求时为 no-op */
  acknowledge(): void
}

export function createPersistFlushRequester(deps: {
  /** 把请求推给 Renderer；无可用窗口返回 false（此时无 Renderer 状态可 flush） */
  deliver(): boolean
  timeoutMs?: number
  onTimeout?(): void
}): PersistFlushRequester {
  let settle: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const finish = (): void => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    const resolve = settle
    settle = undefined
    resolve?.()
  }

  return {
    request(): Promise<void> {
      if (settle !== undefined) return Promise.resolve() // 已有在途请求：不重复投递
      let delivered = false
      try { delivered = deps.deliver() } catch { delivered = false } // 投递失败不阻断退出
      if (!delivered) return Promise.resolve()
      return new Promise<void>((resolve) => {
        settle = resolve
        timer = setTimeout(() => {
          timer = undefined
          // 超时留痕（写日志/审计）自身失败绝不阻断退出，也不能变成退出期的未捕获异常：
          // 两者都比丢一条日志更糟。故 catch 吞掉，且 finish() 无条件执行。
          try { deps.onTimeout?.() } catch { /* fail-open（见上） */ }
          finish()
        }, deps.timeoutMs ?? PERSIST_FLUSH_TIMEOUT_MS)
      })
    },
    acknowledge(): void { finish() }
  }
}
