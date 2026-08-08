// apps/desktop/src/main/windows/main-window.ts
import { app, BrowserWindow, shell } from 'electron'
import { join, sep } from 'path'
import { fileURLToPath } from 'url'
import { realpath } from 'fs/promises'
import { getMainWindow, setMainWindow } from '../ipc/registry'

let pendingFocus = false
let appStarted = false
function setPendingFocus(): void { pendingFocus = true }
function consumePendingFocus(): boolean { const p = pendingFocus; pendingFocus = false; return p }
/** main() 在 registerHandlers 后调用——置位前 focusOrDefer 遇 null 只 defer，不抢在建窗前（避免 IPC handler 未注册时窗口已拉起） */
export function markAppStarted(): void { appStarted = true }

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host
}

async function isAppOwnUrl(targetUrl: string, rendererRoot: string): Promise<boolean> {
  try {
    const url = new URL(targetUrl)
    if (!app.isPackaged) {
      // dev：同源 http(s) 且不在 Vite 文件代理前缀
      const dev = process.env['ELECTRON_RENDERER_URL']
      if (dev && sameOrigin(url, new URL(dev)) && !url.pathname.startsWith('/@fs/') && !url.pathname.startsWith('/@vite/')) {
        return true
      }
      return false
    }
    if (url.protocol !== 'file:') return false
    const targetPath = await realpath(fileURLToPath(url))
    const root = await realpath(rendererRoot)
    const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
    // 路径边界：targetPath === root，或以 root + path.sep 开头——join('.') 返回 '.' 不是分隔符，勿用
    return lower(targetPath) === lower(root) || lower(targetPath).startsWith(lower(root) + sep)
  } catch {
    return false // fail-closed
  }
}

export function createMainWindow(): void {
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
      webSecurity: true
    }
  })
  setMainWindow(win) // new 后、load 前立即注入

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
    const root = join(__dirname, '../renderer')
    void isAppOwnUrl(url, root).then((own) => {
      try {
        if (own) { win.loadURL(url).catch(() => { /* 加载失败保持 preventDefault，fail-closed */ }); return }
        // 非自身但与应用同源（dev 的 /@fs/ 等被拦前缀）→ 拒绝，不开外部浏览器
        const dev = process.env['ELECTRON_RENDERER_URL']
        if (dev && !app.isPackaged && sameOrigin(new URL(url), new URL(dev))) return
        if (url.startsWith('http:') || url.startsWith('https:')) { shell.openExternal(url); return }
        // 其余 deny
      } catch {
        // fail-closed：异步分支任何异常都保持 preventDefault（已调），不崩溃
      }
    })
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']).catch(() => { /* fail-closed：加载失败不静默，窗口不显示由 5s 兜底 show 暴露 */ })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html')).catch(() => { /* fail-closed */ })
  }
}

export function ensureMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    createMainWindow()
    if (consumePendingFocus()) { const w = getMainWindow(); if (w) { if (w.isMinimized()) w.restore(); if (!w.isVisible()) w.show(); w.focus() } }
    return
  }
}

export function focusOrDefer(): void {
  const win = getMainWindow()
  if (!win) {
    // 已完整启动（handler 已注册）→ 重建；启动中途（await ensureUserDataDirs 间隙）→ 置待聚焦，
    // 避免窗口在 registerHandlers 前拉起、首个 getAppInfo() 无 handler 拒绝
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
