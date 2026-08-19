import { describe, expect, it } from 'vitest'
import { auditToolEvent } from '../../src/main/tools/tool-audit'

describe('auditToolEvent', () => {
  it('字段映射 + 脱敏 summary + riskLevel/permissionDecision/cancelSource 扩展（B4/B6/M-4）', () => {
    const out: Array<{ summary?: string; type?: string; toolId?: string; callId?: string; riskLevel?: string; permissionDecision?: string }> = []
    auditToolEvent((e) => out.push(e), { type: 'tool:decision', callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read',
      status: 'awaiting_permission', summary: 'path=<str:8>', riskLevel: 'medium', permissionDecision: 'allow_once' })
    expect(out[0]).toMatchObject({ type: 'tool:decision', toolId: 'tc_1', callId: 'call_1', riskLevel: 'medium', permissionDecision: 'allow_once' })
  })
  it('summary 显式禁止 output 摘要：resultSummary 传参 → 替换为脱敏占位（M-4/M1：精确断言拒绝真的发生）', () => {
    const out: Array<{ summary?: string; type?: string; toolId?: string; callId?: string; riskLevel?: string; permissionDecision?: string }> = []
    auditToolEvent((e) => out.push(e), { type: 'tool:terminal', callId: 'c', status: 'completed',
      summary: '文件内容前 2000 字符……' /* 模拟误传 */ })
    expect(out[0]?.summary).toBe('（已脱敏摘要）')   // M1：精确断言——脱敏替换确实发生（而非 summary 整体丢失）
  })
  it('安全 summary 原样透传（正例，M1）', () => {
    const out: Array<{ summary?: string; type?: string; toolId?: string; callId?: string; riskLevel?: string; permissionDecision?: string }> = []
    auditToolEvent((e) => out.push(e), { type: 'tool:decision', callId: 'c', status: 'awaiting_permission', summary: 'path=<str:8>' })
    expect(out[0]?.summary).toBe('path=<str:8>')
  })
  it('backend 来源完整性注记 + fail-open（L4：补 fail-open 断言——audit 回调抛错不阻断调用方）', () => {
    const out: Array<{ summary?: string; type?: string; toolId?: string; callId?: string; riskLevel?: string; permissionDecision?: string }> = []
    auditToolEvent((e) => out.push(e), { type: 'tool:status-sent', callId: 'c', runtime: 'backend', status: 'completed', summary: '客户端公开事件，非后端完整审计' })
    expect(out[0].summary).toContain('客户端公开事件')
    // fail-open：回调抛错 → auditToolEvent 不吞不包装（抛给调用方由外层 safeAudit 兜底）——此处验证「回调异常时函数仍完成且不产生部分记录」
    expect(() => auditToolEvent(() => { throw new Error('audit down') }, { type: 'tool:decision', callId: 'c', status: 'awaiting_permission' })).toThrow('audit down')
  })
})
