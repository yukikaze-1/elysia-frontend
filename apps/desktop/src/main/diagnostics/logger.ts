// src/main/diagnostics/logger.ts
import type { MessageSanitizer } from './sanitize'
import type { FileWriter } from './file-writer'
import { redactSensitiveValues } from './redact'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogFields = Record<string, string | number | boolean>
export interface LogEvent {
  ts: string
  level: LogLevel
  logger: string
  code: string
  fields?: LogFields
}
export interface Logger {
  error(code: string, fields?: LogFields): void
  warn(code: string, fields?: LogFields): void
  info(code: string, fields?: LogFields): void
  debug(code: string, fields?: LogFields): void
  flush(): Promise<void>
  close(): Promise<void>
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
export function severityOf(level: LogLevel): number { return LOG_LEVEL_ORDER[level] }

export function formatLogEvent(ev: LogEvent): string { return JSON.stringify(ev) }

/**
 * JSONL logger。API = (code, fields?)，无 msg 参数——结构性禁记（无消息正文/Token 接收通道）。
 * fields 落盘前 sanitizePublicMessage（路径）+ redactSensitiveValues（秘密形态）双净化。
 * 写失败 fail-closed：吞掉不阻塞主流程。
 */
export function createLogger(module: string, opts: { level: LogLevel; writer: FileWriter; sanitize: MessageSanitizer }): Logger {
  const threshold = LOG_LEVEL_ORDER[opts.level]
  const log = (level: LogLevel, code: string, fields?: LogFields): void => {
    if (LOG_LEVEL_ORDER[level] > threshold) return
    const safe: LogFields = {}
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string') safe[k] = redactSensitiveValues(opts.sanitize(v))
        else safe[k] = v
      }
    }
    const line = formatLogEvent({ ts: new Date().toISOString(), level, logger: module, code, fields: safe })
    void opts.writer.append(line).catch(() => { /* fail-closed */ })
  }
  return {
    error: (c, f) => log('error', c, f),
    warn: (c, f) => log('warn', c, f),
    info: (c, f) => log('info', c, f),
    debug: (c, f) => log('debug', c, f),
    flush: () => opts.writer.flush(),
    close: () => opts.writer.close()
  }
}
