// apps/desktop/src/main/index.ts
import { app, dialog } from 'electron'
import { installAppIdentity, expectedUserDataBase } from './app/lifecycle'
import { ensureUserDataDirs, UserDataDirError } from './persistence/user-data-dirs'
import { registerHandlers } from './ipc/handlers'
import { ensureMainWindow, focusOrDefer, markAppStarted } from './windows/main-window'

function failStart(message: string): void {
  dialog.showErrorBox('Cyrene 无法启动', message)
  app.exit(1)
}

async function main(): Promise<void> {
  let ident
  try {
    ident = installAppIdentity() // fatal（appData/base 真创建失败）→ failStart 弹框，不静默挂起
  } catch (e) {
    failStart(e instanceof Error ? e.message : '未知错误')
    return
  }
  const { baseCreated, setPathOk } = ident

  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }
  app.on('second-instance', () => focusOrDefer())

  await app.whenReady()

  try {
    app.setAppUserModelId('com.cyrene.desktop')
    // setPath 失败 = base 破损（文件/symlink）——直接弹框，不等 ensureUserDataDirs
    if (!setPathOk) {
      failStart(`userData 目录不可用：${expectedUserDataBase()}（请检查是否为普通文件或符号链接）`)
      return
    }
    await ensureUserDataDirs(expectedUserDataBase(), { baseCreated })
    registerHandlers()
    markAppStarted()
    ensureMainWindow()
  } catch (e) {
    failStart(e instanceof UserDataDirError ? e.message : `启动失败：${e instanceof Error ? e.message : '未知错误'}`)
  }

  app.on('activate', () => focusOrDefer())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

void main().catch((e) => {
  dialog.showErrorBox('Cyrene 无法启动', e instanceof Error ? e.message : '未知错误')
  app.exit(1)
})
