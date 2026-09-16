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
// 抽成纯函数 + deps 注入的理由与 `handleChildProcessGone`（本文件，进程级失败信号的纯处理函数）一致：可单测。
//
// S12（2026-09-15 安全评审）：本模块的 `summarize` 同时喂给**审计**与**原生错误框 / stderr** 两条出口，
// 而此前两条都只 `sanitize`（掩路径）。现在 fail-safe 那一路额外补 `redactSensitiveValues`（审计不动，
// 见 `handleUncaughtException` 内注释）。
import { redactSensitiveValues } from '../diagnostics/redact'
import type { AuditEvent } from '../diagnostics/audit'
import type { Logger } from '../diagnostics/logger'

/**
 * `child-process-gone` 的 GPU 分支（阶段 7 批次 B，D7B-08；契约 H-1 解耦）。
 *
 * 只关注 GPU 子进程异常：warn + `audit(gpu:crash)`（**独立 type，勿复用 renderer:crash**）。
 * 非 GPU（Utility/Zygote/Sandbox helper 等）有意忽略——renderer 崩溃由 `render-process-gone` 覆盖，
 * `child-process-gone` 无 Renderer 子进程。GPU **不 reload**（reload 归 render-process-gone）。
 *
 * 2026-09-17（架构整改 Prompt 2）：从 `main/index.ts` 移入本模块——它与本文件的另外两个守卫
 * 是同一类东西（进程级失败信号的纯处理函数，deps 注入以便单测），index.ts 不再持有具体处理逻辑。
 */
export function handleChildProcessGone(
  details: { type: string; reason: string; exitCode: number },
  deps: { logger: Logger; audit: (e: Omit<AuditEvent, 'ts'>) => void }
): void {
  if (details.type === 'GPU') {
    deps.logger.warn('gpu-process-gone', { reason: details.reason, exitCode: details.exitCode })
    deps.audit({ type: 'gpu:crash', summary: `GPU 进程异常：${details.reason} (exit ${details.exitCode})` })
  }
}

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

/** 把任意抛出值转成可安全写入日志/审计的单行文本（不取 stack——stack 含绝对路径且噪音大）
 *
 *  2026-09-13（type-aware 全集，`no-base-to-string`）：原写法末尾是 `JSON.stringify(value) ?? String(value)`，
 *  而 `String(任意对象)` 会得到 '[object Object]'——虽然对象在正常路径上已被序列化，兜底分支仍可能吐出这句
 *  没有信息量的假文案。现按类型逐支处理：对象只走序列化（失败即明确标注），函数给固定标记
 *  （`String(fn)` 是整段源码，不该进单行日志），剩下的原始值 `String()` 才是准确的。 */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.message || value.name
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'function') return '[函数]'
  if (typeof value === 'object') {
    try { return JSON.stringify(value) ?? '[不可序列化的抛出值]' } catch { return '[不可序列化的抛出值]' }
  }
  // 剩余原始值逐支显式处理（`String(value)` 在"可能含对象"的类型上会被判为可能产出 '[object Object]'，
  // 见 `no-base-to-string`；显式分支让这件事不可能发生）
  if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString()
  return '[不可序列化的抛出值]'
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
  // P1-11（type-aware lint 抓到）：`deps.audit` 的签名是 `void | Promise<void>`，此处**有意不 await**
  // （本函数是同步的，且必须立刻返回——见文件头「unhandledRejection 只留痕」的既定决策）。
  // 但**不能**只写 `void deps.audit(...)`：若它返回的 Promise 拒绝，就会在
  // unhandledRejection 处理器**内部**再制造一个未处理拒绝（潜在自递归）。
  // 故显式吞掉拒绝：既保持不阻塞，也不产生新的未处理拒绝。留痕失败本身已由 logger 那一行覆盖。
  Promise.resolve(deps.audit({ type: 'main:unhandled-rejection', summary: summarize('主进程未处理的 Promise 拒绝', reason, deps) })).catch(() => {})
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
    // S12（2026-09-15 安全评审）：同一条异常文本有两条出口——审计（`audit.ts` 只 `sanitize`，掩路径）
    // 与**原生错误框 / harness stderr**（此前同样只 `sanitize`）。弹窗是「截图进 issue」的高频面，
    // 未被 `redact.ts` 四条规则覆盖的凭据形态会明文出现在那里，故 fail-safe 这一路补 `redactSensitiveValues`。
    // **刻意不动 `summary` 本身**：审计是本地留痕、需要可诊断性，不该因为展示面的口径而被抹成 `[REDACTED]`
    // （`'x'.repeat(5000)` 这类长串会整段命中 base64 规则，实测会把审计摘要压成一个词）。
    deps.onFatal?.(redactSensitiveValues(summary))
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
