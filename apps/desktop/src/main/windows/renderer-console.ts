// apps/desktop/src/main/windows/renderer-console.ts
// Renderer 控制台错误 → Main 日志（P1-12 / M-01，2026-09-11）。
//
// 背景（评审核实）：renderer 侧 JS 错误**从不进入诊断导出**。`main.ts` 的三个错误源
// （Vue errorHandler、window 'error'、'unhandledrejection'）只做 `console.error`，
// 而 Main **没有**订阅 `console-message`（`main-window.ts` 只有 will-navigate/before-input-event/
// render-process-gone），`diagnostics-service` 的 summary 也只含 origin/status/protocolVersion。
// 注释里把「JS 异常是独立候选」列为可观测性目标，但代码从未落地。后果：用户导出诊断包时
// **renderer 侧故障完全不在包内**——而 renderer 恰恰是实际最常出问题的一侧。
//
// 本模块把 renderer 控制台接到既有 logger 上。为什么走 logger 而不是新开一条 IPC：
//   · logger 落盘前已做 **sanitize（路径）+ redact（秘密形态）双净化**（logger.ts:31,41），
//     正是报告要求的脱敏管道，无需再造一条；
//   · 不新增 preload/IPC 暴露面（新增通道要过暴露面 review 与三面对齐门禁），
//     本修法对契约零改动；
//   · `console-message` 天然覆盖**我们没想到去插桩**的错误，比逐点埋点更不易漏。
//
// 报告点名的第二条风险是「防 renderer 噪声淹没主进程日志」——故本模块**有界**：
// 只转发 error 级、按滑窗限流、单条截断，且**被丢弃的条数本身也会记一条**——
// 静默丢弃会重演"看不见"这个原始缺陷，所以抑制必须可见。
import type { Logger } from '../diagnostics/logger'

/** Electron MessageDetails.level：0=verbose 1=info 2=warning 3=error */
export const CONSOLE_LEVEL_ERROR = 3

/**
 * 控制台级别归一（**实测踩过的坑**）：Electron 在 `WebContentsConsoleMessageEventParams` 里
 * 给的是**字符串** `'info' | 'warning' | 'error' | 'debug'`，而两处位置参数（已废弃的那套）
 * 给的是**数字** 0–3。若只按数字比较，`'error' >= 3` 为 false（字符串与数字比较得 NaN），
 * 结果是**一条都不会转发**——正好重演本缺陷"静默无痕"的形态。故两种形态都归一。
 */
export type ConsoleLevel = 'info' | 'warning' | 'error' | 'debug'

/** 接受**字符串**（现代形态，合法取值即 `ConsoleLevel`）或**数字**（废弃位置参数）。
 *  形参原写作 `ConsoleLevel | number | string`——字面量联合被 `string` 吞掉，是冗余类型成分
 *  （`no-redundant-type-constituents`，2026-09-13 type-aware 全集），故收敛为 `string | number`；
 *  合法取值仍由下方逐值比较把关，并写明在上面的注释里。 */
export function normalizeConsoleLevel(level: string | number): ConsoleLevel | undefined {
  if (typeof level === 'number') {
    return level >= CONSOLE_LEVEL_ERROR ? 'error' : level === 2 ? 'warning' : level === 1 ? 'info' : 'debug'
  }
  return level === 'error' || level === 'warning' || level === 'info' || level === 'debug' ? level : undefined
}

export interface RendererConsoleDetails {
  /** 字符串（现代形态，合法取值即 ConsoleLevel）或数字（废弃位置参数）皆可——见 normalizeConsoleLevel */
  level: string | number
  message: string
  /** 来源标识（现代形态的 sourceId，通常是脚本 URL） */
  sourceId?: string
  lineNumber?: number
}

export interface RendererConsoleSink {
  handle(details: RendererConsoleDetails): void
  stats(): { forwarded: number; suppressed: number; ignored: number }
}

export interface RendererConsoleSinkOptions {
  logger?: Pick<Logger, 'warn'>
  now?: () => number
  /** 只转发该级别及以上（默认仅 error；'error' 是最高级，故默认等价于"只转发 error"） */
  minLevel?: ConsoleLevel
  /** 限流窗口长度 */
  windowMs?: number
  /** 每个窗口最多转发多少条 */
  maxPerWindow?: number
  /** 单条消息最大字符数（超出截断并标注） */
  maxChars?: number
}

export const RENDERER_CONSOLE_WINDOW_MS = 10_000
export const RENDERER_CONSOLE_MAX_PER_WINDOW = 20
export const RENDERER_CONSOLE_MAX_CHARS = 500

/**
 * 创建 renderer 控制台 sink。
 *
 * 语义要点：
 *   · 低于 minLevel（默认 error）→ 计入 ignored，不落盘（避免把 renderer 的普通日志搬进主日志）；
 *   · 窗口内超出上限 → 计入 suppressed，**不逐条落盘**；窗口滚动时若发生过抑制，
 *     补记一条 `renderer:console-suppressed`（带被抑制条数）——丢弃必须可见；
 *   · 单条截断，防一条巨型消息把日志撑爆（logger 的字段本身也已过 redact）。
 */
export function createRendererConsoleSink(opts: RendererConsoleSinkOptions = {}): RendererConsoleSink {
  const logger = opts.logger
  const now = opts.now ?? (() => Date.now())
  const minLevel = opts.minLevel ?? 'error'
  const minSeverity = minLevel === 'error' ? 3 : minLevel === 'warning' ? 2 : minLevel === 'info' ? 1 : 0
  const severity = (level: ConsoleLevel): number => level === 'error' ? 3 : level === 'warning' ? 2 : level === 'info' ? 1 : 0
  const windowMs = opts.windowMs ?? RENDERER_CONSOLE_WINDOW_MS
  const maxPerWindow = opts.maxPerWindow ?? RENDERER_CONSOLE_MAX_PER_WINDOW
  const maxChars = opts.maxChars ?? RENDERER_CONSOLE_MAX_CHARS

  let windowStartedAt = 0
  let forwardedInWindow = 0
  let suppressedInWindow = 0
  const totals = { forwarded: 0, suppressed: 0, ignored: 0 }

  /** 窗口滚动：把上一窗口的抑制数补记一条（若有），再重置计数 */
  function rollWindowIfNeeded(at: number): void {
    if (at - windowStartedAt < windowMs) return
    if (windowStartedAt !== 0 && suppressedInWindow > 0) {
      logger?.warn('renderer:console-suppressed', { count: suppressedInWindow, windowMs })
    }
    windowStartedAt = at
    forwardedInWindow = 0
    suppressedInWindow = 0
  }

  return {
    handle(details) {
      const level = normalizeConsoleLevel(details.level)
      if (level === undefined || severity(level) < minSeverity) { totals.ignored++; return }
      const at = now()
      rollWindowIfNeeded(at)
      if (forwardedInWindow >= maxPerWindow) {
        suppressedInWindow++
        totals.suppressed++
        return
      }
      forwardedInWindow++
      totals.forwarded++
      const message = details.message.length > maxChars
        ? `${details.message.slice(0, maxChars)}…（已截断，原 ${details.message.length} 字符）`
        : details.message
      // 字段名与值都只放结构性信息；logger 落盘前还会过 sanitize+redact
      logger?.warn('renderer:console-error', {
        message,
        level,
        ...(details.sourceId ? { sourceId: details.sourceId } : {}),
        ...(typeof details.lineNumber === 'number' ? { line: details.lineNumber } : {})
      })
    },
    stats: () => ({ ...totals })
  }
}
