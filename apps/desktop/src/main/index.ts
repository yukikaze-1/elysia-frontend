import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'

/**
 * 创建主窗口。
 * Phase 0 只要求可运行空工程;安全基线(contextIsolation/sandbox/webSecurity)
 * 已按文档 07 开启,IPC 白名单与 CSP 细化属阶段 1。
 *
 * 注:不使用 @electron-toolkit/* 包——其在 pnpm peer 变体下会解析到错误的
 * electron 副本导致 require('electron').app 为 undefined(见 docs/16 备注)。
 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 外部链接一律交给系统浏览器,不新建窗口
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http:') || details.url.startsWith('https:')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Windows 通知/任务栏应用身份
  app.setAppUserModelId('com.cyrene.desktop')

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
