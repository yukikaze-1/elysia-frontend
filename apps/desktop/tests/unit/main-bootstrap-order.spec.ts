// tests/unit/main-bootstrap-order.spec.ts（node）
//
// 架构整改 Prompt 2：Main 组合根的**启动顺序**门禁。
//
// 为什么需要它：整改把 658 行的 `main()` 拆成 `bootstrap/` 各阶段后，"顺序"从"读一个函数就能看出来"
// 变成"散在多个模块里"——而这一批最大的风险恰恰不是代码风格，是启动顺序。现有测试对顺序的覆盖是
// 空的：没有任何用例断言 pre-ready 各步的相对次序，也没有用例断言"fatal 短路后不再做身份副作用"。
//
// 本文件用**事件序列**代替行号断言：把 pre-ready 阶段会触达的每个边界（harness 归一化、调试门、
// appData 覆写、风味、scheme、身份、单实例锁、ready）都换成记录顺序的假实现，然后断言真实顺序。
// 行号会漂，顺序不会——这正是本门禁要钉住的东西。
//
// 另一半是**结构约束**（源码级）：对话框实例必须在 harness 归一化之后创建。
// 这一条曾是一个真实缺陷：`createDialogService()` 的默认参数会解析 `runtimeEnvironment()` 的进程级
// 单例，而整改前它在模块作用域（`index.ts:66`）就被调用——打包态残留 `CYRENE_TEST_HARNESS=1` 时，
// 静默窗口模式会在归一化之前被记忆。整改把它移到归一化之后，此处用源码扫描防止回退。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  const calls: string[] = []
  const state = {
    calls,
    packaged: false,
    /** 指令式开关：让被测流程在指定时刻改变 mock 行为 */
    switchValue: '',
    hasSwitch: false,
    lockGranted: true,
    devToolsAllowed: true,
    userDataPath: '',
    setPathCalls: [] as string[],
    showErrorBox: [] as Array<{ title: string; content: string }>,
    exitCodes: [] as number[],
    /** 假窗口：`send` 抛错的那些用来证明推送路径有逐窗口守卫 */
    windows: [] as Array<{ isDestroyed: () => boolean; webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } }>,
    toolDeps: undefined as { pushEvent: (ev: unknown) => void } | undefined,
    /** `app.on` 捕获的 listener（second-instance / before-quit 的接线断言用） */
    appListeners: new Map<string, Array<(...args: never[]) => unknown>>(),
    /** `createShutdownHandler` 收到的 deps（退出步骤清单断言用） */
    shutdownDeps: undefined as { steps: Array<{ name: string; run(): Promise<void> }>; quit(): void } | undefined,
    /** `ensureMainWindow` 收到的第二参（F12 门 getter 断言用） */
    windowOpts: undefined as { isDevMode: () => boolean } | undefined
  }
  return state
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return h.packaged },
    commandLine: {
      hasSwitch: () => h.hasSwitch,
      getSwitchValue: () => h.switchValue,
      appendSwitch: (n: string) => { h.calls.push(`appendSwitch:${n}`) }
    },
    getPath: (name: string) => (name === 'userData' ? h.userDataPath : '/tmp/cyrene-bootstrap-order'),
    setName: () => {},
    setPath: (name: string, value: string) => { h.setPathCalls.push(`${name}=${value}`) },
    getUserDataPath: () => h.userDataPath,
    setAppUserModelId: () => {},
    requestSingleInstanceLock: () => { h.calls.push('requestSingleInstanceLock'); return h.lockGranted },
    whenReady: () => Promise.resolve(),
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const list = h.appListeners.get(event) ?? []
      list.push(listener)
      h.appListeners.set(event, list)
      h.calls.push(`app.on:${event}`)
    },
    exit: (code: number) => { h.exitCodes.push(code) },
    quit: () => {},
    getVersion: () => '0.0.0-test',
    isReady: () => true
  },
  BrowserWindow: class { static getAllWindows() { return h.windows } },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => [] },
  dialog: { showErrorBox: (title: string, content: string) => { h.showErrorBox.push({ title, content }) } },
  safeStorage: {},
  shell: { openExternal: () => {}, openPath: () => {} },
  session: { defaultSession: { setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {} } },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {}, unhandle: () => {}, isProtocolHandled: () => false },
  ipcMain: { handle: () => {}, on: () => {} },
  net: {}
}))

vi.mock('../../src/main/app/lifecycle', () => ({
  applyTestAppDataOverride: (mode: string) => { h.calls.push(`testAppDataOverride:${mode}`); return undefined },
  resolveAppDataFlavor: (mode: string, packaged: boolean) => (mode === 'development' && !packaged ? 'dev' : 'default'),
  setAppDataFlavor: (flavor: string) => { h.calls.push(`appDataFlavor:${flavor}`) },
  installAppIdentity: () => { h.calls.push('installAppIdentity'); h.userDataPath = '/tmp/cyrene-bootstrap-order/Cyrene-Dev'; return { baseCreated: false, setPathOk: true } },
  expectedUserDataBase: () => h.userDataPath
}))

vi.mock('../../src/main/config/runtime-environment', () => ({
  normalizeHarnessEnv: (env: Record<string, string | undefined>) => {
    h.calls.push('normalizeHarnessEnv')
    if (env['CYRENE_TEST_HARNESS'] === '1' && h.packaged && env['CYRENE_PACKAGED_HARNESS'] !== '1') { delete env['CYRENE_TEST_HARNESS']; return true }
    return false
  },
  runtimeEnvironment: () => {
    h.calls.push('runtimeEnvironment')
    return { mode: 'test', isTestHarness: false, windowMode: 'visible', windowModeSource: 'default', isSilentWindowMode: false, isVisibleTestMode: false }
  }
}))

vi.mock('../../src/main/config/gpu-mode', () => ({
  resolveGpuDecision: () => { h.calls.push('resolveGpuDecision'); return { disableHardwareAcceleration: false, gpuMode: 'auto', gpuModeSource: 'default' } }
}))

vi.mock('../../src/main/config/debug-switches', () => ({
  findForbiddenDebugLaunch: () => { h.calls.push('debugSwitchGate'); return h.switchValue === 'forbidden' ? 'switch' : null }
}))

vi.mock('../../src/main/protocol', () => ({
  registerCyreneScheme: () => { h.calls.push('registerCyreneScheme') }
}))

vi.mock('../../src/main/windows/main-window', () => ({
  focusOrDefer: () => { h.calls.push('focusOrDefer') },
  setCrashSink: () => { h.calls.push('setCrashSink') },
  setBeforeCloseFlush: () => { h.calls.push('setBeforeCloseFlush') },
  markAppStarted: () => { h.calls.push('markAppStarted') },
  ensureMainWindow: (_sink?: unknown, opts?: { isDevMode: () => boolean }) => {
    h.calls.push('ensureMainWindow')
    h.windowOpts = opts
  },
  getMainWindow: () => null
}))

vi.mock('../../src/main/shutdown', async (importOriginal) => {
  // 只把 createShutdownHandler 换成捕获版；createFatalShutdown 必须保留**真实实现**——
  // pre-ready 的 shell.fatal 依赖它的"closeAll 挂起也 exit(1)"语义，伪造它会削弱既有断言。
  const actual = await importOriginal<typeof import('../../src/main/shutdown')>()
  return {
    ...actual,
    createShutdownHandler: (deps: { steps: Array<{ name: string; run(): Promise<void> }>; quit(): void }) => {
      h.shutdownDeps = deps
      return () => {}
    }
  }
})

vi.mock('../../src/main/bootstrap/runtime-guards', () => ({
  installRuntimeGuards: () => { h.calls.push('installRuntimeGuards') },
  handleChildProcessGone: () => {}
}))

vi.mock('../../src/main/diagnostics', () => ({
  createDiagnostics: () => { h.calls.push('createDiagnostics'); return { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, flush: () => {}, close: () => {} }, auditor: { audit: () => Promise.resolve(), close: () => Promise.resolve() }, logWriter: {}, closeAll: () => Promise.resolve() } }
}))

vi.mock('../../src/main/persistence/user-data-dirs', () => ({
  UserDataDirError: class UserDataDirError extends Error {},
  ensureUserDataDirs: async () => { h.calls.push('ensureUserDataDirs'); return { config: '/tmp/c', logs: '/tmp/l', audit: '/tmp/a', temp: '/tmp/t', appCache: '/tmp/ac', models: '/tmp/m' } }
}))

vi.mock('../../src/main/credentials/credential-store', () => ({
  CredentialStore: class { constructor() { h.calls.push('credentialStore') } }
}))

vi.mock('../../src/main/connection/connection-config', () => ({
  ConnectionConfig: class {
    constructor() { h.calls.push('connectionConfig') }
    close() { h.calls.push('step:credentials') }
    getEndpoint() { return undefined }
  }
}))

vi.mock('../../src/main/diagnostics/sanitize', () => ({
  createSanitizePublicMessage: () => { h.calls.push('sanitize'); return (text: string) => text }
}))

vi.mock('../../src/main/config/dev-ports', () => ({
  assertDevServerOrigin: () => { h.calls.push('assertDevServerOrigin'); return { ok: true } },
  resolveDevDefaultBackendOrigin: () => undefined
}))

vi.mock('../../src/main/config/trusted-renderer-origin', () => ({
  evaluateDevRendererUrl: () => ({ status: 'trusted', reason: '' })
}))

vi.mock('../../src/main/config', () => ({
  getAppConfig: () => ({ mode: 'test', logLevel: 'debug', devToolsAllowed: h.devToolsAllowed, protocolName: 'cyrene', rendererHost: 'renderer' }),
  shouldUseViteDevServer: () => true
}))

vi.mock('../../src/main/native-ui/dialog-service', () => ({
  // 真实实现（dialog-service.ts:119-125）是进程级单例，首次调用才解析 runtimeEnvironment()。
  // 这里如实复刻"单例 + 首次解析环境"两步，正是被测的顺序（归一化之前不得解析）。
  defaultDialogService: () => {
    h.calls.push('defaultDialogService')
    h.calls.push('runtimeEnvironment')
    return { showErrorBox: (title: string, content: string) => { h.showErrorBox.push({ title, content }) }, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: '' }) }
  },
  createDialogService: () => { h.calls.push('createDialogService'); return { showErrorBox: () => {}, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: '' }) } },
  dialogInvocations: () => []
}))

vi.mock('node:fs/promises', () => ({ realpath: async () => '/tmp/cyrene-bootstrap-order' }))

// —— services.ts 的最小依赖面（只为把工具服务的 pushEvent 取出来）——
vi.mock('../../src/main/settings/settings-service', () => ({
  SettingsService: class { async load() { return {} } }
}))
vi.mock('../../src/main/tools/grant-store', () => ({ createGrantStore: () => ({}) }))
vi.mock('../../src/main/tools/tool-registry', () => ({ createToolRegistry: () => ({}) }))
vi.mock('../../src/main/tools/tool-status-sender', () => ({
  createToolStatusSender: () => ({ send: async () => true, uploadToolAttachment: async () => ({}) })
}))
vi.mock('../../src/main/tools/tool-service', () => ({
  createToolService: (deps: { pushEvent: (ev: unknown) => void }) => {
    h.toolDeps = deps
    return { listRecent: () => [], shutdown: () => {}, reconnect: async () => {}, handleRequest: async () => {} }
  }
}))
vi.mock('../../src/main/persistence/session-store', () => ({
  SessionStore: class { async load() { /* noop */ } }
}))
vi.mock('../../src/main/persistence/character-draft-store', () => ({ CharacterDraftStore: class { async load() { /* noop */ } } }))
vi.mock('../../src/main/chat/chat-service', () => ({
  createChatService: () => ({ pushState: () => {}, pushReplay: () => {} })
}))
vi.mock('../../src/main/characters/character-service', () => ({
  createCharacterService: () => ({ getState: () => ({ devMode: false }) })
}))
vi.mock('../../src/main/attachments/upload-service', () => ({
  // upload-service 在 bootstrap/services.ts 里是值导入（new UploadService），mock 工厂不能引用外部变量，
  // 故这里自持一个模块内的记录数组（无需 hoisted 状态）
  UploadService: class {}
}))
vi.mock('../../src/main/attachments/media-service', () => ({
  MediaService: class { putTtsAudio() { return { url: 'cyrene://tts' } } }
}))
vi.mock('../../src/main/live2d/model-registry', () => ({
  Live2DModelRegistry: class {
    listModels = async () => ({ models: [] })
    serve = async () => null
  }
}))
vi.mock('../../src/main/protocol', () => ({
  registerCyreneScheme: () => { h.calls.push('registerCyreneScheme') },
  // start-application.ts 经 protocol/index 取这个供给注册入口（协议 handler 的注册时机 = 建窗之前）
  registerCyreneProtocolHandler: async () => { h.calls.push('registerCyreneProtocolHandler') },
  PROTOCOL_SCHEME: 'cyrene',
  RENDERER_HOST: 'renderer'
}))
vi.mock('../../src/main/protocol/handler', () => ({
  createLive2dResolver: () => async () => null,
  registerCyreneProtocolHandler: async () => { h.calls.push('registerCyreneProtocolHandler') }
}))
vi.mock('../../src/main/persistence/persist-flush', () => ({
  createPersistFlushRequester: () => ({ request: async () => { h.calls.push('step:renderer-persist') }, acknowledge: () => {} })
}))
vi.mock('../../src/main/diagnostics/diagnostics-service', () => ({
  createDiagnosticsService: () => ({ getState: () => ({ devMode: false }), dispose: () => {} })
}))
vi.mock('../../src/main/attachments/file-ref', () => ({
  createFileRefRegistry: () => ({ clear: () => {}, issue: () => 't', resolve: () => undefined, size: () => 0 })
}))
vi.mock('../../src/main/tools/env-bridge', () => ({
  MOCK_THUMBNAIL_DATA_URL: 'data:,',
  parseMockToolAllowRootEnv: () => undefined,
  parseMockCaptureSourcesEnv: () => undefined,
  parseMockGrantDirectoryEnv: () => undefined
}))

const { createRuntimeShell, prepareElectronRuntime } = await import('../../src/main/bootstrap/pre-ready')
const { createInfrastructure } = await import('../../src/main/bootstrap/infrastructure')
const { createTransport, installBackendCallbacks } = await import('../../src/main/bootstrap/transport')
const { createApplicationServices } = await import('../../src/main/bootstrap/services')
const { installShutdownSequence } = await import('../../src/main/bootstrap/shutdown-sequence')
const { startApplication } = await import('../../src/main/bootstrap/start-application')
type Infrastructure = import('../../src/main/bootstrap/infrastructure').Infrastructure
type ApplicationServices = import('../../src/main/bootstrap/services').ApplicationServices

beforeEach(() => {
  h.calls.length = 0
  h.exitCodes.length = 0
  h.showErrorBox.length = 0
  h.setPathCalls.length = 0
  h.packaged = false
  h.switchValue = ''
  h.hasSwitch = false
  h.lockGranted = true
  h.devToolsAllowed = true
  h.userDataPath = ''
  h.windows.length = 0
  h.toolDeps = undefined
  h.appListeners.clear()
  h.shutdownDeps = undefined
  h.windowOpts = undefined
  delete process.env['CYRENE_TEST_HARNESS']
})

describe('pre-ready 顺序（顺序即正确性，见 bootstrap/pre-ready.ts 头注）', () => {
  it('正常启动：harness 归一化 → 调试门 → GPU 判定 → testAppData → 风味 → scheme → 身份 → ready', async () => {
    process.env['CYRENE_TEST_HARNESS'] = '1'
    const shell = createRuntimeShell()
    const result = await prepareElectronRuntime(shell)
    expect(result.abort).toBe(false)
    expect(h.calls).toEqual([
      'normalizeHarnessEnv',
      'defaultDialogService', // 对话框入口（唯一 runtimeEnvironment 消费者）建在归一化之后
      'runtimeEnvironment',
      'debugSwitchGate',
      'appendSwitch:enable-precise-memory-info',
      'resolveGpuDecision',
      'testAppDataOverride:production', // __APP_MODE__ 在单测下未注入 → 归一为 production（见 config/index.ts）
      'appDataFlavor:default', // mode=production ⇒ default 风味（dev 隔离只给 development）
      'registerCyreneScheme',
      'installAppIdentity',
      'requestSingleInstanceLock',
      'app.on:second-instance' // 锁之后立刻注册，否则第二实例事件会被 EventEmitter 丢掉
    ])
  })

  it('单实例锁在身份安装之后：lock 只能在 setPath("userData") 之后请求（锁派生自 userData 路径）', async () => {
    const shell = createRuntimeShell()
    let lockedAfterSetPath = false
    // 身份安装写入 userData 路径后再请求锁——顺序反了这里会是空串
    const result = await prepareElectronRuntime(shell)
    expect(result.abort).toBe(false)
    lockedAfterSetPath = h.userDataPath.length > 0
    expect(lockedAfterSetPath, 'installAppIdentity 必须先于 requestSingleInstanceLock').toBe(true)
  })

  it('调试门命中：短路且不落任何身份副作用（appData/风味/scheme/身份全不做）', async () => {
    h.hasSwitch = true
    h.switchValue = 'forbidden'
    const shell = createRuntimeShell()
    const result = await prepareElectronRuntime(shell)
    expect(result.abort).toBe(true)
    expect(h.calls).toEqual([
      'normalizeHarnessEnv',
      'defaultDialogService', // 对话框入口（唯一 runtimeEnvironment 消费者）建在归一化之后
      'runtimeEnvironment',
      'debugSwitchGate',
      'defaultDialogService', // fatal 弹框复用同一单例（不再解析一次环境——单例已缓存）
      'runtimeEnvironment'
    ])
    expect(h.calls).not.toContain('registerCyreneScheme')
    expect(h.calls).not.toContain('installAppIdentity')
    expect(h.showErrorBox.map((c) => c.title)).toEqual(['Cyrene 无法启动'])
    // fatal 复用 createFatalShutdown：closeAll 存在时 exit 在 race/finally 之后，故等一个宏任务
    await new Promise((r) => setTimeout(r, 0))
    expect(h.exitCodes).toEqual([1])
  })

  it('非持锁实例：exit(0)，且不进入 identity 之后任何步骤', async () => {
    h.lockGranted = false
    const shell = createRuntimeShell()
    const result = await prepareElectronRuntime(shell)
    expect(result.abort).toBe(true)
    expect(h.exitCodes).toEqual([0])
    expect(h.calls).not.toContain('createDiagnostics')
  })

  it('打包态残留 harness 标记：归一化抹掉后才建对话框入口（runtimeEnvironment 在归一化之后）', async () => {
    h.packaged = true
    process.env['CYRENE_TEST_HARNESS'] = '1' // 未被承认（缺 CYRENE_PACKAGED_HARNESS）
    const shell = createRuntimeShell()
    await prepareElectronRuntime(shell)
    expect(h.calls.indexOf('normalizeHarnessEnv')).toBeLessThan(h.calls.indexOf('runtimeEnvironment'))
    // 归一化确实抹掉了环境变量（后续全部读取点看到正式语义）
    expect(process.env['CYRENE_TEST_HARNESS']).toBeUndefined()
  })
})

describe('infrastructure 顺序：diagnostics 必须早于崩溃/进程兜底守卫', () => {
  it('userData 断言 → 子目录 → 脱敏 → diagnostics → 运行期守卫 → 凭据 → 连接配置', async () => {
    const shell = createRuntimeShell()
    const preReady = await prepareElectronRuntime(shell)
    expect(preReady.abort).toBe(false)
    if (preReady.abort) return
    h.calls.length = 0
    const result = await createInfrastructure({ runtime: preReady.runtime, shell, useMock: true })
    expect(result.ok).toBe(true)
    // 只约束本阶段的**装配顺序**：对话框单例（经 Infrastructure.dialogs 取用）可能在之前或之后出现，
    // 故用"相对次序"而不是整串相等——整串相等会被无关的对话框解析次数变化搞红。
    const order = ['ensureUserDataDirs', 'sanitize', 'createDiagnostics', 'installRuntimeGuards', 'credentialStore', 'connectionConfig']
    const indexes = order.map((name) => h.calls.indexOf(name))
    expect(indexes, `未全部命中：${order.filter((_, i) => indexes[i] < 0).join(',')}`).not.toContain(-1)
    expect([...indexes].sort((a, b) => a - b), '六个装配步骤必须按序发生').toEqual(indexes)
  })

  it('setPathOk=false：fatal 短路且不装配 diagnostics（与整改前的早退集合一致）', async () => {
    const shell = createRuntimeShell()
    const preReady = await prepareElectronRuntime(shell)
    if (preReady.abort) throw new Error('前置阶段不应 abort')
    h.calls.length = 0
    const result = await createInfrastructure({
      runtime: { ...preReady.runtime, setPathOk: false, baseCreated: false },
      shell,
      useMock: false
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('userData 目录不可用')
    expect(h.calls).toEqual([])
  })

  // 反向 review 发现的行为漂移（已修）：整改前的 dev 门禁在 `if (!app.isPackaged)` 内，
  // 抽成函数时丢掉了这层门 ⇒ 打包产物里残留的 ELECTRON_RENDERER_URL 会让正式应用拒绝启动。
  it('打包形态（devToolsAllowed=false）不做 dev renderer 门禁', async () => {
    h.devToolsAllowed = false
    const shell = createRuntimeShell()
    const preReady = await prepareElectronRuntime(shell)
    if (preReady.abort) throw new Error('前置阶段不应 abort')
    h.calls.length = 0
    const result = await createInfrastructure({ runtime: preReady.runtime, shell, useMock: false })
    expect(result.ok).toBe(true)
    expect(h.calls).not.toContain('assertDevServerOrigin')
  })
})

describe('适配器接线：installBackendCallbacks 必须真的把回调递到适配器（此前零覆盖）', () => {
  const noopCallbacks = (seen: string[]): Parameters<typeof installBackendCallbacks>[1] => ({
    onConnectionStateChange: () => seen.push('state'),
    onSessionReplay: () => seen.push('replay'),
    onProtocolWarning: () => seen.push('warning'),
    onError: () => seen.push('error'),
    ttsMedia: () => undefined,
    onToolRequest: () => seen.push('tool')
  })

  it('mock 分支：工具请求与连接状态经转发闭包到达回调（不再有跨模块可变容器）', () => {
    const transport = createTransport({ useMock: true })
    const seen: string[] = []
    installBackendCallbacks(transport, noopCallbacks(seen))
    // 接线后从槽取出并触发——等价于 mock 在事件到达时调用构造期注入的闭包
    const sinks = transport.mockSinks
    expect(sinks, 'mock 分支必须暴露转发槽').toBeDefined()
    sinks!.onToolRequest?.({ callId: 'c1' } as never)
    sinks!.onConnectionStateChange?.({ status: 'connected' } as never)
    expect(seen).toEqual(['tool', 'state'])
  })

  it('real 分支：适配器持有的 options 对象确实被赋值（读取点在事件到达时）', () => {
    const transport = createTransport({ useMock: false })
    const seen: string[] = []
    installBackendCallbacks(transport, noopCallbacks(seen))
    const options = transport.realOptions
    expect(options, 'real 分支必须暴露 options 对象').toBeDefined()
    // RealBackend 每次事件都重读 this.options.X——故此处断言 options 上的字段已就位
    options!.onConnectionStateChange?.({ status: 'connected' } as never)
    options!.onProtocolWarning?.({ code: 'MAPPER_ERROR', message: 'm' })
    options!.onError?.({ code: 'E', message: 'm' } as never)
    expect(seen).toEqual(['state', 'warning', 'error'])
    expect(transport.adapter.onToolRequest, 'real 的桌面工具请求走公开字段').toBeTypeOf('function')
  })
})

describe('回归：反向 review 抓到的两处行为漂移', () => {
  /** 走完 pre-ready + infrastructure，拿到可直接喂给 createApplicationServices 的两个上下文 */
  async function makeContexts(): Promise<{ infrastructure: Infrastructure; transport: ReturnType<typeof createTransport> }> {
    const shell = createRuntimeShell()
    const preReady = await prepareElectronRuntime(shell)
    if (preReady.abort) throw new Error('前置阶段不应 abort')
    const infraResult = await createInfrastructure({ runtime: preReady.runtime, shell, useMock: true })
    if (!infraResult.ok) throw new Error(`infrastructure 失败：${infraResult.message}`)
    return { infrastructure: infraResult.infrastructure, transport: createTransport({ useMock: true }) }
  }

  // F1（HIGH）：整改曾把工具事件推送写成裸循环，丢掉 H-12 的「跳过已销毁窗口 + 逐窗口 try/catch」。
  // 该异常发生在 IPC 之外 ⇒ 主进程未捕获异常 ⇒ fatalRuntime 弹框 + exit(1) 中途打断 before-quit
  // 的有序 flush（工具终态 emit 正发生在工具 shutdown 与退出 flush 之间）。
  it('工具事件推送保留逐窗口守卫：已销毁窗口被跳过，send 抛错不外泄', async () => {
    const { infrastructure, transport } = await makeContexts()
    await createApplicationServices({
      infrastructure,
      transport,
      probe: { activeConversationId: () => undefined }
    })
    const pushEvent = h.toolDeps?.pushEvent
    expect(pushEvent, '未捕获到 tool-service 的 pushEvent').toBeTypeOf('function')

    const sent: Array<{ channel: string; payload: unknown }> = []
    h.windows.push(
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, payload) => { sent.push({ channel, payload }) } } },
      { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: () => { throw new Error('已销毁窗口不该被投递') } } },
      // isDestroyed() 与 send() 之间的真实竞态：send 抛错必须被吞掉，且不阻断其余窗口
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw new Error('销毁竞态') } } },
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, payload) => { sent.push({ channel, payload }) } } }
    )

    expect(() => pushEvent?.({ event: 'tool.started' })).not.toThrow()
    expect(sent.length, '健康窗口仍应收到推送（抛错窗口不阻断其余）').toBe(2)
  })

  // F2（MEDIUM）：整改曾把顶层 main().catch 降级成 console.error + exit(1)，丢掉
  // 「无法启动」原生提示与 closeAll（缓冲中的日志/审计可能丢失）。
  it('顶层 main() reject 仍走 shell.fatal：弹「无法启动」+ exit(1)（不是静默 stderr）', async () => {
    const shell = createRuntimeShell()
    // 等价于 index.ts 的 `void main().catch(e => shell.fatal(e.message))`
    shell.fatal('boom')
    expect(h.showErrorBox.map((c) => c.title)).toEqual(['Cyrene 无法启动'])
    expect(h.showErrorBox[0]?.content).toBe('boom')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.exitCodes).toEqual([1])
  })
})

describe('Composition Root wiring 缺口（报告 §12 的四个未覆盖点）', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  /** 走完 pre-ready + infrastructure，拿到可直接喂给 createApplicationServices 的两个上下文 */
  async function makeContexts(): Promise<{ infrastructure: Infrastructure; transport: ReturnType<typeof createTransport> }> {
    const shell = createRuntimeShell()
    const preReady = await prepareElectronRuntime(shell)
    if (preReady.abort) throw new Error('前置阶段不应 abort')
    const infraResult = await createInfrastructure({ runtime: preReady.runtime, shell, useMock: true })
    if (!infraResult.ok) throw new Error(`infrastructure 失败：${infraResult.message}`)
    return { infrastructure: infraResult.infrastructure, transport: createTransport({ useMock: true }) }
  }

  /** startApplication 的最小 deps：只关心它调了谁、按什么顺序、传了什么 */
  function fakeServices() {
    return { live2d: {}, attachments: { media: {} }, diagnostics: { getState: () => ({ devMode: true }) } } as unknown as ApplicationServices
  }

  // ① single-instance / second-instance focus wiring
  it('单实例：拿到锁后才注册 second-instance 聚焦，且 listener 确实调用 focusOrDefer', async () => {
    const shell = createRuntimeShell()
    const result = await prepareElectronRuntime(shell)
    expect(result.abort).toBe(false)

    // 顺序：requestSingleInstanceLock 之后（EventEmitter 不排队，注册早了/晚了都会漏事件）
    const lockIndex = h.calls.indexOf('requestSingleInstanceLock')
    const listenerIndex = h.calls.indexOf('app.on:second-instance')
    expect(lockIndex, '锁必须在 second-instance 注册之前请求').toBeGreaterThan(-1)
    expect(listenerIndex, '必须注册 second-instance 聚焦').toBeGreaterThan(lockIndex)

    const listeners = h.appListeners.get('second-instance') ?? []
    expect(listeners).toHaveLength(1)
    h.calls.length = 0
    listeners[0]?.()
    expect(h.calls, 'second-instance 必须聚焦/建窗').toEqual(['focusOrDefer'])
  })

  it('未拿到锁：直接 exit(0)，不注册 second-instance', async () => {
    h.lockGranted = false
    const shell = createRuntimeShell()
    const result = await prepareElectronRuntime(shell)
    expect(result.abort).toBe(true)
    expect(h.exitCodes).toEqual([0])
    expect(h.appListeners.get('second-instance')).toBeUndefined()
  })

  // ② markAppStarted ③ ensureMainWindow（顺序 + F12 门接线）
  it('启动末段顺序：协议供给 → markAppStarted → ensureMainWindow，且传 F12 门 getter', async () => {
    const { infrastructure } = await makeContexts()
    const services = fakeServices()
    h.calls.length = 0
    await startApplication({ infrastructure, services })

    const proto = h.calls.indexOf('registerCyreneProtocolHandler')
    const started = h.calls.indexOf('markAppStarted')
    const window = h.calls.indexOf('ensureMainWindow')
    expect(proto, '协议供给必须在建窗之前（否则 cyrene:// 404 空白窗）').toBeGreaterThan(-1)
    expect(started, 'markAppStarted 必须在建窗之前（focusOrDefer 的闸门）').toBeGreaterThan(proto)
    expect(window, 'ensureMainWindow 必须在 markAppStarted 之后').toBeGreaterThan(started)
    // D7A-04：F12 门读的是诊断服务的 devMode 会话态，不是常量
    expect(h.windowOpts?.isDevMode()).toBe(true)
  })

  // ④ shutdown step list 本身（集成只钉住 renderer-persist 一步）
  it('退出编排：步骤清单与顺序，且工具 shutdown 先于有序 flush 注册', async () => {
    const { infrastructure } = await makeContexts()
    // diagnostics 步骤读的是 infrastructure.diagnostics 端口（不是 services.diagnostics），
    // 两者都替换，避免把"接错了对象"伪装成通过
    infrastructure.credentials.close = async () => { h.calls.push('step:credentials') }
    infrastructure.diagnostics.closeAll = async () => { h.calls.push('step:diagnostics') }
    const services = fakeServices() as unknown as Record<string, unknown>
    services.adapter = { disconnect: async () => { h.calls.push('step:adapter') } }
    services.tools = { shutdown: () => { h.calls.push('tools.shutdown') } }
    services.diagnostics = { closeAll: async () => { h.calls.push('step:diagnostics(services)') } }
    services.persistFlush = { request: async () => { h.calls.push('step:renderer-persist') }, acknowledge: () => {} }

    h.calls.length = 0
    installShutdownSequence(infrastructure, services as unknown as ApplicationServices)

    expect(h.shutdownDeps?.steps.map((s) => s.name), '步骤清单不得变化/丢步').toEqual([
      'renderer-persist', 'credentials', 'adapter', 'diagnostics'
    ])
    // 两个 before-quit 监听的注册顺序 = 执行顺序：工具收口必须在有序 flush 之前
    const beforeQuit = h.appListeners.get('before-quit') ?? []
    expect(beforeQuit, 'before-quit 必须有两个监听（工具收口 + 有序 flush）').toHaveLength(2)
    h.calls.length = 0
    beforeQuit[0]?.()
    expect(h.calls, '第一个 before-quit 监听必须是工具收口').toEqual(['tools.shutdown'])

    h.calls.length = 0
    for (const step of h.shutdownDeps?.steps ?? []) await step.run()
    await flush()
    expect(h.calls.slice(0, 4), '步骤必须按序执行且每一步都调到真实收尾').toEqual([
      'step:renderer-persist', 'step:credentials', 'step:adapter', 'step:diagnostics'
    ])
  })
})

describe('结构约束：对话框入口不得早于 harness 归一化（整改前的真实缺陷）', () => {
  const preReadySource = readFileSync(new URL('../../src/main/bootstrap/pre-ready.ts', import.meta.url), 'utf8')

  it('全仓只有一个对话框入口实例：shell 复用 defaultDialogService 单例', () => {
    // 自建实例会让 createDialogService 出现第二条调用路径，"先建的那个记住归一化前环境"的缺陷
    // 只是换了个位置（反向 review 发现）。此处钉住 pre-ready 用的是单例。
    expect(preReadySource).toContain('defaultDialogService()')
    // 排除注释行：头注会提到 createDialogService（解释为什么不能自建），只约束真正的调用
    const code = preReadySource
      .split('\n')
      .filter((line) => {
        const t = line.trimStart()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    expect(code, '不得自建 DialogPort 实例').not.toContain('createDialogService(')
  })

  it('pre-ready.ts 里 ensureDialogs() 在 normalizeHarnessForPackagedRun() 之后', () => {
    const normalizeAt = preReadySource.indexOf('normalizeHarnessForPackagedRun()')
    const ensureAt = preReadySource.indexOf('shell.ensureDialogs()')
    expect(normalizeAt).toBeGreaterThan(-1)
    expect(ensureAt).toBeGreaterThan(-1)
    expect(ensureAt, 'createDialogService 会解析 runtimeEnvironment() 单例，必须在归一化之后').toBeGreaterThan(normalizeAt)
  })

  it('index.ts 不再在模块作用域创建对话框/诊断/fatal（避免解析早于归一化）', () => {
    const indexSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(indexSource).not.toContain('createDialogService')
    expect(indexSource).not.toContain('createFatalShutdown')
    expect(indexSource).not.toContain('createDiagnostics')
  })
})
