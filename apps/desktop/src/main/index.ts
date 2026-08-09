// apps/desktop/src/main/index.ts
import { app, dialog, Menu } from 'electron'
import { join } from 'path'
import { installAppIdentity, expectedUserDataBase } from './app/lifecycle'
import { ensureUserDataDirs, UserDataDirError } from './persistence/user-data-dirs'
import { registerHandlers } from './ipc/handlers'
import { ensureMainWindow, focusOrDefer, markAppStarted } from './windows/main-window'
import { hasForbiddenDebugSwitch, hasForbiddenNodeOptions } from './config/debug-switches'
import { getAppConfig, shouldUseViteDevServer } from './config'
import { registerCyreneScheme, registerCyreneProtocolHandler } from './protocol'

function failStart(message: string): void {
  dialog.showErrorBox('Cyrene 无法启动', message)
  app.exit(1)
}

// 打包：移除 DevTools 加速键。macOS 用最小菜单保留 Cmd+Q/Cmd+C/V（appMenu/editMenu/windowMenu 不含 View→DevTools）；
// 其余平台 null 即可。
function applyProductionMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  } else {
    Menu.setApplicationMenu(null)
  }
}

// main() 最前：Chromium 的 CDP 端口在 whenReady 前已绑定，门必须同步生效。
// 命中即 failStart + 返回 true，main() 检测后停止后续执行（不落到 scheme/身份副作用）。
function rejectForbiddenDebugSwitches(): boolean {
  const getSwitch = (n: string): { present: boolean; value: string } => ({
    present: app.commandLine.hasSwitch(n),
    value: app.commandLine.getSwitchValue(n)
  })
  // 仅测试 harness（verify:artifact 冒烟显式设 CYRENE_TEST_HARNESS=1）放行 =0 随机端口；生产默认严格拒绝
  const allowRandomPort = process.env['CYRENE_TEST_HARNESS'] === '1'
  if (app.isPackaged && hasForbiddenDebugSwitch(process.argv, getSwitch, allowRandomPort)) {
    failStart('远程调试/调试开关在发布构建中被禁用')
    return true
  }
  // NODE_OPTIONS 纯 env 通道（argv/commandLine 均不含它）：Electron main 是 Node，单 env 即开 inspector
  if (app.isPackaged && hasForbiddenNodeOptions(process.env['NODE_OPTIONS'])) {
    failStart('NODE_OPTIONS 含调试开关在发布构建中被禁用')
    return true
  }
  return false
}

async function main(): Promise<void> {
  if (rejectForbiddenDebugSwitches()) return
  registerCyreneScheme() // app ready 前

  let ident
  try {
    ident = installAppIdentity()
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
    if (!setPathOk) {
      failStart(`userData 目录不可用：${expectedUserDataBase()}（请检查是否为普通文件或符号链接）`)
      return
    }
    // 防御纵深断言（地基同款）：setPath 后实际 userData 必须等于预期路径，防未来重构/身份顺序变化漂移
    if (app.getPath('userData') !== expectedUserDataBase()) {
      failStart(`userData 路径异常：${app.getPath('userData')}（预期 ${expectedUserDataBase()}）`)
      return
    }
    const config = getAppConfig()
    if (!config.devToolsAllowed) applyProductionMenu() // 打包：无 View→DevTools 加速键（mac 保 Cmd+Q/C/V）
    await ensureUserDataDirs(expectedUserDataBase(), { baseCreated })
    registerHandlers()
    // 协议 handler 在「无 Vite dev server」场景注册（shouldUseViteDevServer = 未打包 && 有 ELECTRON_RENDERER_URL）：
    // dev（electron-vite dev，含 --mode test）→ 走 http 且不产出 out/renderer → 不注册；
    // 其余（打包、test/production 构建、--mode development 直启）→ shouldUseViteDevServer=false → 必须注册，
    // 否则 loadURL 落 cyrene:// 而 handler 缺失 → 404 空白窗。
    if (!shouldUseViteDevServer(app.isPackaged, process.env)) {
      await registerCyreneProtocolHandler(join(__dirname, '../renderer'))
    }
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
