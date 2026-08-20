import { readdir, unlink } from 'fs/promises'
import { join } from 'path'
import type { FileWriter } from './file-writer'
import type { MessageSanitizer } from './sanitize'
import { redactSensitiveValues } from './redact'

export interface AuditEvent {
  ts: string
  type: string
  runtime?: string
  toolId?: string
  callId?: string
  status?: string
  durationMs?: number
  summary?: string
  // —— 阶段 6 批次 B（Task 5）：工具审计扩展可选字段（auditToolEvent 写入；缺省不出现不破坏既有） ——
  riskLevel?: 'safe' | 'medium' | 'high'
  permissionDecision?: 'allow_once' | 'deny' | 'allow_scoped'   // 批次 C（D6C-04）：'allow_scoped'（目录授权命中）
  startedAt?: string
  errorCode?: string
  cancelSource?: 'user' | 'timeout' | 'backend'
  // —— 阶段 6 批次 C（Task 3，F-3 完整性）：审批历史按工具/授权过滤数据源 ——
  permissionGrantId?: string   // 目录授权 grant.id（tool:decision allow_scoped / grant:* 携带）
  toolName?: string            // 工具名（审计事件字段化，回读按工具过滤）
  backendIdentity?: string     // 授权时连接指纹（grant 匹配绑定）
}
export interface Auditor { audit(event: AuditEvent): Promise<void>; close(): Promise<void> }

/** 日期解析格式固定（与 daily 文件名规范一致）：不匹配的文件永不删除 */
const AUDIT_DATE_RE = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export function auditFilesToDelete(files: readonly string[], retentionDays: number, today: Date): string[] {
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - retentionDays)
  return files.filter((name) => {
    const m = AUDIT_DATE_RE.exec(name)
    if (!m) return false
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return d < cutoff // 严格早于 today-retentionDays → 删
  })
}

/** append-only 审计：summary 净化在此层（file-writer 是 dumb append）；启动清理 30 天前文件唯一归属此层 */
export function createAuditor(writer: FileWriter, opts: {
  sanitize: MessageSanitizer
  retentionDays: number
  dir: string
  onCleanupError?: (err: unknown) => void // 装配注入：清理失败记日志（spec §9「启动清理失败记录日志不阻塞」）
}): Auditor {
  void (async () => {
    try {
      const names = await readdir(opts.dir)
      const toDelete = auditFilesToDelete(names, opts.retentionDays, new Date())
      await Promise.all(toDelete.map((n) => unlink(join(opts.dir, n)).catch(() => {})))
    } catch (e: unknown) {
      opts.onCleanupError?.(e) // 记录日志（经装配 logger），不阻塞启动
    }
  })()
  return {
    async audit(event: AuditEvent): Promise<void> {
      const clean: AuditEvent = { ...event }
      if (event.summary !== undefined) clean.summary = redactSensitiveValues(opts.sanitize(event.summary))
      await writer.append(JSON.stringify(clean))
    },
    close: () => writer.close()
  }
}
