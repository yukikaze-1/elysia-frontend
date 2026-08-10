import { createFileWriter } from './file-writer'
import { createLogger, type LogLevel, type Logger } from './logger'
import { createAuditor, type Auditor } from './audit'
import type { MessageSanitizer } from './sanitize'

export interface Diagnostics { logger: Logger; auditor: Auditor; closeAll(): Promise<void> }

/** 装配：rotate 日志（5MB×3 异步批量）+ daily 审计（sync 写）+ 30 天清理；closeAll 串行关闭 */
export function createDiagnostics(dirs: { logs: string; audit: string }, opts: {
  logLevel: LogLevel
  retentionDays: number
  sanitize: MessageSanitizer
}): Diagnostics {
  const logWriter = createFileWriter({ dir: dirs.logs, baseName: 'app', mode: 'rotate', maxSizeBytes: 5 * 1024 * 1024, maxFiles: 3, sync: false })
  const auditWriter = createFileWriter({ dir: dirs.audit, baseName: 'audit', mode: 'daily', retentionDays: opts.retentionDays, sync: true })
  const logger = createLogger('main', { level: opts.logLevel, writer: logWriter, sanitize: opts.sanitize })
  const auditor = createAuditor(auditWriter, { sanitize: opts.sanitize, retentionDays: opts.retentionDays, dir: dirs.audit })
  return {
    logger,
    auditor,
    closeAll: async () => {
      try { await logger.close() } catch { /* 不阻断 */ }
      try { await auditor.close() } catch { /* 不阻断 */ }
    }
  }
}
