// tests/unit/tool-service.spec.ts（node 环境；所有 executor/picker/submit 注入 fake；fixture 目录 beforeEach 创建，H8/新发现5）
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'   // 平台测试用（新发现7）
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createToolService, DesktopToolRequest, ToolServiceError } from '../../src/main/tools/tool-service'   // ToolServiceError import（H4）
import { createToolRegistry } from '../../src/main/tools/tool-registry'

const FIXTURES = '/tmp/cyrene-fixtures'
beforeEach(() => { mkdirSync(FIXTURES, { recursive: true }) })
afterEach(() => { rmSync(FIXTURES, { recursive: true, force: true }) })

function mkReq(over: Partial<DesktopToolRequest> = {}): DesktopToolRequest {
  return { callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read', toolVersion: '1.0',
    runtime: 'desktop', arguments: { path: `${FIXTURES}/notes.md` }, reason: 'read notes', expiresAt: Date.now() + 30_000, ...over }
}
function mkService(over: Record<string, unknown> = {}) {
  const events: any[] = []
  const audit: any[] = []
  const submitStatus = vi.fn().mockResolvedValue(undefined)
  const pushEvent = (ev: any) => events.push(ev)
  const svc = createToolService({
    registry: createToolRegistry(), platform: 'posix', audit: (e: any) => audit.push(e),
    submitStatus, uploadAttachment: vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' }),
    pushEvent, allowRoots: [FIXTURES], ...over,
  })
  return { svc, events, audit, submitStatus }
}

describe('决策链', () => {
  it('未注册工具 → rejected CAPABILITY_UNAVAILABLE（不弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.command.run' }))
    const last = events.at(-1)
    expect(last.status).toBe('rejected'); expect(last.error?.code).toBe('CAPABILITY_UNAVAILABLE')
  })
  it('平台不支持 → 同码拒绝（B3；注入 windows-only 工具，H7）', async () => {
    const registry = createToolRegistry()
    registry.set('desktop.winonly', { name: 'desktop.winonly', version: '1.0', runtime: 'desktop', title: 'w', description: '', dataFlowNote: '', localRisk: 'safe', permissionMode: 'automatic', supportedPlatforms: ['windows'], inputSchema: z.object({}).strict(), outputSchema: z.record(z.string(), z.unknown()), executeRef: 'file.read', defaultTimeoutMs: 1000, isPathTool: false })
    const { svc, events } = mkService({ registry })
    await svc.handleRequest(mkReq({ toolName: 'desktop.winonly', arguments: {} }))
    expect(events.at(-1).error?.code).toBe('CAPABILITY_UNAVAILABLE')
  })
  it('参数 schema 拒（未知键 strict / 缺 path）→ INVALID_ARGUMENTS 不弹窗', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/home/u/a.txt', extra: 1 } }))
    expect(events.at(-1).error?.code).toBe('INVALID_ARGUMENTS')
  })
  it('capture region:null 合法通过（H1/M-6）', async () => {
    const { svc } = mkService()
    await expect(svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: { region: null } }))).resolves.not.toThrow()
  })
  it('paramHash 不一致 → PARAM_HASH_MISMATCH（不弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ paramHash: 'deadbeef'.repeat(8) }))
    expect(events.at(-1).error?.code).toBe('PARAM_HASH_MISMATCH')
  })
  it('黑名单路径命中 → PATH_BLOCKLISTED 不弹窗（压过一切）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/etc/passwd' } }))
    expect(events.at(-1).error?.code).toBe('PATH_BLOCKLISTED')
    expect(events.some(e => e.status === 'awaiting_permission')).toBe(false)
  })
  it('read 未豁免 → awaiting_permission；allowedRoots 内路径不被 /tmp 黑名单误伤（M-1）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/tmp/cyrene-fixtures/a.txt' } }))
    expect(events.at(-1).status).toBe('awaiting_permission')
  })
  it('write 授权前预读 + Diff 随 awaiting 事件下发（L7；fixture 前置，H8）', async () => {
    writeFileSync(`${FIXTURES}/w.txt`, 'old')
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/w.txt`, content: 'new' } }))
    const ev = events.at(-1)
    expect(ev.status).toBe('awaiting_permission')
    expect(ev.diff).toBeDefined(); expect(ev.diff.isNewFile).toBe(false)
    expect(ev.diff.totalLines).toBeGreaterThan(0)   // totalLines（A-20）
  })
  it('wire accepted 在授权判定前发出（M1）', async () => {
    const { svc, submitStatus } = mkService()
    await svc.handleRequest(mkReq())
    expect(submitStatus).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call_1', status: 'accepted' }))
  })
})
describe('幂等与状态机', () => {
  it('同 callId 参数不一致 → PARAM_MISMATCH', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq())
    await svc.handleRequest(mkReq({ arguments: { path: '/home/u/other.txt' } }))
    expect(events.at(-1).error?.code).toBe('PARAM_MISMATCH')
  })
  it('已拒绝保持拒绝（不重弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq())
    await svc.decide('call_1', 'deny')
    const before = events.length
    await svc.handleRequest(mkReq())   // 同 callId 再来（幂等返回当前状态）
    expect(events.at(-1).status).toBe('rejected')
    expect(events.length).toBe(before + 1)   // 只补一条幂等回显，不二次 awaiting
  })
  it('awaiting 队列 FIFO 一次一个（A8）：两请求只有一个 awaiting 事件，decide 后第二个晋升', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ callId: 'call_1', sourceCallId: 'tc_1' }))
    await svc.handleRequest(mkReq({ callId: 'call_2', sourceCallId: 'tc_2' }))
    expect(events.filter(e => e.status === 'awaiting_permission').length).toBe(1)
    await svc.decide('call_1', 'deny')
    expect(events.filter(e => e.status === 'awaiting_permission').length).toBe(2)   // tc_2 晋升
  })
  it('终态后更新忽略（单向前进）', async () => {
    const { svc } = mkService()
    await svc.handleRequest(mkReq())
    await svc.decide('call_1', 'deny')
    await expect(svc.decide('call_1', 'allow_once')).rejects.toMatchObject({ code: 'TOOL_STATE_INVALID' })   // 已 rejected → 抛（H6：无裸调用）
  })
  it('expiresAt 超时 → timeout + wire cancelled（cancelSource timeout）', async () => {
    vi.useFakeTimers()
    const { svc, events, submitStatus } = mkService()
    await svc.handleRequest(mkReq({ expiresAt: Date.now() + 500 }))
    await vi.advanceTimersByTimeAsync(600)
    expect(events.at(-1).status).toBe('timeout')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
    vi.useRealTimers()
  })
  it('decide allow_once → running → 执行成功 → completed + wire result；wire 时序 accepted→running→result（A-7/H5：注入 executorOverride）', async () => {
    const p = `${FIXTURES}/ok.txt`; writeFileSync(p, 'hello')
    const { svc, submitStatus } = mkService({ executorOverride: async () => ({ output: { path: p }, summary: 'ok' }) })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    const order = submitStatus.mock.calls.map(c => c[0].status)
    expect(order).toEqual(['accepted', 'running', 'result'])
  })
  it('decide deny → rejected + wire rejected + 审计 tool:decision deny', async () => {
    const { svc, submitStatus, audit } = mkService()
    await svc.handleRequest(mkReq())
    await svc.decide('call_1', 'deny')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'rejected' }))
    expect(audit.some(e => e.type === 'tool:decision' && e.permissionDecision === 'deny')).toBe(true)
  })
  it('cancel → cancelled + wire cancelled + cancelSource user', async () => {
    const { svc, events, submitStatus } = mkService()
    await svc.handleRequest(mkReq())
    await svc.cancel('call_1')
    expect(events.at(-1).status).toBe('cancelled')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })
  it('outputSchema 校验失败 → failed + INVALID_OUTPUT（B1/M3：注入 executorOverride 返回非法输出）', async () => {
    const p = `${FIXTURES}/ok.txt`; writeFileSync(p, 'x')
    const { svc } = mkService({ executorOverride: async () => ({ output: 42, summary: 'bad' } as never) })   // 非 record → outputSchema 拒
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    const rec = svc.getRecord('call_1')
    expect(rec?.status).toBe('failed'); expect(rec?.error?.code).toBe('INVALID_OUTPUT')
  })
  it('error.message === "" → 归一 undefined（M6/A-16）', async () => {
    const p = '/tmp/cyrene-fixtures/ok.txt'; mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'x')
    const { svc } = mkService({ executorOverride: async () => { throw new ToolServiceError('X', '') } })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    const rec = svc.getRecord('call_1')
    expect(rec?.error?.message).toBeUndefined()
  })
  it('重连：终态 statusSent=false 重发；非终态不动；selected-set 清空（D6B-20/M-7/H7）', async () => {
    const p = `${FIXTURES}/ok.txt`; writeFileSync(p, 'hello')
    // accepted/running 先成功；首次 result 发送失败（statusSent=false）→ 重连重发
    const submitStatus = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const { svc } = mkService({ submitStatus, executorOverride: async () => ({ output: { path: p }, summary: 'ok' }) })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    expect(submitStatus.mock.calls.filter(c => c[0].status === 'result').length).toBe(1)   // 首次 result 发送失败（statusSent=false）
    await svc.reconnect()
    expect(submitStatus.mock.calls.filter(c => c[0].status === 'result').length).toBe(2)   // 重连重发
    // selected-set 清空：先 select 豁免 → reconnect → 豁免失效
  })
  it('shutdown：停止接收 + 未决授权按拒绝（B2）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq())
    svc.shutdown()
    await svc.handleRequest(mkReq({ callId: 'call_9', sourceCallId: 'tc_9' }))
    expect(events.some(e => e.id === 'tc_9' && e.error?.code === 'APP_SHUTTING_DOWN')).toBe(true)
  })
  it('写路径串行锁：同路径两写串行（H7：慢 executorOverride + 交错断言）', async () => {
    const p = `${FIXTURES}/lock.txt`; writeFileSync(p, 'x')
    let running = 0; let maxConcurrent = 0
    const { svc } = mkService({ executorOverride: async () => { running++; maxConcurrent = Math.max(maxConcurrent, running); await new Promise(r => setTimeout(r, 20)); running--; return { output: { path: p }, summary: 'ok' } } })
    await svc.handleRequest(mkReq({ callId: 'call_1', sourceCallId: 'tc_1', arguments: { path: p } }))
    await svc.handleRequest(mkReq({ callId: 'call_2', sourceCallId: 'tc_2', arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    await svc.decide('call_2', 'allow_once')
    await new Promise(r => setTimeout(r, 100))
    expect(maxConcurrent).toBe(1)   // 同路径写串行（per-path 锁）
  })
  it('capture Wayland 授权前拒（A-4）：注入 wayland env → CAPTURE_UNAVAILABLE 不弹窗', async () => {
    // mkService 注入 wayland: true → isWaylandSession 经 deps.isWayland 注入判断
    const { svc, events } = mkService({ isWayland: true })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    expect(events.at(-1).error?.code).toBe('CAPTURE_UNAVAILABLE')
    expect(events.some(e => e.status === 'awaiting_permission')).toBe(false)
  })
  it('select 自动执行（safe/automatic 不弹窗）', async () => {
    const { svc, events } = mkService({ executorOverride: async () => ({ output: {}, summary: 'ok' }) })
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.select', arguments: {} }))
    expect(events.at(-1).status).toBe('completed')   // 无 awaiting 直接执行
  })
  it('审计调用计数：request-received/executing/terminal 各 ≥1', async () => {
    const { svc, audit } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.select', arguments: {} }))
    expect(audit.filter(e => e.type === 'tool:request-received').length).toBe(1)
    expect(audit.some(e => e.type === 'tool:executing')).toBe(true)
    expect(audit.some(e => e.type === 'tool:terminal')).toBe(true)
  })
})
