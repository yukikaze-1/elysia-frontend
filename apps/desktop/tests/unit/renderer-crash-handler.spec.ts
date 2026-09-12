// tests/unit/renderer-crash-handler.spec.ts（node）
// Task 2（阶段 7 批次 B，D7B-05/06/07/08）：主进程崩溃监听——
// ① handleRendererGone 抽函数（main-window.ts 导出；单一可测入口——不依赖 BrowserWindow，
//    注入 fake deps { logger?, audit?, setMarker, reload }）；
// ② handleChildProcessGone 抽函数（index.ts 导出；child-process-gone 的 GPU 分支审计解耦 gpu:crash，契约 H-1）；
// ③ render-process-gone 3 参监听接线（经 setCrashSink/setMarker/createMainWindow 装配，读第 3 参 details）+ getCrashMarker 一次性读后清。
// electron mock 先例：diagnostics-handlers.spec / 注册表 registry-trust.spec（捕获 ipcMain.handle / webContents.on 的 listener 后直调）。
// 说明：index.ts 静态 import 会触发 `void main().catch(...)`——mock app.requestSingleInstanceLock 返回 false 使 main() 提前
//   exit(0) 短路（不进入 whenReady/registerHandlers/工具装配），仅 `installAppIdentity` 在 tmpdir 下 mkdir 两目录（测试可容忍）。
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
// handleChildProcessGone 来自 index.ts。二者共用一个 electron mock（模块级）。
import { createMainWindow, getCrashMarker, handleRendererGone, setCrashSink } from '../../src/main/windows/main-window'
import { handleChildProcessGone } from '../../src/main/index'

afterAll(() => { h.reload.mockClear() })

beforeEach(() => {
  h.goneHandlers.clear()
  h.reload.mockClear()
})

describe('handleRendererGone（抽函数——注入 fake deps，不依赖 BrowserWindow）', () => {
  function makeLogger() {
    return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
  }
  function deps(overrides: Partial<Parameters<typeof handleRendererGone>[1]> = {}) {
    const base: Parameters<typeof handleRendererGone>[1] = {
      logger: makeLogger(),
      audit: vi.fn(),
      setMarker: vi.fn(),
      reload: vi.fn(),
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
    const d = deps()
    handleRendererGone({ reason: 'crashed', exitCode: 1 }, d)
    expect(d.logger!.warn).toHaveBeenCalledWith('render-process-gone', { reason: 'crashed', exitCode: 1 })
    expect(d.audit).toHaveBeenCalledWith({ type: 'renderer:crash', summary: '渲染进程异常：crashed (exit 1)' })
    expect(d.setMarker).toHaveBeenCalledWith({ reason: 'crashed', exitCode: 1, ts: expect.any(Number) })
    expect(d.reload).toHaveBeenCalledTimes(1)
  })

  it('onRendererGone 死成员不存在（LOW-2：setCrashSink 只存 logger/audit）', () => {
    expect(setCrashSink).toBeTypeOf('function')
  })
})

describe('handleChildProcessGone（index.ts 抽函数——child-process-gone GPU 分支），契约 H-1 解耦', () => {
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
    setCrashSink({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() } as never, audit: vi.fn() })
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
