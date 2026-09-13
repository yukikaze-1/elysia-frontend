// tests/unit/real-backend-tools.spec.ts
// 阶段 6 批次 C（Task 5，D6C-11/BE-043）：RealBackend.getToolCallStatus（GET /api/tools/calls/{callId}）——
// 对齐 real-backend-model-services.spec 夹具形态（FakeWs + makeBackend 手动 connect + fetchImpl 注入）；
// 断连/非 2xx/解析失败 → null 降级（reconnect queryStatus 查询分支消费）。
import { describe, expect, it, vi } from 'vitest'
import { RealBackend } from '../../src/main/transport/real-backend'
import { DesktopCallStatusSchema, RepoCallStatusSchema } from '../../src/shared/schemas/ipc-response'
import { DesktopCallStatusSchema as RestDesktopCallStatusSchema } from '../../src/main/transport/protocol-v2/rest-schemas'

/** 假 socket：记录发送帧，可手动 push 后端帧（message handler 注册后即可 push） */
class FakeWs {
  private handlers: Record<string, (arg?: unknown, arg2?: unknown) => void> = {}
  send = vi.fn()
  close = vi.fn()
  readyState = 1
  on(ev: string, cb: (arg?: unknown, arg2?: unknown) => void): this { this.handlers[ev] = cb; return this }
  push(frame: unknown): void { this.handlers['message']?.(JSON.stringify(frame)) }
}

/** 建立已连接 backend（同步推握手帧使 connect resolve）；serverUrl/token 固定供 URL/Bearer 断言 */
async function mkBackend(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): Promise<RealBackend> {
  const ws = new FakeWs()
  const backend = new RealBackend({
    now: () => Date.now(),
    wsFactory: () => ws,
    fetchImpl: fetchImpl as typeof fetch,
    onProtocolWarning: vi.fn(), onError: vi.fn(), logger: { warn: vi.fn() },
  })
  const p = backend.connect({ serverUrl: 'http://localhost:8000', token: 'tok' })
  ws.push({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })
  ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' })
  await p
  return backend
}

describe('批次 C：getToolCallStatus', () => {
  it('GET 组装 + DesktopCallStatusSchema 解析（repo 9 值全分支，契约 F-2）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      callId: 'call_1', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop',
      paramHash: 'abc', status: 'expired', createdAt: '2026-08-20T00:00:00Z', expiresAt: '2026-08-21T00:00:00Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const b = await mkBackend(fetchImpl)
    const r = await b.getToolCallStatus('call_1')
    expect(r).toMatchObject({ callId: 'call_1', status: 'expired' })
    // vitest 的 expect.objectContaining 返回类型被 @vitest/expect 声明为 any；这里按“未知期望值”如实收成
    // unknown 再嵌进外层断言对象（匹配器运行时行为不变，仅阻断 any 扩散）。
    const authorizationMatcher: unknown = expect.objectContaining({ authorization: 'Bearer tok' })
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8000/api/tools/calls/call_1', expect.objectContaining({ headers: authorizationMatcher }))
  })
  it('schema strict：未知字段拒 / 缺必填拒 / succeeded/failed 合法', () => {
    const base = { callId: 'c', toolName: 't', toolVersion: '1', runtime: 'desktop', paramHash: 'h', status: 'succeeded', createdAt: 'x', expiresAt: 'y' }
    expect(DesktopCallStatusSchema.safeParse(base).success).toBe(true)
    expect(DesktopCallStatusSchema.safeParse({ ...base, status: 'pending' }).success).toBe(true)   // repo 9 值含 pending
    expect(DesktopCallStatusSchema.safeParse({ ...base, status: 'result' }).success).toBe(false)   // wire 六态不入 repo 枚举
    expect(DesktopCallStatusSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
    expect(DesktopCallStatusSchema.safeParse({ ...base, createdAt: undefined }).success).toBe(false)
  })
  it('非 2xx / 断连 / 解析失败 → null 降级', async () => {
    const b500 = await mkBackend(vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    expect(await b500.getToolCallStatus('call_1')).toBeNull()
    const bBad = await mkBackend(vi.fn().mockResolvedValue(new Response('{"status":"x"}', { status: 200, headers: { 'content-type': 'application/json' } })))
    expect(await bBad.getToolCallStatus('call_1')).toBeNull()
    // 断连（disconnect 后 status=disconnected）→ null 降级
    await bBad.disconnect()
    expect(await bBad.getToolCallStatus('call_1')).toBeNull()
  })
  it('双源镜像钉测（LOW-1/Task 5 review）：rest-schemas 副本与 ipc-response 副本键集合 + 9 值枚举一致', () => {
    // check:contract 只钉 rest-schemas 副本与 rest.py 的字段键/必填性，不比枚举值、不比 ipc-response 副本——
    // real-backend 解析用 ipc-response 副本，漂移会静默 null（fail-closed 无告警）——此钉测防双源漂移。
    // 注：zod v4 中 .shape 为属性（非方法）；status 字段为 ZodEnum，.options 为枚举值数组；
    // shared 副本类型标注为 z.ZodType（接口无 shape）——cast 取运行时形状。
    const sharedShape = (DesktopCallStatusSchema as unknown as { shape: Record<string, unknown> }).shape
    const restShape = (RestDesktopCallStatusSchema as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(restShape).sort()).toEqual(Object.keys(sharedShape).sort())
    // 9 值枚举逐值一致（rest-schemas 内联枚举 vs shared RepoCallStatusSchema）
    const restStatus = restShape.status as { options?: readonly string[] } | undefined
    const sharedStatus = sharedShape.status as { options?: readonly string[] } | undefined
    expect(restStatus?.options ?? []).toEqual(RepoCallStatusSchema.options)
    expect(sharedStatus?.options ?? []).toEqual(RepoCallStatusSchema.options)
  })
})
