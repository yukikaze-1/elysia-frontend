// src/main/app/process-error-guards.ts —— 主进程未捕获异常兜底（H-12，2026-09-11）。
//
// 背景：`src/main` 此前**没有**注册 `unhandledRejection` / `uncaughtException`（全仓 0 命中），
// 唯一的安全网是 `main()` 自己的 `.catch`。于是一个浮空 promise 的拒绝——例如
// `persistence-handlers.ts` 的 `void shell.openExternal(...)`——既不进诊断日志也不进审计，
// 用户与开发者都看不到。
//
// ## 两个处理器的存续语义**故意不同**，且**都不是「纯增量」**（2026-09-11 实测更正）
//
// 我先前的注释声称「`process.on` 是追加监听，不覆盖 Electron 自带处理器，既有默认行为照旧发生」。
// **该论断是错的**，由一次对照实验推翻（探针：主进程 setTimeout 抛错）：
//   - 不装配本模块 → 出现 Electron 原生弹窗「A JavaScript error occurred in the main process」；
//   - 装配本模块  → 该弹窗消失，进程存活。
// 即 Electron 在**已有应用处理器时会让位**（它只在自己是唯一监听者时才弹窗并终止）。
// 因此注册监听器**顶掉了平台默认的 fail-safe**——我们必须自己把这件事接过来，否则就是
// 「异常被静默吞掉且带着未定义状态继续运行」，比原来的直接崩溃更危险（本应用会写凭据/草稿/消息）。
//
// 据此定案（均经实测，非推断）：
// - `uncaughtException`：留痕后**主动调用 `onFatal`**（弹窗 + 收尾 + 退出），显式恢复 fail-safe，
//   不依赖 Electron 的内部判定。未注入 `onFatal` 时只留痕（测试场景），并由 `installProcessErrorGuards`
//   的调用方负责保证注入。
// - `unhandledRejection`：留痕后**继续运行**。这是对 Node 默认（无监听器时升级为未捕获异常并终止）
//   的**有意偏离**：已观测的唯一实例是良性的（系统无浏览器处理器时 `shell.openExternal` 拒绝）。
//   偏离是有代价的（真正的严重拒绝也会被放过），但「任何浮空 promise 都杀掉应用」明显更糟。
//
// 抽成纯函数 + deps 注入的理由与 `handleChildProcessGone`（index.ts）一致：可单测。
export interface ProcessErrorDeps {
  logger: { error(code: string, fields?: Record<string, string | number | boolean>): void }
  /**
   * 审计留痕。**可以返回 Promise**——未捕获异常路径会 await 它再退出：
   * 实测发现退出会抢在 fire-and-forget 的审计写入之前，把要留的痕一起带走（见文件头）。
   */
  audit(event: { type: string; summary: string }): void | Promise<void>
  /** 统一脱敏（`createSanitizePublicMessage`）：异常文本可能含绝对路径/凭据片段，不得原样落盘 */
  sanitize(text: string): string
  /**
   * 未捕获异常后的 fail-safe（Main 注入：弹窗 + closeAll + exit(1)）。
   * **必须注入**——Electron 的默认弹窗已被本模块顶掉，不接管就等于静默带伤继续运行。
   */
  onFatal?(message: string): void
}

/** 把任意抛出值转成可安全写入日志/审计的单行文本（不取 stack——stack 含绝对路径且噪音大） */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.message || value.name
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  try { return JSON.stringify(value) ?? String(value) } catch { return '[不可序列化的抛出值]' }
}

const MAX_SUMMARY_CHARS = 300

function summarize(label: string, value: unknown, deps: ProcessErrorDeps): string {
  const text = deps.sanitize(describeThrown(value)).replace(/\s+/g, ' ').trim()
  const clipped = text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text
  return `${label}：${clipped}`
}

/** 未处理的 Promise 拒绝：error 级日志 + 审计留痕，随后继续运行（见文件头的有意偏离及其代价） */
export function handleUnhandledRejection(reason: unknown, deps: ProcessErrorDeps): void {
  deps.logger.error('main:unhandled-rejection', { message: deps.sanitize(describeThrown(reason)) })
  deps.audit({ type: 'main:unhandled-rejection', summary: summarize('主进程未处理的 Promise 拒绝', reason, deps) })
}

/**
 * 未捕获异常：error 级日志 → **await 审计落盘** → 交回 fail-safe（弹窗 + 退出）。
 *
 * 顺序不可颠倒，且审计**必须 await**：实测（探针触发主进程未捕获异常）发现若直接退出，
 * fire-and-forget 的审计写入会被退出抢跑而丢失——「至少留痕」这个唯一目的就落空了。
 * 整个函数是 async，但退出由 `onFatal` 负责，故 Node 不会因为处理器返回 Promise 而提前终止。
 */
export async function handleUncaughtException(error: unknown, deps: ProcessErrorDeps): Promise<void> {
  const summary = summarize('主进程未捕获异常', error, deps)
  deps.logger.error('main:uncaught-exception', { message: deps.sanitize(describeThrown(error)) })
  try { await deps.audit({ type: 'main:uncaught-exception', summary }) } catch { /* 留痕失败也要继续走 fail-safe */ }
  try {
    deps.onFatal?.(summary)
  } catch { /* fail-safe 自身失败不得再次抛出（否则在异常处理器里形成二次异常） */ }
}

/** 可注入的进程对象面（默认 globalThis.process）——便于单测用假 EventEmitter 断言接线 */
export interface ProcessLike {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown
}

let installed = false

/**
 * 装配两个兜底监听。重复调用为 no-op（幂等）——避免测试或多路径装配下重复注册
 * 导致同一条异常写两份审计。
 *
 * 注意：本调用**会顶掉 Electron 原生的主进程错误弹窗**（见文件头实测），
 * 故 `deps.onFatal` 必须由调用方注入。
 */
export function installProcessErrorGuards(deps: ProcessErrorDeps, target: ProcessLike = process): void {
  if (installed) return
  installed = true
  target.on('unhandledRejection', (reason) => { handleUnhandledRejection(reason, deps) })
  target.on('uncaughtException', (error) => { void handleUncaughtException(error, deps) })
}

/** 仅供测试：重置幂等标记（生产不调用） */
export function resetProcessErrorGuardsForTest(): void { installed = false }
