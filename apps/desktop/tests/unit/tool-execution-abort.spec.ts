// tests/unit/tool-execution-abort.spec.ts
// A 批（2026-09-16 审计报告裁决批的后续：四条 P2）的判别性用例。
//
// 为什么单独一个文件：这四条都不是"某个函数的分支"，而是**跨时刻**的语义——
//   · A1 执行超时/取消必须让 `tool:decide` 这个 IPC invoke 回包（修复前可能永久 pending）；
//   · A2 终态已回 wire 之后，执行器不得继续做副作用（修复前文件照写、大文件照传）；
//   · A4 授权与执行是两个时刻，路径可被换链（修复前只比对了 size）；
//   · A5 Renderer 崩溃后的唯一水合源 `tool:list` 必须带上审批上下文（修复前明确不带）。
// 每条用例都写明"修复前会怎样"，因为本批防的正是"绿灯的含义被高估"。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync, symlinkSync, lstatSync } from 'node:fs'
import { createToolService, type DesktopToolRequest, type ToolServiceDeps } from '../../src/main/tools/tool-service'
import { createExecutors } from '../../src/main/tools/tool-executors'
import { createToolRegistry, DESKTOP_TOOL_VERSION, type RegisteredTool } from '../../src/main/tools/tool-registry'
import type { PublicToolEvent } from '../../src/shared/contracts/tool'

const FIXTURES = '/tmp/cyrene-abort-fixtures'
beforeEach(() => { mkdirSync(FIXTURES, { recursive: true }) })
afterEach(() => { rmSync(FIXTURES, { recursive: true, force: true }) })

interface Harness {
  deps: ToolServiceDeps
  events: PublicToolEvent[]
  submitStatus: ReturnType<typeof vi.fn>
  uploadAttachment: ReturnType<typeof vi.fn>
}
function mkHarness(over: Partial<ToolServiceDeps> = {}): Harness {
  const events: PublicToolEvent[] = []
  const submitStatus = vi.fn().mockResolvedValue(undefined)
  const uploadAttachment = vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' })
  const deps: ToolServiceDeps = {
    registry: createToolRegistry(), platform: 'posix', audit: () => {},
    submitStatus, uploadAttachment, pushEvent: (ev) => events.push(ev), allowRoots: [FIXTURES], ...over,
  }
  return { deps, events, submitStatus, uploadAttachment }
}
/** `submitStatus` 是裸 `vi.fn()`（调用实参为 any），按 ToolServiceDeps 的真实签名收窄后再断言（对齐 tool-service.spec.ts 的 submitCalls） */
function submitCalls(submitStatus: unknown): { status: string }[] {
  if (typeof submitStatus !== 'function' || !('mock' in submitStatus)) throw new Error('submitStatus 必须是 vi.fn()')
  const mock = submitStatus as { mock: { calls: { status: string }[][] } }
  return mock.mock.calls.map((c) => c[0])
}
function mkReq(over: Partial<DesktopToolRequest> = {}): DesktopToolRequest {
  return { callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read', toolVersion: DESKTOP_TOOL_VERSION,
    runtime: 'desktop', arguments: { path: `${FIXTURES}/notes.md` }, reason: 'read', expiresAt: Date.now() + 30_000, ...over }
}
/** 让已排队的微任务跑完（run() 在 await wireSend 后才进执行器） */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** 永不 settle 的执行器：模拟挂起的 dialog / upload / desktopCapturer */
const hang = (): Promise<never> => new Promise<never>(() => {})
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'STILL_PENDING'> {
  return Promise.race([p, new Promise<'STILL_PENDING'>((r) => setTimeout(() => r('STILL_PENDING'), ms))])
}

describe('A1 执行取消/超时不再让调用方永久挂起', () => {
  it('取消一个永不 settle 的执行 ⇒ decide() 仍然返回（修复前：tool:decide 永久 pending、权限窗永久 busy）', async () => {
    const h = mkHarness({ executorOverride: hang })
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq())
    const deciding = svc.decide('call_1', 'allow_once')
    await tick()                                   // 让 run() 走到执行器并挂住
    await svc.cancel('call_1')
    const outcome = await withTimeout(deciding, 1_000)
    expect(outcome).not.toBe('STILL_PENDING')      // ← 修复前在这里失败（永远等不到）
    expect(h.events.at(-1)?.status).toBe('cancelled')
  })
  it('执行超时 ⇒ decide() 返回且 wire 已发 error{TIMEOUT}（超时不只改状态，也不再等下去）', async () => {
    const registry = createToolRegistry()
    registry.set('desktop.file.read', { ...registry.get('desktop.file.read') as RegisteredTool, defaultTimeoutMs: 40 })
    const h = mkHarness({ registry, executorOverride: hang })
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq())
    const outcome = await withTimeout(svc.decide('call_1', 'allow_once'), 2_000)
    expect(outcome).not.toBe('STILL_PENDING')
    expect(h.events.at(-1)?.status).toBe('timeout')
    expect(h.events.at(-1)?.error?.code).toBe('TIMEOUT')
    expect(submitCalls(h.submitStatus).map((c) => c.status)).toContain('error')
  })
  it('放弃等待后释放 per-path 串行锁：同路径的后续写不再陪着挂到超时', async () => {
    const target = `${FIXTURES}/locked.txt`
    const registry = createToolRegistry()
    // 第二次写给一个很短的执行超时：若锁没被释放，它会因排队而超时（而不是完成）
    const h = mkHarness({ registry })
    const svc = createToolService({ ...h.deps, executorOverride: (rec, _p, signal) =>
      rec.id === 'tc_A' ? hang() : createExecutors(h.deps).execute(rec, _p, signal) })
    await svc.handleRequest(mkReq({ callId: 'call_A', sourceCallId: 'tc_A', toolName: 'desktop.file.write',
      arguments: { path: target, content: 'A' } }))
    const a = svc.decide('call_A', 'allow_once')
    await tick()
    await svc.cancel('call_A')                     // A 被放弃 ⇒ 必须释放它占着的目标路径锁
    await withTimeout(a, 1_000)
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: target, content: 'B' } }))
    await svc.decide('call_1', 'allow_once')
    expect(readFileSync(target, 'utf8')).toBe('B')   // ← 修复前：B 排队在永不 settle 的 A 后面，这里读不到文件
  })
})

describe('A2 终态之后执行器不再继续副作用', () => {
  it('正对照：同一条路径在不被打断时**确实**会走到上传（下面那条断言才不是空的）', async () => {
    const big = `${FIXTURES}/big.txt`
    writeFileSync(big, 'x'.repeat(70 * 1024))      // > RESULT_INLINE_BYTES(64KiB) ⇒ read 走上传分支
    const h = mkHarness()
    const real = createExecutors(h.deps)
    const svc = createToolService({ ...h.deps, executorOverride: (rec, p, signal) => real.execute(rec, p, signal) })
    await svc.handleRequest(mkReq({ arguments: { path: big } }))
    await svc.decide('call_1', 'allow_once')
    expect(h.uploadAttachment).toHaveBeenCalledTimes(1)
  })
  it('被放弃的请求排在 per-path 锁后面真正开跑时，在副作用之前收手（信号贯通到真实执行器）', async () => {
    const big = `${FIXTURES}/big.txt`
    writeFileSync(big, 'x'.repeat(70 * 1024))
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = mkHarness()
    const real = createExecutors(h.deps)
    // A 占住 big.txt 的串行锁并停住；B 读同一路径 ⇒ 排队在 A 后（此时 B 还没进执行器）
    const svc = createToolService({ ...h.deps, executorOverride: async (rec, p, signal) => {
      if (rec.id === 'tc_A') { await gate; return { output: { path: big, name: 'big.txt', size: 1 }, summary: 'A 占锁' } }
      return real.execute(rec, p, signal)
    } })
    await svc.handleRequest(mkReq({ callId: 'call_A', sourceCallId: 'tc_A', arguments: { path: big } }))
    await svc.handleRequest(mkReq({ callId: 'call_B', sourceCallId: 'tc_B', arguments: { path: big } }))
    const a = svc.decide('call_A', 'allow_once')
    await tick()
    const b = svc.decide('call_B', 'allow_once')
    await tick()
    await svc.cancel('call_B')                      // B 在"还没进执行器"时被取消
    await withTimeout(b, 1_000)                     // ⇒ B 的 decide 也必须返回（A1）
    release()                                       // A 结束 ⇒ B 的执行器这才真正开跑（带着已 abort 的信号）
    await withTimeout(a, 1_000)
    await tick()
    // ← 修复前：B 的执行器照常读文件并上传（上传调用数会是 1）
    expect(h.uploadAttachment).not.toHaveBeenCalled()
    expect(h.events.filter((e) => e.id === 'tc_B').at(-1)?.status).toBe('cancelled')
  })
  it('原生选择器返回后才被取消 ⇒ 不登记选择（dialog 不可中断，但它之后的一切都可以放弃）', async () => {
    let release: () => void = () => {}
    let started = false
    const gate = new Promise<void>((r) => { release = r })
    const selectedAdd = vi.fn()
    const h = mkHarness({
      selectedAdd,
      pickFile: async () => { started = true; await gate; return { canceled: false, path: `${FIXTURES}/picked.txt` } },
    })
    const svc = createToolService(h.deps)
    writeFileSync(`${FIXTURES}/picked.txt`, 'hello')
    // select 的 permissionMode 是 automatic ⇒ handleRequest 内部直接 await run()，
    // 所以这里**不能 await 它**：要先让它进到 dialog，再取消，最后才放行 dialog。
    const req = svc.handleRequest(mkReq({ toolName: 'desktop.file.select', arguments: {} }))
    await tick()
    expect(started).toBe(true)                      // 前置：确实卡在 dialog 里（否则本用例什么都没测）
    await svc.cancel('call_1')
    release()
    await req
    expect(selectedAdd).not.toHaveBeenCalled()      // ← 修复前：选择被登记进 selected-set（免确认窗口被无声打开）
  })
  it('executors 层：信号已 abort ⇒ 读写两路都在开跑时收手（写路径不得产生文件）', async () => {
    const w = `${FIXTURES}/never.txt`
    const h = mkHarness()
    const real = createExecutors(h.deps)
    const controller = new AbortController()
    controller.abort()
    const rec = { id: 'tc_x', toolName: 'desktop.file.write', arguments_: { path: w, content: 'nope' },
      status: 'running', title: '写入文件', expiresAt: Date.now() + 1000, toolVersion: DESKTOP_TOOL_VERSION, statusSent: false } as never
    await expect(real.execute(rec, w, controller.signal)).rejects.toThrow('执行已中止')
    expect(existsSync(w)).toBe(false)
    // 边界（不谎称已覆盖）：入口检查是可达的（上面的排队用例会走到它）；而"读完之后、上传之前"那处检查
    // 在当前代码里**不可达**（入口到上传之间全是同步语句），属防护性检查——不是被判别性用例覆盖的分支。
  })
})

describe('A4 授权↔执行的路径身份复核（TOCTOU）', () => {
  it('正对照：没有换链时读/写照常成功（复核不是恒拒）', async () => {
    const p = `${FIXTURES}/stable.txt`
    writeFileSync(p, 'v1')
    const h = mkHarness()
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    expect(h.events.at(-1)?.status).toBe('completed')
  })
  it('授权后目标被换成另一个文件 ⇒ 拒绝（修复前：只有 size 复核，同尺寸替换照样通过）', async () => {
    const p = `${FIXTURES}/swapped.txt`
    writeFileSync(p, 'AAAA')
    const h = mkHarness()
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    // 换链：把原件改名搬走（旧 inode 仍存活 ⇒ 新文件必然拿到不同身份），再在原地造一个同尺寸文件
    renameSync(p, `${p}.orig`)
    writeFileSync(p, 'BBBB')
    await svc.decide('call_1', 'allow_once')
    const last = h.events.at(-1)!
    expect(last.status).toBe('failed')
    expect(last.error?.code).toBe('FILE_CONFLICT')
    expect(last.resultSummary ?? '').not.toContain('BBBB')   // 替换后的内容不得进入任何出参
  })
  it('授权后目标消失 ⇒ 拒绝（错误码是身份判据的 FILE_CONFLICT，不再是裸 fs 的 ENOENT）', async () => {
    const p = `${FIXTURES}/gone.txt`
    writeFileSync(p, 'v1')
    const h = mkHarness()
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    rmSync(p)
    await svc.decide('call_1', 'allow_once')
    expect(h.events.at(-1)?.status).toBe('failed')
    expect(h.events.at(-1)?.error?.code).toBe('FILE_CONFLICT')
  })
  it('授权后被换成指向别处的符号链接 ⇒ 拒绝读，且**未授权文件的内容不会被上传**', async ({ skip }) => {
    const secret = `${FIXTURES}/secret.txt`
    const p = `${FIXTURES}/linked.txt`
    writeFileSync(secret, 'TOP-SECRET-' + 'y'.repeat(70 * 1024))   // > 64KiB ⇒ 一旦读成功就会上传
    writeFileSync(p, 'harmless')
    const h = mkHarness()
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq({ arguments: { path: p } }))     // 身份取自这一刻：普通文件 'harmless'
    // ——授权与执行之间换链——（2026-09-16 修正：本用例原先在 handleRequest **之前**就建好符号链接，
    // 于是授权那一刻路径已是 symlink 态 ⇒ captureFileIdentity 返回 undefined ⇒ 复核"不适用"，
    // 用例实际没测它名字里那件事，还因 realpath 生效把 70KiB 的 secret 读出去并上传。
    // 该缺陷被 Windows 的 EPERM skip 掩盖，直到 Linux CI 连续四轮报红才暴露——见 doc 16 §3.4。）
    rmSync(p)
    let canSymlink = true
    try { symlinkSync(secret, p) } catch { canSymlink = false }
    // Windows 无 symlink 权限（本机复测：文件符号链接与 junction **均为 EPERM**）⇒ 显式 skip 并计入 skipped，
    // 不静默当通过。Linux CI 会真的跑这一条——这条分支**在本机是 NOT VERIFIED**（已记入 doc 16）。
    skip(!canSymlink, '本机无 symlink 权限（Windows 非开发者模式实测 EPERM，junction 同样 EPERM）——该分支由 Linux CI 覆盖')
    await svc.decide('call_1', 'allow_once')
    expect(h.uploadAttachment).not.toHaveBeenCalled()
    const last = h.events.at(-1)!
    expect(last.status).toBe('failed')
    // 换链形态由身份判据点名为 symlink（不是 replaced/gone）——三种形态有各自的错误码契约
    expect(last.error?.code).toBe('PATH_UNSAFE')
  })
  it('lstat 判据：符号链接本身可被识别（权限允许时）', ({ skip }) => {
    const secret = `${FIXTURES}/s2.txt`
    const link = `${FIXTURES}/l2.txt`
    writeFileSync(secret, 'x')
    // 2026-09-16：原先写 `try { symlinkSync } catch { return }`——那在无 symlink 权限的机器上记 **passed**
    // 而零断言（requireAssertions 门禁照出来的正是这种"跳过伪装成通过"）。改为真正的 skip（计入 skipped）。
    let canSymlink = true
    try { symlinkSync(secret, link) } catch { canSymlink = false }
    skip(!canSymlink, '本机无 symlink 权限（Windows 非开发者模式实测 EPERM）——该分支由 Linux CI 覆盖')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })
})

describe('A5 崩溃后水合的审批上下文', () => {
  it('listRecent 带上写 Diff（Renderer 崩溃 reload 后这是唯一水合源；修复前明确不带）', async () => {
    const p = `${FIXTURES}/diffed.txt`
    writeFileSync(p, 'old line\n')
    const h = mkHarness()
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: p, content: 'new line\n' } }))
    const rec = svc.listRecent(20).find((e) => e.id === 'tc_1')
    expect(rec?.status).toBe('awaiting_permission')
    expect(rec?.diff).toBeDefined()                 // ← 修复前 undefined ⇒ 权限窗"看不到 diff 也能批准覆盖"
    expect(rec?.diff?.isNewFile).toBe(false)
  })
  it('listRecent 带上截图子状态机的交互面（选源面板不整体消失）', async () => {
    const h = mkHarness({ enumerateSources: async () => [{ sourceId: 'screen:1', sourceName: '屏 1', thumbnailDataUrl: 'data:image/png;base64,AAA' }] })
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: { region: null } }))
    await svc.decide('call_1', 'allow_once')        // 枚举完成 → awaiting_pick（captureSources 下发）
    const rec = svc.listRecent(20).find((e) => e.id === 'tc_1')
    expect(rec?.captureSources).toHaveLength(1)
  })
  it('字节预算：超预算的截图上下文整块不带（而不是把出参撑过 4 MiB 全局不变量）', async () => {
    // 每个缩略图紧贴 THUMBNAIL_DATA_URL_MAX（64 KiB）之下——超过会被 capture 执行器自己丢弃（那是另一条判据）
    const thumb = 'data:image/png;base64,' + 'A'.repeat(64 * 1024 - 64)
    const h = mkHarness({ enumerateSources: async () => Array.from({ length: 40 }, (_, i) => ({ sourceId: `s${i}`, sourceName: `源 ${i}`, thumbnailDataUrl: thumb })) })
    const svc = createToolService(h.deps)
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: { region: null } }))
    await svc.decide('call_1', 'allow_once')
    const rec = svc.listRecent(20).find((e) => e.id === 'tc_1')
    expect(rec?.status).toBe('running')             // 记录本身照旧在（预算只影响"带不带上下文"）
    expect(rec?.captureSources).toBeUndefined()     // 40 × 约 64 KiB ≈ 2.5 MiB > 2 MiB 预算 ⇒ 整块不带
  })
})
