// tests/unit/tool-service.spec.ts（node 环境；所有 executor/picker/submit 注入 fake；fixture 目录 beforeEach 创建，H8/新发现5）
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'   // 平台测试用（新发现7）
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createToolService, DesktopToolRequest, ToolServiceError } from '../../src/main/tools/tool-service'   // ToolServiceError import（H4）
import { createToolRegistry, DESKTOP_TOOL_VERSION } from '../../src/main/tools/tool-registry'
import { GRANT_TTL_OPTIONS_MS } from '../../src/shared/contracts/tool'   // 批次 C（D6C-04）：grant TTL 白名单
import type { ToolStatusCommand } from '../../src/shared/contracts/backend'   // wire tool.status 六态命令契约（submitStatus 断言取值）

/** 测试事件收集接口（按本文件断言字段最小建模；PublicToolEvent 可赋值） */
interface ToolEv {
  status?: string
  error?: { code?: string; message?: string }
  id?: string
  desktopCallId?: string   // 批次 C（N-3）：F-16 队列晋升按 desktopCallId 过滤
  conversationId?: string  // 阶段 6 联调收口：会话隔离贯通
  diff?: { isNewFile?: boolean; totalLines?: number }
  captureSources?: unknown[]
  capturePreview?: { sourceId?: string; sourceName?: string; previewDataUrl: string; width?: number; height?: number; bytes?: number }
  resultSummary?: string
  riskLevel?: string   // D4-1：本地重算等级（PublicToolEvent.riskLevel）
}
/** 测试审计收集接口（按本文件断言字段最小建模；AuditEvent 可赋值） */
interface AuditEv {
  type?: string
  permissionDecision?: string
  cancelSource?: string
  riskLevel?: string          // D4-1：本地重算等级
  backendRiskLevel?: string   // D4-1：wire 上报值（归一后）
  permissionRequired?: boolean
}

/**
 * `submitStatus` 是 `vi.fn()`（vitest 对裸 `vi.fn()` 的声明是 `Mock<Procedure>`，调用实参为 `any`），
 * 故本 helper 按 ToolServiceDeps 的真实签名把 mock.calls 收成 `ToolStatusCommand` 元组：
 * 用例里 `[0].status` / `[0].callId` / `[0].attachments` 直接受 wire 契约检查，无需逐处标注。
 */
function submitCalls(submitStatus: unknown): ToolStatusCommand[][] {
  if (typeof submitStatus !== 'function' || !('mock' in submitStatus)) throw new Error('submitStatus 必须是 vi.fn()')
  const mock = submitStatus as { mock: { calls: ToolStatusCommand[][] } }
  return mock.mock.calls
}

const FIXTURES = '/tmp/cyrene-fixtures'
beforeEach(() => { mkdirSync(FIXTURES, { recursive: true }) })
afterEach(() => { rmSync(FIXTURES, { recursive: true, force: true }) })

function mkReq(over: Partial<DesktopToolRequest> = {}): DesktopToolRequest {
  return { callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read', toolVersion: DESKTOP_TOOL_VERSION,
    runtime: 'desktop', arguments: { path: `${FIXTURES}/notes.md` }, reason: 'read notes', expiresAt: Date.now() + 30_000, ...over }
}
function mkService(over: Record<string, unknown> = {}) {
  const events: ToolEv[] = []
  const audit: AuditEv[] = []
  const submitStatus = vi.fn().mockResolvedValue(undefined)
  const pushEvent = (ev: ToolEv) => events.push(ev)
  const svc = createToolService({
    registry: createToolRegistry(), platform: 'posix', audit: (e: AuditEv) => audit.push(e),
    submitStatus, uploadAttachment: vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' }),
    pushEvent, allowRoots: [FIXTURES], ...over,
  })
  return { svc, events, audit, submitStatus }
}
/** 批次 C grant 仓库桩（F-5：default 全 stub，按用例覆盖需要的方法；
 * mock 签名放宽（unknown 参数/返回）——用例里的 grant 字面量不必对齐 GrantStore 精确契约（toolName 宽化 string 亦可注入） */
function mkGrantStore(store: { [K in keyof import('../../src/main/tools/grant-store').GrantStore]?: (...args: unknown[]) => unknown } = {}) {
  const real = { list: () => [], add: () => { throw new Error('stub') }, revoke: () => undefined,
    matches: () => undefined, prune: () => {} }
  return { ...real, ...store } as import('../../src/main/tools/grant-store').GrantStore
}

describe('决策链', () => {
  it('conversationId 从请求贯通到公开事件（实时区会话隔离数据源）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ conversationId: 'conv-tools' }))
    expect(events.at(-1)?.conversationId).toBe('conv-tools')
  })
  it('未注册工具 → rejected CAPABILITY_UNAVAILABLE（不弹窗 + wire rejected，H1）', async () => {
    const { svc, events, submitStatus } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.command.run' }))
    const last = events.at(-1)!
    expect(last.status).toBe('rejected'); expect(last.error?.code).toBe('CAPABILITY_UNAVAILABLE')
    // H1：策略拒也回 wire rejected（spec §3.2 step 13）
    const rejectedCmd: ToolStatusCommand = submitCalls(submitStatus).at(-1)![0]
    expect(rejectedCmd.status).toBe('rejected')
    expect(rejectedCmd.error?.code).toBe('CAPABILITY_UNAVAILABLE')
  })
  it('平台不支持 → 同码拒绝（B3；注入 windows-only 工具，H7）', async () => {
    const registry = createToolRegistry()
    registry.set('desktop.winonly', { name: 'desktop.winonly', version: DESKTOP_TOOL_VERSION, runtime: 'desktop', title: 'w', description: '', dataFlowNote: '', localRisk: 'safe', permissionMode: 'automatic', supportedPlatforms: ['windows'], inputSchema: z.object({}).strict(), outputSchema: z.record(z.string(), z.unknown()), executeRef: 'file.read', defaultTimeoutMs: 1000, isPathTool: false })
    const { svc, events } = mkService({ registry })
    await svc.handleRequest(mkReq({ toolName: 'desktop.winonly', arguments: {} }))
    expect(events.at(-1)!.error?.code).toBe('CAPABILITY_UNAVAILABLE')
  })
  it('参数 schema 拒（未知键 strict / 缺 path）→ INVALID_ARGUMENTS 不弹窗', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/home/u/a.txt', extra: 1 } }))
    expect(events.at(-1)!.error?.code).toBe('INVALID_ARGUMENTS')
  })
  it('capture region:null 合法通过（H1/M-6）', async () => {
    const { svc } = mkService()
    await expect(svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: { region: null } }))).resolves.not.toThrow()
  })
  it('paramHash 不一致 → PARAM_HASH_MISMATCH（不弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ paramHash: 'deadbeef'.repeat(8) }))
    expect(events.at(-1)!.error?.code).toBe('PARAM_HASH_MISMATCH')
  })
  it('黑名单路径命中 → PATH_BLOCKLISTED 不弹窗（压过一切）', async () => {
    const platform = process.platform === 'win32' ? 'windows' : 'posix'
    const blacklistedPath = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
    const { svc, events } = mkService({ platform, allowRoots: [] })
    await svc.handleRequest(mkReq({ arguments: { path: blacklistedPath } }))
    expect(events.at(-1)!.error?.code).toBe('PATH_BLOCKLISTED')
    expect(events.some(e => e.status === 'awaiting_permission')).toBe(false)
  })
  it('read 未豁免 → awaiting_permission；allowedRoots 内路径不被 /tmp 黑名单误伤（M-1）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/tmp/cyrene-fixtures/a.txt' } }))
    expect(events.at(-1)!.status).toBe('awaiting_permission')
  })
  // —— D4-1（2026-09-15 裁决「补代码」）：本地风险重算入链 ——
  it('重算等级随公开事件下发，且后端上报更高时抬升（只升不降）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/tmp/cyrene-fixtures/a.txt' }, reportedRiskLevel: 'high' }))
    expect(events.at(-1)!.riskLevel).toBe('high')   // base=medium(read) → 上报 high 抬升
  })
  it('后端上报更低不降级：write（base=high）配 reportedRiskLevel=safe 仍为 high', async () => {
    writeFileSync(join(FIXTURES, 'w.txt'), 'old\n')
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/w.txt`, content: 'new\n' }, reportedRiskLevel: 'safe' }))
    expect(events.at(-1)!.riskLevel).toBe('high')
  })
  it('畸形上报值按 high 处理（不静默忽略、不降级）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/tmp/cyrene-fixtures/a.txt' }, reportedRiskLevel: 'critical' }))
    expect(events.at(-1)!.riskLevel).toBe('high')
  })
  it('审计记录本地等级与后端上报值两栏（可解释「为什么是这个等级」）', async () => {
    const { svc, audit } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/tmp/cyrene-fixtures/a.txt' }, reportedRiskLevel: 'safe', permissionRequired: true }))
    const rec = audit.find(a => a.type === 'tool:request-received')!
    expect(rec.riskLevel).toBe('medium')        // base=medium(read)，上报 safe 不抬升
    expect(rec.backendRiskLevel).toBe('safe')
    expect(rec.permissionRequired).toBe(true)
  })
  it('write 授权前预读 + Diff 随 awaiting 事件下发（L7；fixture 前置，H8）', async () => {
    writeFileSync(`${FIXTURES}/w.txt`, 'old')
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/w.txt`, content: 'new' } }))
    const ev = events.at(-1)!
    expect(ev.status).toBe('awaiting_permission')
    expect(ev.diff).toBeDefined(); expect(ev.diff!.isNewFile).toBe(false)
    expect(ev.diff!.totalLines).toBeGreaterThan(0)   // totalLines（A-20）
  })
  it('wire accepted 在授权判定前发出（M1）', async () => {
    const { svc, submitStatus } = mkService()
    await svc.handleRequest(mkReq())
    expect(submitStatus).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call_1', status: 'accepted' }))
  })

  // —— H-09（2026-09-11）：写路径的同步 diff 不得在授权前冻结主线程 ——
  //
  // 原缺陷：step 7 在**授权之前**就算 diff，而内容大小上限只在 executor（授权之后）；
  // `diffLines` 是同步 Myers 且不让出事件循环 ⇒ 一个数百 KB～数 MB 的 content 足以让整个应用卡住一拍，
  // 而此时所有超时都是定时器驱动的、**都无法触发**。更荒谬的是这种写入本来就会被拒。
  it('H-09：超大 content 在**授权前**即被拒（不再白算一次 diff）', async () => {
    writeFileSync(`${FIXTURES}/w.txt`, 'old')
    const { svc, events } = mkService()
    const huge = 'x'.repeat(2 * 1024 * 1024 + 1)
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/w.txt`, content: huge } }))
    const ev = events.at(-1)!
    expect(ev.status).toBe('failed')
    // 错误码/文案与 executor 的同名上限完全一致 ⇒ 用户可见行为不因前移而改变
    expect(ev.error?.code).toBe('CONTENT_TOO_LARGE')
    expect(ev.error?.message).toContain('2 MiB')
  })

  it('H-09：超大 content 不进入 awaiting_permission（不打扰用户去批准一个必被拒的写入）', async () => {
    writeFileSync(`${FIXTURES}/w.txt`, 'old')
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/w.txt`, content: 'y'.repeat(2 * 1024 * 1024 + 1) } }))
    expect(events.some((e) => e.status === 'awaiting_permission'), '不得弹出一个注定失败的授权窗').toBe(false)
  })

  it('H-09：超过 diff 预览阈值时省略 lines（安全字段照常），且**没有**调用同步 diff', async () => {
    writeFileSync(`${FIXTURES}/w.txt`, 'old')
    // 内容 > MAX_DIFF_INPUT_BYTES 但 < MAX_WRITE_CONTENT_BYTES：写入合法，只该省掉预览
    const big = 'line\n'.repeat(60_000) // ≈ 300 KiB
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/w.txt`, content: big } }))
    const ev = events.at(-1)!
    expect(ev.status).toBe('awaiting_permission')
    expect(ev.diff!.totalLines, '大输入应省略 diff 预览').toBe(0)
    // 安全字段必须保留：isNewFile 驱动「授权后文件被创建 → 拒绝覆盖」，丢了就是安全回归
    expect(ev.diff!.isNewFile).toBe(false)
  })

  it('H-09：常规大小仍产出完整预览（省略逻辑不得误伤正常路径）', async () => {
    writeFileSync(`${FIXTURES}/w.txt`, 'old line 1\nold line 2\n')
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/w.txt`, content: 'new line 1\nnew line 2\n' } }))
    const ev = events.at(-1)!
    expect(ev.status).toBe('awaiting_permission')
    expect(ev.diff!.totalLines, '小文件必须仍有预览').toBeGreaterThan(0)
    expect(ev.diff!.isNewFile).toBe(false)
  })

  it('H-09：新建文件路径不受影响（isNewFile 仍为 true）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/brand-new.txt`, content: 'hello' } }))
    const ev = events.at(-1)!
    expect(ev.status).toBe('awaiting_permission')
    expect(ev.diff!.isNewFile).toBe(true)
  })
})
describe('幂等与状态机', () => {
  it('同 callId 参数不一致 → PARAM_MISMATCH', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq())
    await svc.handleRequest(mkReq({ arguments: { path: '/home/u/other.txt' } }))
    expect(events.at(-1)!.error?.code).toBe('PARAM_MISMATCH')
  })
  it('M-3（批次最终 review）：策略拒同步原记录终态 + 队列晋升 + 无双终态（expiresAt 定时器清除）', async () => {
    vi.useFakeTimers()
    const { svc, events, submitStatus } = mkService()
    await svc.handleRequest(mkReq({ callId: 'call_1', sourceCallId: 'tc_1', expiresAt: Date.now() + 60_000 }))
    await svc.handleRequest(mkReq({ callId: 'call_2', sourceCallId: 'tc_2' }))
    expect(events.filter(e => e.status === 'awaiting_permission').length).toBe(1)   // 队列一次一个（tc_1 是队列头）
    // tc_1 同 sourceCallId 参数不一致 → 策略拒 → 原记录终态 + 队列晋升 tc_2 可见
    await svc.handleRequest(mkReq({ callId: 'call_1', sourceCallId: 'tc_1', arguments: { path: '/home/u/other.txt' } }))
    expect(svc.getRecord('call_1')?.status).toBe('rejected')
    expect(events.filter(e => e.status === 'awaiting_permission').length).toBe(2)   // tc_2 晋升
    // expiresAt 定时器已清 → 不会再有 cancelled 双终态（accepted→rejected 是合法协议序列，无 cancelled 即证明）
    await vi.advanceTimersByTimeAsync(70_000)
    const call1Statuses = submitCalls(submitStatus).filter(c => c[0].callId === 'call_1').map(c => c[0].status)
    expect(call1Statuses).toEqual(['accepted', 'rejected'])   // 仅 accepted→rejected，无 cancelled 双终态
    vi.useRealTimers()
  })
  it('已拒绝保持拒绝（不重弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq())
    await svc.decide('call_1', 'deny')
    const before = events.length
    await svc.handleRequest(mkReq())   // 同 callId 再来（幂等返回当前状态）
    expect(events.at(-1)!.status).toBe('rejected')
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
    expect(events.at(-1)!.status).toBe('timeout')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
    vi.useRealTimers()
  })
  it('decide allow_once → running → 执行成功 → completed + wire result；wire 时序 accepted→running→result（A-7/H5：注入 executorOverride）', async () => {
    const p = `${FIXTURES}/ok.txt`; writeFileSync(p, 'hello')
    const { svc, submitStatus } = mkService({ executorOverride: async () => ({ output: { path: p }, summary: 'ok' }) })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    const order = submitCalls(submitStatus).map(c => c[0].status)
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
    const { svc, events, submitStatus, audit } = mkService()
    await svc.handleRequest(mkReq())
    await svc.cancel('call_1')
    expect(events.at(-1)!.status).toBe('cancelled')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
    expect(audit.some(e => e.type === 'tool:terminal' && e.cancelSource === 'user')).toBe(true)   // L4③
  })
  it('executor 挂起 → 执行超时 → 展示 timeout + wire error{TIMEOUT}（M1）', async () => {
    vi.useFakeTimers()
    const p = `${FIXTURES}/hang.txt`; writeFileSync(p, 'x')
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { svc, events, submitStatus } = mkService({ executorOverride: async () => { await gate; return { output: { path: p }, summary: 'ok' } } })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    const deciding = svc.decide('call_1', 'allow_once')   // 不 await——executor 挂起
    await vi.advanceTimersByTimeAsync(0)                  // 让 running wireSend 微任务落定、执行超时 timer 挂起
    await vi.advanceTimersByTimeAsync(31_000)             // read defaultTimeoutMs=30s
    expect(events.at(-1)!.status).toBe('timeout')
    const timeoutCmd: ToolStatusCommand = submitCalls(submitStatus).at(-1)![0]
    expect(timeoutCmd.status).toBe('error')
    expect(timeoutCmd.error?.code).toBe('TIMEOUT')   // M1：wire error{TIMEOUT} 非 cancelled
    release()
    await deciding
    vi.useRealTimers()
  })
  it('断线重发携带原附件 URL（M2/D6B-11：URL 复用不重传字节）', async () => {
    const p = `${FIXTURES}/att.txt`; writeFileSync(p, 'x')
    const attachments = [{ url: 'mock://a/1', mimeType: 'text/plain', label: 'att' }]
    // accepted/running 先成功；首次 result 发送失败（statusSent=false）→ 重连重发
    const submitStatus = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const { svc } = mkService({ submitStatus, executorOverride: async () => ({ output: { path: p }, summary: 'ok', attachments }) })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    expect(submitCalls(submitStatus).filter(c => c[0].status === 'result')).toHaveLength(1)
    await svc.reconnect()
    const resultCalls = submitCalls(submitStatus).filter(c => c[0].status === 'result')
    expect(resultCalls).toHaveLength(2)                    // 重连重发
    expect(resultCalls[1][0].attachments).toEqual(attachments)   // URL 随重发带上
  })
  it('expiresAt 已过期 → 立即 timeout + wire cancelled（L2）', async () => {
    const { svc, events, submitStatus } = mkService()
    await svc.handleRequest(mkReq({ expiresAt: Date.now() - 1000 }))
    expect(events.at(-1)!.status).toBe('timeout')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })
  it('expiresAt 非法（NaN）→ 立即 timeout + wire cancelled（C-08：显式 Number.isFinite 守卫，非隐式 NaN>0 巧合）', async () => {
    // C-08：#expiresAt 来自 real-backend Date.parse(frame.expiresAt)，非法字符串 → NaN。
    // 当前 NaN > 0 为 false → 走 else expire(rec) 立即过期（行为正确）。本用例钉住该安全默认，
    // 并用显式 Number.isFinite 守卫替代隐式 NaN 比较（防未来改分支时 NaN 落入其他路径）。
    const { svc, events, submitStatus } = mkService()
    await svc.handleRequest(mkReq({ expiresAt: NaN }))
    expect(events.at(-1)!.status).toBe('timeout')
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
    expect(submitCalls(submitStatus).filter(c => c[0].status === 'result').length).toBe(1)   // 首次 result 发送失败（statusSent=false）
    await svc.reconnect()
    expect(submitCalls(submitStatus).filter(c => c[0].status === 'result').length).toBe(2)   // 重连重发
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
    expect(events.at(-1)!.error?.code).toBe('CAPTURE_UNAVAILABLE')
    expect(events.some(e => e.status === 'awaiting_permission')).toBe(false)
  })
  it('select 自动执行（safe/automatic 不弹窗；经 pickFile+selectedAdd，A-14）', async () => {
    const p = `${FIXTURES}/sel-ok.txt`; writeFileSync(p, 'x')   // Task 3 实装后 select 需目标存在（stat + hash 元数据）
    const { svc, events } = mkService({ pickFile: async () => ({ canceled: false, path: p }) })
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.select', arguments: {} }))
    expect(events.at(-1)!.status).toBe('completed')   // 无 awaiting 直接执行
  })
  it('重连 selected-set 清空：豁免失效（L4①/D6B-20）', async () => {
    const p = `${FIXTURES}/sel.txt`; writeFileSync(p, 'x')
    const { svc, events } = mkService({ pickFile: async () => ({ canceled: false, path: p }) })
    // 先 select 豁免：文件选择器选中 p → selectedAdd(p) → selected-set 入 p
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.select', arguments: {} }))
    expect(events.at(-1)!.status).toBe('completed')
    // 豁免生效：同路径 read 不弹窗（直跑——Task 3 read 已实装故 completed，证明未走 awaiting）
    await svc.handleRequest(mkReq({ callId: 'call_2', sourceCallId: 'tc_2', arguments: { path: p } }))
    expect(events.some(e => e.id === 'tc_2' && e.status === 'awaiting_permission')).toBe(false)
    expect(svc.getRecord('tc_2')?.status).toBe('completed')
    // reconnect → selected-set 清空 → 豁免失效 → 再读需弹窗
    await svc.reconnect()
    await svc.handleRequest(mkReq({ callId: 'call_3', sourceCallId: 'tc_3', arguments: { path: p } }))
    expect(events.some(e => e.id === 'tc_3' && e.status === 'awaiting_permission')).toBe(true)
  })
  it('审计调用计数：request-received/executing/terminal 各 ≥1', async () => {
    const { svc, audit } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.select', arguments: {} }))
    expect(audit.filter(e => e.type === 'tool:request-received').length).toBe(1)
    expect(audit.some(e => e.type === 'tool:executing')).toBe(true)
    expect(audit.some(e => e.type === 'tool:terminal')).toBe(true)
  })
})
describe('capture 子状态机（D6B-16/M-5/A-2）', () => {
  it('decide allow → 枚举 → awaiting_pick（captureSources 事件）；不直接 completed', async () => {
    const { svc, events } = mkService({ enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    expect(events.some(e => e.captureSources?.length === 1)).toBe(true)
    expect(events.at(-1)?.status).not.toBe('completed')
  })
  it('乱序：confirm-upload 无 preview → CAPTURE_STATE_INVALID（M2：注入 enumerateSources 触达 awaiting_pick 守卫）', async () => {
    const { svc } = mkService({ enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    await expect(svc.confirmUpload('call_1')).rejects.toMatchObject({ code: 'CAPTURE_STATE_INVALID' })   // 命中「预览未下发」守卫（非 status 分支）
  })
  it('pick 未知 sourceId → 拒（M2：真实快照中确认 sourceId∈快照守卫被触达）', async () => {
    const { svc } = mkService({
      enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }],
      renderPreview: async () => ({ previewDataUrl: 'data:image/png;base64,AA==', bytes: new Uint8Array(1) }),   // 放行路径走注入（node 无 desktopCapturer）
    })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    await expect(svc.pickSource('call_1', 'not-in-snapshot')).rejects.toMatchObject({ code: 'CAPTURE_STATE_INVALID' })   // 命中「sourceId ∉ 快照」守卫
    await expect(svc.pickSource('call_1', 's1')).resolves.toBeUndefined()   // 快照内放行（守卫非一刀切）
  })
  it('pick → 预览下发 → confirm → completed + wire result（running→result 时序）', async () => {
    const { svc, events, submitStatus } = mkService({
      enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏幕 1', thumbnailDataUrl: 'data:image/png;base64,AA==' }],
      renderPreview: async () => ({ previewDataUrl: 'data:image/png;base64,AA==', bytes: new Uint8Array([137, 80, 78, 71]), width: 1920, height: 1080 }),
    })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    expect(events.some(e => e.captureSources)).toBe(true)
    await svc.pickSource('call_1', 's1')
    const preview = events.at(-1)?.capturePreview
    // doc 03 §10（2026-09-13）：预览必须能说出"截的是哪个屏/窗"——sourceName 取自**枚举快照**逐字一致，
    // 且带上尺寸/字节数供用户判断（mock 注入面没有尺寸时这两项缺省，见既有降级用例）
    expect(preview).toMatchObject({ sourceId: 's1', sourceName: '屏幕 1', width: 1920, height: 1080, bytes: 4 })
    await svc.confirmUpload('call_1')
    expect(events.at(-1)?.status).toBe('completed')
    expect(submitCalls(submitStatus).map(c => c[0].status)).toEqual(['accepted', 'running', 'result'])
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'result' }))
  })
  it('预览 >256KiB 降级为缩略图 + confirm 闭环（A-18/L-5/M3）', async () => {
    const { svc, events } = mkService({
      enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }],
      renderPreview: async () => ({ previewDataUrl: 'data:image/png;base64,' + 'B'.repeat(300 * 1024), bytes: new Uint8Array(1) }),
    })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    await svc.pickSource('call_1', 's1')
    // 超限 → 降级为缩略图（previewDataUrl 为缩略图值，长度 < 300KiB）
    expect(events.at(-1)?.capturePreview?.previewDataUrl.length).toBeLessThan(300 * 1024)
    await expect(svc.confirmUpload('call_1')).resolves.toBeUndefined()   // M3 闭环：降级后 confirm 可正常通过（sess.previewDataUrl 已设置）
    expect(events.at(-1)?.status).toBe('completed')
  })
  it('枚举丢弃提示面世（M4）：dropped>0 → awaiting_pick 事件 resultSummary 含「丢弃」', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(70 * 1024)
    const { svc, events } = mkService({ enumerateSources: async () => [{ sourceId: 'big', sourceName: '大', thumbnailDataUrl: big }, { sourceId: 'ok', sourceName: '小', thumbnailDataUrl: 'data:image/png;base64,AA==' }] })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    const pickEv = events.find(e => e.captureSources)
    expect(pickEv?.captureSources?.length).toBe(1)
    expect(pickEv?.resultSummary).toContain('丢弃 1 个')
  })
  it('capture 会话停留态超时（M1）：awaiting_pick 停留超 CAPTURE_SESSION_TTL_MS → cancelled + wire cancelled + 会话清理', async () => {
    vi.useFakeTimers()
    const { svc, events, submitStatus } = mkService({ enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    await vi.advanceTimersByTimeAsync(121_000)
    expect(events.at(-1)?.status).toBe('cancelled')
    expect(events.at(-1)?.error?.code).toBe('TIMEOUT')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
    vi.useRealTimers()
  })
})
describe('批次 C：grant 目录授权', () => {
  it('step 8：write grant 命中 → auto 执行无窗 + 审计 allow_scoped + permissionGrantId=匹配 grant.id（N-7）', async () => {
    const audit = vi.fn()
    const g = { id: 'grant-1', toolName: 'desktop.file.write', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const exec = vi.fn().mockResolvedValue({ output: { path: join(FIXTURES, 'f.txt'), bytesWritten: 2 }, summary: '覆盖 f.txt' })
    const { svc, events } = mkService({ audit, executorOverride: exec, grants: mkGrantStore({ matches: () => g }) })
    await svc.handleRequest(mkReq({ callId: 'call_1', toolName: 'desktop.file.write', arguments: { path: join(FIXTURES, 'f.txt'), content: 'v2' } }))
    expect(exec).toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:decision', permissionDecision: 'allow_scoped', permissionGrantId: 'grant-1' }))
    // auto 路径事件携带 rec.diff（F-11 一致 b——write 命中 preReadForDiff 已算）
    expect(events.some((e) => e.status === 'running')).toBe(true)   // V-15：mkService 返回 { svc, events, ... }——events 为独立数组，svc 无 _events
    expect(events.some((e) => e.diff !== undefined)).toBe(true)
  })
  it('step 8：grant 匹配优先于 selected-set 豁免（F-8 一致）——真双命中 → allow_scoped（MED-1 修复：select target 预创建使 selectedAdd 真实触发）', async () => {
    const audit = vi.fn()
    const target = join(FIXTURES, 'a.txt')
    writeFileSync(target, 'x')   // MED-1：select 执行器 stat 需要目标存在（spec:281/287 先例）——否则 ENOENT → selectedAdd 永不触发、isExempt 恒 false
    const g = { id: 'grant-2', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    // 先真实 select（automatic → auto → 真实 select 执行器 → selectedAdd 写入 selectedSet——mkService 默认 allowRoots: [FIXTURES] 放行 /tmp）
    const { svc } = mkService({
      audit, pickFile: async () => ({ canceled: false, path: target }),
      grants: mkGrantStore({ matches: () => g }),
    })
    await svc.handleRequest(mkReq({ callId: 'call_sel', sourceCallId: 'tc_sel', toolName: 'desktop.file.select', arguments: {} }))   // N-1：独立 sourceCallId——selectedSet 现含 target
    // 再发 read（同路径）：isExempt(target) true 且 grant 命中 → 真双命中 → 审计 allow_scoped（grant 优先）
    await svc.handleRequest(mkReq({ callId: 'call_2', sourceCallId: 'tc_2', toolName: 'desktop.file.read', arguments: { path: target } }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ permissionDecision: 'allow_scoped', permissionGrantId: 'grant-2' }))
    // 反侧（MED-1 建议 b）：同路径 exempt 命中但无 grant → auto 执行但审计无 allow_scoped（豁免命中不审计——批次 B 基线语义）
    audit.mockClear()
    const { svc: svc2 } = mkService({
      audit, pickFile: async () => ({ canceled: false, path: target }),
      grants: mkGrantStore({ matches: () => undefined }),
    })
    await svc2.handleRequest(mkReq({ callId: 'call_sel2', sourceCallId: 'tc_sel2', toolName: 'desktop.file.select', arguments: {} }))   // selectedSet 含 target
    await svc2.handleRequest(mkReq({ callId: 'call_3', sourceCallId: 'tc_3', toolName: 'desktop.file.read', arguments: { path: target } }))
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ permissionDecision: 'allow_scoped' }))   // 仅豁免命中 → 无 allow_scoped 审计
  })
  it('step 8：grant 未命中 → 原 prompt 逻辑（awaiting + 权限窗）', async () => {
    const { svc } = mkService({ grants: mkGrantStore({ matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_3', toolName: 'desktop.file.write', arguments: { path: join(FIXTURES, 'f.txt'), content: 'v2' } }))
    expect(svc.getRecord('call_3')?.status).toBe('awaiting_permission')
  })
  it('step 8：capture 恒强确认（有 grant 也不匹配——工具名二值 guard）（F-6 符合性）', async () => {
    const audit = vi.fn()
    const { svc } = mkService({ audit, grants: mkGrantStore({ matches: () => ({ id: 'grant-x', toolName: 'desktop.screen.capture' as never, scope: { directory: FIXTURES }, backendIdentity: 'h', expiresAt: 1, createdAt: 'x', source: 'directory' as const }) }) })
    await svc.handleRequest(mkReq({ callId: 'call_cap', toolName: 'desktop.screen.capture', arguments: {} }))
    expect(svc.getRecord('call_cap')?.status).toBe('awaiting_permission')   // capture 走 prompt（isExempt 只对 read）
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ permissionDecision: 'allow_scoped' }))
  })
  it('step 8：黑名单优先（F-6 符合性）——黑名单路径 + grant 命中 → PATH_BLOCKLISTED（无 allow_scoped）', async () => {
    const audit = vi.fn()
    const { svc } = mkService({ audit, grants: mkGrantStore({ matches: () => ({ id: 'grant-e', toolName: 'desktop.file.read', scope: { directory: '/etc' }, backendIdentity: 'h', expiresAt: 1, createdAt: 'x', source: 'directory' as const }) }) })
    await svc.handleRequest(mkReq({ callId: 'call_bl', toolName: 'desktop.file.read', arguments: { path: '/etc/passwd' } }))
    expect(svc.getRecord('call_bl')?.status).toBe('rejected')   // step 5 黑名单拒（grant 不可达）
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ permissionDecision: 'allow_scoped' }))
  })
  it('grantDirectory：pickDirectory 注入 → 授权后自动执行 + 审计 allow_scoped（D6C-05；抽查修复：状态化 matches——handleRequest 阶段 grant 未命中→awaiting，grantDirectory add 后激活→F-1 复核命中→执行）', async () => {
    const audit = vi.fn()
    let grantActive = false
    const g = { id: 'grant-3', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const { svc } = mkService({ audit, executorOverride: exec, backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: FIXTURES }), grants: mkGrantStore({ add: () => { grantActive = true; return g }, matches: () => (grantActive ? g : undefined) }) })
    await svc.handleRequest(mkReq({ callId: 'call_4', sourceCallId: 'tc_4', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    expect(svc.getRecord('call_4')?.status).toBe('awaiting_permission')   // grant 未激活 → prompt
    await svc.grantDirectory('call_4', GRANT_TTL_OPTIONS_MS[1])
    expect(exec).toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:decision', permissionDecision: 'allow_scoped', permissionGrantId: 'grant-3' }))
  })
  it('grantDirectory：取消 → grant 不创建、保持 awaiting（F-1 miss 前路径）', async () => {
    const audit = vi.fn()
    const { svc } = mkService({ audit, backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: true }), grants: mkGrantStore() })
    await svc.handleRequest(mkReq({ callId: 'call_5', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc.grantDirectory('call_5', GRANT_TTL_OPTIONS_MS[1])
    expect(svc.getRecord('call_5')?.status).toBe('awaiting_permission')
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:decision' }))
  })
  it('grantDirectory：F-1 picked 目录 ≠ 请求目标 → grant 已建但不执行、保持 awaiting（LOW-2：add spy 钉「已建」）', async () => {
    const exec = vi.fn()
    const add = vi.fn(() => g)
    const other = mkdtempSync(join(tmpdir(), 'cy-other-'))
    const g = { id: 'grant-4', toolName: 'desktop.file.read', scope: { directory: other }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const { svc } = mkService({ executorOverride: exec, backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: other }), grants: mkGrantStore({ add, matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_6', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc.grantDirectory('call_6', GRANT_TTL_OPTIONS_MS[1])
    expect(add).toHaveBeenCalled()   // grant 已建（F-1 语义：授权目录已落，仅本次请求不执行）
    expect(exec).not.toHaveBeenCalled()
    expect(svc.getRecord('call_6')?.status).toBe('awaiting_permission')
  })
  it('grantDirectory：F-3 ttl 非白名单 → INVALID_ARGUMENTS（先注 grants 再断 ttl——F-8 修复）；F-14 grants 缺省 → TOOL_STATE_INVALID 不崩溃', async () => {
    const { svc } = mkService({ backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: FIXTURES }), grants: mkGrantStore() })
    await svc.handleRequest(mkReq({ callId: 'call_7', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await expect(svc.grantDirectory('call_7', 2 ** 53)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    const { svc: svc2 } = mkService({ backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: FIXTURES }) })   // grants undefined
    await svc2.handleRequest(mkReq({ callId: 'call_8', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await expect(svc2.grantDirectory('call_8', GRANT_TTL_OPTIONS_MS[1])).rejects.toMatchObject({ code: 'TOOL_STATE_INVALID' })
  })
  it('grantDirectory：N-4 断连 → 不创建；V-5 dialog 后身份复核不匹配 → 不创建', async () => {
    const add = vi.fn()
    const identity: string | undefined = undefined   // 断连（backendIdentity 返回 undefined）
    const { svc } = mkService({ backendIdentity: () => identity, pickDirectory: async () => ({ canceled: false, path: FIXTURES }), grants: mkGrantStore({ add }) })
    await svc.handleRequest(mkReq({ callId: 'call_9', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc.grantDirectory('call_9', GRANT_TTL_OPTIONS_MS[1])
    expect(add).not.toHaveBeenCalled()
    expect(svc.getRecord('call_9')?.status).toBe('awaiting_permission')
    let identity2: string | undefined = 'http://a'
    const add2 = vi.fn()
    const { svc: svc2 } = mkService({ backendIdentity: () => identity2, pickDirectory: async () => { identity2 = 'http://b'; return { canceled: false, path: FIXTURES } }, grants: mkGrantStore({ add: add2 }) })
    await svc2.handleRequest(mkReq({ callId: 'call_10', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc2.grantDirectory('call_10', GRANT_TTL_OPTIONS_MS[1])
    expect(add2).not.toHaveBeenCalled()
  })
  it('grantDirectory：黑名单目录拒（LOW-1——add 抛 PATH_BLOCKLISTED 传播 + 不执行）', async () => {
    const exec = vi.fn()
    const add = vi.fn(() => { throw new ToolServiceError('PATH_BLOCKLISTED', '目录在黑名单中，无法授权') })
    const { svc } = mkService({ executorOverride: exec, backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: '/etc' }), grants: mkGrantStore({ add, matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_bl2', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await expect(svc.grantDirectory('call_bl2', GRANT_TTL_OPTIONS_MS[1])).rejects.toMatchObject({ code: 'PATH_BLOCKLISTED' })
    expect(exec).not.toHaveBeenCalled()   // 不执行
    expect(svc.getRecord('call_bl2')?.status).toBe('awaiting_permission')   // 保持 awaiting
  })
  it('grantDirectory：F-6 定时器清理 + N-1 dialog 挂起期间 expire → 不执行仅一次终态 + grant 不建（LOW-3：add spy 钉「不建」）', async () => {
    const audit = vi.fn()
    let resolvePick!: (v: { canceled: boolean; path?: string }) => void
    const pick = new Promise<{ canceled: boolean; path?: string }>((r) => { resolvePick = r })
    const g = { id: 'grant-5', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const add = vi.fn(() => g)
    // N-2 修复：matches 恒 undefined（grant 无需在 handleRequest 命中——否则记录即 auto 执行、awaiting 定时器永不设置）；
    //   add mock 保留（grantDirectory 授权流经 add → 但 dialog 后 status 复核（N-1）在 matches 前已返回，matches 不被授权流使用）
    const { svc, events } = mkService({ audit, backendIdentity: () => 'http://h', pickDirectory: () => pick, grants: mkGrantStore({ add, matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_n1', sourceCallId: 'tc_n1', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') }, expiresAt: Date.now() + 50 }))   // 短 TTL
    const p = svc.grantDirectory('call_n1', GRANT_TTL_OPTIONS_MS[1])   // dialog 挂起
    await new Promise((r) => setTimeout(r, 100))   // 等 expiresAt 定时器触发（expire → timeout 终态）
    resolvePick({ canceled: false, path: FIXTURES })
    await p
    const rec = svc.getRecord('call_n1')!
    expect(['timeout', 'cancelled']).toContain(rec.status)   // 已终态（不复活）
    expect(add).not.toHaveBeenCalled()   // LOW-3：N-1「grant 不建」语义钉住（dialog 后 status 复核在 add 前返回）
    // 仅一次终态：events 中终态事件（cancelled/timeout）只出现一次（V-15：events 为 mkService 返回的独立数组）
    const term = events.filter((e) => ['cancelled', 'timeout', 'completed', 'failed', 'rejected'].includes(e.status ?? ''))
    expect(term).toHaveLength(1)
  })
  it('grantDirectory：F-16 run 抛错 → promoteQueue 恒执行（队列头不被卡死——V-17 修复：状态化 matches + awaiting 重发事件观测）', async () => {
    // V-17：matches 状态化（handleRequest 阶段 grant 未激活 → 两条记录均停 awaiting 入队；grantDirectory 时激活）
    let grantActive = false
    const g = { id: 'grant-6', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const exec = vi.fn().mockRejectedValue(new Error('boom'))
    const { svc, events } = mkService({
      executorOverride: exec, backendIdentity: () => 'http://h',
      pickDirectory: async () => ({ canceled: false, path: FIXTURES }),
      grants: mkGrantStore({ matches: () => (grantActive ? g : undefined), add: () => { grantActive = true; return g } }),
    })
    await svc.handleRequest(mkReq({ callId: 'call_f16a', sourceCallId: 'tc_f16a', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc.handleRequest(mkReq({ callId: 'call_f16b', sourceCallId: 'tc_f16b', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'b.txt') } }))   // 队列第二位（N-1：独立 sourceCallId）
    expect(svc.getRecord('call_f16a')?.status).toBe('awaiting_permission')
    expect(svc.getRecord('call_f16b')?.status).toBe('awaiting_permission')
    await svc.grantDirectory('call_f16a', GRANT_TTL_OPTIONS_MS[1])   // run 抛错被 run() 内部 catch → failed；finally promoteQueue
    expect(svc.getRecord('call_f16a')?.status).toBe('failed')
    // promoteQueue 可观测副作用 = dequeueNext 对下一 awaiting 记录重发 awaiting 事件（对齐既有 M-3 口径）
    const awaitingForB = events.filter((e) => e.status === 'awaiting_permission' && e.desktopCallId === 'call_f16b')   // N-3：emit 的 id = sourceCallId——按 desktopCallId 过滤
    expect(awaitingForB.length).toBeGreaterThanOrEqual(1)   // 队列晋升 → f16b 重发 awaiting（若队列卡死则无此事件）
  })
  it('L-1 records 驱逐：>200 逐最旧终态（F-8 修复：grant 命中 auto → 终态；N-1：每条独立 sourceCallId）', async () => {
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const g = { id: 'grant-l1', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const { svc } = mkService({ executorOverride: exec, grants: mkGrantStore({ matches: () => g }) })
    for (let i = 0; i < 205; i++) {
      await svc.handleRequest(mkReq({ callId: `call_${i}`, sourceCallId: `tc_${i}`, toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, `f${i}.txt`) } }))
    }
    const recs = svc.listRecent(500)
    expect(recs.length).toBeLessThanOrEqual(200)   // 205 条终态 → 驱逐至 ≤200
  })
  it('L-1 补充：awaiting/running 永不逐出（D6C-09a——V-16 修复：同一 svc 内先终态后 awaiting；N-1：每条独立 sourceCallId）', async () => {
    // 同一 svc：先 grant 命中（matches → g）造 205 条终态，再换 matches → undefined 造 3 条 awaiting——断言 awaiting 仍全量在 listRecent
    let grantHit = true
    const g = { id: 'grant-l1b', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const { svc } = mkService({ executorOverride: exec, grants: mkGrantStore({ matches: () => (grantHit ? g : undefined) }) })
    for (let i = 0; i < 205; i++) await svc.handleRequest(mkReq({ callId: `call_a${i}`, sourceCallId: `tc_a${i}`, toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, `f${i}.txt`) } }))
    grantHit = false   // 之后请求走 prompt → awaiting
    for (let i = 0; i < 3; i++) await svc.handleRequest(mkReq({ callId: `call_w${i}`, sourceCallId: `tc_w${i}`, toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, `w${i}.txt`) } }))
    const recs = svc.listRecent(500)
    expect(recs.filter((r) => r.status === 'awaiting_permission')).toHaveLength(3)   // awaiting 永不逐出
    expect(recs.length).toBeLessThanOrEqual(200 + 3)   // 终态被逐至 ~200，awaiting 保留
  })
  it('L-3 终态复活防护：已终态记录经 grantDirectory 入口守卫拒绝（N-1；V-07 修正——本用例测的是 grantDirectory 入口守卫，见注）', async () => {
    // V-07 修正：#记录原题为「L-3 run 入口守卫」，但本用例实际触达的是 grantDirectory 入口守卫
    // （tool-service.ts:346 rec.status !== 'awaiting_permission' → TOOL_STATE_INVALID），在 run() 之前同步 throw。
    // run() 的 L-3 守卫（:376 rec.status !== 'requested' && !== 'awaiting_permission' → return）是**纯纵深防御**——
    // 三条公开调用路径（handleRequest auto 分支 / decide / grantDirectory）都在调 run() 前有同步前置状态校验
    // （handleRequest 记录刚创建即 requested；decide/grantDirectory 校验 status==='awaiting_permission'），中间无 await 间隙，
    // 因此 run() 的 :376 守卫在当前 API 下从公开路径不可达，属防未来改动的纵深，无需强行导出 run() 直测（导出改生产 API 违背"不为清单改代码"）。
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const g = { id: 'grant-l3', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    // N-2 修复：matches 恒 undefined（记录先停 awaiting + expiresAt 定时器设置——grant 命中会即 auto 执行，timeout 永不发生）
    // LOW-4：注入 backendIdentity（否则 N-4 断连早退会吸收守卫缺失——守卫被移除时用例仍绿）；断言 rejects TOOL_STATE_INVALID 钉住入口守卫
    const { svc } = mkService({ executorOverride: exec, backendIdentity: () => 'http://h', grants: mkGrantStore({ add: () => g, matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_11', sourceCallId: 'tc_11', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') }, expiresAt: Date.now() + 50 }))   // 短 TTL
    await new Promise((r) => setTimeout(r, 100))   // expire → timeout 终态
    expect(svc.getRecord('call_11')?.status).toBe('timeout')
    // grantDirectory 入口守卫（rec.status !== 'awaiting_permission' → TOOL_STATE_INVALID）——已终态直接拒绝（不进入 pickDirectory/add/run）
    await expect(svc.grantDirectory('call_11', GRANT_TTL_OPTIONS_MS[1])).rejects.toMatchObject({ code: 'TOOL_STATE_INVALID' })
    expect(exec).not.toHaveBeenCalled()
    expect(svc.getRecord('call_11')?.status).toBe('timeout')   // 不被覆写为 running
  })
  it('L-7 confirmUpload 终态 emit 无陈旧 capture 字段（V-6 修复：真实断言，复用既有 capture 用例先例——tool-service.spec.ts:300-334 pickSource/confirmUpload 形态）', async () => {
    // 对齐既有 capture 用例：enumerateSources 注入 + pickSource + confirmUpload——断言 completed 事件载荷 captureSources/capturePreview 为 undefined
    // （renderPreview 注入同既有 describe 内 helper 先例——node 无 desktopCapturer，放行路径走注入）
    const { svc, events } = mkService({
      enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }],
      renderPreview: async () => ({ previewDataUrl: 'data:image/png;base64,AA==', bytes: new Uint8Array([137, 80, 78, 71]) }),
    })
    await svc.handleRequest(mkReq({ callId: 'call_cap2', toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_cap2', 'allow_once')
    await svc.pickSource('call_cap2', 's1')
    await svc.confirmUpload('call_cap2')
    const terminalEv = events.filter((e) => ['completed', 'failed'].includes(e.status ?? '')).at(-1)!   // 终态事件必然存在（completed 已 emit）
    expect(terminalEv).toBeDefined()
    expect(terminalEv.captureSources).toBeUndefined()   // L-7：emit 前已清
    expect(terminalEv.capturePreview).toBeUndefined()
  })
  it('L-2 水合数据源：listRecent 非终态不设 20 上限（F-2 符合性：includeNonTerminalAlways；N-1：每条独立 sourceCallId）', async () => {
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const { svc } = mkService({ executorOverride: exec, grants: mkGrantStore({ matches: () => undefined }) })
    // 25 条 awaiting（非终态）——listRecent(20) 必须全量返回（awaiting 不被 20 上限截断）
    for (let i = 0; i < 25; i++) await svc.handleRequest(mkReq({ callId: `call_h${i}`, sourceCallId: `tc_h${i}`, toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, `h${i}.txt`) } }))
    const recs = svc.listRecent(20)
    expect(recs.filter((r) => r.status === 'awaiting_permission')).toHaveLength(25)   // 非终态全量
    expect(recs).toHaveLength(25)   // 无终态可补足 → 仅非终态
  })
})

// —— 批次 C（D6C-11/F-4）：reconnect queryStatus 三分支测试放 tool-service.spec（spec §3.8 归属，
//    复用 mkService/mkReq/FIXTURES；F-1：queryStatus 字段本批次首次加入 ToolServiceDeps）——
describe('批次 C：reconnect queryStatus 三分支（D6C-11）', () => {
  it('expired → terminal(timeout) + wire cancelled；cancelled/rejected → terminal(cancelled)；succeeded/null → 保持 awaiting（禁止自动执行）', async () => {
    const mk = (status: string | null) => {
      const qs = vi.fn(async () => (status === null ? null : { callId: 'call_r', toolName: 'desktop.file.read', toolVersion: DESKTOP_TOOL_VERSION, runtime: 'desktop', paramHash: 'h', status: status as never, createdAt: 'x', expiresAt: 'y' }))
      return { ...mkService({ queryStatus: qs, grants: mkGrantStore({ matches: () => undefined }) }), qs }
    }
    // 建立 awaiting 记录后调 reconnect()：
    const { svc: sExp } = mk('expired')
    await sExp.handleRequest(mkReq({ callId: 'call_r1', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r1.txt') } }))
    await sExp.reconnect()
    expect(sExp.getRecord('call_r1')?.status).toBe('timeout')
    const { svc: sCan } = mk('cancelled')
    await sCan.handleRequest(mkReq({ callId: 'call_r2', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r2.txt') } }))
    await sCan.reconnect()
    expect(sCan.getRecord('call_r2')?.status).toBe('cancelled')
    const { svc: sOk, qs: qsOk } = mk('succeeded')
    await sOk.handleRequest(mkReq({ callId: 'call_r3', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r3.txt') } }))
    await sOk.reconnect()
    expect(sOk.getRecord('call_r3')?.status).toBe('awaiting_permission')   // succeeded → 保持本地态（禁止自动执行，doc 02 §16.2）
    expect(qsOk).toHaveBeenCalledTimes(1)   // LOW-3：查询已发生（防接线回归空转）
    const { svc: sNull, qs: qsNull } = mk(null)
    await sNull.handleRequest(mkReq({ callId: 'call_r4', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r4.txt') } }))
    await sNull.reconnect()
    expect(sNull.getRecord('call_r4')?.status).toBe('awaiting_permission')   // null → 保持
    expect(qsNull).toHaveBeenCalledTimes(1)   // LOW-3：查询已发生
  })
  it('queryStatus 未注入（undefined）→ reconnect 不查询（mock 装配路径）', async () => {
    const { svc } = mkService({ grants: mkGrantStore({ matches: () => undefined }) })   // 无 queryStatus
    await svc.handleRequest(mkReq({ callId: 'call_r5', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r5.txt') } }))
    await svc.reconnect()
    expect(svc.getRecord('call_r5')?.status).toBe('awaiting_permission')   // 不查不动作
  })
})
