// src/main/bootstrap/runtime-guards.ts —— 崩溃与进程级兜底装配（架构整改 Prompt 2）。
//
// 本模块只做「把已经构造好的诊断端口接到 Electron / Node 的失败信号上」，不构造任何对象。
//
// 存续语义（与整改前 `main()` 内的装配逐条同义）：
// - `child-process-gone`：GPU 子进程异常 → warn + `audit(gpu:crash)`（**独立 type，勿复用 renderer:crash**）。
//   非 GPU（Utility/Zygote/Sandbox helper 等）有意忽略——renderer 崩溃由 `render-process-gone` 覆盖，
//   `child-process-gone` 无 Renderer 子进程。GPU **不 reload**（reload 归 render-process-gone）。
// - `setCrashSink`：Renderer 崩溃 → 审计 + crash marker + reload（sink 状态在 windows/main-window.ts）。
// - `installProcessErrorGuards`：主进程未捕获异常/拒绝（存续语义见 app/process-error-guards.ts 头注）。
//
// 三者都必须在任何可能崩溃的构造之前装配；调用点见 bootstrap/infrastructure.ts。
//
// 三个**处理函数**都在 `app/process-error-guards.ts`（同一类东西：进程级失败信号的纯函数 + deps 注入），
// 本模块只负责"接哪三条线"。
import { app } from 'electron'
import { setCrashSink } from '../windows/main-window'
import { handleChildProcessGone, installProcessErrorGuards } from '../app/process-error-guards'
import type { AppDiagnosticsPort } from './infrastructure'

/** 装配三条失败信号监听。`onFatal` 必须是运行期文案的 fatal（「发生错误」，非「无法启动」）。 */
export function installRuntimeGuards(
  diagnostics: AppDiagnosticsPort,
  onFatal: (message: string) => void
): void {
  const logger = diagnostics.logger
  // 包箭头再传：`audit`/`auditAsync` 是端口对象上的方法，摘下来直接传会丢 `this`（unbound-method 先例）
  const audit = (event: Parameters<AppDiagnosticsPort['audit']>[0]): void => diagnostics.audit(event)
  // ① child-process-gone：audit/diagnostics 为本阶段局部（安全 MED-1——不进模块作用域）
  app.on('child-process-gone', (_ev, d) => handleChildProcessGone(d, { logger, audit }))
  // ② Renderer 崩溃 sink（logger/audit；crashMarker 由 main-window 内部写）
  setCrashSink({ logger, audit })
  // ③ 主进程未捕获异常兜底（H-12）：auditAsync——未捕获异常路径必须等审计落盘再退出
  installProcessErrorGuards({
    logger,
    audit: (event) => diagnostics.auditAsync(event),
    sanitize: diagnostics.sanitize,
    onFatal
  })
}
