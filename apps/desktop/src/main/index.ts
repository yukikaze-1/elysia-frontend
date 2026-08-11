// apps/desktop/src/main/index.ts
import { app, dialog, Menu, safeStorage } from 'electron'
import { join } from 'path'
import { realpath } from 'fs/promises'
import { BACKEND_TOKEN_KEY, isKeyAllowed } from '@shared/contracts'
import type { ConnectionState } from '@shared/contracts/backend'
import type { Message } from '@shared/contracts/message'
import { installAppIdentity, expectedUserDataBase } from './app/lifecycle'
import { ensureUserDataDirs, UserDataDirError } from './persistence/user-data-dirs'
import { registerHandlers } from './ipc/handlers'
import { getMainWindow } from './ipc/registry'
import { ensureMainWindow, focusOrDefer, markAppStarted } from './windows/main-window'
import { hasForbiddenDebugSwitch, hasForbiddenNodeOptions } from './config/debug-switches'
import { getAppConfig, shouldUseViteDevServer } from './config'
import { registerCyreneScheme, registerCyreneProtocolHandler } from './protocol'
import { createDiagnostics } from './diagnostics'
import { createShutdownHandler } from './shutdown'
import { CredentialStore } from './credentials/credential-store'
import { createSanitizePublicMessage } from './diagnostics/sanitize'
import type { BackendAdapter } from './transport/backend-adapter'
import { MockBackend } from './transport/mock-backend'
import { RealBackend } from './transport/real-backend'
import { createChatService, type ChatService } from './chat/chat-service'

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
    const dirs = await ensureUserDataDirs(expectedUserDataBase(), { baseCreated })
    const sanitize = createSanitizePublicMessage({ home: app.getPath('home'), userData: expectedUserDataBase() })
    const safeRoot = await realpath(expectedUserDataBase())
    const diagnostics = createDiagnostics({ logs: dirs.logs, audit: dirs.audit }, { logLevel: config.logLevel, retentionDays: 30, sanitize })
    const store = new CredentialStore(join(dirs.config, 'credentials.json'), safeStorage, isKeyAllowed, safeRoot)
    // 装配 chat-service：MockBackend 默认(演示免 token)；B-01 联调时设 CYRENE_BACKEND=real 切 RealBackend。
    // onConnectionStateChange → svc.pushState；onSessionReplay → svc.pushReplay(chat:replay 生产侧桥,P1-1)。
    // MockBackend 无 onSessionReplay 选项,回放桥仅 RealBackend 分支生效；
    // 用 const 桥容器打破 adapter→svc 环引用(adapter 构造在前、svc 在后,回调只在 connect/disconnect/会话回放时触发,此时已装配完)。
    const chatBridge: { svc: ChatService | undefined } = { svc: undefined }
    const onState = (state: ConnectionState) => chatBridge.svc?.pushState(state)
    const onReplay = (conversationId: string, messages: Message[]) => chatBridge.svc?.pushReplay(conversationId, messages)
    const adapter: BackendAdapter = process.env['CYRENE_BACKEND'] === 'real'
      ? new RealBackend({ onConnectionStateChange: onState, onSessionReplay: onReplay })
      : new MockBackend({ onConnectionStateChange: onState })
    const chatSvc = createChatService({
      adapter,
      send: (channel, payload) => { const w = getMainWindow(); w?.webContents.send(channel, payload) },   // P3:webContents 守卫(窗口未建不崩)
      getToken: () => store.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined),   // R1:CredentialStore 是 async getCredential
      requireToken: adapter instanceof MockBackend ? false : true
    })
    chatBridge.svc = chatSvc
    registerHandlers({ credentials: store, logger: diagnostics.logger, chat: chatSvc })
    app.on('before-quit', createShutdownHandler({ closeAll: diagnostics.closeAll, quit: () => app.quit() }))
    diagnostics.logger.info('app:user-data-ready', { baseCreated, config: dirs.config, logs: dirs.logs, audit: dirs.audit })
    if (!shouldUseViteDevServer(app.isPackaged, process.env)) {
      await registerCyreneProtocolHandler(join(__dirname, '../renderer'))
      diagnostics.logger.info('protocol:registered')
    }
    diagnostics.logger.info('app:started', { mode: config.mode, packaged: app.isPackaged })
    markAppStarted()
    ensureMainWindow((err) => diagnostics.logger.error('window:load-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) }))
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
