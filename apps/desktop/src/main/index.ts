// apps/desktop/src/main/index.ts
import { app, dialog, Menu, safeStorage } from 'electron'
import { join } from 'path'
import { realpath } from 'fs/promises'
import { BACKEND_TOKEN_KEY, BACKEND_TOKEN_ORIGIN_KEY, isKeyAllowed } from '@shared/contracts'
import type { ConnectionState } from '@shared/contracts/backend'
import type { Message } from '@shared/contracts/message'
import { installAppIdentity, expectedUserDataBase } from './app/lifecycle'
import { ensureUserDataDirs, UserDataDirError } from './persistence/user-data-dirs'
import { registerHandlers } from './ipc/handlers'
import { getMainWindow } from './ipc/registry'
import { ensureMainWindow, focusOrDefer, markAppStarted } from './windows/main-window'
import { hasForbiddenDebugSwitch, hasForbiddenNodeOptions } from './config/debug-switches'
import { getAppConfig, shouldUseViteDevServer } from './config'
import { evaluateDevRendererUrl } from './config/trusted-renderer-origin'
import { resolveBackendMode } from './config/backend-mode'
import { ConnectionConfig } from './connection/connection-config'
import { registerCyreneScheme, registerCyreneProtocolHandler } from './protocol'
import { createDiagnostics, type Diagnostics } from './diagnostics'
import type { AuditEvent } from './diagnostics/audit'
import { createShutdownHandler, createFatalShutdown } from './shutdown'
import { CredentialStore } from './credentials/credential-store'
import { SessionStore } from './persistence/session-store'
import { createSanitizePublicMessage } from './diagnostics/sanitize'
import type { BackendAdapter } from './transport/backend-adapter'
import { MockBackend, parseMockHistoryCountEnv } from './transport/mock-backend'
import { RealBackend } from './transport/real-backend'
import { createChatService, type ChatService } from './chat/chat-service'
import { buildBackendErrorHandlers } from './chat/backend-error-handlers'
import { UploadService } from './attachments/upload-service'
import { MediaService } from './attachments/media-service'
import { defaultSafeOpenPlatform } from './persistence/safe-open'

let diagnostics: Diagnostics | undefined

const fatal = createFatalShutdown({
  showError: (m) => dialog.showErrorBox('Cyrene 无法启动', m),
  closeAll: () => (diagnostics ? diagnostics.closeAll() : Promise.resolve()),
  exit: (c) => app.exit(c)
})

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
// 命中即 fatal + 返回 true，main() 检测后停止后续执行（不落到 scheme/身份副作用）。
function rejectForbiddenDebugSwitches(): boolean {
  const getSwitch = (n: string): { present: boolean; value: string } => ({
    present: app.commandLine.hasSwitch(n),
    value: app.commandLine.getSwitchValue(n)
  })
  // 仅测试 harness（verify:artifact 冒烟显式设 CYRENE_TEST_HARNESS=1）放行 =0 随机端口；生产默认严格拒绝
  const allowRandomPort = process.env['CYRENE_TEST_HARNESS'] === '1'
  if (app.isPackaged && hasForbiddenDebugSwitch(process.argv, getSwitch, allowRandomPort)) {
    fatal('远程调试/调试开关在发布构建中被禁用')
    return true
  }
  // NODE_OPTIONS 纯 env 通道（argv/commandLine 均不含它）：Electron main 是 Node，单 env 即开 inspector
  if (app.isPackaged && hasForbiddenNodeOptions(process.env['NODE_OPTIONS'])) {
    fatal('NODE_OPTIONS 含调试开关在发布构建中被禁用')
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
    fatal(e instanceof Error ? e.message : '未知错误')
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
      fatal(`userData 目录不可用：${expectedUserDataBase()}（请检查是否为普通文件或符号链接）`)
      return
    }
    // 防御纵深断言（地基同款）：setPath 后实际 userData 必须等于预期路径，防未来重构/身份顺序变化漂移
    if (app.getPath('userData') !== expectedUserDataBase()) {
      fatal(`userData 路径异常：${app.getPath('userData')}（预期 ${expectedUserDataBase()}）`)
      return
    }
    const config = getAppConfig()
    if (!config.devToolsAllowed) applyProductionMenu() // 打包：无 View→DevTools 加速键（mac 保 Cmd+Q/C/V）
    const dirs = await ensureUserDataDirs(expectedUserDataBase(), { baseCreated })
    const sanitize = createSanitizePublicMessage({ home: app.getPath('home'), userData: expectedUserDataBase() })
    const safeRoot = await realpath(expectedUserDataBase())
    diagnostics = createDiagnostics({ logs: dirs.logs, audit: dirs.audit }, { logLevel: config.logLevel, retentionDays: 30, sanitize })
    // 审计 fail-open（C1）：fire-and-forget；外层 try/catch 兜注入实现同步抛错；ts 统一注入；可选链防 TS18048
    const audit = (event: Omit<AuditEvent, 'ts'>): void => {
      try {
        void diagnostics?.auditor?.audit({ ts: new Date().toISOString(), ...event }).catch((err) =>
          diagnostics?.logger.error('audit:write-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) })
        )
      } catch { /* fail-open 恒成立 */ }
    }
    // 启动门禁（B2/P0-02）：dev 模式下 ELECTRON_RENDERER_URL 必须指向受信地址（回环或 allowlist）。
    // 在 requestSingleInstanceLock 之后——只有持锁主实例评估（第二实例已在 lock 处 exit(0)）。
    // fatal exit 异步，故 untrusted 后必须 return，否则继续建窗/装配。
    if (!app.isPackaged) {
      const devEval = evaluateDevRendererUrl(process.env['ELECTRON_RENDERER_URL'], process.env)
      if (devEval.status === 'untrusted') {
        fatal(`ELECTRON_RENDERER_URL 指向不受信地址：${devEval.reason}（仅允许回环或 CYRENE_DEV_RENDERER_ORIGINS 白名单 http 地址）`)
        return
      }
    }
    const store = new CredentialStore(join(dirs.config, 'credentials.json'), safeStorage, isKeyAllowed, safeRoot)
    // 装配 chat-service：装配策略（spec 决策 7）打包恒 Real；未打包默认 Real，仅 CYRENE_BACKEND=mock 显式 Mock（演示免 token）。
    // onConnectionStateChange → svc.pushState；onSessionReplay → svc.pushReplay(chat:replay 生产侧桥,P1-1)。
    // MockBackend 无 onSessionReplay 选项,回放桥仅 RealBackend 分支生效；
    // 用 const 桥容器打破 adapter→svc 环引用(adapter 构造在前、svc 在后,回调只在 connect/disconnect/会话回放时触发,此时已装配完)。
    const useMock = resolveBackendMode(app.isPackaged, process.env) === 'mock'
    const mockHistoryCount = parseMockHistoryCountEnv(process.env.CYRENE_MOCK_HISTORY_LARGE)
    const chatBridge: { svc: ChatService | undefined } = { svc: undefined }
    const onState = (state: ConnectionState) => chatBridge.svc?.pushState(state)
    const onReplay = (conversationId: string, messages: Message[]) => chatBridge.svc?.pushReplay(conversationId, messages)
    const adapter: BackendAdapter = useMock
      ? new MockBackend({ onConnectionStateChange: onState, ...(mockHistoryCount !== undefined ? { seedHistoryCount: mockHistoryCount } : {}) })
      : (() => {
          // 协议告警/后端错误可见化:onProtocolWarning → 脱敏 warn 日志(不记正文/Token/原始帧);
          // onError → error 日志 + 推 chat:error 给 Renderer(连接面板展示)。getBuild 晚绑定 adapter,
          // 回调只在 connect/帧到达后触发,此时 adapter 已赋值(同 chatBridge 打破环引用的模式)。
          const errorHandlers = buildBackendErrorHandlers({
            logger: diagnostics.logger,
            sanitize,
            send: (channel, payload) => { const w = getMainWindow(); w?.webContents.send(channel, payload) },
            mode: useMock ? 'mock' : 'real',
            getBuild: () => ({ serverVersion: adapter.getConnectionState().serverVersion, protocolVersion: adapter.getConnectionState().protocolVersion }),
            audit   // C2:连接错误审计（fail-open）
          })
          return new RealBackend({
            onConnectionStateChange: onState,
            onSessionReplay: onReplay,
            onProtocolWarning: errorHandlers.onProtocolWarning,
            onError: errorHandlers.onError
          })
        })()
    // connection-config：注入 CredentialStore 端口（token 与 origin 绑定同仓不同 key）——
    // BACKEND_TOKEN_KEY 由 connection-config 的 set/clear 经 credentials IPC 特判委派（决策 9）。
    // onEndpointChanged 审计：只记规范化 origin（不含 token/完整 URL 参数，spec 3.1.2）；AuditEvent 字段 ts/type/summary（无 data）。
    const connConfig = new ConnectionConfig(
      {
        loadToken: () => store.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined),
        saveToken: (v) => store.setCredential(BACKEND_TOKEN_KEY, v),
        clearToken: () => store.clearCredential(BACKEND_TOKEN_KEY),
        loadBinding: () => store.getCredential(BACKEND_TOKEN_ORIGIN_KEY).then((t) => t ?? undefined),
        saveBinding: (o) => store.setCredential(BACKEND_TOKEN_ORIGIN_KEY, o),
        clearBinding: () => store.clearCredential(BACKEND_TOKEN_ORIGIN_KEY)
      },
      (e) => { audit({ type: 'endpoint:set', summary: e.origin }) }
    )
    // 阶段 3 G2 SessionStore（Main 持久化边界，docs/06 §14）：必须在 createChatService 之前装配（chat-service 钩子需要它）。
    // getActiveConversationId 闭包引用 chatBridge.svc（此时未赋值，但只在 connect 后的 persistSession 才调用，懒绑定安全）。
    const sessionStore = new SessionStore({
      appCache: dirs.appCache,
      safeRoot,
      logger: diagnostics.logger,
      countDiagnostic: (code: string) => diagnostics?.logger.warn('persistence:diagnostic', { code }),
      getActiveConversationId: () => chatBridge.svc?.getConnectionState().activeConversationId
    })
    await sessionStore.load() // 损坏隔离，不阻塞启动
    const chatSvc = createChatService({
      adapter,
      send: (channel, payload) => { const w = getMainWindow(); w?.webContents.send(channel, payload) },   // P3:webContents 守卫(窗口未建不崩)
      getToken: () => store.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined),   // R1:CredentialStore 是 async getCredential
      requireToken: !useMock,
      connectionConfig: connConfig,
      packaged: app.isPackaged,
      sessionStore,   // G2：listConversations 派生列表缓存 / activate 记 lastActive / deleteConversation purge
      audit   // C2:连接生命周期审计（connect/disconnect;fail-open）
    })
    chatBridge.svc = chatSvc
    // 阶段 3 G3 附件服务装配（spec §4.4/§4.5）：mediaSvc 需 connConfig.getEndpoint()（签发表 target 为后端 baseUrl），
    // 故放在 connConfig 创建之后、registerHandlers 之前；UploadService 经 adapter 直读盘（D5 路径只在 Main）。
    const uploadSvc = new UploadService({
      backend: adapter,
      userDataBase: expectedUserDataBase,
      platform: defaultSafeOpenPlatform()
    })
    const mediaSvc = new MediaService({
      backend: adapter,
      baseUrl: () => connConfig.getEndpoint()?.baseUrl
    })
    registerHandlers({ credentials: store, logger: diagnostics.logger, chat: chatSvc, connectionConfig: connConfig, sessionStore, attachments: { svc: uploadSvc, media: mediaSvc }, audit })
    app.on('before-quit', createShutdownHandler({
      steps: [
        { name: 'credentials', run: () => store.close() },
        { name: 'adapter', run: () => adapter.disconnect() },
        { name: 'diagnostics', run: () => diagnostics?.closeAll() ?? Promise.resolve() }
      ],
      quit: () => app.quit(),
      onTimeout: () => {
        audit({ type: 'shutdown:timed-out', summary: '退出超时，最后一批写入可能丢失' }) // 走统一 fail-open 包装（ts 注入 + write-failed 日志，批次 C 最终 review 收口）
        diagnostics?.logger.warn('shutdown:timed-out', { message: '退出超时，最后一批写入可能丢失' })
      },
      onError: (step, err) => diagnostics?.logger.error('shutdown:step-failed', { step, message: sanitize(err instanceof Error ? err.message : String(err)) })
    }))
    diagnostics.logger.info('app:user-data-ready', { baseCreated, config: dirs.config, logs: dirs.logs, audit: dirs.audit })
    // G3：媒体分支需 dev/prod 都注册——dev 页面在 Vite http，媒体 URL 在 cyrene://（spec §3.1）。
    // P1-5：dev（shouldUseViteDevServer）省略 rendererRoot——媒体分支不依赖它，避免 out/renderer 未构建时 realpath 抛错。
    await registerCyreneProtocolHandler({
      ...(!shouldUseViteDevServer(app.isPackaged, process.env) ? { rendererRoot: join(__dirname, '../renderer') } : {}),
      resolveMedia: (mediaType, id, request) => mediaSvc.stream(mediaType, id, request)
    })
    diagnostics.logger.info('protocol:registered')
    diagnostics.logger.info('app:started', { mode: config.mode, packaged: app.isPackaged })
    markAppStarted()
    ensureMainWindow((err) => diagnostics?.logger.error('window:load-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) }))
  } catch (e) {
    fatal(e instanceof UserDataDirError ? e.message : `启动失败：${e instanceof Error ? e.message : '未知错误'}`)
  }

  app.on('activate', () => focusOrDefer())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

void main().catch((e) => {
  fatal(e instanceof Error ? e.message : '未知错误')
})
