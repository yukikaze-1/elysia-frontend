// apps/desktop/src/main/windows/main-window.ts
import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'path'
import { getMainWindow, setMainWindow } from '../ipc/registry'
import { getAppConfig, shouldUseViteDevServer } from '../config'
import { evaluateDevRendererUrl } from '../config/trusted-renderer-origin'
import { PROTOCOL_SCHEME, RENDERER_HOST } from '../protocol'
import { classifyNavigation } from './navigation'
import { registerMicrophonePermission } from './mic-permission'
import { createRendererConsoleSink } from './renderer-console'
import type { AuditEvent } from '../diagnostics/audit'
import type { Logger } from '../diagnostics/logger'

// —— 阶段 7 批次 B（D7B-05/08）：崩溃留痕 sink + crashMarker——模块级注入（安全 MED-2：second-instance/activate
//    focusOrDefer 不带 opts，per-opts 会丢——提升为模块级变量，所有创建路径共享）——
//    LOW-2：crashSink 只存 logger/audit（无 onRendererGone 死成员——renderer 已死收不到 push，改 marker 持久化）。
let crashSink: { logger?: Logger; audit?: (e: Omit<AuditEvent, 'ts'>) => void } = {}
export function setCrashSink(sink: typeof crashSink): void { crashSink = sink }

/**
 * P1-12：renderer 控制台 sink——模块级（同 crashSink 理由：`focusOrDefer` 不带 opts）。
 * logger 经 getter **惰性转发**到当前 `crashSink.logger`：sink 在窗口创建时可能早于 `setCrashSink`，
 * 直接持有 logger 引用会永远停在 undefined。
 */
const rendererConsoleSink = createRendererConsoleSink({ logger: { warn: (code, fields) => crashSink.logger?.warn(code, fields) } })
let crashMarker: { reason: string; exitCode: number; ts: number } | null = null
/** 一次性读后清：返回最近一次 Renderer 崩溃 reason/exitCode（剥 ts——契约 RendererCrashEvent 无 ts），读后置 null */
export function getCrashMarker(): { reason: string; exitCode: number } | null {
  const m = crashMarker
  crashMarker = null
  return m ? { reason: m.reason, exitCode: m.exitCode } : null
}

// —— 阶段 7 批次 B（D7B-05/06/07）：render-process-gone 抽函数——单一可测入口（对齐 handleChildProcessGone 模式）——
//    注入 deps（logger/audit 可选 + marker/setMarker/reload）；clean-exit 正常关窗退出不处理；
//    非 clean-exit → warn + audit(renderer:crash) + 写 crashMarker（renderer 已死收不到 push，marker 供 reload 后 getLastCrash 读）+ reload。
export function handleRendererGone(details: { reason: string; exitCode: number }, deps: {
  logger?: Logger
  audit?: (e: Omit<AuditEvent, 'ts'>) => void
  marker: { reason: string; exitCode: number; ts: number } | null
  setMarker: (m: { reason: string; exitCode: number; ts: number }) => void
  reload: () => void
}): void {
  if (details.reason === 'clean-exit') return
  deps.logger?.warn('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
  deps.audit?.({ type: 'renderer:crash', summary: `渲染进程异常：${details.reason} (exit ${details.exitCode})` })
  deps.setMarker({ reason: details.reason, exitCode: details.exitCode, ts: Date.now() })  // D7B-05 修正：renderer 已死收不到 push——marker 供 reload 后 getLastCrash 读
  deps.reload()  // D7B-06/07
}

let pendingFocus = false
let appStarted = false
function setPendingFocus(): void { pendingFocus = true }
function consumePendingFocus(): boolean { const p = pendingFocus; pendingFocus = false; return p }
export function markAppStarted(): void { appStarted = true }

// D-P7：麦克风权限处理器只注册一次（setPermission*Handler 全局覆盖；热重载/多窗重复调用会重复覆盖）
let micPermissionRegistered = false
function registerMicrophonePermissionOnce(): void {
  if (micPermissionRegistered) return
  micPermissionRegistered = true
  registerMicrophonePermission(session.defaultSession)
}

export interface MainWindowOpts {
  /** 阶段 7 批次 A（Task 5，spec §6.4）：开发者模式会话态 getter（F12 门）；缺省恒 false（模块不反向依赖服务） */
  isDevMode?: () => boolean
}

export function createMainWindow(loadErrorSink?: (err: unknown) => void, opts?: MainWindowOpts): void {
  registerMicrophonePermissionOnce()
  const config = getAppConfig()
  const isDevMode = opts?.isDevMode ?? (() => false)
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  // 加载/导航统一谓词（shouldUseViteDevServer = 未打包 && 有 dev server）：
  // dev（electron-vite dev，含 --mode test）→ http；打包恒 cyrene://（残留 dev env 无法劫持）；
  // 无 dev server（test/production 构建、--mode development 直启）→ cyrene://。
  const usingDevServer = shouldUseViteDevServer(app.isPackaged, process.env)
  const devEval = evaluateDevRendererUrl(devUrl, process.env)
  const devOrigin = usingDevServer && devEval.status === 'trusted' ? devEval.url : undefined
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 1100, // 阶段 3 G1（决策 D9）：与 renderer layout/constants.ts MIN_WINDOW_WIDTH 一致
    minHeight: 700, // 阶段 3 G1（决策 D9）：与 renderer layout/constants.ts MIN_WINDOW_HEIGHT 一致
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#181e29',
    title: 'Cyrene',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // D7A-04（阶段 7 批次 A）：devTools 恒 true——开关为唯一开启路径：诊断设置页 devMode 开关（openDevTools/closeDevTools
      // 经 onDevModeChange 接线）+ F12 门（config.devToolsAllowed || isDevMode()）。远程调试端口恒关不变（rejectForbiddenDebugSwitches 不动）。
      devTools: true, // 开关收敛：D7A-04（见上）——既有 devToolsAllowed 仅作 F12 快捷门的另一半判据
      // backgroundThrottling: false——渲染进程 timer/rAF 恒定运行，不随窗口遮挡/失焦节流。
      // 理由（2026-08-19 CI 修复）：① CI 无 WM 的 xvfb 下窗口被判为遮挡 → Chromium 默认节流（timer~1/秒 +
      // rAF 暂停）→ Live2D 渲染环停摆（C1 口型/C2.1 画布 0 像素）；② 生产上全渲染进程 timer 节流会拖慢
      // 流式回复/语音/TTS 等实时链路（窗口被遮时）。Live2D 的「窗口隐藏暂停」由 app 自有 active 门
      // （live2dShown ∧ enabled，Panel startStop 停 rAF）负责，不依赖 Chromium 全局节流。
      backgroundThrottling: false
    }
  })
  setMainWindow(win)

  let shown = false
  const showOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    win.show()
  }
  win.on('ready-to-show', () => { showOnce() })
  win.on('closed', () => { if (getMainWindow() === win) setMainWindow(null) })
  const t = setTimeout(showOnce, 5000)
  win.on('ready-to-show', () => clearTimeout(t))
  win.on('closed', () => clearTimeout(t))

  win.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http:') || details.url.startsWith('https:')) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // P1-12（M-01，2026-09-11）：renderer 控制台错误 → Main 日志（进而进诊断包）。
  // 此前 renderer 侧 JS 错误完全不在诊断包里，而 renderer 恰是最常出问题的一侧。
  // 用**模块级** sink（与 crashSink 同款理由：second-instance/activate 的 focusOrDefer 不带 opts，
  // 每窗口 sink 会丢），只转发 error 级并按滑窗限流（详见 renderer-console.ts 头注）。
  // 签名（Electron 43 实测，勿凭记忆改）：`WebContents.on('console-message')` 的**第一个参数**
  // 就是事件对象本身，参数在它上面（`Event<WebContentsConsoleMessageEventParams>`：message/level/
  // lineNumber/sourceId/frame）；后面那几个位置参数（level:number、message:string…）是**已废弃**的
  // 兼容形态。d.ts 只声明了废弃形态的位置参数，故 `(e, details)` 写法会把 details 推成 number——
  // 这正是本仓库在 `render-process-gone` 上踩过的同类签名坑。
  win.webContents.on('console-message', (details) => {
    rendererConsoleSink.handle({
      level: details.level,
      message: details.message,
      sourceId: details.sourceId,
      lineNumber: details.lineNumber
    })
  })

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault() // 默认 deny
    const kind = classifyNavigation(url, devOrigin, usingDevServer)
    if (kind === 'app') { win.loadURL(url).catch(() => { /* fail-closed */ }); return }
    if (kind === 'external') { shell.openExternal(url).catch(() => { /* 系统浏览器拒绝时吞掉，fail-closed */ }); return }
    // deny（preventDefault 已调）
  })

  // D7A-04（spec §6.4）：F12 运行期门——恒注册处理器，按下时按当前态判定。
  // （最终 review MED-1 修正：创建时一次性求值会使打包态 F12 永不注册——devMode 只能在窗口创建后
  //  经设置页开启；运行期判定保持「非 dev 构建且非 devMode 时 F12 无效果」语义不变）
  win.webContents.on('before-input-event', (_ev, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && (config.devToolsAllowed || isDevMode())) {
      win.webContents.toggleDevTools()
    }
  })

  // D7B-05/D7B-07：Renderer 崩溃——检测 + 持久化 marker + 自动 reload + 审计。
  // 注意：render-process-gone 在 win.webContents（WebContents 类，electron.d.ts:17304）真实签名是 **2 参** (event, details)——details 是第 2 参。
  //   （brief 引用的 3 参 (event, webContents, details) 隶属于 App 类接口 electron.d.ts:700，非 WebContents——H-1 定位错误；此处以真实 WebContents 签名为准。）
  // 抽函数 handleRendererGone：注入 crashSink（logger/audit）+ crashMarker（读写经闭包）+ reload（win 生存守卫）。
  win.webContents.on('render-process-gone', (_ev, details) => {
    handleRendererGone(details, {
      logger: crashSink.logger,
      audit: crashSink.audit,
      marker: crashMarker,
      setMarker: (m) => { crashMarker = m },
      reload: () => { if (!win.isDestroyed() && win.webContents) win.webContents.reload() },
    })
  })

  if (usingDevServer && devOrigin) {
    win.loadURL(devOrigin.toString()).catch((err) => { loadErrorSink?.(err) })
  } else {
    // 打包/直启 cyrene://：失败必须留诊断（handler 缺失→404 空白窗）
    win.loadURL(`${PROTOCOL_SCHEME}://${RENDERER_HOST}/index.html`).catch((err) => { loadErrorSink?.(err) })
  }
}

export function ensureMainWindow(loadErrorSink?: (err: unknown) => void, opts?: MainWindowOpts): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    createMainWindow(loadErrorSink, opts)
    if (consumePendingFocus()) { const w = getMainWindow(); if (w) { if (w.isMinimized()) w.restore(); if (!w.isVisible()) w.show(); w.focus() } }
    return
  }
}

export function focusOrDefer(opts?: MainWindowOpts): void {
  const win = getMainWindow()
  if (!win) {
    if (app.isReady() && appStarted) { createMainWindow(undefined, opts); raiseWindow(); return }
    setPendingFocus()
    return
  }
  if (win.isDestroyed()) { createMainWindow(undefined, opts); raiseWindow(); return }
  raiseWindow()
}

function raiseWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}
