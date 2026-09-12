// src/main/windows/window-presentation.ts
// 统一窗口呈现边界：Main 进程里**唯一**允许直接调用窗口呈现类 API（show/hide/focus/restore/
// moveTop/setAlwaysOnTop/setSkipTaskbar/DevTools 窗口）的地方。
//
// 为什么要有这一层：此前 `main-window.ts` 直接 `new BrowserWindow(...)` 再在
// `ready-to-show` 与一个 5s 兜底定时器里 `win.show()`，`focusOrDefer()`（second-instance/activate）
// 里还有 `restore() → show() → focus()` 的组合。只要测试进程启动 Electron，这条链路就会
// 把窗口弹到桌面上、抢走前台焦点、在任务栏留下图标——全仓 27 个集成 spec、55 次 `launchApp`
// 意味着一次套件运行会重复这件事几十遍（正在全屏游戏时被反复切出）。
//
// 分散地给每处补 `if (silent)` 不是解法：新增一个 show() 调用点就会重新漏一次。故把「环境差异」
// 收敛到本模块的**入口函数**里，调用方（main-window/index/tool/diagnostics）不再自行判断环境：
//   - 建窗：`createAppWindow(options)` —— 选项策略在**创建前**改写（show:false / alwaysOnTop:false /
//     skipTaskbar:true），不是建完再补救（建完再 hide 会先闪一下，正是要消除的现象）；
//   - 显示：`showWindow(win)` / `focusWindow(win)` —— silent 下**不执行**任何 raise；
//   - 置顶：`setWindowAlwaysOnTop(win, flag)` —— silent 下恒 false；
//   - DevTools：`toggleWindowDevTools(win)` —— silent 下不创建 detached 窗口。
//
// 刻意**不**做的事（对应任务书的处理优先级 1→6）：
//   1. 不 show；2. 不主动 focus；3. 不 moveTop；4. 不 alwaysOnTop；5. skipTaskbar；
//   6. **不**设 `focusable: false`。
// 第 6 条是刻意的：`focusable:false` 会改变 renderer 的焦点/键盘语义（activeElement、focus 事件、
// 输入法），而 Playwright 的键盘与输入断言正建立在这些语义上。实测（Windows / Electron 43.3.0，
// 见 tests/integration/silent-window-mode.spec.ts）：`show:false` 且从不 show 的窗口
// `document.hidden === false`、rAF 全速、`page.fill`/`click`/`screenshot` 均正常——即
// 「不显示」本身已足够静默，无需牺牲 renderer 语义。
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { runtimeEnvironment, type RuntimeEnvironment } from '../config/runtime-environment'

/** 出帧保活形态：pending=等待 renderer 就绪；unmapped=隐藏窗口 + 帧订阅（首选）；mapped=回退「映射但不可见」 */
export type FrameKeepAlive = 'pending' | 'unmapped' | 'mapped' | 'none'

export interface AppliedWindowPresentation {
  ts: number
  silent: boolean
  windowMode: RuntimeEnvironment['windowMode']
  windowModeSource: RuntimeEnvironment['windowModeSource']
  /** 实际生效的三项呈现选项（skipTaskbar 在 Electron 无 getter，故留证据供集成断言） */
  options: { show: boolean; alwaysOnTop: boolean; skipTaskbar: boolean }
  frameKeepAlive: FrameKeepAlive
}

let lastApplied: AppliedWindowPresentation | null = null

/** 最近一次经统一入口创建的窗口的呈现选项（harness 探针/集成断言用；生产无消费者） */
export function lastWindowPresentation(): AppliedWindowPresentation | null {
  return lastApplied
}

/**
 * 窗口选项策略：silent 下强制三项，**其余选项逐字保留**（尺寸/最小尺寸/背景色/webPreferences/
 * 标题等业务配置不受影响）。visible 下原样返回调用方配置（含显式 `show:true`、`alwaysOnTop:true`）。
 */
export function windowOptionsForPresentation(
  options: BrowserWindowConstructorOptions,
  env: RuntimeEnvironment = runtimeEnvironment()
): BrowserWindowConstructorOptions {
  if (!env.isSilentWindowMode) return { ...options }
  return {
    ...options,
    show: false,
    alwaysOnTop: false,
    skipTaskbar: true,
  }
}

/** 建窗工厂（测试注入用；默认即 `new BrowserWindow`） */
export type WindowFactory = (options: BrowserWindowConstructorOptions) => BrowserWindow

/**
 * 统一建窗入口：策略先于创建生效，随后记录证据并启动出帧保活。所有应用窗口都必须经此创建
 * （`tests/unit/window-presentation-guard.spec.ts` 用源码扫描把这条纪律钉成门禁）。
 */
export function createAppWindow(
  options: BrowserWindowConstructorOptions,
  env: RuntimeEnvironment = runtimeEnvironment(),
  factory: WindowFactory = (opts) => new BrowserWindow(opts)
): BrowserWindow {
  const applied = windowOptionsForPresentation(options, env)
  const win = factory(applied)
  lastApplied = {
    ts: Date.now(),
    silent: env.isSilentWindowMode,
    windowMode: env.windowMode,
    windowModeSource: env.windowModeSource,
    options: {
      show: applied.show === true,
      alwaysOnTop: applied.alwaysOnTop === true,
      skipTaskbar: applied.skipTaskbar === true,
    },
    frameKeepAlive: 'none',
  }
  if (env.isSilentWindowMode) lastApplied.frameKeepAlive = startSilentFrameKeepAlive(win, env)
  return win
}

/** 单次订阅等待首帧的最长时间（ms）；超时 → 重试；重试耗尽 → 回退「映射但不可见」 */
const FRAME_KEEPALIVE_TIMEOUT_MS = 700
/** 重试次数（首次 + 2 次重试）；每次重试前先结束上一次订阅 */
const FRAME_KEEPALIVE_ATTEMPTS = 3
/** 两次订阅尝试之间的间隔（ms） */
const FRAME_KEEPALIVE_RETRY_DELAY_MS = 300

/**
 * 出帧保活（Silent Test Window Mode 的关键一环，2026-09-12 实测结论）。
 *
 * 问题：`show:false` 且从不 show 的窗口在 Electron 43 / Windows 上 **rAF 被压到约 1 帧/秒**
 * （实测：真实应用静默启动后 600ms 内 0 次 rAF 回调，1.5s 内 2 次；同一窗口 show 之后恢复到
 * ~240 帧/秒）。对测试而言这是致命的——Live2D 渲染环、滚动跟随、reduce-motion 等页面行为都建在
 * rAF 上，而"静默"绝不允许改变 renderer 语义。
 *
 * 解法：订阅窗口的**呈现帧**（`webContents.beginFrameSubscription`）。实测同一隐藏窗口在订阅后
 * 立即恢复满速出帧（600ms 内 134 次 rAF 回调），而窗口**始终未被映射**：不出现在桌面、不抢焦点、
 * 不进任务栏、也不会把全屏游戏顶出去。回调收到的帧被直接丢弃——订阅只为让合成器保持出帧。
 *
 * **订阅时机是承重的**（实测，勿"优化"掉）：在 `new BrowserWindow()` 之后立刻订阅**收不到任何帧**
 * ——导航会重建 RenderWidgetHostView，创建期的订阅随之作废（实测 6s 预算内 0 帧、rAF 全程 0）。
 * 故首次订阅挂在 `dom-ready` 上（该事件在每次导航后都会到达，renderer 崩溃自动 reload 后同样有效），
 * 并在无帧时重试；重试耗尽才回退。
 *
 * 平台回退：若该 API 不可用（历史上仅 macOS/Windows 实现）或重试耗尽，则回退为「映射但不可见」：
 * 先置不透明度 0（win32/darwin 支持；Linux 上是 no-op）、令鼠标穿透，再 `showInactive()`
 * （映射但**不激活**，不抢前台焦点）。回退路径下窗口不抢焦点、不进任务栏，只是不再保证
 * "宿主桌面上完全看不到"——这是显式记录的平台差异，不是静默降级。
 */
export function startSilentFrameKeepAlive(
  win: BrowserWindow | null | undefined,
  env: RuntimeEnvironment = runtimeEnvironment(),
  options: { attempts?: number; frameTimeoutMs?: number; retryDelayMs?: number } = {}
): FrameKeepAlive {
  if (!env.isSilentWindowMode || !usable(win)) return 'none'
  const contents = win.webContents
  if (typeof contents?.beginFrameSubscription !== 'function') return fallbackToInvisibleWindow(win)

  const attemptsMax = options.attempts ?? FRAME_KEEPALIVE_ATTEMPTS
  const frameTimeoutMs = options.frameTimeoutMs ?? FRAME_KEEPALIVE_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? FRAME_KEEPALIVE_RETRY_DELAY_MS

  let mode: FrameKeepAlive = 'pending'
  let attempts = 0
  let frameTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const setMode = (next: FrameKeepAlive): void => {
    mode = next
    if (lastApplied) lastApplied.frameKeepAlive = next
  }

  const subscribe = (): void => {
    retryTimer = undefined
    if (mode !== 'pending' || !usable(win)) return
    attempts += 1
    frameTimer = setTimeout(() => {
      frameTimer = undefined
      try { contents.endFrameSubscription() } catch { /* 未建立订阅时结束是无害的 */ }
      if (mode !== 'pending') return
      if (attempts < attemptsMax) { retryTimer = setTimeout(subscribe, retryDelayMs); return }
      setMode(fallbackToInvisibleWindow(win))
    }, frameTimeoutMs)
    try {
      contents.beginFrameSubscription(false, () => {
        if (frameTimer === undefined) return // 已落定（成功或已回退）：忽略迟到帧
        clearTimeout(frameTimer)
        frameTimer = undefined
        setMode('unmapped')
      })
    } catch {
      clearTimeout(frameTimer)
      frameTimer = undefined
      setMode(fallbackToInvisibleWindow(win))
    }
  }

  // 每次导航（首载 / reload / renderer 崩溃后的自动 reload）都会重建 renderer 视图，故重新订阅。
  contents.on('dom-ready', () => {
    clearTimeout(frameTimer)
    clearTimeout(retryTimer)
    frameTimer = undefined
    retryTimer = undefined
    if (!usable(win)) return
    if (mode === 'mapped') return // 已回退：窗口已映射，出帧不再依赖订阅
    setMode('pending')
    attempts = 0
    subscribe()
  })
  if (!contents.isLoading()) subscribe()
  win.once('closed', () => {
    clearTimeout(frameTimer)
    clearTimeout(retryTimer)
    try { contents.endFrameSubscription() } catch { /* 已销毁 */ }
  })
  return mode
}

/** 回退：映射窗口但让宿主看不到、点不到、也不抢焦点（不透明度 0 在 Linux 上是 no-op，见上） */
function fallbackToInvisibleWindow(win: BrowserWindow): FrameKeepAlive {
  if (!usable(win)) return 'none'
  try { win.setOpacity(0) } catch { /* 平台不支持：窗口仍会映射，但不抢焦点/不进任务栏 */ }
  try { win.setIgnoreMouseEvents(true) } catch { /* 同上 */ }
  win.showInactive() // 映射但不激活：不抢前台焦点（Electron 对 showInactive 的契约）
  return 'mapped'
}

function usable(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return !!win && !win.isDestroyed()
}

/** 显示窗口。silent 下**不显示**（返回 false，调用方据此可断言/记日志）；返回是否真的显示过 */
export function showWindow(win: BrowserWindow | null | undefined, env: RuntimeEnvironment = runtimeEnvironment()): boolean {
  if (env.isSilentWindowMode || !usable(win)) return false
  if (win.isVisible()) return true // 已显示：Electron show() 是幂等 no-op，但避免重复触发 show 事件
  win.show()
  return true
}

/**
 * 提到前台：restore（若最小化）→ show（若不可见）→ focus。
 * silent 下整条链路**不执行**——只 restore 或只 show 同样会把窗口带回桌面。
 */
export function focusWindow(win: BrowserWindow | null | undefined, env: RuntimeEnvironment = runtimeEnvironment()): boolean {
  if (env.isSilentWindowMode) return false
  if (!usable(win)) return false
  if (win.isMinimized()) win.restore()
  showWindow(win, env)
  win.focus()
  return true
}

/**
 * 置顶开关。silent 下**永不置顶**：即便调用方（或未来某个业务配置）要求 true 也会被压成 false，
 * 从而保证「测试窗口绝不覆盖在用户窗口/全屏游戏之上」。
 */
export function setWindowAlwaysOnTop(
  win: BrowserWindow | null | undefined,
  flag: boolean,
  env: RuntimeEnvironment = runtimeEnvironment()
): boolean {
  if (!usable(win)) return false
  const effective = env.isSilentWindowMode ? false : flag
  win.setAlwaysOnTop(effective)
  return effective
}

/**
 * 任务栏图标开关。silent 下恒 true（测试进程不在任务栏反复出现/闪烁）；
 * 与建窗选项同源，供运行期显式调整的调用方使用。
 */
export function setWindowSkipTaskbar(
  win: BrowserWindow | null | undefined,
  flag: boolean,
  env: RuntimeEnvironment = runtimeEnvironment()
): boolean {
  if (!usable(win)) return false
  const effective = env.isSilentWindowMode ? true : flag
  win.setSkipTaskbar(effective)
  return effective
}

/**
 * DevTools。silent 下**不打开**：`openDevTools({ mode: 'detach' })` 会生成第二个受管窗口并抢焦点，
 * 在自动化运行里既无观察者又是干扰源。开发态（dev / 打包 devToolsAllowed）行为逐字不变——
 * 本函数只在 silent 时短路，不做其它改写。
 */
export function toggleWindowDevTools(win: BrowserWindow | null | undefined, env: RuntimeEnvironment = runtimeEnvironment()): boolean {
  if (env.isSilentWindowMode || !usable(win)) return false
  win.webContents.toggleDevTools()
  return true
}

export function openWindowDevTools(
  win: BrowserWindow | null | undefined,
  options: { mode: 'detach' | 'right' | 'bottom' | 'undocked' } = { mode: 'detach' },
  env: RuntimeEnvironment = runtimeEnvironment()
): boolean {
  if (env.isSilentWindowMode || !usable(win)) return false
  win.webContents.openDevTools(options)
  return true
}

export function closeWindowDevTools(win: BrowserWindow | null | undefined): void {
  if (!usable(win)) return
  win.webContents.closeDevTools()
}
