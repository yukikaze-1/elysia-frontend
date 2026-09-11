// src/main/app/process-error-guards.ts —— 主进程未捕获异常兜底（H-12，2026-09-11）。
//
// 背景：`src/main` 此前**没有**注册 `unhandledRejection` / `uncaughtException`（全仓 0 命中），
// 唯一的安全网是 `main()` 自己的 `.catch`。于是一个浮空 promise 的拒绝——例如
// `persistence-handlers.ts` 的 `void shell.openExternal(...)`——既不进诊断日志也不进审计，
// 用户与开发者都看不到。
//
// ## 两个处理器的存续语义**故意不同**，这不是疏漏
//
// - `unhandledRejection`：只留痕，**不改变存续**。Node ≥15 在「无监听器」时把未处理拒绝升级为
//   未捕获异常（进程终止）；一旦有监听器就不再终止。这里选择留痕而不终止，因为已观测到的实例
//   （浏览器拒绝打开链接）是完全良性的，为它杀掉整个应用明显更糟。
// - `uncaughtException`：只留痕，**不替调用方决定是否终止**。`process.on` 是追加监听，不会覆盖
//   Electron 自带的处理器；因此本模块是纯增量——既有的默认行为（Electron 的错误框/Node 的终止）
//   照旧发生。**「留痕」是报告要求的全部**；「主进程异常后是否应主动终止」属产品决策，见 doc 16 §5。
//
// 抽成纯函数 + deps 注入的理由与 `handleChildProcessGone`（index.ts）一致：可单测。
export interface ProcessErrorDeps {
  logger: { error(code: string, fields?: Record<string, string | number | boolean>): void }
  audit(event: { type: string; summary: string }): void
  /** 统一脱敏（`createSanitizePublicMessage`）：异常文本可能含绝对路径/凭据片段，不得原样落盘 */
  sanitize(text: string): string
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

/** 未处理的 Promise 拒绝：error 级日志 + 审计留痕（不终止进程，见文件头） */
export function handleUnhandledRejection(reason: unknown, deps: ProcessErrorDeps): void {
  deps.logger.error('main:unhandled-rejection', { message: deps.sanitize(describeThrown(reason)) })
  deps.audit({ type: 'main:unhandled-rejection', summary: summarize('主进程未处理的 Promise 拒绝', reason, deps) })
}

/** 未捕获异常：error 级日志 + 审计留痕（是否终止交由 Node/Electron 既有行为，见文件头） */
export function handleUncaughtException(error: unknown, deps: ProcessErrorDeps): void {
  deps.logger.error('main:uncaught-exception', { message: deps.sanitize(describeThrown(error)) })
  deps.audit({ type: 'main:uncaught-exception', summary: summarize('主进程未捕获异常', error, deps) })
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
 */
export function installProcessErrorGuards(deps: ProcessErrorDeps, target: ProcessLike = process): void {
  if (installed) return
  installed = true
  target.on('unhandledRejection', (reason) => { handleUnhandledRejection(reason, deps) })
  target.on('uncaughtException', (error) => { handleUncaughtException(error, deps) })
}

/** 仅供测试：重置幂等标记（生产不调用） */
export function resetProcessErrorGuardsForTest(): void { installed = false }
