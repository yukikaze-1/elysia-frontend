// src/main/bootstrap/transport.ts —— 后端适配器装配（架构整改 Prompt 2）。
//
// 本模块承担两件事，二者在整改前混在 `main()` 里、与启动流程纠缠：
//   ① **选择与构造**后端适配器（Real / Mock），含 mock 演示与集成测试用的 `CYRENE_MOCK_*` 夹具 env 桥；
//   ② 把适配器的外向回调（连接状态 / 会话回放 / 协议告警 / 错误 / TTS 媒体 / 桌面工具请求）
//      统一在 wiring 阶段绑定。
//
// 为什么接线要单列一相（整改前的 `chatBridge` / `toolBridge` / `mediaBridge` 与 `fileRefsHolder`
// 就是为了绕过这个顺序）：
// 回调指向 chat/tool/media 三个服务，而这三个服务构造时又需要 adapter 实例。
// 整改前是"先放三个空容器，构造服务后再逐个回填"；现在改为**构造与接线分离**：
//   createTransport({ useMock })                  → 得到 adapter（未接任何跨服务回调）
//   createApplicationServices({ infra, transport }) → 得到 chat/tool/media 等
//   installBackendCallbacks(transport, callbacks)  → 一次性把回调接到已构造好的服务上
//
// 实现要点（为什么不需要任何可变容器）：适配器的回调"读取点"都在**事件到达时**——
// RealBackend 每次事件都重读自己持有的 `options` 对象，MockBackend 每次事件都调用构造时传入的闭包。
// 于是本模块**自己持有那个 options 对象**（`transport.realOptions`），接线阶段对它做属性赋值即可，
// 既不给传输层加 API、也不需要类型断言。
import { readFileSync } from 'fs'
import type { ConnectionState } from '@shared/contracts/backend'
import type { ConversationTokenUsage, Message } from '@shared/contracts/message'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import type { CyreneError } from '@shared/errors'
import { getMainWindow } from '../ipc/registry'
import { MockBackend, parseMockHistoryCountEnv, parseMockVoiceTranscriptDelayEnv, parseMockVoiceTranscriptEnv, parseMockEmitDelayEnv, parseMockEmotionEnv, parseMockMouthLevelEnv, parseMockMouthWindowEnv, parseMockDirectiveEnv, parseMockToolFlowEnv, parseMockToolHistoryEnv, parseMockDisconnectAfterMsEnv, parseMockMultiSegmentEnv } from '../transport/mock-backend'
import { RealBackend, type RealBackendOptions, type TtsMediaSink } from '../transport/real-backend'
import type { BackendAdapter } from '../transport/backend-adapter'
import { MockCharacterBackend } from '../characters/mock-character-backend'
import { resolveCharacterServiceBackend, type CharacterServiceBackendAssembly } from '../characters/character-service-assembly'
import { parseMockCaptureSourcesEnv, parseMockGrantDirectoryEnv, parseMockToolAllowRootEnv } from '../tools/env-bridge'
import type { DesktopToolRequest } from '../tools/tool-execution-contract'

/** mock 演示/集成夹具的 env 桥结果（真实模式一律不解析——`CYRENE_MOCK_*` 误设不生效） */
export interface MockFixtureEnv {
  /** 注入工具 allowRoots（黑名单放宽，仅 mock） */
  toolAllowRoot?: string[]
  /** 注入确定性采集源清单（仅 mock） */
  captureSources?: ReturnType<typeof parseMockCaptureSourcesEnv>
  /** 注入目录授权流固定路径（仅 mock） */
  grantDirectoryPath?: string
  /** 口型包络源选择（仅 mock；渲染侧经 getRuntimeInfo 水合） */
  mouthLevel?: 'step' | 'sine'
}

export interface Transport {
  adapter: BackendAdapter
  useMock: boolean
  /** 角色域后端装配（real 与 mock 都在 `createTransport` 内解析完成） */
  characterBackend: CharacterServiceBackendAssembly
  /** mock 夹具 env 桥结果（services 装配工具服务时消费；real 模式为空对象） */
  fixtureEnv: MockFixtureEnv
  /**
   * real 分支的适配器选项对象——**由本模块持有并传给构造函数**，接线阶段对它做属性赋值。
   * mock 分支为 undefined（mock 的回调在构造时以转发闭包注入，见 `mockSinks`）。
   */
  realOptions?: RealBackendOptions
  /** mock 分支的转发闭包槽（仅 mock 有值；`installBackendCallbacks` 填它） */
  mockSinks?: MockSinks
}

export interface TransportOptions {
  useMock: boolean
}

/** 真实模式下 `CYRENE_MOCK_*` 一律不注入（纪律同 mockMouthLevel：真实模式误设不得关掉黑名单/门禁） */
export function resolveMockFixtureEnv(useMock: boolean, env: NodeJS.ProcessEnv = process.env): MockFixtureEnv {
  if (!useMock) return {}
  const toolAllowRoot = parseMockToolAllowRootEnv(env.CYRENE_MOCK_TOOL_ALLOW_ROOT)
  const captureSources = parseMockCaptureSourcesEnv(env.CYRENE_MOCK_CAPTURE_SOURCES)
  const grantDirectoryPath = parseMockGrantDirectoryEnv(env.CYRENE_MOCK_GRANT_DIRECTORY)
  const mouthLevel = parseMockMouthLevelEnv(env.CYRENE_MOCK_MOUTH_LEVEL)
  return {
    ...(toolAllowRoot !== undefined ? { toolAllowRoot } : {}),
    ...(captureSources !== undefined ? { captureSources } : {}),
    ...(grantDirectoryPath !== undefined ? { grantDirectoryPath } : {}),
    ...(mouthLevel !== undefined ? { mouthLevel } : {})
  }
}

/**
 * 构造后端适配器。**此阶段不接任何跨服务回调**——回调在 `installBackendCallbacks` 一次性绑定。
 *
 * Mock 分支的 `CYRENE_MOCK_*` 夹具桥（历史条数/语音转写文本与延迟/发射间隔/情绪/口型/TTS 窗口/
 * 表现指令/工具双轨/归档 seed/回复正文夹具/自动断线/多分段/生成卡死）全部在 `buildMockBackendOptions`
 * 解析：它们只在 mock 分支被读取，该分支本身即等价门控，语义与整改前逐条一致。
 */
export function createTransport(options: TransportOptions): Transport {
  const { useMock } = options
  const fixtureEnv = resolveMockFixtureEnv(useMock)

  if (!useMock) {
    const realOptions: RealBackendOptions = {}
    const adapter = new RealBackend(realOptions)
    return {
      adapter,
      useMock: false,
      characterBackend: resolveCharacterServiceBackend({ useMock: false, adapter }),
      fixtureEnv,
      realOptions
    }
  }

  // FE-E1：Mock 角色服务与聊天 Mock 通过装配层注入不可变 binding 快照，二者仍保持独立。
  const mockCharacterBackend = new MockCharacterBackend()
  // mock 适配器把构造期回调**拷进实例字段**，故此处传入"事件到达时才读"的转发闭包：
  // 闭包读的局部变量 `sinks` 由 `installBackendCallbacks` 填满（接线阶段唯一入口）。
  // 填满前触发回调是"静默无接收者"，与整改前经可选链的行为逐字一致
  // （这些回调只在 connect / 帧到达时触发，那时接线早已完成）。
  const sinks: MockSinks = {}
  const adapter = new MockBackend({
    ...buildMockBackendOptions(),
    features: mockCharacterBackend.features,
    characterBindings: mockCharacterBackend.getConversationBindings(),
    characterBindingResolver: (characterId: string) => mockCharacterBackend.getConversationBinding(characterId),
    onConnectionStateChange: (state) => sinks.onConnectionStateChange?.(state),
    toolRequestSink: (req) => sinks.onToolRequest?.(req),
    ...(fixtureEnv.mouthLevel !== undefined
      ? { mockMouthLevel: fixtureEnv.mouthLevel, ttsAudioSink: (id: string, b: Uint8Array, m?: string) => sinks.ttsAudioSink?.(id, b, m) }
      : {})
  })
  return {
    adapter,
    useMock: true,
    characterBackend: resolveCharacterServiceBackend({
      useMock: true,
      adapter,
      mockBackend: mockCharacterBackend,
      getMockFeatures: () => mockCharacterBackend.features
    }),
    fixtureEnv,
    mockSinks: sinks
  }
}

/** mock 分支的接线目标（仅在 `createTransport` 与 `installBackendCallbacks` 之间传递） */
interface MockSinks {
  onConnectionStateChange?: (state: ConnectionState) => void
  onToolRequest?: (req: DesktopToolRequest) => void
  ttsAudioSink?: (id: string, bytes: Uint8Array, mime?: string) => { url: string } | undefined
}

/** mock 夹具选项拼装（与整改前 `main()` 的 MockBackend 构造参数**逐条同义**）。 */
function buildMockBackendOptions(): Omit<ConstructorParameters<typeof MockBackend>[0], 'features' | 'characterBindings' | 'characterBindingResolver'> {
  const env = process.env
  const mockHistoryCount = parseMockHistoryCountEnv(env.CYRENE_MOCK_HISTORY_LARGE)
  // P4-B Task 15 最小 env 桥：测试注入普通录音转写文本（显式空串=未识别，mock 不发 transcript）。
  const mockVoiceTranscript = parseMockVoiceTranscriptEnv(env.CYRENE_MOCK_VOICE_TRANSCRIPT)
  // Task 3 env 桥（R-S4-05）：mock 慢转写，集成可观察「正在识别…」等待态。
  // 与 voiceTranscriptText 的「空串合法」语义刻意不同——延迟 env 空串 → Number('')=0 → 钳 0（无延迟），合法。
  const mockVoiceTranscriptDelay = parseMockVoiceTranscriptDelayEnv(env.CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS)
  const mockEmitDelay = parseMockEmitDelayEnv(env.CYRENE_MOCK_EMIT_DELAY_MS)
  // H-10 集成注入：发送触发的生成只发 generation.started 后彻底静默（模拟后端卡住/丢终态）
  const mockStallGeneration = env.CYRENE_MOCK_STALL_GENERATION === '1'
  const mockGenerationEmotion = parseMockEmotionEnv(env.CYRENE_MOCK_GENERATION_EMOTION)
  const mockMouthWindowMs = parseMockMouthWindowEnv(env.CYRENE_MOCK_MOUTH_WINDOW_MS)
  const mockDirective = parseMockDirectiveEnv(env.CYRENE_MOCK_DIRECTIVE)
  const mockToolFlow = parseMockToolFlowEnv(env.CYRENE_MOCK_TOOL_FLOW)
  const mockToolHistory = parseMockToolHistoryEnv(env.CYRENE_MOCK_TOOL_HISTORY)
  const mockDisconnectAfter = parseMockDisconnectAfterMsEnv(env.CYRENE_MOCK_DISCONNECT_AFTER_MS)
  const mockMultiSegment = parseMockMultiSegmentEnv(env.CYRENE_MOCK_MULTI_SEGMENT)
  // 阶段 7 批次 A（Task 3，可行 MED）：mock 回复正文夹具 env 桥——内容覆盖 mock 生成回复正文
  // （集成 markdown-xss 注入 XSS 载荷用）；读取失败（路径缺失/权限）→ readFileSync 抛 IOException
  // 构造报错 fail-start（测试夹具缺失属装配错误）。
  const mockReplyFixtureText = env.CYRENE_MOCK_REPLY_FIXTURE ? readFileSync(env.CYRENE_MOCK_REPLY_FIXTURE, 'utf-8') : undefined

  return {
    ...(mockHistoryCount !== undefined ? { seedHistoryCount: mockHistoryCount } : {}),
    ...(mockVoiceTranscript !== undefined ? { voiceTranscriptText: mockVoiceTranscript } : {}),
    ...(mockVoiceTranscriptDelay !== undefined ? { transcriptDelayMs: mockVoiceTranscriptDelay } : {}),
    ...(mockEmitDelay !== undefined ? { emitDelayMs: mockEmitDelay } : {}),
    ...(mockGenerationEmotion !== undefined ? { generationEmotion: mockGenerationEmotion } : {}),
    ...(mockMouthWindowMs !== undefined ? { mouthTtsWindowMs: mockMouthWindowMs } : {}),
    ...(mockDirective !== undefined ? { directive: mockDirective } : {}),
    ...(mockToolFlow !== undefined ? { toolFlow: mockToolFlow } : {}),
    ...(mockToolHistory ? { toolHistory: true } : {}),
    ...(mockReplyFixtureText !== undefined ? { replyFixtureText: mockReplyFixtureText } : {}),
    ...(mockDisconnectAfter !== undefined ? { disconnectAfterMs: mockDisconnectAfter } : {}),
    ...(mockMultiSegment !== undefined ? { multiSegmentCount: mockMultiSegment } : {}),
    ...(mockStallGeneration ? { stallGeneration: true } : {})
  }
}

/**
 * 适配器 → 服务的跨服务回调集合。全部在 wiring 阶段一次性绑定，不存在"先 undefined 后回填"的容器。
 */
export interface BackendCallbacks {
  onConnectionStateChange(state: ConnectionState): void
  onSessionReplay(conversationId: string, messages: Message[], usage?: ConversationTokenUsage): void
  onProtocolWarning(warning: ProtocolWarning): void
  onError(error: CyreneError): void
  /** 音频帧到达时取 TTS 媒体接收端（返回 undefined 即无接收端：real 侧告警丢弃 `TTS_MEDIA_SINK_MISSING`） */
  ttsMedia(): TtsMediaSink | undefined
  /** 桌面工具请求交付（mock 经构造注入的 `toolRequestSink` 转发槽，real 经公开的 `onToolRequest` 字段） */
  onToolRequest(req: DesktopToolRequest): void
}

/**
 * 把回调接到适配器上。本函数是**唯一**接线点，故也是唯一需要审读"谁在什么时候被接上"的地方。
 *
 * 两条分支的注入点不同、语义相同：
 * - RealBackend：对自己持有的 `options` 对象做属性赋值。**读取点全部在事件到达时**
 *   （`this.options.X?.(…)`，含 connect 时构造的 FrameMapper），故等价于构造时传入；
 *   字段名受 `RealBackendOptions` 类型检查，改名即编译失败（不需要任何类型断言）。
 * - MockBackend：三个回调在构造时已拷进实例字段，故经构造时传入的转发闭包（`transport.mockSinks`）赋值。
 *
 * 两个接线目标都由 `Transport` 持有，生命周期被限制在本模块内——不再是整改前那种"模块作用域、
 * 跨三个阶段各自回填"的容器。唯一约束是调用顺序：`createTransport` 之后、connect 之前。
 */
export function installBackendCallbacks(transport: Transport, callbacks: BackendCallbacks): void {
  const sinks = transport.mockSinks
  if (sinks) {
    sinks.onConnectionStateChange = (state) => callbacks.onConnectionStateChange(state)
    sinks.onToolRequest = (req) => callbacks.onToolRequest(req)
    sinks.ttsAudioSink = (id, bytes, mime) => callbacks.ttsMedia()?.putTtsAudio(id, bytes, mime)
  }
  const options = transport.realOptions
  if (options) {
    // real 的桌面工具请求走公开可选字段（D6B-08 契约）；mock 经构造注入的 toolRequestSink
    transport.adapter.onToolRequest = (req) => callbacks.onToolRequest(req)
    options.onConnectionStateChange = (state) => callbacks.onConnectionStateChange(state)
    options.onSessionReplay = (conversationId, messages, usage) => callbacks.onSessionReplay(conversationId, messages, usage)
    options.onProtocolWarning = (warning) => callbacks.onProtocolWarning(warning)
    options.onError = (error) => callbacks.onError(error)
    options.getTtsMedia = () => callbacks.ttsMedia()
  }
}

/** webContents 推送入口：窗口未建时静默丢弃（P3 守卫，与整改前一致） */
export function sendToMainWindow(channel: string, payload: unknown): void {
  const win = getMainWindow()
  win?.webContents.send(channel, payload)
}
