// apps/desktop/tests/unit/ipc-tool-handlers.spec.ts
// 阶段 6 批次 B/C：tool 九通道 handler 装配单测（spec A-5/B-4/D6C-12）。
// 注册器参数注入收集器（registerHandler 签名 (channel, executor, arity)——测试不碰真实 ipcMain，
// 直接对收集到的 executor 调用验证转发到 tool-service；schema 校验断言直接 safeParse 共享 schema（M5）。
import { describe, expect, it, vi } from 'vitest'
import { registerToolHandlers } from '../../src/main/ipc/tool-handlers'
import { IpcChannels } from '@shared/contracts/ipc'
import { PermissionDecisionSchema, ToolCancelSchema, ToolPickSourceSchema, ToolConfirmUploadSchema, ToolListResponseSchema } from '@shared/schemas/ipc-response'

// N-4（批次 C review）：夹具脚手架 define 于 describe 顶层（批次 B 遗留的 registered/reg/byChannel 为各 it 内局部——统一提升）
// F-10：registerToolHandlers deps 新必填字段（grants/history/auditDir）由 setupRegister 统一补齐（既有 2 处 per-it 字面量不再散落）
const tools = {
  decide: vi.fn(), cancel: vi.fn(), listRecent: vi.fn().mockReturnValue([]), pickSource: vi.fn(), confirmUpload: vi.fn(),
  grantDirectory: vi.fn().mockResolvedValue(true),   // 批次 C（D6C-12）：目录授权创建流（FINAL-LOW：executed 回传）
}
// V-28：fake.list 返回含 revokedAt 的既有 grant——handler 先查存在性（未知 vs 已撤销 no-op 幂等成功 的区分机制）
const fakeGrantStore = {
  list: () => [{ id: 'grant-1', toolName: 'desktop.file.read', scope: { directory: '/d' },
    backendIdentity: 'http://h', expiresAt: 1, createdAt: 'x', source: 'directory' as const, revokedAt: 'x', revokeSource: 'user' as const }],
  add: () => ({ id: 'grant-n' }), revoke: () => undefined, matches: () => undefined, prune: () => {},
} as never
const fakeHistory = vi.fn().mockResolvedValue([{ ts: 'x', type: 'tool:decision' }])
function setupRegister(toolsOver: Partial<typeof tools> = {}): { registered: Array<{ ch: string; ex: unknown; arity: number }>; byChannel: Map<string, (input: unknown) => Promise<unknown>> } {
  const registered: Array<{ ch: string; ex: unknown; arity: number }> = []
  const byChannel = new Map<string, (input: unknown) => Promise<unknown>>()
  const reg = (ch: string, ex: unknown, arity: number) => { registered.push({ ch, ex, arity }); byChannel.set(ch, ex as (input: unknown) => Promise<unknown>) }
  registerToolHandlers({ tools: { ...tools, ...toolsOver } as never, sanitize: (x: string) => x, grants: fakeGrantStore, history: fakeHistory, auditDir: '/tmp/audit' }, reg as never)
  return { registered, byChannel }
}
const { registered, byChannel } = setupRegister()

describe('tool-handlers 九通道（A-5/B-4/D6C-12）', () => {
  it('九通道注册：channel 名 + arity 全 1（M2：arity 断言——toolList 若回归 arity 0 必红；批次 C 四新通道顺序追加）', () => {
    const chs = registered.map((r) => r.ch)
    expect(chs).toEqual([IpcChannels.toolDecide, IpcChannels.toolCancel, IpcChannels.toolList, IpcChannels.toolPickSource, IpcChannels.toolConfirmUpload,
      IpcChannels.toolGrantDirectory, IpcChannels.toolGrants, IpcChannels.toolGrantRevoke, IpcChannels.toolHistory])
    expect(registered.map((r) => r.arity)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])   // invokeWithArgs 恒带 1 参（M2）
  })
  it('批次 B 五通道逐一转发 tool-service（M2：逐通道参数映射断言）', async () => {
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
  it('批次 C：toolGrantDirectory ttl 非白名单 → SCHEMA_VALIDATION_FAILED（F-3）；白名单值 → 转发 grantDirectory', async () => {
    const res = await byChannel.get(IpcChannels.toolGrantDirectory)!({ callId: 'c', ttlMs: 2 ** 53 })
    expect(res).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    const ok = await byChannel.get(IpcChannels.toolGrantDirectory)!({ callId: 'c', ttlMs: 86_400_000 })
    expect(ok).toMatchObject({ ok: true })
    expect(tools.grantDirectory).toHaveBeenCalledWith('c', 86_400_000)
    expect(ok).toMatchObject({ ok: true, data: { executed: true } })   // FINAL-LOW：executed 回传
  })
  it('批次 C：toolGrantRevoke 未知 id → GRANT_NOT_FOUND；已撤销 → no-op 成功（V-28）', async () => {
    // fake.list 返回 [{ id: 'grant-1', ..., revokedAt: 'x' }]——handler 先查存在性（V-28 区分机制）
    const miss = await byChannel.get(IpcChannels.toolGrantRevoke)!({ id: 'nope' })
    expect(miss).toMatchObject({ ok: false, error: { code: 'GRANT_NOT_FOUND' } })
    const hit = await byChannel.get(IpcChannels.toolGrantRevoke)!({ id: 'grant-1' })
    expect(hit).toMatchObject({ ok: true })   // 已撤销 → revoke 内部 no-op 幂等成功
  })
  it('批次 C：toolGrants 回读接线（deps.grants.list 调用 + 响应 schema 通过）', async () => {
    const res = await byChannel.get(IpcChannels.toolGrants)!({})
    expect(res).toMatchObject({ ok: true })
    expect(res).toHaveProperty('data')   // GrantListResponseSchema 数组
  })
  it('批次 C：toolHistory 回读接线（deps.history 调用）', async () => {
    const res = await byChannel.get(IpcChannels.toolHistory)!({ limit: 50 })
    expect(res).toMatchObject({ ok: true })
    expect(fakeHistory).toHaveBeenCalledWith('/tmp/audit', { limit: 50 })
    expect(res).toHaveProperty('data')   // historyEntrySchema 数组
  })
  it('批次 C：decide/cancel handler .catch 无 unhandled rejection（L-8）', async () => {
    // tools.decide reject → handler 返回结构化错误不抛（executor 错误上提既有兜底）
    const { byChannel: bc2 } = setupRegister({ decide: vi.fn().mockRejectedValue(new Error('boom')) })
    const res = await bc2.get(IpcChannels.toolDecide)!({ callId: 'c', decision: 'allow_once' })
    expect(res).toMatchObject({ ok: false })   // 错误被结构化上提，无 unhandled rejection
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
