import type { AuditEvent } from '../diagnostics/audit'

export interface ToolAuditInput {
  type: 'tool:request-received' | 'tool:decision' | 'tool:executing' | 'tool:status-sent' | 'tool:terminal'
  callId: string; sourceCallId?: string; toolName?: string; runtime?: 'desktop' | 'backend'
  status?: string; durationMs?: number; summary?: string
  riskLevel?: 'safe' | 'medium' | 'high'; permissionDecision?: 'allow_once' | 'deny' | 'allow_scoped'   // 批次 C：'allow_scoped'（目录授权命中）
  startedAt?: string; errorCode?: string; cancelSource?: 'user' | 'timeout' | 'backend'
  permissionGrantId?: string; backendIdentity?: string   // 批次 C（Task 3，F-3 完整性）：目录授权审计字段
}

/** 脱敏工具审计（D6B-18/M-4）：summary 只允许脱敏摘要或固定元数据；
 * 显式拒绝文件内容片段（resultSummary/outputSummary/error.message 不得入 summary） */
export function auditToolEvent(audit: (ev: AuditEvent) => void, input: ToolAuditInput): void {
  let summary: string | undefined = input.summary
  if (summary && !isSafeSummary(summary)) summary = '（已脱敏摘要）'
  audit({ ts: new Date().toISOString(), type: input.type, runtime: input.runtime, toolId: input.sourceCallId,
    callId: input.callId, status: input.status, durationMs: input.durationMs, summary,
    riskLevel: input.riskLevel, permissionDecision: input.permissionDecision, startedAt: input.startedAt,
    errorCode: input.errorCode, cancelSource: input.cancelSource,
    permissionGrantId: input.permissionGrantId, toolName: input.toolName, backendIdentity: input.backendIdentity })   // L1：去双跳 cast——ToolAuditInput 与扩展后 AuditEvent 逐字段兼容，直接赋值让编译器承担映射检查
}
function isSafeSummary(s: string): boolean {
  // 安全形态：redactToolArguments 产物（<redacted>/<str:N>/类型名/固定元数据）——无原始文件内容特征
  return !s.includes('文件内容') && !s.includes('前 2000 字符') && s.length <= 512
}
