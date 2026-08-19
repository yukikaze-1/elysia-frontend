import { describe, expect, it } from 'vitest'
import { auditToolEvent } from '../../src/main/tools/tool-audit'

describe('auditToolEvent', () => {
  it('字段映射 + 脱敏 summary + riskLevel/permissionDecision/cancelSource 扩展（B4/B6/M-4）', () => {
    const out: any[] = []
    auditToolEvent((e) => out.push(e), { type: 'tool:decision', callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read',
      status: 'awaiting_permission', summary: 'path=<str:8>', riskLevel: 'medium', permissionDecision: 'allow_once' })
    expect(out[0]).toMatchObject({ type: 'tool:decision', toolId: 'tc_1', callId: 'call_1', riskLevel: 'medium', permissionDecision: 'allow_once' })
  })
  it('summary 显式禁止 output 摘要：resultSummary 传参 → 不入 audit（M-4）', () => {
    const out: any[] = []
    auditToolEvent((e) => out.push(e), { type: 'tool:terminal', callId: 'c', status: 'completed',
      summary: '文件内容前 2000 字符……' /* 模拟误传 */ })
    // auditToolEvent 只允许 redactToolArguments 产物/固定元数据——本用例传文件内容 → 函数应拒绝（抛出或忽略该 summary）
    expect(out[0]?.summary).not.toContain('文件内容')
  })
  it('backend 来源完整性注记 + fail-open', () => {
    const out: any[] = []
    auditToolEvent((e) => out.push(e), { type: 'tool:status-sent', callId: 'c', runtime: 'backend', status: 'completed', summary: '客户端公开事件，非后端完整审计' })
    expect(out[0].summary).toContain('客户端公开事件')
  })
})
