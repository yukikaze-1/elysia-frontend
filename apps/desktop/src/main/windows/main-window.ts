// apps/desktop/src/main/windows/main-window.ts
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { getMainWindow, setMainWindow } from '../ipc/registry'
import { getAppConfig, shouldUseViteDevServer } from '../config'
import { PROTOCOL_SCHEME, RENDERER_HOST } from '../protocol'
import { classifyNavigation } from './navigation'

let pendingFocus = false
let appStarted = false
function setPendingFocus(): void { pendingFocus = true }
function consumePendingFocus(): boolean { const p = pendingFocus; pendingFocus = false; return p }
export function markAppStarted(): void { appStarted = true }

export function createMainWindow(loadErrorSink?: (err: unknown) => void): void {
  const config = getAppConfig()
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  // 加载/导航统一谓词（shouldUseViteDevServer = 未打包 && 有 dev server）：
  // dev（electron-vite dev，含 --mode test）→ http；打包恒 cyrene://（残留 dev env 无法劫持）；
  // 无 dev server（test/production 构建、--mode development 直启）→ cyrene://。
  const usingDevServer = shouldUseViteDevServer(app.isPackaged, process.env)
  // devOrigin 仅在 usingDevServer 下解析，且 try/catch——打包/残留畸形 ELECTRON_RENDERER_URL 不崩建窗（导航门 deny 兜底）
  let devOrigin: URL | undefined
  if (usingDevServer && devUrl) {
    try { devOrigin = new URL(devUrl) } catch { devOrigin = undefined }
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 736,
    minHeight: 560,
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
      devTools: config.devToolsAllowed // BrowserWindow 层封死 DevTools：打包恒 false（Electron 安全检查清单项）
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

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault() // 默认 deny
    const kind = classifyNavigation(url, devOrigin, usingDevServer)
    if (kind === 'app') { win.loadURL(url).catch(() => { /* fail-closed */ }); return }
    if (kind === 'external') { shell.openExternal(url).catch(() => { /* 系统浏览器拒绝时吞掉，fail-closed */ }); return }
    // deny（preventDefault 已调）
  })

  if (config.devToolsAllowed) {
    win.webContents.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    })
  }

  if (usingDevServer && devUrl) {
    win.loadURL(devUrl).catch((err) => { loadErrorSink?.(err) })
  } else {
    // 打包/直启 cyrene://：失败必须留诊断（handler 缺失→404 空白窗）
    win.loadURL(`${PROTOCOL_SCHEME}://${RENDERER_HOST}/index.html`).catch((err) => { loadErrorSink?.(err) })
  }
}

export function ensureMainWindow(loadErrorSink?: (err: unknown) => void): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    createMainWindow(loadErrorSink)
    if (consumePendingFocus()) { const w = getMainWindow(); if (w) { if (w.isMinimized()) w.restore(); if (!w.isVisible()) w.show(); w.focus() } }
    return
  }
}

export function focusOrDefer(): void {
  const win = getMainWindow()
  if (!win) {
    if (app.isReady() && appStarted) { createMainWindow(); raiseWindow(); return }
    setPendingFocus()
    return
  }
  if (win.isDestroyed()) { createMainWindow(); raiseWindow(); return }
  raiseWindow()
}

function raiseWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}
