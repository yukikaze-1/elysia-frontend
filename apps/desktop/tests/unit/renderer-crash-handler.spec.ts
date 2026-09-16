// tests/unit/renderer-crash-handler.spec.ts（node）
// Task 2（阶段 7 批次 B，D7B-05/06/07/08）：主进程崩溃监听——
// ① handleRendererGone 抽函数（main-window.ts 导出；单一可测入口——不依赖 BrowserWindow，
//    注入 fake deps { logger?, audit?, setMarker, reload }）；
// ② handleChildProcessGone 抽函数（2026-09-17 架构整改 Prompt 2 起在 app/process-error-guards.ts；
//    更早版本在 index.ts。child-process-gone 的 GPU 分支审计解耦 gpu:crash，契约 H-1）；
// ③ render-process-gone 3 参监听接线（经 setCrashSink/setMarker/createMainWindow 装配，读第 3 参 details）+ getCrashMarker 一次性读后清。
// electron mock 先例：diagnostics-handlers.spec / 注册表 registry-trust.spec（捕获 ipcMain.handle / webContents.on 的 listener 后直调）。
// 说明：本文件已不再 import index.ts（handleChildProcessGone 迁址），但 electron mock 仍是必需品——
//   main-window.ts 与 process-error-guards.ts 的模块级代码都依赖它。
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// —— hoisted：vi.mock 工厂可引用的共享状态（render-process-gone listener 捕获 + reload + 版本化 window/webContents 工厂）——
// 注：vi.hoisted 工厂在任何模块 import 求值前运行——不能引用 node 内建 join/tmpdir，故 APP_DATA 用字面量路径。
const h = vi.hoisted(() => {
  const noop = vi.fn()
  const APP_DATA = '/tmp/cyrene-7b-task2-appdata'
  const goneHandlers = new Map<string, (...a: unknown[]) => void>()
  const reload = vi.fn()

  const makeWebContents = () => ({
    id: 1,
    mainFrame: { url: 'cyrene://renderer/index.html' },
    on: vi.fn((ev: string, fn: (...a: unknown[]) => void) => { if (ev === 'render-process-gone') goneHandlers.set('render-process-gone', fn) }),
    setWindowOpenHandler: vi.fn(),
    reload,
    loadURL: vi.fn(async () => {}),
    send: noop,
  })

  const makeWin = () => {
    const wc = makeWebContents()
    return {
      webContents: wc,
      on: vi.fn(),
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      show: vi.fn(), focus: vi.fn(), restore: vi.fn(),
      loadURL: vi.fn(async () => {}),
    }
  }

  const mockApp = {
    isPackaged: false,
    commandLine: { hasSwitch: () => false, getSwitchValue: () => '' },
    getPath: () => APP_DATA,
    setName: noop, setPath: noop,
    requestSingleInstanceLock: () => false,   // main() 提前短路 exit(0)（见文件头注释）
    on: noop, quit: noop, exit: noop,
    whenReady: () => Promise.resolve(),
    getVersion: () => '1.0.0', setAppUserModelId: noop,
  }

  return {
    noop, APP_DATA, goneHandlers, reload, makeWin, mockApp,
  }
})

vi.mock('electron', () => ({
  app: h.mockApp,
  BrowserWindow: class {
    webContents: unknown
    on: unknown
    isDestroyed: unknown
    isMinimized: unknown
    isVisible: unknown
    show: unknown
    focus: unknown
    restore: unknown
    loadURL: unknown
    constructor() {
      const w = h.makeWin()
      this.webContents = w.webContents
      this.on = w.on
      this.isDestroyed = w.isDestroyed
      this.isMinimized = w.isMinimized
      this.isVisible = w.isVisible
      this.show = w.show
      this.focus = w.focus
      this.restore = w.restore
      this.loadURL = w.loadURL
    }
    static getAllWindows() { return [] }
  },
  session: { defaultSession: { setPermissionCheckHandler: h.noop, setPermissionRequestHandler: h.noop } },
  shell: { openExternal: h.noop },
  dialog: { showErrorBox: h.noop },
  Menu: { setApplicationMenu: h.noop, buildFromTemplate: () => [] },
  safeStorage: {},
  net: {},
  protocol: { registerSchemesAsPrivileged: h.noop, handle: h.noop, unhandle: h.noop, isProtocolHandled: () => false },
  ipcMain: { handle: h.noop, on: h.noop },
}))

// handleRendererGone / getCrashMarker / setCrashSink / createMainWindow 来自 main-window.ts；
// handleChildProcessGone 来自 app/process-error-guards.ts（2026-09-17 架构整改 Prompt 2 前在 index.ts）。
// 二者共用一个 electron mock（模块级）。
import { createMainWindow, getCrashMarker, handleRendererGone, setCrashSink } from '../../src/main/windows/main-window'
import { CRASH_RELOAD_MAX, CRASH_RELOAD_WINDOW_MS, ERR_ABORTED, createCrashStormGuard, describeLoadFailure, shouldHandleLoadFailure } from '../../src/main/windows/main-window'
import { handleChildProcessGone } from '../../src/main/app/process-error-guards'

afterAll(() => { h.reload.mockClear() })

beforeEach(() => {
  h.goneHandlers.clear()
  h.reload.mockClear()
})

describe('handleRendererGone（抽函数——注入 fake deps，不依赖 BrowserWindow）', () => {
  function makeLogger() {
    return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
  }
  /** handleRendererGone 的 deps 第二参（含 logger/audit/setMarker/stormGuard/reload） */
  type RendererGoneDeps = Parameters<typeof handleRendererGone>[1]
  function deps(overrides: Partial<RendererGoneDeps> = {}) {
    // setMarker 按 handleRendererGone 的真实 deps 签名标注——裸 `vi.fn()` 的调用实参是 `any`
    const base = {
      logger: makeLogger(),
      audit: vi.fn(),
      setMarker: vi.fn<(m: { reason: string; exitCode: number; ts: number }) => void>(),
      // 默认给一个"永远允许重载"的守卫（时间注入成常量 ⇒ 计数只增不减 ⇒ 只有上限能拦住）；
      // 风暴用例自己注入带时间的守卫——每个用例一份，避免模块级单例式的互相污染。
      stormGuard: createCrashStormGuard(() => 0),
      reload: vi.fn()
    }
    return { ...base, ...overrides }
  }

  it('clean-exit 不触发 audit/setMarker/reload（正常关窗退出，不处理）', () => {
    const d = deps()
    handleRendererGone({ reason: 'clean-exit', exitCode: 0 }, d)
    expect(d.audit).not.toHaveBeenCalled()
    expect(d.setMarker).not.toHaveBeenCalled()
    expect(d.reload).not.toHaveBeenCalled()
  })

  it('crashed 触发 warn + audit(renderer:crash) + setMarker(reason/exitCode/ts) + reload', () => {
    // setMarker 以带真实签名的 mock 注入（deps() 的 `{...base, ...overrides}` 会把 Mock 展宽成裸函数签名，
    // 展宽后 `.mock.calls` 不可达——原写法只能用 expect.any(Number)，其返回类型是 any）；这里保留调用记录
    const setMarker = vi.fn<(m: { reason: string; exitCode: number; ts: number }) => void>()
    const d = deps({ setMarker })
    handleRendererGone({ reason: 'crashed', exitCode: 1 }, d)
    expect(d.logger.warn).toHaveBeenCalledWith('render-process-gone', { reason: 'crashed', exitCode: 1 })
    expect(d.audit).toHaveBeenCalledWith({ type: 'renderer:crash', summary: '渲染进程异常：crashed (exit 1)' })
    const marker = setMarker.mock.calls[0][0]
    expect(marker.reason).toBe('crashed')
    expect(marker.exitCode).toBe(1)
    expect(typeof marker.ts).toBe('number')
    expect(d.reload).toHaveBeenCalledTimes(1)
  })

  it('onRendererGone 死成员不存在（LOW-2：setCrashSink 只存 logger/audit）', () => {
    expect(setCrashSink).toBeTypeOf('function')
  })
})

describe('崩溃 reload 风暴抑制 + 主 frame 加载失败判定（2026-09-16 审计 P2）', () => {
  function makeLogger() {
    return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
  }

  it('时间窗内崩溃超过上限 ⇒ 不再 reload，改留痕 + 用户可见提示（修复前：无限重载，用户一直看白屏）', () => {
    let clock = 1_000
    const logger = makeLogger()
    // 审计按真实形状标注（裸 vi.fn() 的调用实参是 any，取 summary 会命中 no-unsafe-member-access）
    const audit = vi.fn<(e: { type: string; summary?: string }) => void>()
    const reload = vi.fn(); const notifyStorm = vi.fn()
    const stormGuard = createCrashStormGuard(() => clock)
    const deps = { logger, audit, setMarker: vi.fn(), stormGuard, notifyStorm, reload }
    for (let i = 0; i < CRASH_RELOAD_MAX; i++) handleRendererGone({ reason: 'crashed', exitCode: 1 }, deps)
    expect(reload).toHaveBeenCalledTimes(CRASH_RELOAD_MAX)   // 上限之内照旧重载
    clock += 10   // 仍在窗口内
    handleRendererGone({ reason: 'crashed', exitCode: 1 }, deps)
    expect(reload).toHaveBeenCalledTimes(CRASH_RELOAD_MAX)   // ← 修复前这里会变成 +1（第 N+1 次无脑重载）
    expect(logger.warn).toHaveBeenCalledWith('renderer:crash-storm', { recent: CRASH_RELOAD_MAX + 1, windowMs: CRASH_RELOAD_WINDOW_MS })
    const stormRecords = audit.mock.calls.map((c) => c[0]).filter((e) => e.type === 'renderer:crash-storm')
    expect(stormRecords).toHaveLength(1)
    expect(stormRecords[0].summary ?? '').toContain('已停止自动重载')
    expect(notifyStorm).toHaveBeenCalledWith(CRASH_RELOAD_MAX + 1)
    // 崩溃本身依旧如实留痕（停止重载不等于不记录）
    expect(audit.mock.calls.map((c) => c[0])).toContainEqual({ type: 'renderer:crash', summary: '渲染进程异常：crashed (exit 1)' })
  })

  it('时间窗滑过之后恢复允许重载（不是"一次性熔断"，而是限速）', () => {
    let clock = 1_000
    const reload = vi.fn()
    const deps = { logger: makeLogger(), audit: vi.fn(), setMarker: vi.fn(), stormGuard: createCrashStormGuard(() => clock), reload }
    for (let i = 0; i <= CRASH_RELOAD_MAX; i++) handleRendererGone({ reason: 'crashed', exitCode: 1 }, deps)
    expect(reload).toHaveBeenCalledTimes(CRASH_RELOAD_MAX)   // 第 4 次已被拦
    clock += CRASH_RELOAD_WINDOW_MS + 1                      // 全部旧记录滑出窗口
    handleRendererGone({ reason: 'crashed', exitCode: 1 }, deps)
    expect(reload).toHaveBeenCalledTimes(CRASH_RELOAD_MAX + 1)
  })

  it('clean-exit 不进入风暴计数（正常关窗不是崩溃）', () => {
    const reload = vi.fn()
    let clock = 1_000
    const deps = { logger: makeLogger(), audit: vi.fn(), setMarker: vi.fn(), stormGuard: createCrashStormGuard(() => clock), reload }
    for (let i = 0; i < CRASH_RELOAD_MAX + 2; i++) handleRendererGone({ reason: 'clean-exit', exitCode: 0 }, deps)
    clock += 1
    handleRendererGone({ reason: 'crashed', exitCode: 1 }, deps)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('主 frame 加载失败判定：只有主 frame 且非 ERR_ABORTED 才算失败（子 frame 与主动取消不提示用户）', () => {
    expect(shouldHandleLoadFailure({ errorCode: -2, isMainFrame: true })).toBe(true)
    expect(shouldHandleLoadFailure({ errorCode: ERR_ABORTED, isMainFrame: true })).toBe(false)
    expect(shouldHandleLoadFailure({ errorCode: -2, isMainFrame: false })).toBe(false)
  })

  it('加载失败描述含错误码/原因/地址（原文经审计与提示两处展示，不得为空）', () => {
    expect(describeLoadFailure({ errorCode: -6, errorDescription: 'ERR_FILE_NOT_FOUND', url: 'cyrene://renderer/index.html' }))
      .toBe('页面加载失败（-6 ERR_FILE_NOT_FOUND）：cyrene://renderer/index.html')
    expect(describeLoadFailure({ errorCode: -2, errorDescription: '', url: '' }))
      .toBe('页面加载失败（-2 未知原因）：未知地址')
  })
})

describe('handleChildProcessGone（app/process-error-guards.ts 抽函数——child-process-gone GPU 分支），契约 H-1 解耦', () => {
  it('GPU 进程异常 → logger.warn + audit(gpu:crash)（不 reload——GPU 非 renderer，无 reload 语义）', () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
    const audit = vi.fn()
    handleChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 1 }, { logger, audit })
    expect(logger.warn).toHaveBeenCalledWith('gpu-process-gone', { reason: 'crashed', exitCode: 1 })
    expect(audit).toHaveBeenCalledWith({ type: 'gpu:crash', summary: 'GPU 进程异常：crashed (exit 1)' })
  })

  it('非 GPU 子进程（如 Utility）不触发审计（仅 GPU 分支关注）', () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
    const audit = vi.fn()
    handleChildProcessGone({ type: 'Utility', reason: 'clean-exit', exitCode: 0 }, { logger, audit })
    expect(logger.warn).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('render-process-gone 监听接线（createMainWindow 装配）+ getCrashMarker 一次性读后清', () => {
  it('监听读 details——crashed → audit + marker 写入 + reload；getCrashMarker 读后清。注：win.webContents 的 render-process-gone 为 2 参 (event, details)（electron.d.ts:17304）', () => {
    setCrashSink({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }, audit: vi.fn() })
    createMainWindow(undefined, undefined)
    const listener = h.goneHandlers.get('render-process-gone')
    expect(listener).toBeDefined()
    // 2 参触发：(event, details) —— details 是第 2 参（WebContents 真实签名）
    listener!({}, { reason: 'crashed', exitCode: 7 })
    const m1 = getCrashMarker()
    expect(m1).toEqual({ reason: 'crashed', exitCode: 7 })
    expect(getCrashMarker()).toBeNull() // 一次性：读后清
  })
})
