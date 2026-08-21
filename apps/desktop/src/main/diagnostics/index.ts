import { createFileWriter, type FileWriter } from './file-writer'
import { createLogger, type LogLevel, type Logger } from './logger'
import { createAuditor, type Auditor } from './audit'
import type { MessageSanitizer } from './sanitize'

export interface Diagnostics { logger: Logger; auditor: Auditor; logWriter: FileWriter; closeAll(): Promise<void> }

/** 装配：rotate 日志（5MB×3 异步批量 + 5s 定时 flush）+ daily 审计（sync 写）+ 30 天清理；closeAll 串行关闭 */
export function createDiagnostics(dirs: { logs: string; audit: string }, opts: {
  logLevel: LogLevel
  retentionDays: number
  sanitize: MessageSanitizer
  logFlushIntervalMs?: number // 默认 5000；测试可注入小值
}): Diagnostics {
  const logWriter = createFileWriter({ dir: dirs.logs, baseName: 'app', mode: 'rotate', maxSizeBytes: 5 * 1024 * 1024, maxFiles: 3, sync: false, flushIntervalMs: opts.logFlushIntervalMs ?? 5000 })
  const auditWriter = createFileWriter({ dir: dirs.audit, baseName: 'audit', mode: 'daily', retentionDays: opts.retentionDays, sync: true })
  const logger = createLogger('main', { level: opts.logLevel, writer: logWriter, sanitize: opts.sanitize })
  const auditor = createAuditor(auditWriter, {
    sanitize: opts.sanitize,
    retentionDays: opts.retentionDays,
    dir: dirs.audit,
    onCleanupError: (err) => logger.error('audit:cleanup-failed', { message: err instanceof Error ? err.message : String(err) })
  })
  return {
    logger,
    auditor,
    // 阶段 7 批次 A（Task 3，可行 R2-5）：运行日志 writer 引用带出——诊断服务 deps.logWriter 消费
    // （getState 展示大小/文件清单、Task 4 clear/export）；既有调用方（main/index.ts）解构不受影响。
    logWriter,
    closeAll: async () => {
      try { await logger.close() } catch { /* 不阻断 */ }
      try { await auditor.close() } catch { /* 不阻断 */ }
    }
  }
}
