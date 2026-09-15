import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { BackendEvent } from '@shared/contracts'
import type {
  ActivateConversationResult,
  ActivateModelProfileCommand,
  BackendSession,
  CancelGenerationInput,
  ChatHistoryPage,
  ChatHistoryQuery,
  ConnectInput,
  ConnectionState,
  ConversationDetail,
  ConversationMessagesQuery,
  GetConversationQuery,
  MessageContextQuery,
  MessagePage,
  DesktopCallStatus,
  ModelProfileTestResult,
  ToolStatusCommand
} from '@shared/contracts/backend'
export type { ConnectionState, ConnectionStatus } from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput, Page, PageQuery } from '@shared/contracts/conversation'
import type { ClientRequestRef, Message, SendMessageInput } from '@shared/contracts/message'
import type {
  CharacterArchiveResult,
  CharacterDetail,
  CharacterDraft,
  CharacterId,
  CharacterListQuery,
  CharacterMutationResult,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterRevisionQuery,
  CharacterPublicState,
  CharacterRevisionSummary,
  CharacterValidationResult,
  CloneCharacterCommand,
  CreateCharacterCommand,
  ResetCharacterEvolutionCommand,
  ResetCharacterEvolutionResult,
  RollbackCharacterCommand,
  UpdateCharacterCommand,
  UpdateUserIdentityCommand,
  UserIdentityProfile,
  CharacterSummary
} from '@shared/contracts/character'
import type { ActiveModelSelection, ModelProfile, ModelProfileTestCommand, ModelServiceType, SetTtsVoiceCommand, TtsPreviewCommand, TtsVoiceListResult, UpsertModelProfileCommand } from '@shared/contracts/model'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { ProtocolWarningCode } from '@shared/contracts/protocol'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { parseRawFrame } from './protocol-v2/raw-schemas'
import {
  parseBackendFeatureFlags,
  toDomainArchiveResult,
  toDomainCharacterList,
  toDomainDetail,
  toDomainMutationResult,
  toDomainPreviewResult,
  toDomainProfile,
  toDomainPublicState,
  toDomainResetResult,
  toDomainRevisionList,
  toDomainValidationResult,
  toRestCharacterListQuery,
  toRestCharacterRevisionQuery,
  toRestCloneCharacterBody,
  toRestCreateCharacterBody,
  toRestPreviewCharacterBody,
  toRestResetEvolutionBody,
  toRestRollbackCharacterBody,
  toRestUpdateCharacterBody,
  toRestUpdateMeBody,
  toRestValidateCharacterBody,
  toRestCreateSessionBody
} from './protocol-v2/character-rest-mapper'
import type {
  RawAudioCancelled,
  RawAudioChunk,
  RawAudioEnd,
  RawAudioStart,
  RawErrorMessage,
  RawServerInfo,
  RawSessionMessage,
  RawToolStatus,
  RawUserAck
} from './protocol-v2/raw-types'
import { FrameMapper } from './protocol-v2/frame-mapper'
import { RestMapper, compareBySortKey, pairToolCalls } from './protocol-v2/rest-mapper'
import { parseRestActivateResult, parseRestMessagesPage, parseRestSessionDetail, parseRestSessions, RestSessionSummarySchema, parseAttachmentUploadResponse, parseAttachmentSignResponse, parseRestMessageContext, parseRestSearchMessages, parseRestStickerList, parseRestProviders, parseRestProviderTest, parseRestTtsVoices, parseRestTtsPreview } from './protocol-v2/rest-schemas'
import {
  parseRestMe,
  parseRestCharacterList,
  parseRestCharacterDetail,
  parseRestCharacterRevisions,
  parseRestCharacterMutation,
  parseRestCharacterArchive,
  parseRestCharacterValidation,
  parseRestCharacterPreview,
  parseRestCharacterState,
  parseRestResetEvolution,
  RestUpdateMeBodySchema,
  RestCharacterListQuerySchema,
  RestCharacterRevisionQuerySchema,
  RestCreateCharacterBodySchema,
  RestUpdateCharacterBodySchema,
  RestCloneCharacterBodySchema,
  RestRollbackCharacterBodySchema,
  RestValidateCharacterBodySchema,
  RestPreviewCharacterBodySchema,
  RestResetEvolutionBodySchema
} from './protocol-v2/character-rest-schemas'
import { DesktopCallStatusSchema } from '@shared/schemas/ipc-response'   // 批次 C（D6C-11）：GET tools/calls 响应解析
import { providersToModelProfiles } from './providers-mapper'
import type { RestSearchMessagesResponse } from './protocol-v2/rest-types'
import { VOICE_ERROR_CODES } from '@shared/contracts'
import type { HistoryCategory, StickerManifest, VoiceErrorEvent, AudioCancelInput, DictationStartInput, DictationStopInput, RealtimeVoiceControlInput, RealtimeVoiceStartInput, VoiceCommitInput, VoiceDiscardInput, VoiceInputMode, VoiceRecordStartInput, VoiceRecordStopInput, AudioSessionReadyEvent } from '@shared/contracts'
import type { BackendAdapter, BackendEventHandler, UploadContent } from './backend-adapter'
import type { CharacterServiceBackendPort } from '../characters/character-backend-port'
import type { AttachmentInfo, AttachmentSignResult } from '@shared/contracts/attachments'
import type { ToolAttachment } from '@shared/contracts/tool'
import type { DesktopToolRequest } from '../tools/tool-service'
import { isDomainAllowed } from '../tools/tool-policy'   // D4-15：域名黑名单（凭据只发往已连接后端端点）

export interface WebSocketLike {
  on(ev: 'open' | 'message' | 'close' | 'error' | 'unexpected-response', cb: (arg?: unknown, arg2?: unknown) => void): void
  send(data: string | Uint8Array): void
  close(): void
  readyState: number
}
/** TTS 音频落盘 sink（Task 6 由 MediaService 装配）：putTtsAudio 写入 bytes 并返回可播放 url */
export interface TtsMediaSink {
  putTtsAudio(id: string, bytes: Uint8Array, mime?: string): { url: string }
}
export interface RealBackendOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike
  onProtocolWarning?: (warning: ProtocolWarning) => void
  onSessionReplay?: (conversationId: string, messages: Message[]) => void
  onError?: (error: CyreneError) => void
  /** 帧解析/提炼失败告警（L-4/D6C-09d；测试注入 spy 断言；缺省静默） */
  logger?: { warn(msg: string, extra?: Record<string, unknown>): void }
  /** 连接状态变化回调(状态机任意迁移触发;2C 用于 IPC 状态推送) */
  onConnectionStateChange?: (state: ConnectionState) => void
  /** TTS 音频 sink 提供器(Task 6 装配 MediaService);返回 undefined 表示当前无 sink(不落盘、告警 TTS_MEDIA_SINK_MISSING) */
  getTtsMedia?: () => TtsMediaSink | undefined
  ackTimeoutMs?: number   // 默认 15000;测试注入小值
  reconnectBaseDelayMs?: number  // 默认 1000;测试注入缩短值避免慢测试
  /** S7/C9：重连退避的随机源（默认 `Math.random`）。测试注入固定值即可复现确定延迟 */
  random?: () => number
  handshakeTimeoutMs?: number  // 默认 10000;握手(connect → server_info)超时,测试注入小值
  restTimeoutMs?: number  // 默认 10000;REST 请求超时,测试注入小值
  uploadTimeoutMs?: number  // 默认 60000;附件上传长超时(非 10s,spec §4.4),测试注入小值
  switchTimeoutMs?: number  // 默认 10000;switch_model/set_tts_voice result 帧等待超时,测试注入小值
  /**
   * D4-15：域名黑名单允许集（origin 列表，精确匹配）。
   *
   * 默认允许集只有「已连接端点」（`serverUrl` 的 origin）——即 doc 04 §7.4 的「上传/连接仅限已连接
   * 后端端点」。本选项用于显式放行**额外的受信端点**（典型场景：主端点 + 反代/对象存储网关），
   * 缺省为空 ⇒ 不产生任何额外放行面。绝不接受通配符或子域匹配（缩小口径只能靠显式列举）。
   */
  allowedDomainOrigins?: string[]
}

/** ack 关联的 pending 发送(按 clientRequestId 幂等) */
interface PendingAck {
  resolve: (ref: ClientRequestRef) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The promise returned by one explicit connect() call.  It is deliberately
 * separate from the socket incarnation: a transient socket failure can enter
 * the background reconnect loop after this promise has been rejected, while a
 * newer explicit connect() must be able to settle its own promise only.
 */
interface PendingConnect {
  resolve: (session: BackendSession) => void
  reject: (error: unknown) => void
  settled: boolean
  /**
   * The request stays alive while a transient socket failure is retried. A
   * handshake timeout on the first socket is still fail-fast, while later
   * sockets belong to the reconnect loop.
   */
  reconnecting: boolean
}

const PROTOCOL_VERSION_WIRE = '2.0'   // wire 上 server_info.protocol_version 的展示值(两层取值,见 design §5.3)
const ACK_TIMEOUT_DEFAULT_MS = 15000
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000
const RECONNECT_MAX_ATTEMPTS = 6
const HANDSHAKE_TIMEOUT_DEFAULT_MS = 10000
const REST_TIMEOUT_DEFAULT_MS = 10000
const UPLOAD_TIMEOUT_DEFAULT_MS = 60000
const TOOL_CAPTURE_MAX_BYTES = 16 * 1024 * 1024
const DESKTOP_CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]+$/
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

/** category → search 端点 category 参数（P2-1：不做 'image,video' 组合串假设——契约无出处；按 docs/02 §19 资源端点
 *  单值枚举 image|link|video|audio|file|sticker 处理。image_video（图片/视频 tab）拆两次单值查询合并；其余单值透传；
 *  search 端点 category 最终取值以真实后端联调确认为准（开放项 §7）。check:contract 不覆盖 REST schema，按 frontend_contract/rest.py 人工核对。 */
const HISTORY_CATEGORY_WIRE: Record<HistoryCategory, string[] | undefined> = {
  all: undefined,
  image_video: ['image', 'video'],
  sticker: ['sticker'],
  file: ['file'],
  audio: ['audio'],
  link: ['link']
}

// —— image_video 分页子流状态（P1-3）——
// 旧实现用 Promise.all 并行跑 image/video 两子查询、共用一个不透明游标 → 第二页两流同用异流游标必错。
// 改为：不透明游标 JSON 编码 { image, video } 两个独立子流游标（null=该子流已耗尽，跳过查询；缺省=首次）。
/** 子流状态：exhausted=已耗尽（不再查询）；cursor=该子流继续游标（undefined=首次/尚未查询） */
interface ImageVideoSubStreamState { exhausted: boolean; cursor?: string }
/** 解析后的 image_video 分页状态 */
interface ImageVideoCursorState { image: ImageVideoSubStreamState; video: ImageVideoSubStreamState }
/** 编码进不透明游标的持久形状 */
interface ImageVideoCursorEncoded { image: string | null; video: string | null }

function parseImageVideoCursor(cursor: string | undefined): ImageVideoCursorState {
  if (!cursor) return { image: { exhausted: false }, video: { exhausted: false } }
  try {
    const raw = JSON.parse(cursor) as { image?: string | null; video?: string | null }
    return {
      image: { exhausted: raw.image === null, cursor: typeof raw.image === 'string' ? raw.image : undefined },
      video: { exhausted: raw.video === null, cursor: typeof raw.video === 'string' ? raw.video : undefined }
    }
  } catch {
    // 非本实现编码的游标（后端/旧数据）→ 按首次处理（image/video 都从第一页开始）
    return { image: { exhausted: false }, video: { exhausted: false } }
  }
}

/** REST HTTP 状态 + 后端 code → 领域错误码(spec §5.3 REST 错误映射)。
 *  400 CONTRACT_VALIDATION/INVALID_TIMEZONE → INVALID_INPUT;401/403 → AUTHENTICATION_FAILED;404 → NOT_FOUND;其余 → UNKNOWN。 */
function mapHttpError(status: number, code: string): CyreneErrorCode {
  if (status === 400 && code === 'CONTRACT_VALIDATION') return CyreneErrorCode.INVALID_INPUT
  if (status === 400 && code === 'INVALID_TIMEZONE') return CyreneErrorCode.INVALID_INPUT   // 阶段3 整改 P0-01：后端日期/时区 fail-fast（BE-S3-INT-P1-01）
  if (status === 401 || status === 403) return CyreneErrorCode.AUTHENTICATION_FAILED
  if (status === 404) return CyreneErrorCode.NOT_FOUND
  return CyreneErrorCode.UNKNOWN
}

type CharacterResponseParser<T> = (input: unknown) =>
  | { success: true; data: T }
  | { success: false; error: unknown }

type CharacterRequestSchema<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown }
}

function characterRequest<T>(schema: CharacterRequestSchema<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `${label}请求校验失败`)
  return parsed.data
}

function requireCharacterId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `${label}标识无效`)
  }
  return value
}

function characterQuery(params: object): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number') query.set(key, String(value))
  }
  return query.toString()
}

/**
 * RealBackend:真实后端适配器(WS 连接核心 + REST 会话方法)。
 * 协议差异全部收敛在此(URL/字段名/WS 帧),UI 只消费领域事件。
 * Task 4 实现 connect/握手/帧分派/session 回放/心跳重连/ack 关联/error 路由;
 * Task 5 实现 REST 会话方法(list/get/messages/create/rename/delete/activate + Bearer + 错误映射);
 * P4-A 模型/TTS 方法已真实落成;P4-B 语音控制帧/sendAudioBytes/voice.error 路由已落地(Task 4);
 * 批次 B（Task 6）submitToolResult（tool.status 帧）与 tool.request 路由（onToolRequest）已落地。
 */
export class RealBackend implements BackendAdapter, CharacterServiceBackendPort {
  private ws?: WebSocketLike
  private readonly options: RealBackendOptions
  private readonly handler = new Set<BackendEventHandler>()
  private readonly pendingAcks = new Map<string, PendingAck>()
  private state: ConnectionState = { status: 'disconnected' }
  private mapper?: FrameMapper
  private readonly restMapper = new RestMapper()
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private handshakeTimer?: ReturnType<typeof setTimeout>
  /**
   * Local transport incarnation.  `connectionId` comes from the server and
   * is not a safe callback owner (a server may reuse it, and a socket can be
   * replaced before its close/error event is delivered).  Every socket and
   * every lifecycle callback captures this monotonic value together with the
   * socket object; both must still match before touching current state.
   */
  private transportIncarnation = 0
  private lastSocketClosedAt?: number
  private disconnected = false
  private serverUrl = ''

  /**
   * D4-15（2026-09-15 裁决「补代码」）：域名黑名单——**凭据只发往已连接后端端点**。
   *
   * doc 04 §7.4「域名黑名单 = 上传/连接仅限已连接后端端点（`ConnectionConfig` baseUrl origin）」，
   * 但此前 `isDomainAllowed` 只有定义与单测、**生产零调用**（review C5/D4-15）。本方法是唯一接线点：
   * 三个带 Bearer 的直写 fetch（`uploadAttachments` / `uploadToolAttachment` / `readToolAttachment`）
   * 在发请求前必须过一遍。
   *
   * **判据**：目标 URL 的 origin 必须命中**允许集**——`serverOrigin`（配置端点，反代 path 前缀不计入
   * origin）并集 `options.allowedDomainOrigins`（若配置）。默认允许集即单一端点，等同于「只发往后端」。
   *
   * **如实声明边界（勿把本守卫当 SSRF 防护）**：三个调用点的目标 URL 都由 `serverUrl`/`serverOrigin`
   * 自身拼出，故在**当前**代码里本断言恒真。它的价值是①把「domain 黑名单」从零调用变为**唯一且显式**的
   * 收口点（review C5/D4-15 的原文指控成立）；②给后续任何改用「非自身拼出的 URL」的取值留一处
   * fail-closed 的闸门——例如将来按后端返回的绝对上传地址直传；③端点畸形时**拒发**而非默默打空请求。
   *
   * 失败即**拒发**（不降级、不改写目标）——凭据泄露比上传失败严重。
   */
  private assertBackendOrigin(targetUrl: string): void {
    const allowed = [this.serverOrigin, ...(this.options.allowedDomainOrigins ?? [])].filter((o): o is string => !!o)
    if (allowed.length === 0) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接，域名黑名单无法比对')
    if (!allowed.some((origin) => isDomainAllowed(targetUrl, origin))) {
      throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '目标地址不在已连接后端端点之内（域名黑名单）')
    }
  }
  /** 允许集基线：配置端点的 origin（`serverUrl` 可能带反代 path 前缀，origin 不含 path；畸形/空 → undefined） */
  private get serverOrigin(): string | undefined {
    try { return this.serverUrl ? new URL(this.serverUrl).origin : undefined } catch { return undefined }
  }
  private token = ''
  /**
   * Local source ownership for the current explicit connection. This is
   * deliberately opaque and never derived from (or correlated with) token
   * material. A background socket retry does not mint a new scope.
   */
  private connectionScopeId?: string
  private pendingConnect?: PendingConnect
  /** T3:在途 REST 请求的 AbortController;disconnect 时统一 abort,使挂起请求按 NOT_CONNECTED 终止 */
  private readonly activeControllers = new Set<AbortController>()
  /** server_info.services 归一化（llm/stt/tts 每服务 model 三态：string|null|缺省）；P4-A 由 getActiveModelSelection 消费 */
  private services?: { llm?: { model?: string | null }; stt?: { model?: string | null }; tts?: { model?: string | null } }
  /** switch_model result 帧 pending 关联（无 clientRequestId，按 service+model 回显匹配，D-A14）；单服务单 in-flight */
  private pendingSwitch: Map<ModelServiceType, { model: string; resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }> = new Map()
  /** set_tts_voice result 帧 pending 关联（按 voice 回显匹配）；单 in-flight */
  private pendingVoice?: { voice: string; resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
  /** 单活动语音会话注册表（P4-B Task 4）：任一语音 start 前守卫（本地抛错防重入），成功后置位；
   *  record.stop/discard、dictation.stop/cancel、voice_session.ended 清位（realtime stop/cancel 延后到 ended 回执）。
   *  真实并发冲突由后端 error{VOICE_SESSION_CONFLICT} 帧经 voice.error 兜底（D-P15）。 */
  private activeVoice?: { kind: VoiceInputMode; key: string }
  /** TTS audio_* 帧缓冲（Task 5）：按 stream_id 积累 chunks；audio_end 时拼装写入 sink 并 emit ready；新 stream supersede 旧 */
  private ttsBuffers = new Map<number, { chunks: Uint8Array[]; bytes: number; format: 'wav' | 'mp3'; durationMs?: number }>()
  /** Monotonic local source fence for REST results that outlive an explicit connect boundary. */
  private sourceGeneration = 0
  /** 批次 B（Task 6，D6B-08）：tool.request 路由目标——可空 setter（index.ts 在 adapter 构造后注入 tool-service，
   *  避免构造环；BackendAdapter 接口可选成员，real 专用）。 */
  onToolRequest?: (req: DesktopToolRequest) => void

  constructor(options: RealBackendOptions = {}) { this.options = options }

  private get restTimeoutMs(): number { return this.options.restTimeoutMs ?? REST_TIMEOUT_DEFAULT_MS }

  getConnectionState(): ConnectionState { return this.state }

  /** 清除握手超时 timer(connect → server_info);server_info 到达/关闭/disconnect/非 101 响应/重连挂起手动 connect 均调用 */
  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined }
  }

  /** A callback is allowed to enter the adapter only while it owns the live socket. */
  private isCurrentTransport(ws: WebSocketLike, incarnation: number): boolean {
    return !this.disconnected && this.ws === ws && this.transportIncarnation === incarnation
  }

  /** Retire a socket before closing/replacing it so its queued callbacks fail closed. */
  private retireTransport(ws: WebSocketLike, incarnation: number): boolean {
    if (this.ws !== ws || this.transportIncarnation !== incarnation) return false
    this.transportIncarnation++
    this.ws = undefined
    return true
  }

  /** 统一状态迁移入口:赋值 + 回调。加性改造——迁移前后各状态机路径产生的对象值不变;
   *  `this.state` 直接替换(非原地 Object.assign):getConnectionState 当前无外部调用方持引用依赖对象身份
   *  (仅 spec 即时断言),替换语义与 2B 逐点一致,避免原地合并残留旧字段(如 error 后 lastError 泄漏进 connecting)。 */
  private setState(next: ConnectionState): void {
    this.state = next
    this.options.onConnectionStateChange?.(this.state)
  }

  private sourceBoundaryError(): CyreneError {
    return new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, '连接来源已切换，请重试')
  }

  /**
   * REST 请求失败归一（2026-09-10）。
   *
   * 背景：四处 REST catch 的兜底分支此前是裸 `throw e`。当失败发生在网络层时，`e` 是
   * `fetch` 抛出的**原生异常**（Chromium 的 `TypeError: Failed to fetch`，无错误码）。
   * 它穿透到 renderer 后，契约按 `code` 匹配自然落空 → 界面把 `Failed to fetch` 原样显示给用户
   * （真机实测：网络中断时角色公开状态卡片出现该文本）。
   *
   * 这里把「非 CyreneError」一律归一为 `NOT_CONNECTED`：语义正确（请求根本没到达后端）、
   * 有错误码（契约可映射）、文案可操作。已是 `CyreneError` 的原样抛出——HTTP 错误、超时、
   * 取消等业务语义不能被这条兜底覆盖。
   *
   * 不让 renderer 各渲染点自行过滤：UI 层过滤只能做到「不显示」，而这里能给出**可操作的原因**。
   */
  private restFailure(error: unknown): CyreneError {
    if (error instanceof CyreneError) return error
    // 底层成因不能就此消失：实测为定位一次偶发失败花了三轮，正是因为这里把
    // `ECONNREFUSED` / `ECONNRESET` / abort / DNS 等完全不同的成因压成一句话且不留任何痕迹。故把原始错误挂在
    // **非枚举的 `cause`**（ES2022 语义，不进序列化）：不改用户可见文案、不改错误码。
    const wrapped = new CyreneError(CyreneErrorCode.NOT_CONNECTED,
      '无法连接后端：网络请求失败，请检查连接或后端是否在运行')
    Object.defineProperty(wrapped, 'cause', { value: error, enumerable: false, configurable: true, writable: true })
    // 同时把**成因的码/名**放进 `details`（仅码名：
    // 不带消息、不带路径）——这样下一次偶发在**CI 日志里就能读出成因**（vitest 会把 details 序列化进失败输出）。
    // IPC 执行器只从 details 里取特定字段（retryable/requestId/issues 等），故不会被整体投影给 Renderer。
    const causeCode = (error as { code?: unknown }).code
    const kind = typeof causeCode === 'string' ? causeCode : error instanceof Error ? error.name : typeof error
    Object.defineProperty(wrapped, 'details', { value: { cause: kind }, enumerable: true, configurable: true, writable: true })
    return wrapped
  }

  /**
   * Explicit connect is a hard source boundary even when endpoint, account,
   * character identity and server connectionId are all reused. Retire every
   * operation owned by the old source before installing the new token/scope;
   * automatic socket reconnect deliberately does not call this method.
   */
  private clearSourceOwnedOperations(): void {
    this.sourceGeneration++
    this.clearHandshakeTimer()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }

    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.sourceBoundaryError())
    }
    this.pendingAcks.clear()

    for (const pending of this.pendingSwitch.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.sourceBoundaryError())
    }
    this.pendingSwitch.clear()

    if (this.pendingVoice) {
      clearTimeout(this.pendingVoice.timer)
      this.pendingVoice.reject(this.sourceBoundaryError())
      this.pendingVoice = undefined
    }

    this.activeVoice = undefined
    this.ttsBuffers.clear()
    this.services = undefined
    // FrameMapper owns segment/audio identity tables. Do not let one survive
    // into B even if a stale audio_end callback is delivered later.
    this.mapper = undefined

    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()

    // Retire/close A before B allocates a socket. WebSocket mocks may invoke
    // close synchronously; retirement makes those callbacks inert first.
    const oldWs = this.ws
    if (oldWs) {
      const oldIncarnation = this.transportIncarnation
      this.retireTransport(oldWs, oldIncarnation)
      try { oldWs.close() } catch { /* source replacement is best effort */ }
    } else {
      this.transportIncarnation++
    }
  }

  /** Settle only the still-current explicit connect attempt. */
  private settleConnectAttempt(attempt: PendingConnect | undefined, result: { session: BackendSession } | { error: unknown }): boolean {
    if (!attempt || attempt.settled || this.pendingConnect !== attempt) return false
    attempt.settled = true
    this.pendingConnect = undefined
    if ('session' in result) attempt.resolve(result.session)
    else attempt.reject(result.error)
    return true
  }

  /** Keep the explicit connect request as the owner of future retry sockets. */
  private markConnectAttemptReconnecting(attempt: PendingConnect | undefined): void {
    if (!attempt || attempt.settled || this.pendingConnect !== attempt) return
    attempt.reconnecting = true
  }

  subscribe(handler: BackendEventHandler): () => void { this.handler.add(handler); return () => this.handler.delete(handler) }
  async setToken(token: string): Promise<void> { this.token = token }

  // —— 帧分派 ——
  private handleFrame(rawText: string, connectAttempt?: PendingConnect): void {
    let parsed: ReturnType<typeof parseRawFrame>
    try { parsed = parseRawFrame(JSON.parse(rawText)) } catch { this.warn('RAW_FRAME_INVALID', 'JSON 解析失败'); return }
    if (!parsed.success) { this.warn('RAW_FRAME_INVALID', '帧校验失败'); return }
    const frame = parsed.data
    switch (frame.type) {
      case 'session': this.handleSession(frame); return
      case 'server_info': this.handleServerInfo(frame, connectAttempt); return
      case 'expression': {
        if (!this.requireCharacterIdentityWhenProfilesEnabled(frame, 'expression')) return
        // expression 与 Live2D 指令一样必须经过 FrameMapper：legacy 无身份帧由 mapper
        // 返回 null，带 character identity 的帧则进入领域事件并保持身份。
        const ev = this.mapper?.mapFrame(frame)
        if (ev) this.emit(ev)
        return
      }
      case 'state': return // FE-INT-P1-01:FSM 状态契约识别,renderer 暂不消费(有意忽略,勿误删)
      case 'typing': return // FE-INT-P1-01:输入状态契约识别,renderer 暂不消费(有意忽略,勿误删)
      // 阶段 6 真实联调：后端少数旧输出旁路会越过 v2 分流，向 v2 连接广播这三类 v1 兼容帧。
      // v2 的 generation.* / session 已是权威来源；这里只做严格 schema 接纳并显式忽略，避免重复渲染与伪协议告警。
      case 'delta':
      case 'message':
      case 'token_usage': return
      case 'user_message.ack': this.handleAck(frame); return
      case 'error': this.handleErrorFrame(frame); return
      case 'switch_model_result': {
        // 模型 Profile 激活结果：无 clientRequestId，按 service+model 回显匹配 pending（D-A14）；
        // 不匹配/无 pending：忽略（不 resolve/reject、不告警）；匹配后仍 emit 事件给 store。
        const pending = this.pendingSwitch.get(frame.service)
        if (pending && pending.model === frame.model) {
          clearTimeout(pending.timer)
          this.pendingSwitch.delete(frame.service)
          if (frame.ok) pending.resolve()
          else pending.reject(this.resultFrameError(frame.error))
        }
        const ev = this.mapper?.mapFrame(frame)
        if (ev) this.emit(ev)
        return
      }
      case 'set_tts_voice_result': {
        // TTS 声音切换结果：按 voice 回显匹配 pending（voice 缺省不匹配，D-A14）；匹配后仍 emit 事件。
        // P4-A final review：后端 SetTtsVoiceResultMessage 失败时 voice 恒缺省省略（ok:False + error，ws_message.py:565），
        // 仅按 voice 回显匹配会让失败 pending 永不结算（误报 10s 超时）→ 权威失败帧（voice 缺省 + ok:false）也结算。
        const pending = this.pendingVoice
        if (pending && (frame.voice === pending.voice || (!frame.ok && frame.voice === undefined))) {
          clearTimeout(pending.timer)
          this.pendingVoice = undefined
          if (frame.ok) pending.resolve()
          else pending.reject(this.resultFrameError(frame.error))
        }
        const ev = this.mapper?.mapFrame(frame)
        if (ev) this.emit(ev)
        return
      }
      case 'voice_session.ended': {
        // 实时语音会话终态回执：释放单活动会话注册表（Task 4 Step 2 "ended 清位"——realtime stop/cancel
        // 后 activeVoice 保留到 ended 到达，期间仍拒绝其他语音 start，避免双会话）
        if (this.activeVoice?.kind === 'realtime' && this.activeVoice.key === frame.sessionId) {
          this.activeVoice = undefined
        }
        const ev = this.mapper?.mapFrame(frame)
        if (ev) this.emit(ev)
        return
      }
      case 'audio_start': {
        if (!this.requireCharacterIdentityWhenProfilesEnabled(frame, 'audio_start')) return
        this.handleAudioStart(frame)
        return
      }
      case 'audio': this.handleAudioChunk(frame); return
      case 'audio_end': this.handleAudioEnd(frame); return
      case 'audio_cancelled': this.handleAudioCancelled(frame); return
      case 'live2d.directive': {
        if (!this.requireCharacterIdentityWhenProfilesEnabled(frame, 'live2d.directive')) return
        // 批次 C（C3）：后端 Live2D 表现指令建议——经 FrameMapper（Task 1）映射为扁平 Live2DDirectiveEvent
        // 后 emit（store handleDirective 消费）；形状不符已被 raw-schema（Task 1）拒在 parseRawFrame，
        // 不再需要运行时 canary（漂移 canary 放单测级）。
        const ev = this.mapper?.mapFrame(frame)
        if (ev) this.emit(ev)
        return
      }
      case 'tool.request': {
        // 批次 B（Task 6，D6B-08）：显式 case——mapper 校验+脱敏产出仍保留（批次 A 单测依赖 mapFrame 校验），
        // 但不再 emit（Renderer 不经领域事件收桌面工具请求），改路由 tool-service（onToolRequest；index.ts 装配后注入）。
        // arguments/paramHash 只在 Main 流转（D6-07：公开事件不带原始参数）。
        // 批次 C（L-4，D6C-09d）：解析/提炼失败 → warn + 丢弃该帧不崩溃（不 catch 后继续 emit——失败即协议异常）
        try {
          const ev = this.mapper?.mapFrame(frame)   // H3：mapToolRequest 为 private——走 mapFrame 公开入口（产物 ToolRequestEvent）
          if (!ev) return
          this.onToolRequest?.({
            callId: frame.callId, sourceCallId: frame.sourceCallId, toolName: frame.toolName,
            toolVersion: frame.toolVersion, runtime: 'desktop', arguments: frame.arguments, reason: frame.reason,
            expiresAt: Date.parse(frame.expiresAt), paramHash: frame.paramHash,
            conversationId: this.state.activeConversationId,
            // D4-1（2026-09-15 裁决「补代码」）：此前被丢弃的三个风险元数据字段——riskLevel 进本地重算，
            // permissionRequired 进审计。approvalAuthority 仍不使用（本地授权判定权威在注册表，doc 04 §7.4）。
            reportedRiskLevel: frame.riskLevel,
            permissionRequired: frame.permissionRequired,
            approvalAuthority: frame.approvalAuthority,
          })
        } catch (e) {
          // C-10（#18）：非 Error 抛掷归一——`(e as Error).message` 对非 Error 得 undefined，改用 instanceof 判
          this.options.logger?.warn('tool.request:parse-failed', { message: e instanceof Error ? e.message : String(e) })
        }
        return
      }
      default: {
        try {
          const ev = this.mapper?.mapFrame(frame)
          if (ev) this.emit(ev)
        } catch (e) {
          const err = e instanceof CyreneError ? e : new CyreneError(CyreneErrorCode.UNKNOWN, '帧映射失败')
          this.warn('MAPPER_ERROR', err.message)
          this.options.onError?.(err) // 承接点 I-1:映射错误降级告警,不断连
        }
      }
    }
  }

  private handleSession(frame: RawSessionMessage): void {
    if (frame.conversationId) {
      this.setState({ ...this.state, activeConversationId: frame.conversationId })
      this.mapper?.setActiveConversationId(frame.conversationId)
      const messages = pairToolCalls(frame.messages.map((m) => this.restMapper.toDomainMessageFromReplay(m, frame.conversationId as string)))
      this.options.onSessionReplay?.(frame.conversationId, messages)
    } else {
      // C5（2026-09-15 契约评审）：`sessionBuffer` 原设计是「缺 conversationId 的旧后端回放先缓冲、
  // 待 REST active:true 解析后投递」——那条投递路径**从未实现**，字段写进去就再也不出来，
  // 且连告警都没有（回放静默丢失）。权威后端当前 `conversationId` 必填，故该分支今天不可达。
      // 处置：**删掉死字段 + 显式告警**（fail-loud，不再留一个"看起来会投递"的状态）。
      this.warn('SESSION_REPLAY_UNATTRIBUTED', `session 帧缺 conversationId，${frame.messages.length} 条回放无法归属会话，已丢弃`)
    }
  }

  /**
   * Raw schemas stay migration-compatible with old servers, while a server
   * that advertises character_profiles has a stronger runtime guarantee:
   * character-bound presentation/audio frames must carry the full immutable
   * character tuple.  Drop legacy/unattributed frames before they can reach
   * Renderer stores or the TTS identity table.
   */
  private requireCharacterIdentityWhenProfilesEnabled(
    frame: { characterId?: string; characterInstanceId?: string; characterRevision?: number },
    type: string
  ): boolean {
    if (this.state.features?.characterProfiles !== true) return true
    if (frame.characterId !== undefined && frame.characterInstanceId !== undefined && frame.characterRevision !== undefined) return true
    this.warn('RAW_FRAME_INVALID', `${type} 在 character_profiles=true 时必须携带完整角色身份`)
    return false
  }

  private handleServerInfo(frame: RawServerInfo, connectAttempt?: PendingConnect): void {
    this.clearHandshakeTimer() // server_info 到达即握手完成,成功与版本不符两条路径都清(后者走 fail-closed)
    if (frame.protocol_version !== PROTOCOL_VERSION_WIRE) {
      const err = new CyreneError(CyreneErrorCode.PROTOCOL_MISMATCH, `后端协议版本 ${frame.protocol_version} 不兼容，要求 ${PROTOCOL_VERSION_WIRE}`)
      // Retire before close because ws implementations/mocks may deliver the
      // close callback synchronously.  That callback must not schedule a
      // reconnect before the protocol-mismatch error state is installed.
      const ws = this.ws
      if (ws) {
        const incarnation = this.transportIncarnation
        this.retireTransport(ws, incarnation)
        try { ws.close() } catch { /* protocol mismatch close is best effort */ }
      }
      this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl, connectionScopeId: this.connectionScopeId })
      this.settleConnectAttempt(connectAttempt, { error: err })
      this.options.onError?.(err)
      return
    }
    this.reconnectAttempts = 0
    this.setState({
      status: 'connected',
      serverUrl: this.serverUrl,
      protocolVersion: frame.protocol_version,
      serverVersion: frame.server_version,
      connectionScopeId: this.connectionScopeId,
      connectionId: frame.connectionId,
      activeConversationId: this.state.activeConversationId,
      lastError: undefined,
      // 多角色 FE-A（§5.2）：类型化能力旗标——wire === true 才 true，缺省/其他形状 false；
      // 仅 connected 填充且每次 server_info 整体替换（connecting/error 路径不带 features，不留旧连接能力）
      features: parseBackendFeatureFlags(frame.features)
    })
    const session: BackendSession = {
      sessionId: frame.connectionId ?? 'local',
      protocolVersion: frame.protocol_version,
      serverUrl: this.serverUrl
    }
    this.settleConnectAttempt(connectAttempt, { session })
    // services 归一化（版本校验 early-return 之后）：RawServerInfo.services 是 loose record，
    // 只取每服务 model（string|null），未知形状忽略，绝不直接赋值原始 record。
    this.services = this.normalizeServices(frame.services)
  }

  /** RawServerInfo.services 是 loose record（raw-types.ts:53）；只取每服务 model（string|null），未知形状忽略 */
  private normalizeServices(raw: Record<string, unknown> | undefined): { llm?: { model?: string | null }; stt?: { model?: string | null }; tts?: { model?: string | null } } {
    const pick = (svc: string): { model?: string | null } | undefined => {
      const entry = raw?.[svc]
      if (!entry || typeof entry !== 'object') return undefined
      const m = (entry as { model?: unknown }).model
      if (typeof m === 'string') return { model: m }
      if (m === null) return { model: null }
      return undefined
    }
    return { llm: pick('llm'), stt: pick('stt'), tts: pick('tts') }
  }

  private handleAck(frame: RawUserAck): void {
    const pending = this.pendingAcks.get(frame.clientRequestId)
    if (!pending) {
      this.warn('ACK_UNKNOWN_CLIENT_REQUEST_ID', `收到未关联的 user_message.ack: ${frame.clientRequestId}`)
      return
    }
    clearTimeout(pending.timer)
    this.pendingAcks.delete(frame.clientRequestId)
    if (frame.status === 'accepted') {
      pending.resolve({ clientRequestId: frame.clientRequestId, serverMessageId: frame.messageId })
    } else {
      const backendDetails = frame.error.details
      pending.reject(new CyreneError(CyreneErrorCode.BACKEND_REJECTED, frame.error.message, {
        backendCode: frame.error.code,
        retryable: frame.error.retryable,
        ...(frame.error.retryAfterMs !== undefined ? { retryAfterMs: frame.error.retryAfterMs } : {}),
        ...(backendDetails !== undefined ? { backendDetails } : {}),
        ...(typeof backendDetails?.idempotency_durable === 'boolean'
          ? { idempotencyDurable: backendDetails.idempotency_durable }
          : {})
      }))
    }
  }

  /** 语音族错误码判定（D-P15）：VOICE_ERROR_CODES 成员即语音族错误；
   *  Minor 9：CONTRACT_VALIDATION 不入 VOICE_ERROR_CODES（避免非语音 CONTRACT 也抑制连接横幅），
   *  语音会话活跃时的 CONTRACT 违规由调用方按「CONTRACT_VALIDATION && activeVoice」另行判定。 */
  private isVoiceErrorCode(code: string | undefined): boolean {
    return code !== undefined && (VOICE_ERROR_CODES as readonly string[]).includes(code)
  }

  private handleErrorFrame(frame: RawErrorMessage): void {
    // D-P15 语音族错误路由：语音族错误码 ∪（CONTRACT_VALIDATION && 语音会话活跃）→ 额外 emit voice.error
    // （connectionStore 据此抑制全局连接错误横幅）；随后仍走既有 onError 路径（日志/审计不丢）。非语音族不变。
    if (this.isVoiceErrorCode(frame.code) || (frame.code === 'CONTRACT_VALIDATION' && this.activeVoice)) {
      // 显式 T=VoiceErrorEvent：条件展开的 message 会让 TS 把 T 宽化为整个 BackendEvent 联合无法收窄
      const ev = this.mapper?.stampEvent<VoiceErrorEvent>({ event: 'voice.error', code: frame.code as string, ...(frame.message ? { message: frame.message } : {}) })
      if (ev) this.emit(ev)
    }
    const err = new CyreneError(CyreneErrorCode.UNKNOWN, frame.message, {
      code: frame.code,
      requestId: frame.requestId,
      clientRequestId: frame.clientRequestId,
      retryable: frame.retryable,
      retryAfterMs: frame.retryAfterMs,
      ...(frame.details !== undefined ? { backendDetails: frame.details } : {}),
      ...(typeof frame.details?.idempotency_durable === 'boolean'
        ? { idempotencyDurable: frame.details.idempotency_durable }
        : {})
    })
    this.warn('WS_ERROR_FRAME', `后端 error 帧: ${frame.code ?? '(无 code)'} ${frame.message}`)
    this.options.onError?.(err)
  }

  private warn(code: ProtocolWarningCode, message: string): void {
    this.options.onProtocolWarning?.({ code, message })
  }

  // —— TTS 播放帧（audio_*，Task 5；spec §5.5 / D-P8/D-P9）——
  // 文本 JSON 帧（data 为 base64），与二进制接收分支无关（二进制是 WASM 下行/上行语音流，Task 4 分流）。
  /** audio_start：建缓冲条目（durationMs 从帧拷贝）、emit started。新 stream（同 stream_id）自然 supersede 旧缓冲（.set 覆盖） */
  private handleAudioStart(frame: RawAudioStart): void {
    this.ttsBuffers.set(frame.stream_id, {
      chunks: [],
      bytes: 0,
      format: frame.format,
      ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {})
    })
    const ev = this.mapper?.mapFrame(frame)
    if (ev) this.emit(ev)
  }
  /** audio：base64 解码 append 到缓冲（按序拼接） */
  private handleAudioChunk(frame: RawAudioChunk): void {
    const b = this.ttsBuffers.get(frame.stream_id)
    if (!b) { this.warn('AUDIO_ORPHAN_CHUNK', `收到未关联 audio_start 的 audio chunk: stream_id=${frame.stream_id}`); return }
    const bytes = Buffer.from(frame.data, 'base64')
    b.chunks.push(new Uint8Array(bytes))
    b.bytes += bytes.length
  }
  /** audio_end：拼装缓冲写入 sink，emit ready；无 sink 告警丢弃 */
  private handleAudioEnd(frame: RawAudioEnd): void {
    // Keep both owners local. A subscriber may synchronously start an
    // explicit connect from the `audio.session.ready` callback; in that
    // case source cleanup replaces `this.mapper` and clears the shared
    // buffer map. The old callback must never delete B's same stream id or
    // clear B's mapper identity in its finally block.
    const sourceGeneration = this.sourceGeneration
    const mapper = this.mapper
    const b = this.ttsBuffers.get(frame.stream_id)
    if (!b) {
      // 即使缓冲已经被取消/丢弃，也必须清理同 stream 的角色身份，避免下一次
      // audio_start 之前错误继承上一段 TTS 的 character snapshot。
      mapper?.clearAudioIdentity(frame.stream_id)
      this.warn('AUDIO_END_NO_BUFFER', `收到未关联 audio_start 的 audio_end: stream_id=${frame.stream_id}`)
      return
    }
    try {
      if (sourceGeneration !== this.sourceGeneration) return
      const mime = b.format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
      const sink = this.options.getTtsMedia?.()
      if (!sink) {
        this.warn('TTS_MEDIA_SINK_MISSING', `TTS 音频 sink 缺失,丢弃 stream_id=${frame.stream_id}`)
        return
      }
      const concatLen = b.chunks.reduce((s, c) => s + c.length, 0)
      const concat = new Uint8Array(concatLen)
      let off = 0
      for (const c of b.chunks) { concat.set(c, off); off += c.length }
      const { url } = sink.putTtsAudio(`tts-${randomUUID()}`, concat, mime)
      // A sink is supplied by Main and is normally synchronous, but keep the
      // generation check after it as well so a re-entrant source switch cannot
      // publish an A ready event into B.
      if (sourceGeneration !== this.sourceGeneration) return
      const ev = mapper?.stampEvent<AudioSessionReadyEvent>({
        event: 'audio.session.ready',
        streamId: frame.stream_id,
        url,
        ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}),
        format: b.format
      })
      if (ev) this.emit(ev)
    } catch (error) {
      // sink/组装/事件装配失败均按丢弃处理；身份与二进制缓冲由 finally 一并释放。
      this.options.logger?.warn('tts.audio-end:discarded', { message: error instanceof Error ? error.message : String(error) })
    } finally {
      // Only the owner which found this buffer may remove it from the shared
      // map. A source switch clears the old map before B is installed; an
      // unconditional delete here would otherwise erase B's same-key stream.
      if (sourceGeneration === this.sourceGeneration) this.ttsBuffers.delete(frame.stream_id)
      mapper?.clearAudioIdentity(frame.stream_id)
    }
  }
  /** audio_cancelled：清缓冲 + emit cancelled */
  private handleAudioCancelled(frame: RawAudioCancelled): void {
    this.ttsBuffers.delete(frame.stream_id)
    const ev = this.mapper?.mapFrame(frame)
    if (ev) this.emit(ev)
  }

  /**
   * Stamp only the two renderer-facing character events with the desktop-local
   * source fence. The raw wire schemas deliberately remain backend-owned and
   * never accept this field. Events from an old socket are already fenced by
   * (ws, transportIncarnation); this stamp additionally fences events queued
   * in IPC while an explicit connection is replaced.
   */
  private emit(event: BackendEvent): void {
    const scoped = this.connectionScopeId
      && (event.event === 'character.state.changed' || event.event === 'character.catalog.changed')
      ? { ...event, connectionScopeId: this.connectionScopeId }
      : event
    for (const h of this.handler) h(scoped)
  }

  // —— 连接生命周期 ——
  async connect(input: ConnectInput): Promise<BackendSession> {
    if (!input.token) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '缺少 token: 2B 要求建立认证连接', { reason: 'token_missing' })
    }
    this.clearSourceOwnedOperations()
    // A second explicit connect owns a new promise and transport.  Settle the
    // previous promise before replacing its socket so it can never be left
    // pending or later be resolved by B's server_info.
    const superseded = this.pendingConnect
    if (superseded) {
      this.settleConnectAttempt(superseded, {
        error: new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, '连接尝试已被新的连接替换')
      })
    }
    this.serverUrl = input.serverUrl
    this.token = input.token
    // `connect` is the source boundary. The socket(s) created below all
    // belong to this scope; the automatic reconnect loop never regenerates it.
    this.connectionScopeId = randomUUID()
    this.reconnectAttempts = 0
    this.disconnected = false
    return new Promise<BackendSession>((resolve, reject) => {
      const attempt: PendingConnect = { resolve, reject, settled: false, reconnecting: false }
      this.pendingConnect = attempt
      this.setState({ status: 'connecting', serverUrl: this.serverUrl, connectionScopeId: this.connectionScopeId })
      try {
        this.establishWs(attempt)
      } catch (error) {
        // wsFactory failures happen synchronously before any socket callback
        // can settle the attempt.  Keep the same per-attempt ownership rule.
        this.settleConnectAttempt(attempt, { error })
        this.setState({ status: 'error', lastError: error instanceof Error ? error.message : String(error), serverUrl: this.serverUrl, connectionScopeId: this.connectionScopeId })
      }
    })
  }

  private establishWs(connectAttempt?: PendingConnect): void {
    const wsBase = this.serverUrl.replace(/^http/, 'ws') + '/ws'
    const headers: Record<string, string> = {
      'X-Protocol-Version': '2',           // resolve_protocol_version 只认精确 "2"(两层取值,design §5.3)
      'X-Client-Platform': 'electron',
      Authorization: `Bearer ${this.token}`
    }
    // A manual connect can replace a socket while its close/error callback is
    // still queued.  Retire the old object first, then allocate a fresh
    // incarnation even when a wsFactory happens to return the same object.
    const previousWs = this.ws
    if (previousWs) {
      const previousIncarnation = this.transportIncarnation
      this.retireTransport(previousWs, previousIncarnation)
      try { previousWs.close() } catch { /* stale close is best effort */ }
    }
    const factory = this.options.wsFactory
    // aiohttp 压缩连接空闲后可以 RSV 保留位错误拒绝首个客户端业务帧，控制面显式不协商压缩。
    const ws = factory ? factory(wsBase, headers) : new WebSocket(wsBase, { headers, perMessageDeflate: false })
    const incarnation = ++this.transportIncarnation
    this.ws = ws
    this.mapper = new FrameMapper({ connectionId: this.serverUrl, onProtocolWarning: this.options.onProtocolWarning })
    // 握手超时:建 socket 后立即启动(先于 message 注册,保证同步推帧夹具的 server_info 也能在 handleServerInfo 清掉)。
    // 显式 connect 的首个 socket 超时 fail-fast；一旦该请求已进入瞬态
    // 重连，后续 socket 的握手超时只关闭并继续退避，直到同一个请求成功
    // 握手或被硬错误/显式 disconnect/重连上限结算。
    const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_DEFAULT_MS
    this.handshakeTimer = setTimeout(() => {
      if (!this.isCurrentTransport(ws, incarnation)) return
      this.handshakeTimer = undefined
      if (connectAttempt && this.pendingConnect === connectAttempt && !connectAttempt.reconnecting) {
        this.retireTransport(ws, incarnation)
        try { ws.close() } catch { /* timeout close is best effort */ }
        const err = new CyreneError(CyreneErrorCode.TIMEOUT, `等待 server_info 超时(${handshakeTimeoutMs}ms)`)
        this.settleConnectAttempt(connectAttempt, { error: err })
        this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl, connectionScopeId: this.connectionScopeId })
        this.options.onError?.(err)
      } else {
        // Automatic reconnect must go through the normal close path so it
        // retires the incarnation and schedules the next attempt.  Closing
        // after that call is safe even for ws mocks that invoke `close`
        // listeners synchronously.
        this.onSocketClosed(ws, incarnation, connectAttempt)
        try { ws.close() } catch { /* timeout close is best effort */ }
      }
    }, handshakeTimeoutMs)
    ws.on('message', (arg?: unknown, arg2?: unknown) => {
      if (!this.isCurrentTransport(ws, incarnation)) return
      if (arg === undefined) return
      // P4-B Task 4：意外二进制接收（TTS audio_* 等二进制下行由 Task 5 分流；当前无消费方 → 告警忽略不崩）。
      // 判据用 ws 库第二参（isBinary 布尔）而非 Buffer.isBuffer——真实 ws 在 Node 22 下文本帧也以 Buffer 投递
      //（typeof=object），第二参才是二进制/文本的权威判别；文本帧(无论 string/Buffer)仍走 handleFrame。
      if (arg2 === true) { this.warn('UNEXPECTED_BINARY', '收到意外二进制帧,已忽略'); return }
      // 文本帧在 Node 22 下可能是 string 也可能是 Buffer（见上条注释）：三种形态显式区分，
      // 不再 `String(arg)`——那对任意对象都会得到 '[object Object]'（no-base-to-string，2026-09-13）。
      const text = typeof arg === 'string'
        ? arg
        : Buffer.isBuffer(arg)
          ? arg.toString('utf8')
          : ArrayBuffer.isView(arg)
            ? Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength).toString('utf8')
            : '[非文本帧]'
      this.handleFrame(text, connectAttempt)
    })
    ws.on('close', () => { this.onSocketClosed(ws, incarnation, connectAttempt) })
    ws.on('error', () => { this.onSocketClosed(ws, incarnation, connectAttempt) })
    ws.on('unexpected-response', (_req, res) => { this.onUnexpectedResponse(ws, incarnation, res, connectAttempt) })
  }

  /** 非 101 升级响应:仅 400/401/403 fail-fast(协议/认证硬错);429 RATE_LIMITED/503 超限等瞬态状态码 → 走重连退避,
   *  避免限流下全 fail-fast 让重连永久失效(F3,whole-branch review) */
  private onUnexpectedResponse(ws: WebSocketLike, incarnation: number, res: unknown, connectAttempt?: PendingConnect): void {
    if (!this.isCurrentTransport(ws, incarnation)) return
    this.clearHandshakeTimer() // 非 101 升级响应即握手失败,不再等超时
    const statusCode = typeof res === 'object' && res !== null && 'statusCode' in res
      ? (res as { statusCode?: number }).statusCode
      : undefined
    if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
      const err = new CyreneError(
        statusCode === 400 ? CyreneErrorCode.PROTOCOL_MISMATCH : CyreneErrorCode.AUTHENTICATION_FAILED,
        `WebSocket 升级被拒绝(HTTP ${statusCode ?? '未知状态码'})`,
        { statusCode }
      )
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
      this.retireTransport(ws, incarnation)
      this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl, connectionScopeId: this.connectionScopeId })
      this.settleConnectAttempt(connectAttempt, { error: err })
      this.options.onError?.(err)
      return
    }
    // 瞬态状态码:视为本次连接失败,关闭当前 socket 后进入指数退避重连(不置 error)
    this.onSocketClosed(ws, incarnation, connectAttempt, {
      statusCode,
      reason: 'unexpected-response'
    })
  }

  private onSocketClosed(ws: WebSocketLike, incarnation: number, connectAttempt?: PendingConnect, _reconnectDetails?: Record<string, unknown>): void {
    // Old close/error callbacks are deliberately inert.  In particular they
    // must not clear a replacement socket or schedule a second reconnect.
    if (!this.isCurrentTransport(ws, incarnation)) return
    this.clearHandshakeTimer() // socket 关闭即当前握手结束,避免超时回调在退避期间误触发
    this.retireTransport(ws, incarnation)
    if (this.disconnected) return
    if (this.state.status === 'error') return // unexpected-response/版本不符 fail-fast 后,后续 close/error 不再翻回 reconnecting
    // Keep the explicit connect request pending across transient failures so
    // a later server_info can resolve the original promise. The socket owner
    // is still fenced by (ws, incarnation), so an old callback cannot affect
    // a replacement request.
    this.markConnectAttemptReconnecting(connectAttempt)
    const reconnectOwner = connectAttempt && !connectAttempt.settled && this.pendingConnect === connectAttempt
      ? connectAttempt
      : undefined
    // P4-B：socket 掉线即语音会话随连接终止一并失效——后端侧会话已随连接销毁或不再送达 ended 回执。
    // 若此处不清位，重连后 activeVoice 恒存（无 ended 可清），所有 start* 永久抛「已有活动语音会话进行中」→ 语音输入锁死（task-4 review Important）。
    this.activeVoice = undefined
    this.lastSocketClosedAt = this.options.now?.() ?? Date.now() // F2:掉线时刻接入注入时钟(now())
    this.scheduleReconnect(reconnectOwner)
  }

  /** 指数退避重连(1s ×2 上限 30s);连续失败超过 6 次 → error 状态 */
  private scheduleReconnect(connectAttempt?: PendingConnect): void {
    if (this.disconnected) return
    if (this.state.status === 'error') return
    if (this.reconnectTimer) return // close+error 双触发只排一次
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      const err = new CyreneError(CyreneErrorCode.NOT_CONNECTED, `重连失败超过 ${RECONNECT_MAX_ATTEMPTS} 次，连接终止`)
      this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl, connectionScopeId: this.connectionScopeId })
      this.settleConnectAttempt(this.pendingConnect, { error: err })
      this.options.onError?.(err)
      return
    }
    this.setState({ status: 'reconnecting', serverUrl: this.serverUrl, connectionScopeId: this.connectionScopeId })
    // 退避延迟 = base * 2^(attempts-1) 封顶 MAX，再加**随机抖动**；now() 注入时钟做差值判定(自上次掉线已流逝
    // 时间计入延迟, 测试可注入时钟/缩短 reconnectBaseDelayMs 避免慢测试)
    //
    // S7/C9（2026-09-15 评审）：doc 02 要求「指数退避**并加入随机抖动**」，而实现此前是纯确定性退避
    // （全 `src/main` 无 `Math.random`）。多客户端/多窗口同时掉线会同步重连，把恢复流量压成尖峰。
    // 抖动用**全抖动**口径（`random(0, backoff]`），随机源可注入（`options.random`）以便测试确定性。
    const now = this.options.now?.() ?? Date.now()
    const base = this.options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS
    const backoffMs = Math.min(base * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS)
    const rand = this.options.random ?? Math.random
    const jitteredMs = Math.max(1, Math.min(backoffMs, Math.round(backoffMs * rand())))
    const elapsed = this.lastSocketClosedAt !== undefined ? Math.max(0, now - this.lastSocketClosedAt) : 0
    const delay = Math.max(0, jitteredMs - elapsed)
    const scheduledIncarnation = this.transportIncarnation
    const scheduledConnect = connectAttempt
    const timer = setTimeout(() => {
      // clearTimeout cannot cancel a callback which has already entered the
      // event loop.  Keep the timer owner check alongside the socket fence so
      // a stale callback cannot start a third socket or clear a newer timer.
      if (this.reconnectTimer !== timer) return
      this.reconnectTimer = undefined
      if (this.disconnected || this.transportIncarnation !== scheduledIncarnation || this.pendingConnect !== scheduledConnect) return
      // Preserve the explicit request owner across transient retries. When
      // there is no explicit request this remains an ordinary background
      // reconnect. Capture the owner in the timer so a stale timer cannot
      // start a socket for a newer manual connect request.
      this.establishWs(scheduledConnect)
    }, delay)
    this.reconnectTimer = timer
  }

  async disconnect(): Promise<void> {
    this.disconnected = true
    this.clearHandshakeTimer() // 握手未完成时取消:清超时 timer,避免其后误触发
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer)
      pending.reject(new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，ack 未完成'))
    }
    this.pendingAcks.clear()
    for (const pending of this.pendingSwitch.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，模型切换已取消'))
    }
    this.pendingSwitch.clear()
    if (this.pendingVoice) {
      clearTimeout(this.pendingVoice.timer)
      this.pendingVoice.reject(new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，声音切换已取消'))
      this.pendingVoice = undefined
    }
    this.activeVoice = undefined // P4-B:显式 disconnect 即语音会话失效(同重连语义),防重连后语音输入锁死(task-4 review Important)
    this.ttsBuffers.clear()
    this.services = undefined
    const ws = this.ws
    // Retire before close: ws libraries may synchronously invoke close/error
    // listeners, and queued callbacks must not re-enter after disconnect.
    if (ws) {
      this.transportIncarnation++
      this.ws = undefined
      try { ws.close() } catch { /* disconnect is idempotent */ }
    } else {
      // Also invalidate a callback that captured a socket just before it was
      // detached by another lifecycle path.
      this.transportIncarnation++
    }
    // 握手未完成(connecting/reconnecting)时取消:reject 挂起的 connect promise,避免 await connect() 永久挂死
    this.settleConnectAttempt(this.pendingConnect, {
      error: new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已取消')
    })
    this.setState({ status: 'disconnected' })
    // T3:abort 全部在途 REST 请求(disconnected 已置 true → catch 走 NOT_CONNECTED,不误报 TIMEOUT)
    for (const c of this.activeControllers) c.abort()
    this.activeControllers.clear()
    this.connectionScopeId = undefined
  }

  // —— WS 发送 ——
  async sendMessage(input: SendMessageInput): Promise<ClientRequestRef> {
    if (this.state.status !== 'connected' || !this.ws) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接，无法发送消息')
    }
    const ackTimeoutMs = this.options.ackTimeoutMs ?? ACK_TIMEOUT_DEFAULT_MS
    // F7:同 clientRequestId 重复 → 先 reject 旧 pending(GENERATION_CONFLICT)再覆盖,防首个 promise 永不 settle
    // 且避免新 pending 注册后被旧 timer 误删(旧 timer 已 clearTimeout)
    const existing = this.pendingAcks.get(input.clientRequestId)
    if (existing) {
      clearTimeout(existing.timer)
      this.pendingAcks.delete(input.clientRequestId)
      existing.reject(new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, `clientRequestId 重复: ${input.clientRequestId}`))
    }
    const promise = new Promise<ClientRequestRef>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.pendingAcks.get(input.clientRequestId)
        if (current?.timer !== timer) return
        this.pendingAcks.delete(input.clientRequestId)
        reject(new CyreneError(CyreneErrorCode.TIMEOUT, `user_message.ack 超时(${ackTimeoutMs}ms): ${input.clientRequestId}`))
      }, ackTimeoutMs)
      this.pendingAcks.set(input.clientRequestId, { resolve, reject, timer })
    })
    const payload: Record<string, unknown> = { type: 'text', content: input.text, clientRequestId: input.clientRequestId, conversationId: input.conversationId }
    // C10（2026-09-15 契约评审）：把「这一条用户消息」的本地 id 一并上行——后端 `V2TextMessage` 接受
    // 可选 `clientMessageId`（X99 `66557628` 取证）并在 ACK 里回显。**注意**：对方归档/回放不带该字段，
    // 所以它现在只是"给后端一个稳定身份"，前端对账那一半被后端能力挡住（见 SendMessageInput 注释与 doc 18）。
    if (input.clientMessageId) payload.clientMessageId = input.clientMessageId
    if (input.attachments?.length) payload.attachments = input.attachments
    if (input.stickerId) payload.stickerId = input.stickerId   // 阶段 3 G4：贴图消息 wire（D8）
    try {
      this.ws.send(JSON.stringify(payload))
    } catch {
      const pending = this.pendingAcks.get(input.clientRequestId)
      if (pending) { clearTimeout(pending.timer); this.pendingAcks.delete(input.clientRequestId) }
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '发送失败: WebSocket 已关闭')
    }
    return promise
  }

  async cancelGeneration(_input: CancelGenerationInput): Promise<void> {
    if (this.state.status !== 'connected' || !this.ws) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接，无法取消生成')
    }
    // interrupt 非定向(后端 InterruptMessage 仅 {type:"interrupt"});generationId 仅日志关联
    this.ws.send(JSON.stringify({ type: 'interrupt' }))
  }

  // —— REST 会话方法(Task 5)——
  /** 统一 REST 请求:仅在当前 WS 握手已完成时开放，serverUrl 尾斜杠剥除 + Authorization Bearer + content-type;
   *  非 2xx → CyreneError(mapHttpError)。T3:每请求一个 AbortController,restTimeoutMs 超时 timer abort → TIMEOUT;
   *  disconnect 主动 abort → NOT_CONNECTED(不误报超时)。 */
  private async restFetch(path: string, init?: RequestInit): Promise<Response> {
    // serverUrl/token 会为重连与显式再次连接保留，不能把“曾经连接过”当作当前 REST 写权限。
    // 所有 REST 方法共用此门禁，避免 Renderer IPC 或其他 Main 调用方绕过离线 UI 门控。
    if (this.state.status !== 'connected' || this.disconnected) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '当前未连接，无法执行后端请求')
    }
    if (!this.serverUrl) {
      // F1:spec B-G6⑤——REST 方法需先 connect(serverUrl 自 connect 记录),connect 前调用显式失败而非打到空 url
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'REST 方法需先 connect')
    }
    const sourceGeneration = this.sourceGeneration
    /**
     * H-11c（P1-6，2026-09-11 修复）：REST 响应的栅栏**只按 source scope 判定**，
     * 不再因「transport incarnation 变了」作废**已经拿到**的响应。
     *
     * 原实现（评审指出、本次核实）：在**检查状态码之前**先套 incarnation 栅栏 ⇒ 任何 WS 重连
     * （含自动重连）都会把已到达的正常 `200` 丢掉、替换为"连接来源已切换，请重试"。
     * 而 fetch **没有被 abort**、服务端副作用已提交 ⇒ 对非幂等写（上传、建会话、保存）
     * 用户看到失败并被诱导重试，造成**重复副作用**。该行为还被 `real-backend-character.spec.ts`
     * 的用例锁死（那条用例把"同一 source 的 socket 重连"与"来源已切换"混为一谈）。
     *
     * 为什么可以只按 source 判定：incarnation 的语义是"换了一条 WS 连接"，source scope 的语义是
     * "换了后端/配置"——栅栏的目的是阻止**另一个后端**的数据进入领域。本项目**只面向一个后端**，
     * 同一 source 的 socket 重连不该作废已完成的 REST 响应。真正的换源仍由 sourceGeneration 拦下。
     *
     * incarnation 仍用于它本职之处：WS 事件门（旧 socket 的事件必须丢）、连接/断开生命周期、
     * 语音 pending 作废——那些问的是"流还活着吗"，与"这个已完成的 REST 结果属于哪个后端"是两件事。
     */
    const requestTransportIncarnation = this.transportIncarnation
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.restTimeoutMs)
    this.activeControllers.add(controller)
    const url = `${this.serverUrl.replace(/\/$/, '')}${path}`
    try {
      const res = await (this.options.fetchImpl ?? fetch)(url, {
        ...init,
        signal: controller.signal,
        // S2（2026-09-15 安全评审）：**禁止跟随重定向**。fetch 默认 `follow`（≤20 跳、允许跨源），
        // 而 `assertBackendOrigin` 只比对**初始** URL ⇒ 后端可控的 307/308 会让 Main 以用户机器身份
        // 把请求（含请求体：307/308 规范要求保留）重发到 `Location` 指向的回环/内网目标——这些目标
        // 通常从后端主机不可达、从用户桌面可达，属**新增能力**（盲 SSRF）。目标仍由后端选择 ⇒ fail-closed。
        // doc 07 的「认证请求重定向到不同 Origin 时不转发凭据」此前无实现无测试，本条是它的落地口径。
        redirect: 'error',
        headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
      })
      // 换源（另一个后端/配置）→ 丢弃。这是栅栏的唯一职责。
      if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
      // 连接已断 → 结果不应再被应用（保守语义保持不变）。注意：**重连不算断开**
      // （disconnected 仍为 false），故重连不再走到这里——这正是本次修复的差别。
      if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，请求已取消')
      if (!res.ok) {
        // `res.json()` 是 any：落成 unknown 再按字段读（2026-09-13 type-aware 全集）
        const body: unknown = await res.json().catch(() => ({}))
        const code = (body as { code?: string }).code ?? 'HTTP_ERROR'
        throw new CyreneError(mapHttpError(res.status, code), (body as { message?: string }).message ?? `HTTP ${res.status}`, body)
      }
      return res
    } catch (e) {
      if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
      if (requestTransportIncarnation !== this.transportIncarnation && !this.disconnected) throw this.sourceBoundaryError()
      if (controller.signal.aborted) {
        // I3/D17:disconnect 主动 abort 时 disconnected 已置 true → NOT_CONNECTED;否则是超时 timer abort → TIMEOUT
        if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，请求已取消')
        throw new CyreneError(CyreneErrorCode.TIMEOUT, `REST 请求超时(${this.restTimeoutMs}ms): ${path}`)
      }
      throw this.restFailure(e)
    } finally {
      clearTimeout(timer)
      this.activeControllers.delete(controller)
    }
  }

  async listConversations(input: PageQuery): Promise<Page<Conversation>> {
    const q = new URLSearchParams()
    if (input.cursor) q.set('cursor', input.cursor)
    if (input.limit) q.set('limit', String(input.limit))
    const res = await this.restFetch(`/api/sessions${q.size ? `?${q}` : ''}`)
    const parsed = parseRestSessions(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '会话列表响应校验失败')
    return { items: parsed.data.sessions.map((s) => this.restMapper.toConversation(s)), hasMore: parsed.data.has_more, nextCursor: parsed.data.cursor }
  }

  async getConversation(input: GetConversationQuery): Promise<ConversationDetail> {
    const res = await this.restFetch(`/api/sessions/${encodeURIComponent(input.conversationId)}`)
    const parsed = parseRestSessionDetail(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '会话详情响应校验失败')
    const { session, messages } = parsed.data
    // 详情第一页 query_page 为 _id 倒序 → (timestamp, messageId) 正序归一化(与 toMessagePage 'before' 同规则)
    const items = pairToolCalls(messages
      .map((m) => this.restMapper.toDomainMessage(m, session.conversationId)))
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1)
    return { ...this.restMapper.toConversation(session), messages: items }
  }

  async getConversationMessages(input: ConversationMessagesQuery): Promise<MessagePage> {
    const q = new URLSearchParams()
    if (input.before) q.set('before', input.before)
    if (input.after) q.set('after', input.after)
    if (input.limit) q.set('limit', String(input.limit))
    const res = await this.restFetch(`/api/sessions/${encodeURIComponent(input.conversationId)}/messages${q.size ? `?${q}` : ''}`)
    const parsed = parseRestMessagesPage(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '会话消息响应校验失败')
    // before/无游标首页为倒序 → 'before'(正序归一化);after 增量已正序 → 'after'(不反转)
    const direction = input.after && !input.before ? 'after' : 'before'
    return this.restMapper.toMessagePage(parsed.data, { direction, conversationId: input.conversationId })
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const res = await this.restFetch('/api/sessions', { method: 'POST', body: JSON.stringify(toRestCreateSessionBody(input)) })
    const parsed = RestSessionSummarySchema.safeParse(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '创建会话响应校验失败')
    return this.restMapper.toConversation(parsed.data)
  }

  async renameConversation(id: string, title: string): Promise<Conversation> {
    const res = await this.restFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) })
    const parsed = RestSessionSummarySchema.safeParse(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '重命名会话响应校验失败')
    return this.restMapper.toConversation(parsed.data)
  }

  async deleteConversation(id: string): Promise<void> {
    await this.restFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async activateConversation(conversationId: string): Promise<ActivateConversationResult> {
    const res = await this.restFetch(`/api/sessions/${encodeURIComponent(conversationId)}/activate`, { method: 'POST' })
    const parsed = parseRestActivateResult(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '激活会话响应校验失败')
    this.setState({ ...this.state, activeConversationId: parsed.data.activeConversationId })
    if (this.state.status === 'connected' && this.ws) {
      // 回放走 WS activate_session(仅 connected 发送;未连接时只 REST 切 active)
      this.ws.send(JSON.stringify({ type: 'activate_session', conversationId }))
    }
    return { conversationId: parsed.data.activeConversationId }
  }

  // —— 多角色角色域 REST（FE-B）：raw 只在 Main 经 character-rest schema + mapper 转换 ——
  /**
   * Character REST responses are deliberately parsed in one place.  The
   * parser receives unknown JSON and only its typed success branch is allowed
   * to reach the domain mapper; malformed or non-JSON responses fail closed.
   */
  private async parseCharacterResponse<T>(
    response: Response,
    parser: CharacterResponseParser<T>,
    label: string
  ): Promise<T> {
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, `${label}响应不是有效 JSON`)
    }
    const parsed = parser(body)
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, `${label}响应校验失败`)
    return parsed.data
  }

  async getMe(): Promise<UserIdentityProfile> {
    const res = await this.restFetch('/api/me')
    const raw = await this.parseCharacterResponse(res, parseRestMe, '用户档案')
    return toDomainProfile(raw)
  }

  async updateMe(input: UpdateUserIdentityCommand): Promise<UserIdentityProfile> {
    const body = characterRequest(RestUpdateMeBodySchema, toRestUpdateMeBody(input), '用户档案更新')
    const res = await this.restFetch('/api/me', { method: 'PUT', body: JSON.stringify(body) })
    const raw = await this.parseCharacterResponse(res, parseRestMe, '用户档案更新')
    return toDomainProfile(raw)
  }

  async listCharacters(input: CharacterListQuery = {}): Promise<Page<CharacterSummary>> {
    const body = characterRequest(RestCharacterListQuerySchema, toRestCharacterListQuery(input), '角色列表查询')
    const query = characterQuery(body)
    const res = await this.restFetch(`/api/characters${query ? `?${query}` : ''}`)
    const raw = await this.parseCharacterResponse(res, parseRestCharacterList, '角色列表')
    return toDomainCharacterList(raw)
  }

  async getCharacter(characterId: CharacterId): Promise<CharacterDetail> {
    const id = requireCharacterId(characterId, '角色')
    const res = await this.restFetch(`/api/characters/${encodeURIComponent(id)}`)
    const raw = await this.parseCharacterResponse(res, parseRestCharacterDetail, '角色详情')
    return toDomainDetail(raw)
  }

  async createCharacter(input: CreateCharacterCommand): Promise<CharacterDetail> {
    const body = characterRequest(RestCreateCharacterBodySchema, toRestCreateCharacterBody(input), '创建角色')
    const res = await this.restFetch('/api/characters', { method: 'POST', body: JSON.stringify(body) })
    const raw = await this.parseCharacterResponse(res, parseRestCharacterDetail, '创建角色')
    return toDomainDetail(raw)
  }

  async updateCharacter(input: UpdateCharacterCommand): Promise<CharacterMutationResult> {
    const id = requireCharacterId(input.characterId, '角色')
    const body = characterRequest(RestUpdateCharacterBodySchema, toRestUpdateCharacterBody(input), '更新角色')
    const res = await this.restFetch(`/api/characters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
    const raw = await this.parseCharacterResponse(res, parseRestCharacterMutation, '更新角色')
    return toDomainMutationResult(raw)
  }

  async cloneCharacter(input: CloneCharacterCommand): Promise<CharacterDetail> {
    const id = requireCharacterId(input.characterId, '角色')
    const body = characterRequest(RestCloneCharacterBodySchema, toRestCloneCharacterBody(input), '克隆角色')
    const res = await this.restFetch(`/api/characters/${encodeURIComponent(id)}/clone`, { method: 'POST', body: JSON.stringify(body) })
    const raw = await this.parseCharacterResponse(res, parseRestCharacterDetail, '克隆角色')
    return toDomainDetail(raw)
  }

  async archiveCharacter(characterId: CharacterId): Promise<CharacterArchiveResult> {
    const id = requireCharacterId(characterId, '角色')
    const res = await this.restFetch(`/api/characters/${encodeURIComponent(id)}`, { method: 'DELETE' })
    const raw = await this.parseCharacterResponse(res, parseRestCharacterArchive, '归档角色')
    return toDomainArchiveResult(raw)
  }

  async listCharacterRevisions(input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>> {
    const id = requireCharacterId(input.characterId, '角色')
    const body = characterRequest(RestCharacterRevisionQuerySchema, toRestCharacterRevisionQuery(input), '角色版本查询')
    const query = characterQuery(body)
    const res = await this.restFetch(`/api/characters/${encodeURIComponent(id)}/revisions${query ? `?${query}` : ''}`)
    const raw = await this.parseCharacterResponse(res, parseRestCharacterRevisions, '角色版本列表')
    return toDomainRevisionList(raw)
  }

  async rollbackCharacter(input: RollbackCharacterCommand): Promise<CharacterMutationResult> {
    const id = requireCharacterId(input.characterId, '角色')
    const body = characterRequest(RestRollbackCharacterBodySchema, toRestRollbackCharacterBody(input), '回滚角色')
    const res = await this.restFetch(`/api/characters/${encodeURIComponent(id)}/rollback`, { method: 'POST', body: JSON.stringify(body) })
    const raw = await this.parseCharacterResponse(res, parseRestCharacterMutation, '回滚角色')
    return toDomainMutationResult(raw)
  }

  async validateCharacter(draft: CharacterDraft): Promise<CharacterValidationResult> {
    const body = characterRequest(RestValidateCharacterBodySchema, toRestValidateCharacterBody(draft), '校验角色')
    const res = await this.restFetch('/api/characters/validate', { method: 'POST', body: JSON.stringify(body) })
    const raw = await this.parseCharacterResponse(res, parseRestCharacterValidation, '角色校验')
    return toDomainValidationResult(raw)
  }

  async previewCharacter(input: CharacterPreviewCommand): Promise<CharacterPreviewResult> {
    const body = characterRequest(RestPreviewCharacterBodySchema, toRestPreviewCharacterBody(input), '预览角色')
    const res = await this.restFetch('/api/characters/preview', { method: 'POST', body: JSON.stringify(body) })
    const raw = await this.parseCharacterResponse(res, parseRestCharacterPreview, '角色预览')
    return toDomainPreviewResult(raw)
  }

  async getCharacterState(instanceId: string): Promise<CharacterPublicState> {
    const id = requireCharacterId(instanceId, '角色实例')
    const res = await this.restFetch(`/api/character-instances/${encodeURIComponent(id)}/state`)
    const raw = await this.parseCharacterResponse(res, parseRestCharacterState, '角色公开状态')
    return toDomainPublicState(raw)
  }

  async resetCharacterEvolution(input: ResetCharacterEvolutionCommand): Promise<ResetCharacterEvolutionResult> {
    const id = requireCharacterId(input.characterInstanceId, '角色实例')
    const body = characterRequest(RestResetEvolutionBodySchema, toRestResetEvolutionBody(input), '重置角色演化')
    const res = await this.restFetch(`/api/character-instances/${encodeURIComponent(id)}/reset-evolution`, { method: 'POST', body: JSON.stringify(body) })
    const raw = await this.parseCharacterResponse(res, parseRestResetEvolution, '重置角色演化')
    return toDomainResetResult(raw)
  }

  // —— 阶段 3 G3 附件上传/签发（spec §4.4/§4.5）——
  // H-01 结构性收窄（2026-09-14）：此处原有 `readUploadBytes(f)`，带一条 `fs.readFile(f.path)` 回退。
  // 那是全仓**第二个**「从 descriptor 取路径直接读盘」的解析点，且这一层**没有** realpath、userData
  // 包含判定与敏感路径黑名单（守卫只在 `UploadService`）。实测该回退**从未执行**（`UploadService` 是
  // `UploadContent` 唯一构造点，两个分支都填 `bytes`）⇒ 已删除，`UploadContent.bytes` 改为**必填**。
  // 现在「path → fs」在全仓只剩 `UploadService` 一处，且那一处四道守卫齐全。

  async uploadAttachments(files: UploadContent[], opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]> {
    if (!this.serverUrl) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'REST 方法需先 connect')
    // S8（2026-09-15 安全评审）：本方法是**唯一** Renderer 可达的直写 fetch，此前只判 `!serverUrl`
    // （而 `disconnect()` 并不清 `serverUrl`）⇒ 用户点断开 / 切换地址之后，仍可让 Main 带着 Bearer
    // 把用户文件 POST 到**旧后端**。工具域的两个直写方法各自补了门禁，只有这条漏了——此处补齐。
    if (this.state.status !== 'connected' || this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'REST 方法需先 connect')
    this.assertBackendOrigin(this.serverUrl)
    const sourceGeneration = this.sourceGeneration
    const uploadTimeoutMs = this.options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_DEFAULT_MS
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), uploadTimeoutMs)
    // P1-1：取消经 opts.signal 接入——AbortSignal.any 组合超时与调用方取消；任一方 abort 即终止 fetch（spec §4.1 D10）
    const effectiveSignal = opts?.signal ? AbortSignal.any([timeoutController.signal, opts.signal]) : timeoutController.signal
    this.activeControllers.add(timeoutController)
    const form = new FormData()
    for (const f of files) {
      const bytes = f.bytes
      // 每文件 kind：重复 kind 字段按文件顺序对应；可省略由后端魔数判定
      if (f.kind) form.append('kind', f.kind)
      // bytes 为 Uint8Array<ArrayBufferLike>（fs/promises readFile 或调用方构造）；BlobPart 需 ArrayBufferView<ArrayBuffer>——
      // 本组上传来源均为新分配的 Uint8Array，buffer 即完整数据，cast 安全（TS2322 兼容）
      form.append('files', new Blob([bytes as unknown as BlobPart], { type: f.mediaType }), f.name)
    }
    const url = `${this.serverUrl.replace(/\/$/, '')}/api/uploads`
    try {
      const res = await (this.options.fetchImpl ?? fetch)(url, {
        method: 'POST',
        signal: effectiveSignal,
        redirect: 'error',   // S2：不跟随重定向（理由见 restFetch；307/308 会保留 multipart 请求体）
        headers: { authorization: `Bearer ${this.token}` },   // multipart 不设 content-type（fetch 自动带 boundary）
        body: form
      })
      if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
      if (!res.ok) {
        // `res.json()` 是 any：落成 unknown 再按字段读（2026-09-13 type-aware 全集）
        const body: unknown = await res.json().catch(() => ({}))
        const code = (body as { code?: string }).code ?? 'HTTP_ERROR'
        throw new CyreneError(mapHttpError(res.status, code), (body as { message?: string }).message ?? `HTTP ${res.status}`, body)
      }
      const parsed = parseAttachmentUploadResponse(await res.json())
      if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '附件上传响应校验失败')
      return parsed.data.attachments
    } catch (e) {
      if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
      if (opts?.signal?.aborted) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '附件上传已取消')   // 调用方取消（IPC attachments:cancel 触发）
      if (timeoutController.signal.aborted) {
        if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，上传已取消')
        throw new CyreneError(CyreneErrorCode.TIMEOUT, `附件上传超时(${uploadTimeoutMs}ms)`)
      }
      throw this.restFailure(e)
    } finally {
      clearTimeout(timer)
      this.activeControllers.delete(timeoutController)
    }
  }

  async signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult> {
    const res = await this.restFetch(`/api/attachments/${encodeURIComponent(attachmentId)}/sign`)
    const parsed = parseAttachmentSignResponse(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '签发响应校验失败')
    return parsed.data
  }

  // —— 阶段 3 G4 历史查看器/表情（spec §4.3/§4.4/§4.5，D2/D8）——
  // 已知限制（P2-3）：真实后端 search item 无 kind/url，表情分类在查看器内为纯文本行、无贴图缩略图——
  // 待后端 SearchMessageItem 增 kind/url 或 queryResources 通道后再富化；不伪造实现（保持文本展示，不为此绕契约）。
  async getMessageContext(input: MessageContextQuery): Promise<MessagePage> {
    const params: Record<string, string> = { conversationId: input.conversationId }
    if (input.before !== undefined) params['before'] = String(input.before)
    if (input.after !== undefined) params['after'] = String(input.after)
    const q = new URLSearchParams(params).toString()
    const res = await this.restFetch(`/api/messages/${encodeURIComponent(input.messageId)}/context?${q}`)
    const parsed = parseRestMessageContext(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '消息上下文响应校验失败')
    return this.restMapper.toMessagePageFromContext(parsed.data)
  }

  async queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage> {
    const wireCats = HISTORY_CATEGORY_WIRE[input.category] ?? [undefined]
    if (wireCats.length === 1) {
      // 单流（all/sticker/file/audio/link）：不透明游标直接透传；领域层统一 sortKey 升序（P1-01，与 image_video/loadMore 一致）
      const data = await this.fetchHistoryStream(input, wireCats[0], input.cursor)
      const items = data.items.map((i) => this.restMapper.toChatHistoryItem(i)).sort(compareBySortKey)
      return { items, hasMore: data.has_more, nextCursor: data.has_more ? data.cursor : undefined }
    }
    // image_video：两子流（image/video）独立游标 + 顺序合并（P1-3）。
    // 不透明游标编码 { image, video } 两个子流游标（null=已耗尽跳过），loadMore 时各子流用自己的游标续页，
    // 合并按 sortKey 排序、has_more = 任一子流还有余量——杜绝「两子查询共用同一游标 → 第二页异流/跳漏」。
    const state = parseImageVideoCursor(input.cursor)
    const [imgCat, vidCat] = wireCats
    const [imgPage, vidPage] = await Promise.all([
      state.image.exhausted ? null : this.fetchHistoryStream(input, imgCat, state.image.cursor),
      state.video.exhausted ? null : this.fetchHistoryStream(input, vidCat, state.video.cursor)
    ])
    const mapped = [imgPage, vidPage].filter((p): p is RestSearchMessagesResponse => p !== null)
      .flatMap((p) => p.items.map((i) => this.restMapper.toChatHistoryItem(i)))
    const byHit = new Map(mapped.map((i) => [i.hitId, i]))
    const items = [...byHit.values()].sort(compareBySortKey)
    const hasMore = (imgPage?.has_more ?? false) || (vidPage?.has_more ?? false)
    const nextState: ImageVideoCursorEncoded = {
      image: imgPage === null ? null : imgPage.has_more ? imgPage.cursor ?? null : null,
      video: vidPage === null ? null : vidPage.has_more ? vidPage.cursor ?? null : null
    }
    return { items, hasMore, nextCursor: hasMore ? JSON.stringify(nextState) : undefined }
  }

  /** image_video 单子流查询（category=image 或 video；cursor 为该子流独立游标，P1-3） */
  private async fetchHistoryStream(input: ChatHistoryQuery, cat: string | undefined, cursor: string | undefined): Promise<RestSearchMessagesResponse> {
    const params: Record<string, string> = {}
    if (input.query) params['query'] = input.query
    if (input.scope.type === 'conversation') params['conversationId'] = input.scope.conversationId
    if (input.localDate) {
      params['date_from'] = input.localDate   // YYYY-MM-DD 自然日（阶段3 联调前整改 P0-01：不再预转 UTC ISO，后端自转半开区间）
      params['date_to'] = input.localDate
    }
    params['timezone'] = input.timeZone
    if (cat) params['category'] = cat
    if (cursor) params['cursor'] = cursor
    params['limit'] = String(input.limit)
    const q = new URLSearchParams(params).toString()
    const res = await this.restFetch(`/api/search/messages${q ? `?${q}` : ''}`)
    const parsed = parseRestSearchMessages(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '历史搜索响应校验失败')
    return parsed.data
  }

  async listStickers(): Promise<StickerManifest> {
    const res = await this.restFetch('/api/stickers')
    const parsed = parseRestStickerList(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '表情清单响应校验失败')
    return this.restMapper.toStickerManifest(parsed.data)
  }

  // —— 模型/TTS 方法(阶段 4 批次A:真实后端落成)——
  /** 发无 ACK 帧,需等 result 帧(switch_model/set_tts_voice)或已连接即可发(语音控制帧);
   *  未连接抛 NOT_CONNECTED;返回局部 const ws——this.ws 为可变属性 TS 不窄化,后续 ws.send 用返回值 */
  private requireWs(): WebSocketLike {
    if (this.state.status !== 'connected' || !this.ws) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接，无法执行模型操作')
    return this.ws
  }
  private switchTimeoutMs(): number { return this.options.switchTimeoutMs ?? 10000 }

  /** 错误三形状 §3.4 之 3：result 帧 error 为 "<CODE>: <msg>" 前缀串 → {backendCode, message}；缺码保留原文 */
  private resultFrameError(error: string | undefined): Error {
    const m = /^([A-Z_]+):\s*(.*)$/.exec(error ?? '')
    return new CyreneError(CyreneErrorCode.UNKNOWN, m ? m[2] : (error ?? '模型切换失败'), { backendCode: m ? m[1] : undefined })
  }

  async listModelProfiles(type?: ModelServiceType): Promise<ModelProfile[]> {
    const res = await this.restFetch('/api/providers')
    const parsed = parseRestProviders(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'providers 响应校验失败')
    const all = providersToModelProfiles(parsed.data)
    return type ? all.filter((p) => p.type === type) : all
  }

  async testModelProfile(input: ModelProfileTestCommand): Promise<ModelProfileTestResult> {
    const res = await this.restFetch('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({
        service: input.service, provider: input.provider, model: input.model, level: input.level,
        ...(input.baseUrl ? { base_url: input.baseUrl } : {}), ...(input.apiKey ? { api_key: input.apiKey } : {})
      })
    })
    const parsed = parseRestProviderTest(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'providers/test 响应校验失败')
    const d = parsed.data
    return { profileId: `${input.provider}/${input.model}`, service: input.service, level: input.level, ok: d.ok, ...(d.latency_ms !== undefined ? { latencyMs: d.latency_ms } : {}), ...(d.error ? { error: d.error } : {}), ...(d.detail ? { detail: d.detail } : {}) }
  }

  async saveModelProfile(input: UpsertModelProfileCommand): Promise<ModelProfile> {
    const res = await this.restFetch('/api/providers', {
      method: 'POST',
      body: JSON.stringify({
        service: input.type,
        entry: {
          name: input.name, ...(input.baseUrl ? { base_url: input.baseUrl } : {}),
          ...(input.apiKey ? { api_key: input.apiKey } : {}), ...(input.apiKeyEnv ? { api_key_env: input.apiKeyEnv } : {}),
          ...(input.models ? { models: input.models } : {}), ...(input.executionLocation ? { runtime: input.executionLocation } : {}),
          // P4-A final review：capabilities wire 契约是 dict[str, Any]（rest.py CustomProvider），不能原样发 string[]——
          // 后端持久化到 custom_providers.yaml 后，下次 GET /api/providers 的 pydantic 校验会拒绝 list，整个 provider 列表 500。
          ...(input.capabilities ? { capabilities: Object.fromEntries(input.capabilities.map((c) => [c, true])) } : {})
        }
      })
    })
    await res.json() // ApiOk{data: 全量 custom 列表}；api_key 已剔除，弃用
    // save 响应不含 credentialConfigured（F2）→ 重新 GET 取真实状态
    const fresh = await this.restFetch('/api/providers')
    const parsed = parseRestProviders(await fresh.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'providers 响应校验失败')
    const target = providersToModelProfiles(parsed.data).find((p) => p.source === 'custom' && p.model === input.name)
    if (!target) throw new CyreneError(CyreneErrorCode.UNKNOWN, `保存后未找到 custom/${input.name}`)
    if (input.makeActive) await this.activateModelProfile({ profileId: target.id, service: target.type })
    return target
  }

  async deleteModelProfile(service: ModelServiceType, name: string): Promise<void> {
    await this.restFetch(`/api/providers/${service}/${encodeURIComponent(name)}`, { method: 'DELETE' })
  }

  async listTtsVoices(): Promise<TtsVoiceListResult> {
    const res = await this.restFetch('/api/tts/voices')
    const parsed = parseRestTtsVoices(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'tts/voices 响应校验失败')
    const d = parsed.data
    // capabilities wire 为 dict（rest.py TtsVoiceEntry），展开键名为领域 string[]（对齐 ProviderEntry 映射惯例，稳定排序）
    return { voices: d.voices.map((v) => ({ id: v.id, ...(v.name ? { name: v.name } : {}), languages: v.languages ?? [], capabilities: Object.keys(v.capabilities ?? {}).sort() })), current: d.current ?? undefined, source: d.source === 'api' ? 'api' : 'static', ...(d.error ? { error: d.error } : {}) }
  }

  /** 返回 raw（bytes 由 IPC handler 写入 MediaService）；二进制不越 Main */
  async previewTts(input: TtsPreviewCommand): Promise<{ ok: boolean; mime?: string; bytes?: Uint8Array; durationMs?: number; error?: string }> {
    const res = await this.restFetch('/api/tts/preview', { method: 'POST', body: JSON.stringify(input.voiceId ? { voice_id: input.voiceId } : {}) })
    const parsed = parseRestTtsPreview(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, 'tts/preview 响应校验失败')
    const d = parsed.data
    if (!d.ok) return { ok: false, ...(d.error ? { error: d.error } : {}) }
    if (!d.audio_base64) return { ok: false, error: '试听无音频数据' }
    const bytes = Buffer.from(d.audio_base64, 'base64')
    // P4-A final review：非空 base64 解出 0 字节（空音频）→ 与缺 audio_base64 同语义，<audio> 无法解码，显式失败
    if (bytes.length === 0) return { ok: false, error: '试听无音频数据' }
    return { ok: true, mime: d.mime, bytes: new Uint8Array(bytes), ...(d.duration_ms !== undefined ? { durationMs: d.duration_ms } : {}) }
  }

  async setTtsVoice(input: SetTtsVoiceCommand): Promise<void> {
    const ws = this.requireWs()
    return new Promise<void>((resolve, reject) => {
      // 单 in-flight（D-A14）：重入时 supersede 旧 pending（GENERATION_CONFLICT + clearTimeout 旧 timer），
      // 防止旧 timer 稍后无条件清掉新 pending 导致新 result 帧被忽略/误报 TIMEOUT
      const existing = this.pendingVoice
      if (existing) { clearTimeout(existing.timer); existing.reject(new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, `同声音切换未完成`)) }
      const timer = setTimeout(() => {
        // 所有权限定：仅当当前 pending 仍是本 timer 时才清（防御旧 timer 迟到清新 pending 的跨清竞态）
        if (this.pendingVoice?.timer !== timer) return
        this.pendingVoice = undefined
        reject(new CyreneError(CyreneErrorCode.TIMEOUT, `set_tts_voice 超时`))
      }, this.switchTimeoutMs())
      this.pendingVoice = { voice: input.voice, resolve, reject, timer }
      ws.send(JSON.stringify({ type: 'set_tts_voice', voice: input.voice }))
    })
  }

  async activateModelProfile(input: ActivateModelProfileCommand): Promise<void> {
    const ws = this.requireWs()
    return new Promise<void>((resolve, reject) => {
      const existing = this.pendingSwitch.get(input.service)
      if (existing) { clearTimeout(existing.timer); existing.reject(new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, `同服务切换未完成`)) }
      const timer = setTimeout(() => {
        if (this.pendingSwitch.get(input.service)?.timer !== timer) return
        this.pendingSwitch.delete(input.service)
        reject(new CyreneError(CyreneErrorCode.TIMEOUT, `switch_model 超时`))
      }, this.switchTimeoutMs())
      this.pendingSwitch.set(input.service, { model: input.profileId, resolve, reject, timer })
      ws.send(JSON.stringify({ type: 'switch_model', service: input.service, model: input.profileId }))
    })
  }

  getActiveModelSelection(): ActiveModelSelection {
    const s = this.services
    return { ...(s?.llm?.model ? { llmProfileId: s.llm.model } : {}), ...(s?.stt?.model ? { voiceSttProfileId: s.stt.model } : {}), ...(s?.tts?.model ? { ttsProfileId: s.tts.model } : {}) }
  }

  // —— P4-B 语音（Task 4：真实 wire 控制帧 + sendAudioBytes + voice.error 路由；Task 5 接 TTS audio_* 下行）——
  /** 单活动语音会话守卫：任一语音 start 前检查（本地抛错防重入，不依赖 CyreneErrorCode——无 VOICE 码；
   *  真实后端并发冲突由 error{VOICE_SESSION_CONFLICT} 帧经 voice.error 兜底） */
  private requireNoActiveVoice(): void {
    if (this.activeVoice) throw new Error('已有活动语音会话进行中')
  }

  async startRecordVoice(input: VoiceRecordStartInput): Promise<{ recordingId: string }> {
    this.requireNoActiveVoice()
    const ws = this.requireWs()
    // voice.record.start 无 conversationId（会话归属在 commit 时带，contract VoiceRecordStartMessage）
    ws.send(JSON.stringify({ type: 'voice.record.start', recordingId: input.recordingId }))
    this.activeVoice = { kind: 'record', key: input.recordingId }
    return { recordingId: input.recordingId }
  }

  async stopRecordVoice(input: VoiceRecordStopInput): Promise<void> {
    const ws = this.requireWs()
    ws.send(JSON.stringify({ type: 'voice.record.stop', recordingId: input.recordingId }))
    this.activeVoice = undefined // 录音会话已释放（TRANSCRIBING 窗口仍等 voice.transcript，不占活动注册表）
  }

  async commitVoice(input: VoiceCommitInput): Promise<ClientRequestRef> {
    // 复用既有 pendingAck 机制（按 clientRequestId 关联 user_message.ack；幂等键即 clientRequestId，
    // 重入 supersede 旧 pending 防双结算，语义同 sendMessage/F7）。先 requireWs()（未连接抛 NOT_CONNECTED），
    // 再注册 pending——避免未连接时留下悬空 pending 条目。
    const ws = this.requireWs()
    const ackTimeoutMs = this.options.ackTimeoutMs ?? ACK_TIMEOUT_DEFAULT_MS
    const existing = this.pendingAcks.get(input.clientRequestId)
    if (existing) {
      clearTimeout(existing.timer)
      this.pendingAcks.delete(input.clientRequestId)
      existing.reject(new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, `clientRequestId 重复: ${input.clientRequestId}`))
    }
    const promise = new Promise<ClientRequestRef>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.pendingAcks.get(input.clientRequestId)
        if (current?.timer !== timer) return
        this.pendingAcks.delete(input.clientRequestId)
        reject(new CyreneError(CyreneErrorCode.TIMEOUT, `voice.commit user_message.ack 超时(${ackTimeoutMs}ms): ${input.clientRequestId}`))
      }, ackTimeoutMs)
      this.pendingAcks.set(input.clientRequestId, { resolve, reject, timer })
    })
    try {
      ws.send(JSON.stringify({
        type: 'voice.commit',
        recordingId: input.recordingId,
        text: input.text,
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        conversationId: input.conversationId
      }))
    } catch {
      const pending = this.pendingAcks.get(input.clientRequestId)
      if (pending) { clearTimeout(pending.timer); this.pendingAcks.delete(input.clientRequestId) }
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '发送失败: WebSocket 已关闭')
    }
    return promise
  }

  async discardVoice(input: VoiceDiscardInput): Promise<void> {
    const ws = this.requireWs()
    ws.send(JSON.stringify({ type: 'voice.discard', recordingId: input.recordingId }))
    this.activeVoice = undefined
  }

  async startRealtimeVoice(input: RealtimeVoiceStartInput): Promise<{ sessionId: string }> {
    this.requireNoActiveVoice()
    const ws = this.requireWs()
    ws.send(JSON.stringify({ type: 'voice_session.start', sessionId: input.sessionId, ...(input.conversationId ? { conversationId: input.conversationId } : {}) }))
    this.activeVoice = { kind: 'realtime', key: input.sessionId }
    return { sessionId: input.sessionId }
  }

  async stopRealtimeVoice(input: RealtimeVoiceControlInput): Promise<void> {
    const ws = this.requireWs()
    ws.send(JSON.stringify({ type: 'voice_session.stop', sessionId: input.sessionId }))
    // 清 active 延后到 voice_session.ended 回执（handleFrame case），此期间拒绝新语音 start 防双会话
  }

  async cancelRealtimeVoice(input: RealtimeVoiceControlInput): Promise<void> {
    const ws = this.requireWs()
    ws.send(JSON.stringify({ type: 'voice_session.cancel', sessionId: input.sessionId }))
  }

  async startDictation(input: DictationStartInput): Promise<{ clientRequestId: string }> {
    this.requireNoActiveVoice()
    const ws = this.requireWs()
    // sttProfileId 缺省不带键 → 后端用全局活动 STT（D-P14/D-8；E-07 契约缺省语义）
    ws.send(JSON.stringify({ type: 'dictation.start', clientRequestId: input.clientRequestId, ...(input.sttProfileId ? { sttProfileId: input.sttProfileId } : {}) }))
    this.activeVoice = { kind: 'dictation', key: input.clientRequestId }
    return { clientRequestId: input.clientRequestId }
  }

  async stopDictation(input: DictationStopInput): Promise<void> {
    const ws = this.requireWs()
    ws.send(JSON.stringify({ type: 'dictation.stop', clientRequestId: input.clientRequestId }))
    this.activeVoice = undefined
  }

  async cancelDictation(input: DictationStopInput): Promise<void> {
    const ws = this.requireWs()
    ws.send(JSON.stringify({ type: 'dictation.cancel', clientRequestId: input.clientRequestId }))
    this.activeVoice = undefined
  }

  sendAudioBytes(bytes: Uint8Array): void {
    // 双 guard：连接态 + 活动语音会话；任一不满足丢弃告警（同步 void，不 throw）
    if (this.state.status !== 'connected' || !this.ws) {
      this.warn('VOICE_BINARY_NOT_CONNECTED', '未连接,丢弃语音音频字节')
      return
    }
    if (!this.activeVoice) {
      this.warn('VOICE_BINARY_NO_SESSION', '无活动语音会话,丢弃语音音频字节')
      return
    }
    this.ws.send(bytes)
  }

  async audioCancel(input: AudioCancelInput): Promise<void> {
    const ws = this.requireWs()
    ws.send(JSON.stringify({ type: 'audio.cancel', stream_id: input.streamId }))
  }

  async submitToolResult(input: ToolStatusCommand): Promise<void> {
    // 批次 B（Task 6）：ToolStatusCommand → tool.status 帧发送（Client→Server 方向，不进 RawFrameSchema——
    // Task 4 语音控制帧同款构造发送；D-status-runtime runtime 保持 str）。RawToolAttachment 与 ToolAttachment
    // 字段同形（url/mimeType/label），attachments 直接透传无需映射。
    const ws = this.requireWs()
    const frame: RawToolStatus = {
      type: 'tool.status', callId: input.callId, status: input.status,
      toolName: input.toolName, toolVersion: input.toolVersion, runtime: input.runtime, paramHash: input.paramHash,
      output: input.output, error: input.error, attachments: input.attachments, executionSummary: input.executionSummary,
    }
    ws.send(JSON.stringify(frame))
  }

  /** 批次 C（D6C-11/BE-043）：查询桌面调用服务端状态（GET /api/tools/calls/{callId}，restFetch 缺省 GET）。
   *  断连/非 2xx/解析失败 → null 降级（tool-service reconnect 查询分支消费；任何失败不阻断） */
  async getToolCallStatus(callId: string): Promise<DesktopCallStatus | null> {
    if (!this.serverUrl || this.state.status === 'disconnected') return null
    try {
      const res = await this.restFetch(`/api/tools/calls/${encodeURIComponent(callId)}`)
      const parsed = DesktopCallStatusSchema.safeParse(await res.json())
      return parsed.success ? parsed.data : null
    } catch { return null }   // 降级：任何失败不阻断
  }

  /** 工具附件上传（阶段 6 批次 B Task 5）：multipart POST /api/uploads/desktop/{callId}，
   *  X-Client-Connection 持有者校验（server_info.connectionId，docs/02 §19）；响应仅 {url}（H1/M4/L4），
   *  mimeType/label 本地回填。注意：不复用 restFetch——其强制 content-type: application/json 会覆盖 multipart
   *  boundary（uploadAttachments L778 同款注释），故按同款纪律（fetchImpl 注入 + AbortController + activeControllers，代码 M2）直写。 */
  async uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment> {
    if (this.state.status !== 'connected' || !this.state.connectionId) throw new CyreneError(CyreneErrorCode.TOOL_UPLOAD_FAILED, '缺少连接标识')
    const sourceGeneration = this.sourceGeneration
    const serverUrl = this.serverUrl
    this.assertBackendOrigin(serverUrl)
    const form = new FormData()
    const ext = mime === 'image/png' ? 'png' : mime === 'text/plain' ? 'txt' : mime.split('/')[1] ?? 'bin'
    // bytes 为调用方 Uint8Array；BlobPart 需 ArrayBufferView<ArrayBuffer>（uploadAttachments 同款 cast，TS2322 兼容）
    form.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), `${label ?? 'attachment'}-${callId}.${ext}`)
    const controller = new AbortController()
    const uploadTimeoutMs = this.options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_DEFAULT_MS   // M2：工具附件走长超时（60s，与 uploadAttachments 同口径——截图/大文件传输常超 10s）
    const timer = setTimeout(() => controller.abort(), uploadTimeoutMs)
    this.activeControllers.add(controller)
    const url = `${serverUrl.replace(/\/$/, '')}/api/uploads/desktop/${callId}`
    try {
      const res = await (this.options.fetchImpl ?? fetch)(url, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',   // S2：不跟随重定向（理由见 restFetch）
        headers: { authorization: `Bearer ${this.token}`, 'X-Client-Connection': this.state.connectionId },   // multipart 不设 content-type（fetch 自动带 boundary）
        body: form
      })
      if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
      if (!res.ok) throw new CyreneError(CyreneErrorCode.TOOL_UPLOAD_FAILED, `上传失败 ${res.status}`)
      const data = (await res.json()) as { url: string }
      return { url: data.url, mimeType: mime, label }
    } catch (e) {
      if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
      if (controller.signal.aborted) {
        // I3/D17：disconnect 主动 abort 时 disconnected 已置 true → NOT_CONNECTED；否则是超时 timer abort → TIMEOUT
        if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，上传已取消')
        throw new CyreneError(CyreneErrorCode.TIMEOUT, `工具附件上传超时(${uploadTimeoutMs}ms)`)
      }
      throw this.restFailure(e)
    } finally {
      clearTimeout(timer)
      this.activeControllers.delete(controller)
    }
  }

  /**
   * 读取已归档桌面截图。Bearer、后端地址和原始上传 URL 始终留在 Main；返回前执行 ID、状态、
   * MIME、大小及 PNG 魔数校验，避免把任意受鉴权响应代理给 Renderer。
   */
  async readToolAttachment(callId: string): Promise<{ bytes: Uint8Array; mimeType: 'image/png' } | null> {
    if (!DESKTOP_CALL_ID_PATTERN.test(callId)) return null
    if (!this.serverUrl || this.state.status === 'disconnected') {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接，无法读取工具附件')
    }
    this.assertBackendOrigin(this.serverUrl)
    const sourceGeneration = this.sourceGeneration
    const controller = new AbortController()
    const timeoutMs = this.options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_DEFAULT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    this.activeControllers.add(controller)
    const url = `${this.serverUrl.replace(/\/$/, '')}/uploads/desktop/${encodeURIComponent(callId)}.png`
    try {
      const res = await (this.options.fetchImpl ?? fetch)(url, {
        signal: controller.signal,
        redirect: 'error',   // S2：不跟随重定向（理由见 restFetch）
        headers: { authorization: `Bearer ${this.token}`, accept: 'image/png' }
      })
      if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
      if (res.status === 404) return null
      if (!res.ok) throw new CyreneError(mapHttpError(res.status, 'HTTP_ERROR'), `工具附件读取失败 ${res.status}`)
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (mime !== 'image/png') {
        await res.body?.cancel()
        return null
      }
      const declaredLength = Number(res.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > TOOL_CAPTURE_MAX_BYTES) {
        await res.body?.cancel()
        return null
      }
      const reader = res.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
        if (!value) continue
        total += value.byteLength
        if (total > TOOL_CAPTURE_MAX_BYTES) {
          await reader.cancel()
          return null
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return hasPngSignature(bytes) ? { bytes, mimeType: 'image/png' } : null
    } catch (e) {
      if (sourceGeneration !== this.sourceGeneration) throw this.sourceBoundaryError()
      if (controller.signal.aborted) {
        if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，工具附件读取已取消')
        throw new CyreneError(CyreneErrorCode.TIMEOUT, `工具附件读取超时(${timeoutMs}ms)`)
      }
      throw this.restFailure(e)
    } finally {
      clearTimeout(timer)
      this.activeControllers.delete(controller)
    }
  }
}
