// src/main/bootstrap/services.ts —— 应用服务构造（架构整改 Prompt 2）。
//
// 本阶段做**构造**与**构造期自带的依赖注入**，不做跨服务事件接线：后端 → chat/media/tool 的回调、
// chat → fileRef 清理等"服务之间的连接"都在 `wire.ts` 里一次性绑定。
//
// 两处例外，都是"构造期依赖"而非"运行期接线"，故刻意留在本阶段：
// ① `SessionStore.getActiveConversationId` —— 构造期必填的读探针，而它要读的 chat 服务需要
//    sessionStore 先存在（同步构造环）。处置见 `ActiveConversationProbe`：惰性、只读、无状态。
// ② `chat.onConnectionTeardown: () => fileRefs.clear()` —— registry 无依赖，故提到 chat 之前构造，
//    直接把清理钩子传进构造函数（整改前它是一个跨段可变容器 `fileRefsHolder`）。
//
// 输入是 infrastructure + transport 两个明确的上下文对象，不 import 任何全局单例。
import { BrowserWindow, app } from 'electron'
import { BACKEND_TOKEN_KEY, PushChannels } from '@shared/contracts'
import { getMainWindow } from '../ipc/registry'
import { broadcastToWindows } from '../windows/broadcast'
import { closeWindowDevTools, openWindowDevTools } from '../windows/window-presentation'
import { release as osRelease, type as osType } from 'node:os'
import { SettingsService } from '../settings/settings-service'
import { SessionStore } from '../persistence/session-store'
import { CharacterDraftStore } from '../persistence/character-draft-store'
import { createChatService } from '../chat/chat-service'
import { createCharacterService } from '../characters/character-service'
import { UploadService } from '../attachments/upload-service'
import { createFileRefRegistry } from '../attachments/file-ref'
import { MediaService } from '../attachments/media-service'
import { defaultSafeOpenPlatform } from '../persistence/safe-open'
import { Live2DModelRegistry } from '../live2d/model-registry'
import { createToolStatusSender } from '../tools/tool-status-sender'
import { createToolService } from '../tools/tool-service'
import { createToolRegistry } from '../tools/tool-registry'
import { createGrantStore } from '../tools/grant-store'
import { isPathBlacklisted, isPathWithinRoot, normalizeToolPath } from '../tools/tool-policy'
import { MOCK_THUMBNAIL_DATA_URL } from '../tools/env-bridge'
import { createPersistFlushRequester } from '../persistence/persist-flush'
import { createDiagnosticsService } from '../diagnostics/diagnostics-service'
import type { ChatService } from '../chat/chat-service'
import type { CharacterService } from '../characters/character-service'
import type { MediaService as MediaServiceType } from '../attachments/media-service'
import type { UploadService as UploadServiceType } from '../attachments/upload-service'
import type { FileRefRegistry } from '../attachments/file-ref'
import type { Live2DModelRegistry as Live2DModelRegistryType } from '../live2d/model-registry'
import type { SettingsService as SettingsServiceType } from '../settings/settings-service'
import type { SessionStore as SessionStoreType } from '../persistence/session-store'
import type { CharacterDraftStore as CharacterDraftStoreType } from '../persistence/character-draft-store'
import type { ToolService } from '../tools/tool-service'
import type { GrantStore } from '../tools/grant-store'
import type { PersistFlushRequester } from '../persistence/persist-flush'
import type { DiagnosticsService } from '../diagnostics/diagnostics-service'
import type { BackendConnectionPort, ModelBackendPort, ToolBackendPort, VoiceBackendPort } from '../transport/backend-ports'
import type { Infrastructure } from './infrastructure'
import type { Transport } from './transport'
import { sendToMainWindow } from './transport'

/**
 * "当前激活会话"读探针。
 *
 * `SessionStore.persistSession` 在草稿淘汰时需要知道哪个会话是激活的，避免淘汰用户正在看的那个。
 * 提供者是 chat 服务（`adapter.getConnectionState().activeConversationId`），而 chat 服务构造时
 * 又需要 sessionStore —— 同步构造环。此处刻意**不做可变容器**，而是把读探针作为构造依赖传入：
 * 它只被调用、不被赋值，且调用点（persistSession 的淘汰分支）在 connect 之后。
 */
export interface ActiveConversationProbe {
  activeConversationId(): string | undefined
}

export interface ApplicationServices {
  settings: SettingsServiceType
  grants: GrantStore
  tools: ToolService
  chat: ChatService
  characters: CharacterService
  attachments: { svc: UploadServiceType; media: MediaServiceType; fileRefs: FileRefRegistry }
  live2d: Live2DModelRegistryType
  sessionStore: SessionStoreType
  characterDrafts: CharacterDraftStoreType
  diagnostics: DiagnosticsService
  persistFlush: PersistFlushRequester
  /**
   * 后端能力视图（架构整改 Prompt 3）：**同一个** RealBackend/MockBackend 实例的三张领域窄视图，
   * 只放"构造期之后仍需要"的那三张——连接（退出编排 / 后端错误处理器 / harness 探针）、
   * voice 与 model（IPC handler 注册阶段）。
   * chat / attachment / events / tool 的视图在构造期就直接注入各自的服务
   * （`createChatService` / `UploadService` / `MediaService` / `createDiagnosticsService` /
   * `createToolStatusSender`），不经容器二次转发，也不在此暴露聚合面。
   */
  backend: {
    connection: BackendConnectionPort
    voice: VoiceBackendPort
    model: ModelBackendPort
  }
  /** 角色连接世代号递增钩子（由 wire.ts 接在 adapter.onConnectionStateChange 上） */
  bumpCharacterEpoch(): void
}

export interface CreateServicesArgs {
  infrastructure: Infrastructure
  transport: Transport
  /** chat 服务构造后必须把它暴露给 sessionStore 的读探针（见 ActiveConversationProbe） */
  probe: ActiveConversationProbe
}

export async function createApplicationServices(args: CreateServicesArgs): Promise<ApplicationServices> {
  const { infrastructure: infra, transport, probe } = args
  const { adapter, useMock } = transport
  // —— 后端能力视图（Prompt 3）：同一实例的领域窄视图。组合根在此按需取出，
  //    各服务只接收自己声明的端口（注入的是同一个实例，不复制任何连接/鉴权/重连状态）。
  //    容器只保留"构造期之后仍需要"的三张（见 ApplicationServices.backend 注释）。
  const backend: ApplicationServices['backend'] = { connection: adapter, voice: adapter, model: adapter }
  // 工具服务的重连分支（queryStatus）只经这张窄视图取用后端能力——组合根本身不直接调聚合面
  const toolBackend: ToolBackendPort = adapter
  const { logger, auditor, logWriter, sanitize } = infra.diagnostics
  // 统一包一层箭头再往下传：`audit` 是端口对象上的方法，摘下来直接传会丢 `this`
  // （`unbound-method`，2026-09-13 type-aware 全集；与 backend-error-handlers 的 bind 先例同因）。
  const audit = (event: Parameters<typeof infra.diagnostics.audit>[0]): void => infra.diagnostics.audit(event)
  const { dirs, config, connectionConfig, credentials, dialogs } = infra

  // FE-B：角色服务维护独立连接世代（递增钩子由 wire.ts 接在连接状态回调上；此处只读）
  let characterConnectionEpoch = 0
  const characterService = createCharacterService({
    backend: transport.characterBackend.backend,
    isConnected: () => backend.connection.getConnectionState().status === 'connected',
    getFeatures: transport.characterBackend.getFeatures,
    getConnectionEpoch: () => characterConnectionEpoch
  })

  // —— 阶段 7 批次 A（Task 5，spec §6.3）：诊断服务装配（F-08 定案——事件源 deps 注入、构造期 subscribe，
  //    无 attachAdapter 方法；构造在 adapter 之后：事件源引用须先就位——与 chat/tool svc 同款时序治理）——
  const diagnosticsSvc: DiagnosticsService = createDiagnosticsService({
    dirs: { logs: dirs.logs, audit: dirs.audit, temp: dirs.temp },
    logger,
    auditor,
    logWriter,
    sanitize,
    events: adapter, // 只需事件流这一项能力（BackendEventSourcePort）
    dialogs,
    getMainWindow: () => getMainWindow() ?? undefined, // registry 返回 null→undefined（service 侧判空回退无父对话框）
    getConnectionSummary: () => {
      const s = backend.connection.getConnectionState()
      let origin: string | undefined
      try { origin = s.serverUrl !== undefined ? new URL(s.serverUrl).origin : undefined } catch { origin = undefined } // 非法 URL/mock 场景不出 origin
      return { origin, status: s.status, protocolVersion: s.protocolVersion }
    },
    onDevEvent: (ev) => sendToMainWindow(PushChannels.diagnosticsDevEvent, ev),
    onDevModeChange: (enabled) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      // silent 测试模式：不创建 detached DevTools 窗口（第二个受管窗口会抢焦点且无观察者）；见 window-presentation.ts
      if (enabled) openWindowDevTools(win, { mode: 'detach' })
      else closeWindowDevTools(win)
    },
    appInfo: () => ({
      appName: 'Cyrene',
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      os: `${osType()} ${osRelease()}`,
      packaged: app.isPackaged,
      mode: config.mode
    })
  })

  // —— 阶段 6 批次 C（V-4 HIGH 定案）：SettingsService 上移——GrantStore 构造依赖 settings ——
  // settings 不依赖 toolSvc（无环）；load 为 eager（save 在内存态上 merge，未装载即 save 会以默认值覆盖已有落盘值）。
  const settingsSvc = new SettingsService({
    dir: dirs.config,
    safeRoot: infra.safeRoot,
    logger,
    countDiagnostic: (code: string) => logger.warn('persistence:diagnostic', { code })
  })
  await settingsSvc.load() // fail-open：损坏/版本不匹配隔离备份 + 回默认，不阻塞启动

  // F-4：platform 显式变量（grantStore normalizeDirectory 与 toolSvc 共用同一平台判定）
  const platform: 'posix' | 'windows' = process.platform === 'win32' ? 'windows' : 'posix'
  // —— 批次 C（V-3/F-5）：backendIdentity 同源闭包（GrantStore 与 tool-service 两处注入同一实例）——
  // real：connConfig 端点 origin（懒求值——闭包仅在 grant 创建时调用）；mock：固定常量 'mock://local'
  // （F-5——非 origin 语义，new URL('mock://local').origin 是 'null'）；env 每次调用实时读取（V-2 惰性）。
  const backendIdentity = useMock
    ? () => (process.env.CYRENE_MOCK_GRANT_BACKEND_IDENTITY ?? 'mock://local')
    : () => { const u = connectionConfig.getEndpoint(); return u ? u.origin : undefined }

  const grantStore = createGrantStore({
    settings: settingsSvc,
    audit,
    normalizeDirectory: (raw) => normalizeToolPath(raw, { platform }).realPath,
    // F-3：调用方放宽形态（与 tool-service 的 allowRoots 判定同款）
    isBlacklisted: (real) =>
      isPathBlacklisted(real, undefined, { platform }) &&
      !(transport.fixtureEnv.toolAllowRoot ?? []).some((r) => isPathWithinRoot(real, r, platform)),
    backendIdentity,
    platform, // V-20：matches 平台门控（win32 toLowerCase / posix 直比）
    logger
  })
  const statusSender = createToolStatusSender({ backend: adapter, audit })   // 注入聚合实例，服务侧只声明工具端口的两个方法
  const captureSources = transport.fixtureEnv.captureSources
  const grantDirectoryPath = transport.fixtureEnv.grantDirectoryPath
  const toolSvc = createToolService({
    registry: createToolRegistry(),
    platform,
    audit,
    submitStatus: async (cmd) => { const ok = await statusSender.send(cmd); if (!ok) throw new Error('send failed') },
    uploadAttachment: (callId, bytes, mime, label) => statusSender.uploadToolAttachment(callId, bytes, mime, label),
    pushEvent: (ev) => { broadcastToolEvent(ev) },
    ...(transport.fixtureEnv.toolAllowRoot !== undefined ? { allowRoots: transport.fixtureEnv.toolAllowRoot } : {}),
    ...(captureSources !== undefined
      ? {
          enumerateSources: async () => captureSources.map((s) => ({ ...s, thumbnailDataUrl: MOCK_THUMBNAIL_DATA_URL })),
          renderPreview: async () => ({ previewDataUrl: MOCK_THUMBNAIL_DATA_URL, bytes: new Uint8Array([137, 80, 78, 71]) }), // H11：固定 PNG 头 bytes 供上传断言（R9）
          isWayland: false // mock 模式不判 Wayland（完整 H3④）
        }
      : {}),
    // —— 批次 C（D6C-05/12）：目录授权注入 ——
    grants: grantStore,
    backendIdentity,
    pickDirectory: grantDirectoryPath !== undefined
      ? async () => ({ canceled: false, path: grantDirectoryPath }) // mock：固定授权目录（F-9）
      : async (opts) => {
          // Main 默认：原生目录选择器（silent 测试模式不弹窗，返回取消）
          const r = await dialogs.showOpenDialog(undefined, { properties: ['openDirectory'], title: opts.title })
          return { canceled: r.canceled, path: r.filePaths[0] }
        },
    // D6C-11（LOW-2 承接）：real 才注入——reconnect 三分支闭环；mock 不注入 → 不查（F-20）
    queryStatus: useMock ? undefined : (callId) => toolBackend.getToolCallStatus(callId)
  })

  // S5-B2（2026-09-15，H-01 结构性修法）：`fileRefs` 是**不可猜文件引用表**，也是附件链路的信任锚——
  // 附件链不接受任何裸路径（IPC schema 已移除 `path`），只接受 Main 自己签发的 token。
  // 显式断开连接 / 切换后端地址时清空（经 chat 服务的 `onConnectionTeardown`，见下）。
  // 整改 Prompt 2：registry 提到 chat 服务**之前**构造，清理钩子直接传入构造函数，
  // 不再需要 `fileRefsHolder` 这个跨段可变容器。
  const fileRefs = createFileRefRegistry()

  // 阶段 3 G2 SessionStore（Main 持久化边界，docs/06 §14）：必须在 createChatService 之前装配（chat 服务钩子需要它）。
  const sessionStore = new SessionStore({
    appCache: dirs.appCache,
    safeRoot: infra.safeRoot,
    logger,
    countDiagnostic: (code: string) => logger.warn('persistence:diagnostic', { code }),
    getActiveConversationId: () => probe.activeConversationId()
  })
  await sessionStore.load() // 损坏隔离，不阻塞启动

  // FE-D2：角色编辑器草稿独立于 SessionStore，使用同一 app-cache/safeRoot/原子写边界。
  const characterDrafts = new CharacterDraftStore({
    appCache: dirs.appCache,
    safeRoot: infra.safeRoot,
    logger,
    countDiagnostic: (code: string) => logger.warn('persistence:diagnostic', { code })
  })
  await characterDrafts.load() // 损坏/超限草稿隔离后以空仓库启动，不阻塞连接

  // 装配 chat-service：onConnectionStateChange → chat.pushState、onSessionReplay → chat.pushReplay
  // 由 wire.ts 接线（P1-1 生产侧桥）；MockBackend 无 onSessionReplay，回放桥仅 RealBackend 分支生效。
  const chatSvc = createChatService({
    backend: adapter, // 注入聚合实例；ChatService 只声明连接 + 事件源 + 会话/消息三张视图
    send: (channel, payload) => sendToMainWindow(channel, payload), // P3:webContents 守卫(窗口未建不崩)
    getToken: () => credentials.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined), // R1:CredentialStore 是 async getCredential
    requireToken: !useMock,
    connectionConfig,
    packaged: app.isPackaged,
    ...(useMock && transport.fixtureEnv.mouthLevel !== undefined ? { mockMouthLevel: transport.fixtureEnv.mouthLevel } : {}), // C1：mock 模式合成包络源选择
    sessionStore, // G2：listConversations 派生列表缓存 / activate 记 lastActive / deleteConversation purge
    audit, // C2:连接生命周期审计（connect/disconnect;fail-open）
    onConnectionTeardown: () => fileRefs.clear() // 显式断开 / 切换后端地址（瞬态重连不清）
  })

  // 阶段 3 G3 附件服务装配（spec §4.4/§4.5）：mediaSvc 需 connConfig.getEndpoint()（签发表 target 为后端 baseUrl）；
  // UploadService 经 Main 自持的 fileRef 表读盘（D5 路径只在 Main）；两者各只声明自己用到的后端方法视图。
  const uploadSvc = new UploadService({
    backend: adapter,
    userDataBase: () => infra.userDataBase,
    platform: defaultSafeOpenPlatform(),
    fileRefs,
    logger // S7：被拒的具体原因只进 Main 日志，公开面统一（去存在性 oracle）
  })
  const mediaSvc = new MediaService({
    backend: adapter,
    baseUrl: () => connectionConfig.getEndpoint()?.baseUrl
  })

  // 阶段 5 批次 A Live2D 模型注册表（spec D5A-07）：扫 dirs.models，manifest+integrity 两级可用性 + fail-closed verify。
  // 纯磁盘只读，无生命周期（懒加载 integrity），registerHandlers 前装配即可。
  const live2dRegistry = new Live2DModelRegistry({ modelsDir: dirs.models })

  // 2026-09-11（H-04）：退出前请求 Renderer flush 防抖持久化（草稿/设置/布局/角色草稿）。
  // 由 Main 发起而非 Renderer 的 beforeunload——后者无法 await 异步 IPC；ack 经 IpcChannels.persistFlushDone。
  const persistFlush = createPersistFlushRequester({
    deliver: () => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return false // 无窗口即无 Renderer 状态可 flush（fail-open）
      win.webContents.send(PushChannels.persistFlushRequest)
      return true
    },
    onTimeout: () => logger.warn('persist-flush:timeout', { message: '退出前 Renderer 持久化 flush 未在预算内确认' })
  })

  return {
    settings: settingsSvc,
    grants: grantStore,
    tools: toolSvc,
    chat: chatSvc,
    characters: characterService,
    attachments: { svc: uploadSvc, media: mediaSvc, fileRefs },
    live2d: live2dRegistry,
    sessionStore,
    characterDrafts,
    diagnostics: diagnosticsSvc,
    persistFlush,
    backend,
    bumpCharacterEpoch: () => { characterConnectionEpoch++ }
  }
}

/**
 * 工具状态事件的广播出口（唯一 `PushChannels.toolEvent` 生产侧）。
 *
 * **必须走 `broadcastToWindows`**（H-12，2026-09-11）：它是三个 send 点里唯一带
 * `isDestroyed()` 检查 + 逐窗口 try/catch 的实现。裸 `webContents.send` 在窗口关闭过程中会抛错，
 * 而该异常发生在 IPC 之外（没有 executor 的错误信封兜底）⇒ 主进程未捕获异常 ⇒ `fatalRuntime`
 * 弹框 + `exit(1)`**中途打断 before-quit 的有序 flush**（工具终态 emit 正发生在工具 shutdown 与
 * 退出 flush 之间）。2026-09-17 反向 review 抓到本行曾在整改中被写成裸循环，已修回。
 */
function broadcastToolEvent(ev: unknown): void {
  broadcastToWindows(BrowserWindow.getAllWindows(), PushChannels.toolEvent, ev)
}
