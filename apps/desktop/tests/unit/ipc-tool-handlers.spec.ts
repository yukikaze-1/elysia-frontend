// apps/desktop/tests/unit/ipc-tool-handlers.spec.ts
// 阶段 6 批次 B（Task 6）：tool 五通道 handler 装配单测（spec A-5/B-4）。
// 注册器参数注入收集器（registerHandler 签名 (channel, executor, arity)——测试不碰真实 ipcMain，
// 直接对收集到的 executor 调用验证转发到 tool-service；schema 校验断言直接 safeParse 共享 schema（M5）。
import { describe, expect, it, vi } from 'vitest'
import { registerToolHandlers } from '../../src/main/ipc/tool-handlers'
import { IpcChannels } from '@shared/contracts/ipc'
import { PermissionDecisionSchema, ToolCancelSchema, ToolPickSourceSchema, ToolConfirmUploadSchema, ToolListResponseSchema } from '@shared/schemas/ipc-response'

describe('tool-handlers 五通道（A-5/B-4）', () => {
  it('五通道注册：channel 名 + arity 全 1（M2：arity 断言——toolList 若回归 arity 0 必红）', async () => {
    const tools = { decide: vi.fn(), cancel: vi.fn(), listRecent: vi.fn().mockReturnValue([]), pickSource: vi.fn(), confirmUpload: vi.fn() }
    const registered: any[] = []
    const reg = (ch: string, ex: any, arity: number | undefined) => { registered.push({ ch, ex, arity }) }
    registerToolHandlers({ tools: tools as any, sanitize: (x: string) => x }, reg)
    expect(registered.map(r => r.ch)).toEqual([IpcChannels.toolDecide, IpcChannels.toolCancel, IpcChannels.toolList, IpcChannels.toolPickSource, IpcChannels.toolConfirmUpload])
    expect(registered.map(r => r.arity)).toEqual([1, 1, 1, 1, 1])   // invokeWithArgs 恒带 1 参（M2）
  })
  it('五通道逐一转发 tool-service（M2：逐通道参数映射断言）', async () => {
    const tools = { decide: vi.fn(), cancel: vi.fn(), listRecent: vi.fn().mockReturnValue([]), pickSource: vi.fn(), confirmUpload: vi.fn() }
    const registered: any[] = []
    const reg = (ch: string, ex: any, arity: number | undefined) => { registered.push({ ch, ex, arity }) }
    registerToolHandlers({ tools: tools as any, sanitize: (x: string) => x }, reg)
    const byChannel = new Map(registered.map(r => [r.ch, r.ex]))
    await byChannel.get(IpcChannels.toolDecide)!({ callId: 'call_1', decision: 'allow_once' })
    expect(tools.decide).toHaveBeenCalledWith('call_1', 'allow_once')
    await byChannel.get(IpcChannels.toolCancel)!({ callId: 'call_2' })
    expect(tools.cancel).toHaveBeenCalledWith('call_2')
    await byChannel.get(IpcChannels.toolList)!({})
    expect(tools.listRecent).toHaveBeenCalledWith(20)
    await byChannel.get(IpcChannels.toolPickSource)!({ callId: 'call_3', sourceId: 's1' })
    expect(tools.pickSource).toHaveBeenCalledWith('call_3', 's1')
    await byChannel.get(IpcChannels.toolConfirmUpload)!({ callId: 'call_4' })
    expect(tools.confirmUpload).toHaveBeenCalledWith('call_4')
  })
  it('非法 schema → 共享 schema 拒（M2：标题与断言一致——结构化错误由 createIpcHandler 通用层保证）', async () => {
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
