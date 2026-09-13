// tests/unit/window-presentation.spec.ts
// 统一窗口呈现边界的判别力用例（Silent Test Window Mode，2026-09-12）。
//
// 覆盖三件事：
//   ① 选项策略：silent 下 show/alwaysOnTop/skipTaskbar 三项被强制，**其余配置逐字保留**；
//      visible 下调用方配置逐字不变（假绿防范：断言的是"没有被改写"，不是"函数被调用过"）。
//   ② 呈现动作门：silent 下 show/focus/restore/置顶/任务栏/DevTools 全部不执行（含"组合拳"
//      restore→show→focus），visible 下逐字执行。
//   ③ 留痕：`lastWindowPresentation()` 记录真实生效的选项（skipTaskbar 在 Electron 无 getter，
//      集成断言只能靠它）。
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { resolveRuntimeEnvironment, type RuntimeEnvironment } from '../../src/main/config/runtime-environment'

const { BrowserWindowMock, constructed } = vi.hoisted(() => {
  const constructed: Record<string, unknown>[] = []
  class BrowserWindowMock {
    webContents: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      constructed.push(options)
      this.webContents = {
        isLoading: () => false,
        on: () => { /* no-op */ },
        beginFrameSubscription: (_onlyDirty: boolean, cb: () => void) => { this.webContents['frameCb'] = cb },
        endFrameSubscription: () => { /* no-op */ },
      }
    }
    isDestroyed(): boolean { return false }
    isVisible(): boolean { return false }
    once(): void { /* no-op */ }
  }
  return { BrowserWindowMock, constructed }
})
vi.mock('electron', () => ({ BrowserWindow: BrowserWindowMock }))

const {
  createAppWindow,
  focusWindow,
  lastWindowPresentation,
  openWindowDevTools,
  setWindowAlwaysOnTop,
  setWindowSkipTaskbar,
  showWindow,
  startSilentFrameKeepAlive,
  toggleWindowDevTools,
  windowOptionsForPresentation,
} = await import('../../src/main/windows/window-presentation')

const SILENT: RuntimeEnvironment = resolveRuntimeEnvironment({ env: { CYRENE_TEST_HARNESS: '1' }, mode: 'test' })
const VISIBLE: RuntimeEnvironment = resolveRuntimeEnvironment({ env: { CYRENE_WINDOW_MODE: 'visible', CYRENE_TEST_HARNESS: '1' }, mode: 'test' })
const PROD: RuntimeEnvironment = resolveRuntimeEnvironment({ env: {}, mode: 'production' })

const BASE_OPTIONS = {
  width: 1200,
  height: 760,
  minWidth: 1100,
  backgroundColor: '#181e29',
  title: 'Cyrene',
  webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
}

interface FakeWindow {
  win: BrowserWindow
  calls: string[]
  /** 模拟"合成器出帧"：触发 beginFrameSubscription 的回调 */
  fireFrame(): void
  /** 模拟一次导航完成（dom-ready）：导航会重建 renderer 视图，保活据此重新订阅 */
  fireDomReady(): void
  visible: boolean
  minimized: boolean
  destroyed: boolean
}

function fakeWindow(init: { visible?: boolean; minimized?: boolean; destroyed?: boolean; noFrameApi?: boolean; beginThrows?: boolean; loading?: boolean } = {}): FakeWindow {
  const calls: string[] = []
  let frameCb: (() => void) | undefined
  const domReadyListeners: Array<() => void> = []
  const state = { visible: init.visible ?? false, minimized: init.minimized ?? false, destroyed: init.destroyed ?? false, loading: init.loading ?? false }
  const webContents: Record<string, unknown> = {
    isLoading: () => state.loading,
    on: (event: string, cb: () => void) => { calls.push(`on:${event}`); if (event === 'dom-ready') domReadyListeners.push(cb) },
    toggleDevTools: () => { calls.push('toggleDevTools') },
    openDevTools: (opts: unknown) => { calls.push(`openDevTools:${JSON.stringify(opts)}`) },
    closeDevTools: () => { calls.push('closeDevTools') },
  }
  if (!init.noFrameApi) {
    webContents.beginFrameSubscription = (_onlyDirty: boolean, cb: () => void) => {
      calls.push('beginFrameSubscription')
      if (init.beginThrows) throw new Error('unsupported platform')
      frameCb = cb
    }
    webContents.endFrameSubscription = () => { calls.push('endFrameSubscription') }
  }
  const win = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    show: () => { calls.push('show'); state.visible = true },
    showInactive: () => { calls.push('showInactive'); state.visible = true },
    focus: () => { calls.push('focus') },
    restore: () => { calls.push('restore'); state.minimized = false },
    setOpacity: (value: number) => { calls.push(`setOpacity:${value}`) },
    setIgnoreMouseEvents: (ignore: boolean) => { calls.push(`ignoreMouseEvents:${ignore}`) },
    setAlwaysOnTop: (flag: boolean) => { calls.push(`setAlwaysOnTop:${flag}`) },
    setSkipTaskbar: (flag: boolean) => { calls.push(`setSkipTaskbar:${flag}`) },
    once: (event: string) => { calls.push(`once:${event}`) },
    webContents,
  }
  return {
    win: win as unknown as BrowserWindow,
    calls,
    fireFrame: () => frameCb?.(),
    fireDomReady: () => { for (const cb of domReadyListeners) cb() },
    get visible() { return state.visible },
    get minimized() { return state.minimized },
    get destroyed() { return state.destroyed },
  }
}

describe('窗口选项策略', () => {
  it('silent：强制 show=false / alwaysOnTop=false / skipTaskbar=true，其余配置逐字保留', () => {
    const applied = windowOptionsForPresentation(BASE_OPTIONS, SILENT)
    expect(applied.show).toBe(false)
    expect(applied.alwaysOnTop).toBe(false)
    expect(applied.skipTaskbar).toBe(true)
    // 业务配置不得被顺手改写（尺寸/标题/背景色/webPreferences 对象同一引用）
    expect(applied.width).toBe(1200)
    expect(applied.height).toBe(760)
    expect(applied.minWidth).toBe(1100)
    expect(applied.title).toBe('Cyrene')
    expect(applied.backgroundColor).toBe('#181e29')
    expect(applied.webPreferences).toBe(BASE_OPTIONS.webPreferences)
    // 刻意不设 focusable：改它会动 renderer 的焦点/键盘语义（见模块头注的优先级 1→6）
    expect('focusable' in applied).toBe(false)
  })

  it('silent：调用方即便显式要求 show=true/alwaysOnTop=true 也被覆盖（窗口生命周期不由调用方决定）', () => {
    const applied = windowOptionsForPresentation({ ...BASE_OPTIONS, show: true, alwaysOnTop: true, skipTaskbar: false }, SILENT)
    expect(applied.show).toBe(false)
    expect(applied.alwaysOnTop).toBe(false)
    expect(applied.skipTaskbar).toBe(true)
  })

  it('visible / 生产：调用方配置逐字不变（含显式 show:true 与 alwaysOnTop:true）', () => {
    for (const env of [VISIBLE, PROD]) {
      const requested = { ...BASE_OPTIONS, show: true, alwaysOnTop: true, skipTaskbar: false }
      expect(windowOptionsForPresentation(requested, env)).toEqual(requested)
      expect(windowOptionsForPresentation(BASE_OPTIONS, env)).toEqual(BASE_OPTIONS)
    }
  })
})

describe('统一建窗入口', () => {
  it('silent：经注入工厂建窗，并把生效选项留痕', () => {
    const f = fakeWindow()
    const factory = vi.fn((_opts: BrowserWindowConstructorOptions) => f.win)
    createAppWindow(BASE_OPTIONS, SILENT, factory)
    expect(factory).toHaveBeenCalledTimes(1)
    const passed = factory.mock.calls[0]![0]
    expect(passed.show).toBe(false)
    expect(passed.alwaysOnTop).toBe(false)
    expect(passed.skipTaskbar).toBe(true)
    expect(lastWindowPresentation()).toMatchObject({
      silent: true,
      windowMode: 'silent',
      windowModeSource: 'harness-default',
      options: { show: false, alwaysOnTop: false, skipTaskbar: true },
    })
  })

  it('可见测试模式：留痕记录 silent=false（人工调试现场可查）', () => {
    createAppWindow({ ...BASE_OPTIONS, show: true }, VISIBLE, () => ({} as BrowserWindow))
    expect(lastWindowPresentation()).toMatchObject({ silent: false, windowMode: 'visible', options: { show: true, alwaysOnTop: false, skipTaskbar: false } })
  })

  it('默认工厂即 new BrowserWindow（同一入口，生产无第二条建窗路径）', () => {
    constructed.length = 0
    createAppWindow(BASE_OPTIONS, SILENT)
    expect(constructed).toHaveLength(1)
    expect(constructed[0].show).toBe(false)
    expect(constructed[0].skipTaskbar).toBe(true)
  })
})

describe('出帧保活（隐藏窗口的 rAF 不被压到 1 帧/秒）', () => {
  it('silent：订阅挂在 dom-ready 上（导航重建 renderer 视图，创建期订阅收不到任何帧——实测 6s 内 0 帧）', () => {
    const f = fakeWindow({ loading: true })
    expect(startSilentFrameKeepAlive(f.win, SILENT, { frameTimeoutMs: 20 })).toBe('pending')
    expect(f.calls).not.toContain('beginFrameSubscription')
    f.fireDomReady()
    expect(f.calls).toContain('beginFrameSubscription')
    f.fireFrame()
    expect(lastWindowPresentation()?.frameKeepAlive).toBe('unmapped')
    expect(f.visible).toBe(false)
    expect(f.calls).not.toContain('showInactive')
  })

  it('silent：页面已就绪时立即订阅；帧到达 → 留痕 unmapped，窗口始终未映射', async () => {
    const f = fakeWindow({ loading: false })
    createAppWindow(BASE_OPTIONS, SILENT, () => f.win)
    expect(f.calls).toContain('beginFrameSubscription')
    expect(f.calls).toContain('once:closed')
    f.fireFrame()
    await new Promise((r) => setTimeout(r, 20))
    expect(lastWindowPresentation()?.frameKeepAlive).toBe('unmapped')
    expect(f.visible).toBe(false)
  })

  it('silent：每次导航（含 renderer 崩溃后的 reload）都重新订阅一次', () => {
    const f = fakeWindow({ loading: false })
    startSilentFrameKeepAlive(f.win, SILENT, { frameTimeoutMs: 50 })
    f.fireFrame()
    const before = f.calls.filter((c) => c === 'beginFrameSubscription').length
    f.fireDomReady() // 第二次导航
    expect(f.calls.filter((c) => c === 'beginFrameSubscription').length).toBe(before + 1)
    f.fireFrame()
  })

  it('API 不可用（平台差异）→ 回退"映射但不可见"：不透明度 0 + 鼠标穿透 + showInactive（不激活）', () => {
    const f = fakeWindow({ noFrameApi: true })
    expect(startSilentFrameKeepAlive(f.win, SILENT, { frameTimeoutMs: 20 })).toBe('mapped')
    expect(f.calls).toEqual(['setOpacity:0', 'ignoreMouseEvents:true', 'showInactive'])
    expect(f.visible).toBe(true)
    expect(f.calls).not.toContain('focus')  // showInactive 不激活窗口
    expect(f.calls).not.toContain('show')   // 绝不用会抢焦点的 show()
  })

  it('订阅抛错（平台不支持）→ 同上回退，不抛到调用方', () => {
    const f = fakeWindow({ beginThrows: true, loading: false })
    expect(startSilentFrameKeepAlive(f.win, SILENT, { frameTimeoutMs: 20 })).toBe('mapped')
    expect(f.calls).toContain('showInactive')
  })

  it('重试耗尽仍无帧 → 结束订阅并回退，保证渲染回路不断供', async () => {
    const f = fakeWindow({ loading: false })
    const mode = startSilentFrameKeepAlive(f.win, SILENT, { attempts: 2, frameTimeoutMs: 10, retryDelayMs: 5 })
    expect(mode).toBe('pending')
    // 2026-09-13（flake 处置，**断言未放宽**）：原先这里是固定 `setTimeout(r, 80)` 之后直接断言
    // 「已回退」。重试链本身只要约 25ms（10+5+10），但全套 252 个 spec 并行跑时事件循环被挤，
    // 定时器可被推迟到 80ms 之后 ⇒ 断言先于终态执行 ⇒ 偶发红（本机全量跑实测红过一次、
    // 单跑 20/20 绿）。改为等待**同一个终态条件**成立，只是把"等多久"从猜的 80ms 换成上限 2s：
    // 两个断言（恰好 2 次订阅 + 已回退）都留在轮询内 ⇒ 真出现第 3 次重试或永不回退仍会红。
    await vi.waitFor(() => {
      expect(f.calls.filter((c) => c === 'beginFrameSubscription')).toHaveLength(2) // 首次 + 1 次重试
      expect(f.calls).toContain('showInactive')
    }, { timeout: 2000, interval: 10 })
    expect(f.visible).toBe(true)
  })

  it('visible / 生产模式：不订阅、不映射、不设不透明度（语义零改动）', () => {
    for (const env of [VISIBLE, PROD]) {
      const f = fakeWindow()
      expect(startSilentFrameKeepAlive(f.win, env, { frameTimeoutMs: 20 })).toBe('none')
      expect(f.calls).toEqual([])
      expect(f.visible).toBe(false)
    }
  })
})

describe('呈现动作门：silent 下不得执行', () => {
  it('showWindow / focusWindow 均为 no-op（含 restore→show→focus 组合）', () => {
    const f = fakeWindow({ minimized: true })
    expect(showWindow(f.win, SILENT)).toBe(false)
    expect(focusWindow(f.win, SILENT)).toBe(false)
    expect(f.calls).toEqual([])
    expect(f.visible).toBe(false)
    expect(f.minimized).toBe(true) // restore 也必须没发生
  })

  it('置顶与任务栏：silent 下恒 false / 恒 true，不随调用方参数', () => {
    const f = fakeWindow()
    expect(setWindowAlwaysOnTop(f.win, true, SILENT)).toBe(false)
    expect(setWindowSkipTaskbar(f.win, false, SILENT)).toBe(true)
    expect(f.calls).toEqual(['setAlwaysOnTop:false', 'setSkipTaskbar:true'])
  })

  it('DevTools：silent 下不打开、不切换（detached 窗口会抢焦点且无观察者）', () => {
    const f = fakeWindow()
    expect(toggleWindowDevTools(f.win, SILENT)).toBe(false)
    expect(openWindowDevTools(f.win, { mode: 'detach' }, SILENT)).toBe(false)
    expect(f.calls).toEqual([])
  })

  it('窗口已销毁 / 缺省：一律不动作，且不抛错', () => {
    const destroyed = fakeWindow({ destroyed: true })
    expect(showWindow(destroyed.win, PROD)).toBe(false)
    expect(focusWindow(destroyed.win, PROD)).toBe(false)
    expect(setWindowAlwaysOnTop(destroyed.win, true, PROD)).toBe(false)
    expect(openWindowDevTools(destroyed.win, { mode: 'detach' }, PROD)).toBe(false)
    expect(showWindow(null, PROD)).toBe(false)
    expect(focusWindow(undefined, PROD)).toBe(false)
    expect(destroyed.calls).toEqual([])
  })
})

describe('呈现动作门：visible / 生产语义逐字不变', () => {
  it('showWindow 显示一次；已可见时不重复触发', () => {
    const f = fakeWindow()
    expect(showWindow(f.win, PROD)).toBe(true)
    expect(f.calls).toEqual(['show'])
    expect(showWindow(f.win, PROD)).toBe(true)
    expect(f.calls).toEqual(['show']) // 幂等：不再触发第二次 show 事件
  })

  it('focusWindow 执行 restore → show → focus（顺序即抢前台的完整链路）', () => {
    const f = fakeWindow({ minimized: true })
    expect(focusWindow(f.win, PROD)).toBe(true)
    expect(f.calls).toEqual(['restore', 'show', 'focus'])
  })

  it('置顶/任务栏/DevTools 按调用方参数生效', () => {
    const f = fakeWindow()
    expect(setWindowAlwaysOnTop(f.win, true, VISIBLE)).toBe(true)
    expect(setWindowSkipTaskbar(f.win, false, VISIBLE)).toBe(false)
    expect(toggleWindowDevTools(f.win, VISIBLE)).toBe(true)
    expect(openWindowDevTools(f.win, { mode: 'detach' }, VISIBLE)).toBe(true)
    expect(f.calls).toEqual(['setAlwaysOnTop:true', 'setSkipTaskbar:false', 'toggleDevTools', 'openDevTools:{"mode":"detach"}'])
  })
})
