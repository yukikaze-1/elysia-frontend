// apps/desktop/src/main/index.ts
import { app, dialog, Menu, safeStorage, BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import { realpath } from 'fs/promises'
import { BACKEND_TOKEN_KEY, BACKEND_TOKEN_ORIGIN_KEY, PushChannels, isKeyAllowed } from '@shared/contracts'
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
import { createLive2dResolver } from './protocol/handler'
import { createDiagnostics, type Diagnostics } from './diagnostics'
import type { AuditEvent } from './diagnostics/audit'
import { createShutdownHandler, createFatalShutdown } from './shutdown'
import { CredentialStore } from './credentials/credential-store'
import { SessionStore } from './persistence/session-store'
import { SettingsService } from './settings/settings-service'
import { createSanitizePublicMessage } from './diagnostics/sanitize'
import type { BackendAdapter } from './transport/backend-adapter'
import { MockBackend, parseMockHistoryCountEnv, parseMockVoiceTranscriptDelayEnv, parseMockVoiceTranscriptEnv, parseMockEmitDelayEnv, parseMockEmotionEnv, parseMockMouthLevelEnv, parseMockMouthWindowEnv, parseMockDirectiveEnv, parseMockToolFlowEnv, parseMockToolHistoryEnv } from './transport/mock-backend'
import { RealBackend } from './transport/real-backend'
import { createChatService, type ChatService } from './chat/chat-service'
import { buildBackendErrorHandlers } from './chat/backend-error-handlers'
import { UploadService } from './attachments/upload-service'
import { MediaService } from './attachments/media-service'
import { defaultSafeOpenPlatform } from './persistence/safe-open'
import { Live2DModelRegistry } from './live2d/model-registry'
import { createToolStatusSender } from './tools/tool-status-sender'
import { createToolService, type ToolService } from './tools/tool-service'
import { createToolRegistry } from './tools/tool-registry'
import { createGrantStore } from './tools/grant-store'   // 批次 C（D6C-03/06）：目录授权仓库
import { isPathBlacklisted, normalizeToolPath } from './tools/tool-policy'   // 批次 C（F-4）：grant 目录归一 + 黑名单复核
import { MOCK_THUMBNAIL_DATA_URL, parseMockCaptureSourcesEnv, parseMockGrantDirectoryEnv, parseMockToolAllowRootEnv } from './tools/env-bridge'

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
    // P4-B Task 15 最小 env 桥：测试注入普通录音转写文本（显式空串=未识别，mock 不发 transcript）。
    // 仅跨 voiceTranscriptText——voiceError 注入不需要 env 桥（错误路由已有单测/集成覆盖）。
    const mockVoiceTranscript = parseMockVoiceTranscriptEnv(process.env.CYRENE_MOCK_VOICE_TRANSCRIPT)
    // Task 3 env 桥（R-S4-05）：mock 慢转写，集成可观察「正在识别…」等待态（Task 5 用）。undefined 不注入（缺省 0）；
    // 与 voiceTranscriptText 的「空串合法」语义刻意不同——延迟 env 空串 → Number('')=0 → 钳 0（无延迟），合法。
    const mockVoiceTranscriptDelay = parseMockVoiceTranscriptDelayEnv(process.env.CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS)
    // Task 6（阶段 5 批次 B 集成）：mock replay 事件间隔放宽（集成断言 thinking→speaking 稳定窗口）
    const mockEmitDelay = parseMockEmitDelayEnv(process.env.CYRENE_MOCK_EMIT_DELAY_MS)
    // Task 6（阶段 5 批次 B 集成）：generation.completed 情绪注入（情绪态→表情可观测）
    const mockGenerationEmotion = parseMockEmotionEnv(process.env.CYRENE_MOCK_GENERATION_EMOTION)
    // 批次 C（C1）集成 env 桥：mock 合成包络源选择（CYRENE_MOCK_MOUTH_LEVEL='step'/'sine'；undefined/非法 → 不注入）。
    // renderer 无法读 env（sandbox），经 getRuntimeInfo 水合窄字段 mockMouthLevel 下发（仅 mock 模式填充）。
    const mockMouthLevel = parseMockMouthLevelEnv(process.env.CYRENE_MOCK_MOUTH_LEVEL)
    // 批次 C（C1）集成稳健化：mock TTS 采样窗口时长（CYRENE_MOCK_MOUTH_WINDOW_MS；undefined → 缺省 1500ms）。
    // 慢 CI（SwiftShader 渲染饱和）上 1.5s 窗口可能被口部采样错过，集成测设更长窗口保证断言。
    const mockMouthWindowMs = parseMockMouthWindowEnv(process.env.CYRENE_MOCK_MOUTH_WINDOW_MS)
    // 批次 C（C3）集成 env 桥：mock 表现指令建议（CYRENE_MOCK_DIRECTIVE JSON → 下一 generation.completed 后发射；
    // 非法 JSON/字段不符 → 不注入，缺省不发射）
    const mockDirective = parseMockDirectiveEnv(process.env.CYRENE_MOCK_DIRECTIVE)
    // 阶段 6 批次 A（F-6-22）集成 env 桥：mock 工具双轨模拟（CYRENE_MOCK_TOOL_FLOW JSON → generation.completed 后
    // 按 kind 发射 tool.* 领域事件；非法 JSON/形状 → 不注入）与归档配对 seed（CYRENE_MOCK_TOOL_HISTORY='1'/'true'）
    const mockToolFlow = parseMockToolFlowEnv(process.env.CYRENE_MOCK_TOOL_FLOW)
    const mockToolHistory = parseMockToolHistoryEnv(process.env.CYRENE_MOCK_TOOL_HISTORY)
    // 阶段 7 批次 A（Task 3，可行 MED）：mock 回复正文夹具 env 桥——CYRENE_MOCK_REPLY_FIXTURE 指向本地文件，
    // 内容经 options.replyFixtureText 覆盖 mock 生成回复正文（集成 markdown-xss 注入 XSS 载荷用）。
    // 仅 mock 模式（useMock 门控——真实模式误设不注入，纪律同 mockMouthLevel）；renderer 不读 env；
    // 读取失败（路径缺失/权限）→ readFileSync 抛 IOException 构造报错 fail-start（测试夹具缺失属装配错误）。
    const mockReplyFixtureText = useMock && process.env.CYRENE_MOCK_REPLY_FIXTURE
      ? readFileSync(process.env.CYRENE_MOCK_REPLY_FIXTURE, 'utf-8')
      : undefined
    // P4-B TTS 实时朗读音频 sink 桥容器（Task 5 RealBackend getTtsMedia → Task 6 MediaService putTtsAudio）：
    // mediaSvc 在 adapter 之后创建，用 const 桥打破 adapter→media 环引用（与 chatBridge 同款模式）；
    // getTtsMedia 回调只在 audio_end 帧到达时触发，此时 mediaSvc 已装配完。
    const mediaBridge: { media: MediaService | undefined } = { media: undefined }
    const chatBridge: { svc: ChatService | undefined } = { svc: undefined }
    // 批次 B（Task 6）：tool-service 桥容器（MockBackend 构造 options 的 toolRequestSink 闭包读取——
    // toolSvc 在 adapter 之后构造，回调只在桌面工具请求到达时触发，此时已装配完）
    const toolBridge: { svc: ToolService | undefined } = { svc: undefined }
    const onState = (state: ConnectionState) => {
      chatBridge.svc?.pushState(state)
      // A-8（D6B-11）：重连成功（connected）→ 工具服务重发未确认终态 + 清 selected-set；首次连接无记录为 no-op
      if (state.status === 'connected') void toolBridge.svc?.reconnect()
    }
    const onReplay = (conversationId: string, messages: Message[]) => chatBridge.svc?.pushReplay(conversationId, messages)
    const adapter: BackendAdapter = useMock
      ? new MockBackend({ onConnectionStateChange: onState, ...(mockHistoryCount !== undefined ? { seedHistoryCount: mockHistoryCount } : {}), ...(mockVoiceTranscript !== undefined ? { voiceTranscriptText: mockVoiceTranscript } : {}), ...(mockVoiceTranscriptDelay !== undefined ? { transcriptDelayMs: mockVoiceTranscriptDelay } : {}), ...(mockEmitDelay !== undefined ? { emitDelayMs: mockEmitDelay } : {}), ...(mockGenerationEmotion !== undefined ? { generationEmotion: mockGenerationEmotion } : {}), ...(mockMouthLevel !== undefined ? { mockMouthLevel, ttsAudioSink: (id: string, bytes: Uint8Array, mime?: string) => mediaBridge.media?.putTtsAudio(id, bytes, mime) } : {}), ...(mockMouthWindowMs !== undefined ? { mouthTtsWindowMs: mockMouthWindowMs } : {}), ...(mockDirective !== undefined ? { directive: mockDirective } : {}), ...(mockToolFlow !== undefined ? { toolFlow: mockToolFlow } : {}), ...(mockToolHistory ? { toolHistory: true } : {}), ...(mockReplyFixtureText !== undefined ? { replyFixtureText: mockReplyFixtureText } : {}), toolRequestSink: (req) => { void toolBridge.svc?.handleRequest(req) } })
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
            onError: errorHandlers.onError,
            // P4-B：TTS 音频 sink（Task 5/6）。mediaBridge.media 未装配前返回 undefined → real-backend 告警丢弃（TTS_MEDIA_SINK_MISSING）
            getTtsMedia: () => mediaBridge.media
              ? { putTtsAudio: (id, bytes, mime) => mediaBridge.media!.putTtsAudio(id, bytes, mime) }
              : undefined
          })
        })()
    // —— 阶段 6 批次 C（V-4 HIGH 定案）：SettingsService 上移——批次 C 需在 createToolService 之前装配（GrantStore 构造依赖 settings）——
    // settings 不依赖 toolSvc（无环）；load 为 eager（save 在内存态上 merge，未装载即 save 会以默认值覆盖已有落盘值）。
    const settingsSvc = new SettingsService({ dir: dirs.config, safeRoot, logger: diagnostics.logger })
    await settingsSvc.load() // fail-open：损坏/版本不匹配隔离备份 + 回默认，不阻塞启动
    // F-4：platform 显式变量（原 toolSvc 内联字面量上提——grantStore normalizeDirectory 与 toolSvc 共用同一平台判定）
    const platform: 'posix' | 'windows' = process.platform === 'win32' ? 'windows' : 'posix'
    // —— 批次 C（V-3/F-5）：backendIdentity 同源闭包（GrantStore 与 tool-service 两处注入同一实例）——
    // real：connConfig 端点 origin（懒求值——connConfig 声明于下方，闭包仅 grant 创建时调用，创建顺序无关无 TDZ）；
    // mock：固定常量 'mock://local'（F-5——非 origin 语义，new URL('mock://local').origin 是 'null'）；
    // env CYRENE_MOCK_GRANT_BACKEND_IDENTITY 闭包内每次调用实时读取（V-2 惰性——集成测试中途翻转可观测）
    const backendIdentity = useMock
      ? () => (process.env.CYRENE_MOCK_GRANT_BACKEND_IDENTITY ?? 'mock://local')
      : () => { const u = connConfig.getEndpoint(); return u ? u.origin : undefined }
    // —— 阶段 6 批次 B（Task 6）：Desktop 工具服务装配（Main 权限/执行边界；adapter 构造之后、registerHandlers 之前）——
    // env 桥（**mock 模式专用门控 M-2（批次最终 review）**——真实模式误设 CYRENE_MOCK_* 不注入：
    // 防真实 capture 返回 mock 占位/Wayland 门禁被关/真实模式放行黑名单根；对齐 mockMouthLevel 的 useMock 先例 index.ts:278）
    const toolAllowRoot = useMock ? parseMockToolAllowRootEnv(process.env.CYRENE_MOCK_TOOL_ALLOW_ROOT) : undefined
    const captureSources = useMock ? parseMockCaptureSourcesEnv(process.env.CYRENE_MOCK_CAPTURE_SOURCES) : undefined
    // 批次 C（D6C-12/F-9）：mock 授权目录 env 桥（单个 JSON 字符串路径；useMock 门控——真实模式误设不注入）
    const grantDirectoryPath = useMock ? parseMockGrantDirectoryEnv(process.env.CYRENE_MOCK_GRANT_DIRECTORY) : undefined
    // —— 批次 C（D6C-03/06）：GrantStore 装配（settings.tools.grants 读写 + grant:* 审计 + 黑名单复核）——
    // settingsSvc 已 eager load（V-4 上移）；normalizeDirectory 目录存在性靠 dialog 只返回存在目录，非法/失败抛 PATH_UNSAFE
    const grantStore = createGrantStore({
      settings: settingsSvc,
      audit,
      normalizeDirectory: (raw) => normalizeToolPath(raw, { platform }).realPath,
      isBlacklisted: (real) => isPathBlacklisted(real) && !(toolAllowRoot ?? []).some((r) => real === r || real.startsWith(r + '/')),   // F-3：调用方放宽形态（tool-service.ts:403 同款）
      backendIdentity,
      platform,   // V-20：matches 平台门控（win32 toLowerCase / posix 直比）
      logger: diagnostics.logger,
    })
    const statusSender = createToolStatusSender({ adapter, audit })
    const toolSvc = createToolService({
      registry: createToolRegistry(),
      platform,
      audit,
      submitStatus: async (cmd) => { const ok = await statusSender.send(cmd); if (!ok) throw new Error('send failed') },
      uploadAttachment: (callId, bytes, mime, label) => statusSender.uploadToolAttachment(callId, bytes, mime, label),
      pushEvent: (ev) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(PushChannels.toolEvent, ev) },
      ...(toolAllowRoot !== undefined ? { allowRoots: toolAllowRoot } : {}),
      ...(captureSources !== undefined
        ? {
            enumerateSources: async () => captureSources.map((s) => ({ ...s, thumbnailDataUrl: MOCK_THUMBNAIL_DATA_URL })),
            renderPreview: async () => ({ previewDataUrl: MOCK_THUMBNAIL_DATA_URL, bytes: new Uint8Array([137, 80, 78, 71]) }),   // H11：固定 PNG 头 bytes 供上传断言（R9）
            isWayland: false,   // mock 模式不判 Wayland（完整 H3④）
          }
        : {}),
      // —— 批次 C（D6C-05/12）：目录授权注入 ——
      grants: grantStore,
      backendIdentity,
      pickDirectory: grantDirectoryPath !== undefined
        ? async () => ({ canceled: false, path: grantDirectoryPath })   // mock：固定授权目录（F-9）
        : async (opts) => {
            const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: opts.title })   // Main 默认：原生目录选择器
            return { canceled: r.canceled, path: r.filePaths[0] }
          },
      queryStatus: useMock ? undefined : (callId) => adapter.getToolCallStatus(callId),   // D6C-11（LOW-2 承接）：real 才注入——reconnect 三分支闭环；mock 不注入 → 不查（F-20）
    })
    toolBridge.svc = toolSvc
    // 工具请求入口（mock 构造注入 / real 可选 setter——都在 adapter 构造之后，无环）
    if (adapter instanceof MockBackend) {
      // MockBackend 的 toolRequestSink 已在构造 options 传入（经 toolBridge 打破 adapter→toolSvc 环）
    } else {
      adapter.onToolRequest = (req) => { void toolSvc.handleRequest(req) }
    }
    // Main 侧测试探针（M10：集成测试断言 wire lastToolStatus 需要；仅测试 harness 装配）
    if (process.env.CYRENE_TEST_HARNESS === '1') {
      const probe = globalThis as unknown as { __cyreneMainProbe: { getLastToolStatus: () => unknown; getToolRecords: () => unknown[] } }
      probe.__cyreneMainProbe = {
        getLastToolStatus: () => (adapter as MockBackend).lastToolStatus ?? null,
        getToolRecords: () => [...toolSvc.listRecent(50)],
      }
    }
    app.on('before-quit', () => toolSvc.shutdown())
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
    // 阶段 4 批次 B SettingsService：已上移至 createToolService 之前（批次 C V-4 装配顺序——GrantStore 构造依赖，见上）
    const chatSvc = createChatService({
      adapter,
      send: (channel, payload) => { const w = getMainWindow(); w?.webContents.send(channel, payload) },   // P3:webContents 守卫(窗口未建不崩)
      getToken: () => store.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined),   // R1:CredentialStore 是 async getCredential
      requireToken: !useMock,
      connectionConfig: connConfig,
      packaged: app.isPackaged,
      ...(useMock && mockMouthLevel !== undefined ? { mockMouthLevel } : {}),   // C1：mock 模式合成包络源选择
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
    mediaBridge.media = mediaSvc // audio_end 触发 getTtsMedia 回调前必须先就位（装配期完成，远早于用户 connect）
    // 阶段 5 批次 A Live2D 模型注册表（spec D5A-07）：扫 dirs.models，manifest+integrity 两级可用性 + fail-closed verify。
    // 纯磁盘只读，无生命周期（懒加载 integrity），registerHandlers 前装配即可。
    const live2dRegistry = new Live2DModelRegistry({ modelsDir: dirs.models })
    registerHandlers({ credentials: store, logger: diagnostics.logger, chat: chatSvc, connectionConfig: connConfig, sessionStore, attachments: { svc: uploadSvc, media: mediaSvc }, models: { adapter, media: mediaSvc }, settings: { svc: settingsSvc }, voice: { adapter, media: mediaSvc }, live2d: { registry: live2dRegistry }, tools: toolSvc, grants: grantStore, auditDir: dirs.audit, audit })
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
      resolveMedia: (mediaType, id, request) => mediaSvc.stream(mediaType, id, request),
      // 阶段 5 批次 A（A4）：live2d 供给分派——registered/available 门禁 + fail-closed verify（首命中 await 全量 hash）
      // + containment/白名单 + mime/no-store + dev CORS（受信 dev Origin 成功与错误响应均回补 ACAO）。
      resolveLive2d: createLive2dResolver(live2dRegistry)
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
