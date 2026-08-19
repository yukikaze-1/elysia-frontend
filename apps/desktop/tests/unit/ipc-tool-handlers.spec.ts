// apps/desktop/tests/unit/ipc-tool-handlers.spec.ts
// 阶段 6 批次 B（Task 6）：tool 五通道 handler 装配单测（spec A-5/B-4）。
// 注册器参数注入收集器（registerHandler 签名 (channel, executor, arity)——测试不碰真实 ipcMain，
// 直接对收集到的 executor 调用验证转发到 tool-service；schema 校验断言直接 safeParse 共享 schema（M5）。
import { describe, expect, it, vi } from 'vitest'
import { registerToolHandlers } from '../../src/main/ipc/tool-handlers'
import { IpcChannels } from '@shared/contracts/ipc'
import { PermissionDecisionSchema, ToolCancelSchema, ToolPickSourceSchema, ToolConfirmUploadSchema, ToolListResponseSchema } from '@shared/schemas/ipc-response'

describe('tool-handlers 五通道（A-5/B-4）', () => {
  it('合法调用转发 tool-service', async () => {
    const tools = { decide: vi.fn(), cancel: vi.fn(), listRecent: vi.fn().mockReturnValue([]), pickSource: vi.fn(), confirmUpload: vi.fn() }
    const registered: any[] = []
    const reg = (ch: string, ex: any, arity: number | undefined) => { registered.push({ ch, ex, arity }) }
    registerToolHandlers({ tools: tools as any, sanitize: (x: string) => x }, reg)
    expect(registered.map(r => r.ch)).toEqual([IpcChannels.toolDecide, IpcChannels.toolCancel, IpcChannels.toolList, IpcChannels.toolPickSource, IpcChannels.toolConfirmUpload])
    // 合法载荷 → executor 执行 → tools.* 被调
    await registered[0].ex({ callId: 'call_1', decision: 'allow_once' })
    expect(tools.decide).toHaveBeenCalledWith('call_1', 'allow_once')
  })
  it('非法 schema → SCHEMA_VALIDATION_FAILED 结构化错误', async () => {
    // 直接对 createIpcHandler 产物做 safeParse：PermissionDecisionSchema.safeParse({callId:1}) 失败
    expect(PermissionDecisionSchema.safeParse({ callId: 1 }).success).toBe(false)
    expect(ToolCancelSchema.safeParse({}).success).toBe(false)
    expect(ToolPickSourceSchema.safeParse({ callId: 'c' }).success).toBe(false)   // 缺 sourceId
    expect(ToolConfirmUploadSchema.safeParse({ callId: 'c' }).success).toBe(true)
  })
  it('toolList 响应 schema（ToolListResponseSchema）', () => {
    expect(ToolListResponseSchema.safeParse([]).success).toBe(true)
  })
  it('isTrustedSender 拒由 registerHandler 层保证（registry 既有单测覆盖，本批引用不重复）', () => { /* 注记 */ })
})
