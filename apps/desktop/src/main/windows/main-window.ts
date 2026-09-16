// apps/desktop/src/main/windows/main-window.ts
import { app, session, shell } from 'electron'
import { join } from 'path'
import { getMainWindow, setMainWindow } from '../ipc/registry'
import { getAppConfig, shouldUseViteDevServer } from '../config'
import { evaluateDevRendererUrl } from '../config/trusted-renderer-origin'
import { PROTOCOL_SCHEME, RENDERER_HOST } from '../protocol'
import { classifyNavigation } from './navigation'
import { registerMicrophonePermission } from './mic-permission'
import { createRendererConsoleSink } from './renderer-console'
// Silent Test Window Mode（2026-09-12）：一切窗口呈现动作经统一边界——本文件不再直接
// new BrowserWindow / show() / focus() / restore() / toggleDevTools（见 window-presentation.ts 头注）。
import { createAppWindow, focusWindow, showWindow, toggleWindowDevTools } from './window-presentation'
import { defaultDialogService } from '../native-ui/dialog-service'   // 加载失败/风暴停止重载的用户提示（唯一原生 UI 边界；silent 下只留痕不弹窗）
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
//    注入 deps（logger/audit 可选 + setMarker/reload）；clean-exit 正常关窗退出不处理；
//    非 clean-exit → warn + audit(renderer:crash) + 写 crashMarker（renderer 已死收不到 push，marker 供 reload 后 getLastCrash 读）+ reload。
export function handleRendererGone(details: { reason: string; exitCode: number }, deps: {
  logger?: Logger
  audit?: (e: Omit<AuditEvent, 'ts'>) => void
  setMarker: (m: { reason: string; exitCode: number; ts: number }) => void
  /** 崩溃 reload 风暴抑制（2026-09-16 审计 P2）。**必填**：给默认值就等于"忘了传也没有这道保护" */
  stormGuard: CrashStormGuard
  /** 因风暴而停止自动重载时的用户可见提示（经 native-ui 边界；silent 测试模式自动短路） */
  notifyStorm?: (recent: number) => void
  reload: () => void
}): void {
  if (details.reason === 'clean-exit') return
  deps.logger?.warn('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
  deps.audit?.({ type: 'renderer:crash', summary: `渲染进程异常：${details.reason} (exit ${details.exitCode})` })
  deps.setMarker({ reason: details.reason, exitCode: details.exitCode, ts: Date.now() })  // D7B-05 修正：renderer 已死收不到 push——marker 供 reload 后 getLastCrash 读
  const storm = deps.stormGuard.record()
  if (!storm.allowReload) {
    // 不再 reload：窗口数秒内反复崩溃是**确定性**故障的形态，继续重载只会把同一件事重复下去，
    // 而用户始终停在白屏前、日志与审计被同一件事刷满。
    deps.logger?.warn('renderer:crash-storm', { recent: storm.recent, windowMs: CRASH_RELOAD_WINDOW_MS })
    deps.audit?.({ type: 'renderer:crash-storm', summary: `渲染进程在 ${Math.round(CRASH_RELOAD_WINDOW_MS / 1000)} 秒内崩溃 ${storm.recent} 次，已停止自动重载` })
    deps.notifyStorm?.(storm.recent)
    return
  }
  deps.reload()  // D7B-06/07
}

/**
 * 崩溃 reload 的风暴抑制（2026-09-16 审计 P2「崩溃自动 reload 无风暴抑制」）。
 *
 * 修复前：每次非 clean-exit 崩溃都无条件 reload——没有计数、没有退避、没有上限、没有时间窗，
 * `crashMarker` 是单槽覆盖式（不是计数）。判据只有一个"窗口还活着"。
 *
 * 计数是**每窗口一份**（在 `createMainWindow` 闭包内创建），刻意不用模块级单例：
 * 模块级状态会让单测互相污染（前一条用例制造的崩溃把后一条推进"风暴"），而这类污染正是本仓
 * 反复记录过的假红/假绿来源。
 */
export const CRASH_RELOAD_MAX = 3
export const CRASH_RELOAD_WINDOW_MS = 60_000
export interface CrashStormGuard {
  /** 记一次崩溃并回答"还能不能自动重载"（`recent` = 时间窗内的崩溃次数） */
  record(): { allowReload: boolean; recent: number }
}
export function createCrashStormGuard(now: () => number = Date.now): CrashStormGuard {
  const stamps: number[] = []
  return {
    record(): { allowReload: boolean; recent: number } {
      const ts = now()
      stamps.push(ts)
      while (stamps.length > 0 && ts - (stamps[0] ?? ts) > CRASH_RELOAD_WINDOW_MS) stamps.shift()
      return { allowReload: stamps.length <= CRASH_RELOAD_MAX, recent: stamps.length }
    },
  }
}

// —— 2026-09-16 审计 P2：主 frame 加载失败 / 渲染进程无响应 ——
// 此前这两个事件**全仓零订阅点**：加载失败只有 `loadURL(...).catch` 留一行日志（无 UI、无重试），
// 而 `render-process-gone` 既不覆盖"主 frame 加载失败"（那时 renderer 通常还活着），也不覆盖
// "无响应"（卡死不是退出）。于是两种情况在用户侧都是**无提示白屏**，且没有任何恢复入口。
/** Chromium 的 ERR_ABORTED：用户/代码主动取消导航，不是失败，不该提示用户也不该重试 */
export const ERR_ABORTED = -3
export const LOAD_RETRY_LIMIT = 1
export const LOAD_RETRY_DELAY_MS = 1000
export function shouldHandleLoadFailure(input: { errorCode: number; isMainFrame: boolean }): boolean {
  if (!input.isMainFrame) return false
  return input.errorCode !== ERR_ABORTED
}
/** 用户可读的失败描述。URL 只会是 `cyrene://…` 或受信 dev http，非用户本机路径 */
export function describeLoadFailure(input: { errorCode: number; errorDescription: string; url: string }): string {
  return `页面加载失败（${input.errorCode} ${input.errorDescription || '未知原因'}）：${input.url || '未知地址'}`
}

let pendingFocus = false
let appStarted = false
function setPendingFocus(): void { pendingFocus = true }
function consumePendingFocus(): boolean { const p = pendingFocus; pendingFocus = false; return p }
export function markAppStarted(): void { appStarted = true }

// —— 2026-09-16 审计 P1-1（H-04 在真实退出路径上恒空转）：关窗前 flush 钩子 ——
// 同样提升为模块级（理由同 crashSink/rendererConsoleSink：`focusOrDefer` 在 second-instance/activate
// 上不带 opts，per-opts 会丢）。装配根在建好 requester 后注册一次。
let beforeCloseFlush: (() => Promise<void>) | undefined
export function setBeforeCloseFlush(fn: (() => Promise<void>) | undefined): void { beforeCloseFlush = fn }

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
  // 主 frame 的加载目标：dev（受信 http）或打包/直启 cyrene://。**唯一来源**——下面的首次加载与
  // did-fail-load 的重试都读它，避免"重试打到另一个地址"这种最难查的分叉。
  const loadTarget = devOrigin ? devOrigin.toString() : `${PROTOCOL_SCHEME}://${RENDERER_HOST}/index.html`
  // 崩溃风暴抑制：每窗口一份（理由见 createCrashStormGuard 注记）
  const crashStormGuard = createCrashStormGuard()
  // 主 frame 加载失败的有界重试计数（见下方 did-fail-load 处理器）
  let loadRetries = 0
  const win = createAppWindow({
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

  // 首帧就绪后显示一次（silent 测试模式下 showWindow 是 no-op——窗口保持隐藏但 renderer 照常运行）。
  // 5s 兜底定时器保留原语义：ready-to-show 未在预算内到达时也把窗口交出去（silent 下同样被门短路），
  // 避免"窗口永远不出现"这类只在异常路径暴露的回归。
  let shown = false
  const showOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    showWindow(win)
  }
  win.on('ready-to-show', () => { showOnce() })
  win.on('closed', () => { if (getMainWindow() === win) setMainWindow(null) })
  const t = setTimeout(showOnce, 5000)
  win.on('ready-to-show', () => clearTimeout(t))
  win.on('closed', () => clearTimeout(t))

  // —— 2026-09-16 审计 P1-1：真实退出路径上的持久化 flush ——
  // 缺陷：Windows/Linux 上用户退出应用的**唯一**路径是关闭最后一个窗口，其事件顺序经同版本
  // Electron 43.3.0 实测为 close → closed（此刻 windows=0、getMainWindow() 已置 null）
  //   → window-all-closed（index.ts 里 app.quit()）→ before-quit。
  // 而 flush 的唯一投递点 `createPersistFlushRequester.deliver()` 读的正是 getMainWindow()，
  // 在 before-quit 时恒为 null ⇒ `deliver()` 返回 false ⇒ requester 立即 resolve（fail-open）
  // ⇒ 草稿 800ms / 设置 500ms / 布局 200ms / 角色草稿防抖写全部静默丢失。
  // Renderer 侧也没有 `beforeunload`/`pagehide`/`unload` 补偿通道（全仓 0 命中），故必须在
  // 窗口级 close 上拦一次——它严格早于 closed。
  //
  // 为什么 `destroy()` 而不是再 `close()`：这里已经 flush 完，destroy 直接进 closed，避免二次 close
  // 递归；Renderer 无 beforeunload 处理器（同上 0 命中），跳过它不丢任何行为。
  // 有界：requester 自带 700ms 预算（超时也 resolve），故最多延迟关窗 700ms 且绝不阻断退出。
  // app.quit() 路径不受影响：那条路上 before-quit 先 make preventDefault 跑完 flush，本钩子只会
  // 再问一次（Renderer 已落盘，毫秒级 ack）。
  let closeFlushDone = false
  win.on('close', (event) => {
    if (closeFlushDone || !beforeCloseFlush) return   // 未注册钩子 → 保持原有直通语义
    closeFlushDone = true
    event.preventDefault()
    void (async () => {
      try {
        await beforeCloseFlush?.()
      } catch {
        // fail-open：flush 自身失败绝不能把窗口留在打不开也关不掉的状态
      } finally {
        if (!win.isDestroyed()) win.destroy()
      }
    })()
  })

  win.webContents.setWindowOpenHandler((details) => {
    // P1-11（type-aware lint 抓到）：这里此前没有接 `.catch`，而**同一个文件的 will-navigate 分支有**。
    // 外链打开失败会变成 Main 的未处理拒绝；两处行为应当一致，故补齐（fail-closed：拒绝时什么都不做）。
    if (details.url.startsWith('http:') || details.url.startsWith('https:')) {
      shell.openExternal(details.url).catch(() => { /* 系统浏览器拒绝时吞掉，fail-closed */ })
    }
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
      toggleWindowDevTools(win)
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
      setMarker: (m) => { crashMarker = m },
      stormGuard: crashStormGuard,
      notifyStorm: (recent) => {
        // 原生错误框是同步阻塞调用；但走到这里时 renderer **已经死透且停止重载**，
        // 不阻塞什么，而"什么都不说"就是审计报告点名的无提示白屏。silent 测试模式下 dialog-service
        // 只记录调用并转 stderr，不会弹窗打扰宿主桌面。
        defaultDialogService().showErrorBox(
          '界面已停止自动重载',
          `页面在 ${Math.round(CRASH_RELOAD_WINDOW_MS / 1000)} 秒内崩溃了 ${recent} 次，已停止自动重载以免反复重启。\n\n请关闭并重新打开应用；若反复出现，请在设置页导出诊断包以便定位。`,
        )
      },
      reload: () => { if (!win.isDestroyed() && win.webContents) win.webContents.reload() },
    })
  })

  // 主 frame 加载失败：留痕 + 一次有界重试 + 仍失败则给出用户可见提示（而不是无提示白屏）。
  // 重试只做一次且带延迟：瞬时故障（协议处理器尚未就绪、dev server 刚起来）值得一次机会，
  // 而"无限重试"与崩溃风暴同形，会变成另一种打转。
  win.webContents.on('did-fail-load', (_ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!shouldHandleLoadFailure({ errorCode, isMainFrame })) return
    const url = String(validatedURL || loadTarget)
    const description = String(errorDescription ?? '')
    const detail = describeLoadFailure({ errorCode, errorDescription: description, url })
    crashSink.logger?.error('window:did-fail-load', { errorCode, errorDescription: description, url })
    crashSink.audit?.({ type: 'renderer:load-failed', summary: detail })
    if (loadRetries < LOAD_RETRY_LIMIT) {
      loadRetries++
      crashSink.logger?.warn('window:load-retry', { attempt: loadRetries, delayMs: LOAD_RETRY_DELAY_MS })
      const timer = setTimeout(() => {
        if (win.isDestroyed()) return
        // 再失败会再次进入本处理器（那时 loadRetries 已到上限 → 走提示分支）
        win.loadURL(url).catch(() => { /* 失败由 did-fail-load 承接，这里不重复留痕 */ })
      }, LOAD_RETRY_DELAY_MS)
      win.on('closed', () => clearTimeout(timer))
      return
    }
    defaultDialogService().showErrorBox(
      '页面加载失败',
      `${detail}\n\n已重试 ${loadRetries} 次仍未成功。请关闭并重新打开应用；若反复出现，请在设置页导出诊断包。`,
    )
  })

  // 渲染进程无响应（界面冻结）：留痕 + **非阻塞**的标题提示。
  // 这里刻意不用错误框：`showErrorBox` 是同步阻塞调用，界面已经卡住时再阻塞 Main 会让 IPC 一起停摆
  // ——那会把"界面卡住"升级成"整个应用卡住"。标题是唯一既不阻塞又对用户可见的现成面。
  win.webContents.on('unresponsive', () => {
    crashSink.logger?.warn('renderer:unresponsive', {})
    crashSink.audit?.({ type: 'renderer:unresponsive', summary: '渲染进程无响应（界面冻结）' })
    if (!win.isDestroyed()) win.setTitle('Cyrene — 界面无响应')
  })
  win.webContents.on('responsive', () => {
    crashSink.logger?.info('renderer:responsive', {})
    if (!win.isDestroyed()) win.setTitle('Cyrene')
  })

  // dev → 受信 http（electron-vite dev，含 --mode test）；打包/直启 → cyrene://（残留 dev env 无法劫持）。
  // 失败必须留诊断（handler 缺失 → 404 空白窗）；`loadTarget` 与 did-fail-load 的重试**同源**。
  win.loadURL(loadTarget).catch((err) => { loadErrorSink?.(err) })
}

export function ensureMainWindow(loadErrorSink?: (err: unknown) => void, opts?: MainWindowOpts): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    createMainWindow(loadErrorSink, opts)
    if (consumePendingFocus()) focusWindow(getMainWindow())
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

/**
 * 把主窗口提到前台（second-instance / activate / 待决聚焦）。
 * silent 测试模式下 focusWindow 是 no-op——「第二个实例」与托盘/激活类路径都不能抢焦点，
 * 但生产语义（restore → show → focus）逐字不变。
 */
function raiseWindow(): void {
  focusWindow(getMainWindow())
}
