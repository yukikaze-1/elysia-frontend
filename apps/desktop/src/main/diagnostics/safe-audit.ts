// src/main/diagnostics/safe-audit.ts
import type { AuditEvent } from './audit'
/** fail-open（C1）：audit 回调（含注入实现同步抛错）失败不传播——调用方操作结果不受影响 */
export function safeAudit(audit: ((event: Omit<AuditEvent, 'ts'>) => void) | undefined, event: Omit<AuditEvent, 'ts'>): void {
  if (!audit) return
  try { audit(event) } catch { /* fail-open：审计失败不改变操作结果 */ }
}
