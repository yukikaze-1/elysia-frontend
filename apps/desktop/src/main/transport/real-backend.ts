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
  DictationSession,
  GetConversationQuery,
  MessageContextQuery,
  MessagePage,
  ModelProfileTestResult,
  StartDictationInput,
  StartVoiceInputInput,
  StopDictationInput,
  StopVoiceInputInput,
  ToolResult,
  VoiceInputSession
} from '@shared/contracts/backend'
export type { ConnectionState, ConnectionStatus } from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput, Page, PageQuery } from '@shared/contracts/conversation'
import type { ClientRequestRef, Message, SendMessageInput } from '@shared/contracts/message'
import type { ActiveModelSelection, ModelProfile, ModelProfileTestCommand, ModelServiceType, SetTtsVoiceCommand, TtsPreviewCommand, TtsVoiceListResult, UpsertModelProfileCommand } from '@shared/contracts/model'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { ProtocolWarningCode } from '@shared/contracts/protocol'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { parseRawFrame } from './protocol-v2/raw-schemas'
import type {
  RawErrorMessage,
  RawServerInfo,
  RawSessionMessage,
  RawSessionMessageItem,
  RawUserAck
} from './protocol-v2/raw-types'
import { FrameMapper } from './protocol-v2/frame-mapper'
import { RestMapper, compareBySortKey } from './protocol-v2/rest-mapper'
import { parseRestActivateResult, parseRestMessagesPage, parseRestSessionDetail, parseRestSessions, RestSessionSummarySchema, parseAttachmentUploadResponse, parseAttachmentSignResponse, parseRestMessageContext, parseRestSearchMessages, parseRestStickerList, parseRestProviders, parseRestProviderTest, parseRestTtsVoices, parseRestTtsPreview } from './protocol-v2/rest-schemas'
import { providersToModelProfiles } from './providers-mapper'
import type { RestSearchMessagesResponse } from './protocol-v2/rest-types'
import type { HistoryCategory, StickerManifest } from '@shared/contracts'
import type { BackendAdapter, BackendEventHandler, UploadContent } from './backend-adapter'
import type { AttachmentInfo, AttachmentSignResult } from '@shared/contracts/attachments'

export interface WebSocketLike {
  on(ev: 'open' | 'message' | 'close' | 'error' | 'unexpected-response', cb: (arg?: unknown, arg2?: unknown) => void): void
  send(data: string): void
  close(): void
  readyState: number
}
export interface RealBackendOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike
  onProtocolWarning?: (warning: ProtocolWarning) => void
  onSessionReplay?: (conversationId: string, messages: Message[]) => void
  onError?: (error: CyreneError) => void
  /** 连接状态变化回调(状态机任意迁移触发;2C 用于 IPC 状态推送) */
  onConnectionStateChange?: (state: ConnectionState) => void
  ackTimeoutMs?: number   // 默认 15000;测试注入小值
  reconnectBaseDelayMs?: number  // 默认 1000;测试注入缩短值避免慢测试
  handshakeTimeoutMs?: number  // 默认 10000;握手(connect → server_info)超时,测试注入小值
  restTimeoutMs?: number  // 默认 10000;REST 请求超时,测试注入小值
  uploadTimeoutMs?: number  // 默认 60000;附件上传长超时(非 10s,spec §4.4),测试注入小值
  switchTimeoutMs?: number  // 默认 10000;switch_model/set_tts_voice result 帧等待超时,测试注入小值
}

/** ack 关联的 pending 发送(按 clientRequestId 幂等) */
interface PendingAck {
  resolve: (ref: ClientRequestRef) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

const PROTOCOL_VERSION_WIRE = '2.0'   // wire 上 server_info.protocol_version 的展示值(两层取值,见 design §5.3)
const ACK_TIMEOUT_DEFAULT_MS = 15000
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000
const RECONNECT_MAX_ATTEMPTS = 6
const HANDSHAKE_TIMEOUT_DEFAULT_MS = 10000
const REST_TIMEOUT_DEFAULT_MS = 10000
const UPLOAD_TIMEOUT_DEFAULT_MS = 60000

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

/**
 * RealBackend:真实后端适配器(WS 连接核心 + REST 会话方法)。
 * 协议差异全部收敛在此(URL/字段名/WS 帧),UI 只消费领域事件。
 * Task 4 实现 connect/握手/帧分派/session 回放/心跳重连/ack 关联/error 路由;
 * Task 5 实现 REST 会话方法(list/get/messages/create/rename/delete/activate + Bearer + 错误映射);
 * 模型/语音/工具方法抛 NOT_IMPLEMENTED 占位(阶段 3/4/6)。
 */
export class RealBackend implements BackendAdapter {
  private ws?: WebSocketLike
  private readonly options: RealBackendOptions
  private readonly handler = new Set<BackendEventHandler>()
  private readonly pendingAcks = new Map<string, PendingAck>()
  private state: ConnectionState = { status: 'disconnected' }
  private mapper?: FrameMapper
  private readonly restMapper = new RestMapper()
  private sessionBuffer: RawSessionMessageItem[] = []
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private lastSocketClosedAt?: number
  private disconnected = false
  private serverUrl = ''
  private token = ''
  private connectResolve?: (s: BackendSession) => void
  private connectReject?: (e: unknown) => void
  /** T3:在途 REST 请求的 AbortController;disconnect 时统一 abort,使挂起请求按 NOT_CONNECTED 终止 */
  private readonly activeControllers = new Set<AbortController>()
  /** server_info.services 归一化（llm/stt/tts 每服务 model 三态：string|null|缺省）；P4-A 由 getActiveModelSelection 消费 */
  private services?: { llm?: { model?: string | null }; stt?: { model?: string | null }; tts?: { model?: string | null } }
  /** switch_model result 帧 pending 关联（无 clientRequestId，按 service+model 回显匹配，D-A14）；单服务单 in-flight */
  private pendingSwitch: Map<ModelServiceType, { model: string; resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }> = new Map()
  /** set_tts_voice result 帧 pending 关联（按 voice 回显匹配）；单 in-flight */
  private pendingVoice?: { voice: string; resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }

  constructor(options: RealBackendOptions = {}) { this.options = options }

  private get restTimeoutMs(): number { return this.options.restTimeoutMs ?? REST_TIMEOUT_DEFAULT_MS }

  getConnectionState(): ConnectionState { return this.state }

  /** 清除握手超时 timer(connect → server_info);server_info 到达/关闭/disconnect/非 101 响应/重连挂起手动 connect 均调用 */
  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined }
  }

  /** 统一状态迁移入口:赋值 + 回调。加性改造——迁移前后各状态机路径产生的对象值不变;
   *  `this.state` 直接替换(非原地 Object.assign):getConnectionState 当前无外部调用方持引用依赖对象身份
   *  (仅 spec 即时断言),替换语义与 2B 逐点一致,避免原地合并残留旧字段(如 error 后 lastError 泄漏进 connecting)。 */
  private setState(next: ConnectionState): void {
    this.state = next
    this.options.onConnectionStateChange?.(this.state)
  }
  subscribe(handler: BackendEventHandler): () => void { this.handler.add(handler); return () => this.handler.delete(handler) }
  async setToken(token: string): Promise<void> { this.token = token }

  // —— 帧分派 ——
  private handleFrame(rawText: string): void {
    let parsed: ReturnType<typeof parseRawFrame>
    try { parsed = parseRawFrame(JSON.parse(rawText)) } catch { this.warn('RAW_FRAME_INVALID', 'JSON 解析失败'); return }
    if (!parsed.success) { this.warn('RAW_FRAME_INVALID', '帧校验失败'); return }
    const frame = parsed.data
    switch (frame.type) {
      case 'session': this.handleSession(frame); return
      case 'server_info': this.handleServerInfo(frame); return
      case 'expression': return
      case 'state': return // FE-INT-P1-01:FSM 状态契约识别,renderer 暂不消费(有意忽略,勿误删)
      case 'typing': return // FE-INT-P1-01:输入状态契约识别,renderer 暂不消费(有意忽略,勿误删)
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
        const pending = this.pendingVoice
        if (pending && frame.voice !== undefined && pending.voice === frame.voice) {
          clearTimeout(pending.timer)
          this.pendingVoice = undefined
          if (frame.ok) pending.resolve()
          else pending.reject(this.resultFrameError(frame.error))
        }
        const ev = this.mapper?.mapFrame(frame)
        if (ev) this.emit(ev)
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
      if (this.sessionBuffer.length > 0) {
        // B-6:旧回放缓冲被替换(新会话帧自带 conversationId)
        this.warn('SESSION_BUFFER_REPLACED', `活动会话 ${frame.conversationId} 到达,丢弃 ${this.sessionBuffer.length} 条未归属回放缓冲`)
      }
      this.setState({ ...this.state, activeConversationId: frame.conversationId })
      this.mapper?.setActiveConversationId(frame.conversationId)
      const messages = frame.messages.map((m) => this.restMapper.toDomainMessageFromReplay(m, frame.conversationId as string))
      this.sessionBuffer = []
      this.options.onSessionReplay?.(frame.conversationId, messages)
    } else {
      // B-6:旧后端 session 帧缺 conversationId → 缓冲,待活动会话经 REST active:true 解析后投递(Task 5)
      this.sessionBuffer = frame.messages
    }
  }

  private handleServerInfo(frame: RawServerInfo): void {
    this.clearHandshakeTimer() // server_info 到达即握手完成,成功与版本不符两条路径都清(后者走 fail-closed)
    if (frame.protocol_version !== PROTOCOL_VERSION_WIRE) {
      const err = new CyreneError(CyreneErrorCode.PROTOCOL_MISMATCH, `后端协议版本 ${frame.protocol_version} 不兼容,要求 ${PROTOCOL_VERSION_WIRE}`)
      this.ws?.close() // 版本不符 fail-closed:关闭已建立的 socket,避免后续帧继续被分派/泄漏
      this.ws = undefined
      this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl })
      this.connectReject?.(err)
      this.connectResolve = undefined
      this.connectReject = undefined
      this.options.onError?.(err)
      return
    }
    this.reconnectAttempts = 0
    this.setState({
      status: 'connected',
      serverUrl: this.serverUrl,
      protocolVersion: frame.protocol_version,
      serverVersion: frame.server_version,
      connectionId: frame.connectionId,
      activeConversationId: this.state.activeConversationId,
      lastError: undefined
    })
    this.connectResolve?.({
      sessionId: frame.connectionId ?? 'local',
      protocolVersion: frame.protocol_version,
      serverUrl: this.serverUrl
    })
    this.connectResolve = undefined
    this.connectReject = undefined
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

  private handleErrorFrame(frame: RawErrorMessage): void {
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

  private emit(event: BackendEvent): void { for (const h of this.handler) h(event) }

  // —— 连接生命周期 ——
  async connect(input: ConnectInput): Promise<BackendSession> {
    if (!input.token) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '缺少 token: 2B 要求建立认证连接', { reason: 'token_missing' })
    }
    this.clearHandshakeTimer() // m4:重连挂起时手动 connect 防双 socket(旧握手 timer 一并清)
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    this.serverUrl = input.serverUrl
    this.token = input.token
    this.reconnectAttempts = 0
    this.disconnected = false
    return new Promise<BackendSession>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      this.setState({ status: 'connecting', serverUrl: this.serverUrl })
      this.establishWs()
    })
  }

  private establishWs(): void {
    const wsBase = this.serverUrl.replace(/^http/, 'ws') + '/ws'
    const headers: Record<string, string> = {
      'X-Protocol-Version': '2',           // resolve_protocol_version 只认精确 "2"(两层取值,design §5.3)
      'X-Client-Platform': 'electron',
      Authorization: `Bearer ${this.token}`
    }
    const factory = this.options.wsFactory
    // aiohttp 压缩连接空闲后可以 RSV 保留位错误拒绝首个客户端业务帧，控制面显式不协商压缩。
    const ws = factory ? factory(wsBase, headers) : new WebSocket(wsBase, { headers, perMessageDeflate: false })
    this.ws = ws
    this.mapper = new FrameMapper({ connectionId: this.serverUrl, onProtocolWarning: this.options.onProtocolWarning })
    // 握手超时:建 socket 后立即启动(先于 message 注册,保证同步推帧夹具的 server_info 也能在 handleServerInfo 清掉)。
    // 超时按是否在用户 connect 流程分派:有 connect promise → fail-fast reject TIMEOUT + error;
    // 自动重连(无 connect promise)→ 关闭后走指数退避继续。
    const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_DEFAULT_MS
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined
      this.ws?.close(); this.ws = undefined
      if (this.connectReject) {
        const err = new CyreneError(CyreneErrorCode.TIMEOUT, `等待 server_info 超时(${handshakeTimeoutMs}ms)`)
        this.connectReject(err); this.connectResolve = undefined; this.connectReject = undefined
        this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl })
        this.options.onError?.(err)
      } else {
        this.onSocketClosed()   // 自动重连:关闭后走指数退避
      }
    }, handshakeTimeoutMs)
    ws.on('message', (arg?: unknown) => {
      if (arg === undefined) return
      const text = typeof arg === 'string' ? arg : arg instanceof Buffer ? arg.toString('utf8') : String(arg)
      this.handleFrame(text)
    })
    ws.on('close', () => { this.onSocketClosed() })
    ws.on('error', () => { this.onSocketClosed() })
    ws.on('unexpected-response', (_req, res) => { this.onUnexpectedResponse(res) })
  }

  /** 非 101 升级响应:仅 400/401/403 fail-fast(协议/认证硬错);429 RATE_LIMITED/503 超限等瞬态状态码 → 走重连退避,
   *  避免限流下全 fail-fast 让重连永久失效(F3,whole-branch review) */
  private onUnexpectedResponse(res: unknown): void {
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
      this.ws = undefined
      this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl })
      this.connectReject?.(err)
      this.connectResolve = undefined
      this.connectReject = undefined
      this.options.onError?.(err)
      return
    }
    // 瞬态状态码:视为本次连接失败,关闭当前 socket 后进入指数退避重连(不置 error)
    this.onSocketClosed()
  }

  private onSocketClosed(): void {
    this.clearHandshakeTimer() // socket 关闭即当前握手结束,避免超时回调在退避期间误触发
    if (this.disconnected) return
    if (this.state.status === 'error') return // unexpected-response/版本不符 fail-fast 后,后续 close/error 不再翻回 reconnecting
    this.ws = undefined
    this.lastSocketClosedAt = this.options.now?.() ?? Date.now() // F2:掉线时刻接入注入时钟(now())
    this.scheduleReconnect()
  }

  /** 指数退避重连(1s ×2 上限 30s);连续失败超过 6 次 → error 状态 */
  private scheduleReconnect(): void {
    if (this.disconnected) return
    if (this.state.status === 'error') return
    if (this.reconnectTimer) return // close+error 双触发只排一次
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      const err = new CyreneError(CyreneErrorCode.NOT_CONNECTED, `重连失败超过 ${RECONNECT_MAX_ATTEMPTS} 次,连接终止`)
      this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl })
      this.connectReject?.(err)
      this.connectResolve = undefined
      this.connectReject = undefined
      this.options.onError?.(err)
      return
    }
    this.setState({ status: 'reconnecting', serverUrl: this.serverUrl })
    // 退避延迟 = base * 2^(attempts-1) 封顶 MAX;now() 注入时钟做差值判定(自上次掉线已流逝时间计入延迟,
    // 测试可注入时钟/缩短 reconnectBaseDelayMs 避免慢测试)
    const now = this.options.now?.() ?? Date.now()
    const base = this.options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS
    const backoffMs = Math.min(base * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS)
    const elapsed = this.lastSocketClosedAt !== undefined ? Math.max(0, now - this.lastSocketClosedAt) : 0
    const delay = Math.max(0, backoffMs - elapsed)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.establishWs()
    }, delay)
  }

  async disconnect(): Promise<void> {
    this.disconnected = true
    this.clearHandshakeTimer() // 握手未完成时取消:清超时 timer,避免其后误触发
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer)
      pending.reject(new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开,ack 未完成'))
    }
    this.pendingAcks.clear()
    this.ws?.close()
    this.ws = undefined
    // 握手未完成(connecting/reconnecting)时取消:reject 挂起的 connect promise,避免 await connect() 永久挂死
    this.connectReject?.(new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已取消'))
    this.connectResolve = undefined
    this.connectReject = undefined
    this.setState({ status: 'disconnected' })
    // T3:abort 全部在途 REST 请求(disconnected 已置 true → catch 走 NOT_CONNECTED,不误报 TIMEOUT)
    for (const c of this.activeControllers) c.abort()
    this.activeControllers.clear()
  }

  // —— WS 发送 ——
  async sendMessage(input: SendMessageInput): Promise<ClientRequestRef> {
    if (this.state.status !== 'connected' || !this.ws) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接,无法发送消息')
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
        this.pendingAcks.delete(input.clientRequestId)
        reject(new CyreneError(CyreneErrorCode.TIMEOUT, `user_message.ack 超时(${ackTimeoutMs}ms): ${input.clientRequestId}`))
      }, ackTimeoutMs)
      this.pendingAcks.set(input.clientRequestId, { resolve, reject, timer })
    })
    const payload: Record<string, unknown> = { type: 'text', content: input.text, clientRequestId: input.clientRequestId, conversationId: input.conversationId }
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
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接,无法取消生成')
    }
    // interrupt 非定向(后端 InterruptMessage 仅 {type:"interrupt"});generationId 仅日志关联
    this.ws.send(JSON.stringify({ type: 'interrupt' }))
  }

  // —— REST 会话方法(Task 5)——
  /** 统一 REST 请求:serverUrl 尾斜杠剥除 + Authorization Bearer + content-type;非 2xx → CyreneError(mapHttpError)。
   *  T3:每请求一个 AbortController,restTimeoutMs 超时 timer abort → TIMEOUT;disconnect 主动 abort → NOT_CONNECTED(不误报超时)。 */
  private async restFetch(path: string, init?: RequestInit): Promise<Response> {
    if (!this.serverUrl) {
      // F1:spec B-G6⑤——REST 方法需先 connect(serverUrl 自 connect 记录),connect 前调用显式失败而非打到空 url
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'REST 方法需先 connect')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.restTimeoutMs)
    this.activeControllers.add(controller)
    const url = `${this.serverUrl.replace(/\/$/, '')}${path}`
    try {
      const res = await (this.options.fetchImpl ?? fetch)(url, {
        ...init,
        signal: controller.signal,
        headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const code = (body as { code?: string }).code ?? 'HTTP_ERROR'
        throw new CyreneError(mapHttpError(res.status, code), (body as { message?: string }).message ?? `HTTP ${res.status}`, body)
      }
      return res
    } catch (e) {
      if (controller.signal.aborted) {
        // I3/D17:disconnect 主动 abort 时 disconnected 已置 true → NOT_CONNECTED;否则是超时 timer abort → TIMEOUT
        if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开,请求已取消')
        throw new CyreneError(CyreneErrorCode.TIMEOUT, `REST 请求超时(${this.restTimeoutMs}ms): ${path}`)
      }
      throw e
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
    const items = messages
      .map((m) => this.restMapper.toDomainMessage(m, session.conversationId))
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
    const res = await this.restFetch('/api/sessions', { method: 'POST', body: JSON.stringify(input.title !== undefined ? { title: input.title } : {}) })
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

  // —— 阶段 3 G3 附件上传/签发（spec §4.4/§4.5）——
  private async readUploadBytes(f: UploadContent): Promise<Uint8Array> {
    if (f.bytes) return f.bytes
    if (f.path) return new Uint8Array(await (await import('fs/promises')).readFile(f.path))
    throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '上传内容缺少 bytes/path')
  }

  async uploadAttachments(files: UploadContent[], opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]> {
    if (!this.serverUrl) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'REST 方法需先 connect')
    const uploadTimeoutMs = this.options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_DEFAULT_MS
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), uploadTimeoutMs)
    // P1-1：取消经 opts.signal 接入——AbortSignal.any 组合超时与调用方取消；任一方 abort 即终止 fetch（spec §4.1 D10）
    const effectiveSignal = opts?.signal ? AbortSignal.any([timeoutController.signal, opts.signal]) : timeoutController.signal
    this.activeControllers.add(timeoutController)
    const form = new FormData()
    for (const f of files) {
      const bytes = await this.readUploadBytes(f)
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
        headers: { authorization: `Bearer ${this.token}` },   // multipart 不设 content-type（fetch 自动带 boundary）
        body: form
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const code = (body as { code?: string }).code ?? 'HTTP_ERROR'
        throw new CyreneError(mapHttpError(res.status, code), (body as { message?: string }).message ?? `HTTP ${res.status}`, body)
      }
      const parsed = parseAttachmentUploadResponse(await res.json())
      if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '附件上传响应校验失败')
      return parsed.data.attachments
    } catch (e) {
      if (opts?.signal?.aborted) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '附件上传已取消')   // 调用方取消（IPC attachments:cancel 触发）
      if (timeoutController.signal.aborted) {
        if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，上传已取消')
        throw new CyreneError(CyreneErrorCode.TIMEOUT, `附件上传超时(${uploadTimeoutMs}ms)`)
      }
      throw e
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
  /** 发无 ACK 帧,需等 result 帧(switch_model/set_tts_voice);未连接抛 NOT_CONNECTED */
  private requireWs(): void {
    if (this.state.status !== 'connected' || !this.ws) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接，无法执行模型操作')
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
          ...(input.capabilities ? { capabilities: input.capabilities } : {})
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
    return { ok: true, mime: d.mime, bytes: new Uint8Array(bytes), ...(d.duration_ms !== undefined ? { durationMs: d.duration_ms } : {}) }
  }

  async setTtsVoice(input: SetTtsVoiceCommand): Promise<void> {
    this.requireWs()
    return new Promise<void>((resolve, reject) => {
      // 单 in-flight（D-A14）：重入时 supersede 旧 pending（GENERATION_CONFLICT + clearTimeout 旧 timer），
      // 防止旧 timer 稍后无条件清掉新 pending 导致新 result 帧被忽略/误报 TIMEOUT
      const existing = this.pendingVoice
      if (existing) { clearTimeout(existing.timer); existing.reject(new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, `同声音切换未完成`)) }
      const timer = setTimeout(() => {
        // 所有权限定：仅当当前 pending 仍是本 timer 时才清（防御旧 timer 迟到清新 pending 的跨清竞态）
        if (this.pendingVoice?.timer === timer) this.pendingVoice = undefined
        reject(new CyreneError(CyreneErrorCode.TIMEOUT, `set_tts_voice 超时`))
      }, this.switchTimeoutMs())
      this.pendingVoice = { voice: input.voice, resolve, reject, timer }
      this.ws!.send(JSON.stringify({ type: 'set_tts_voice', voice: input.voice }))
    })
  }

  async activateModelProfile(input: ActivateModelProfileCommand): Promise<void> {
    this.requireWs()
    return new Promise<void>((resolve, reject) => {
      const existing = this.pendingSwitch.get(input.service)
      if (existing) { clearTimeout(existing.timer); existing.reject(new CyreneError(CyreneErrorCode.GENERATION_CONFLICT, `同服务切换未完成`)) }
      const timer = setTimeout(() => { this.pendingSwitch.delete(input.service); reject(new CyreneError(CyreneErrorCode.TIMEOUT, `switch_model 超时`)) }, this.switchTimeoutMs())
      this.pendingSwitch.set(input.service, { model: input.profileId, resolve, reject, timer })
      this.ws!.send(JSON.stringify({ type: 'switch_model', service: input.service, model: input.profileId }))
    })
  }

  getActiveModelSelection(): ActiveModelSelection {
    const s = this.services
    return { ...(s?.llm?.model ? { llmProfileId: s.llm.model } : {}), ...(s?.stt?.model ? { voiceSttProfileId: s.stt.model } : {}), ...(s?.tts?.model ? { ttsProfileId: s.tts.model } : {}) }
  }

  // —— 非目标方法(阶段 3/4/6 实现,不 Mock 假装)——
  async startVoiceInput(_input: StartVoiceInputInput): Promise<VoiceInputSession> { throw this.notImplemented('startVoiceInput') }
  async stopVoiceInput(_input: StopVoiceInputInput): Promise<void> { throw this.notImplemented('stopVoiceInput') }
  async startDictation(_input: StartDictationInput): Promise<DictationSession> { throw this.notImplemented('startDictation') }
  async stopDictation(_input: StopDictationInput): Promise<void> { throw this.notImplemented('stopDictation') }
  async submitToolResult(_input: ToolResult): Promise<void> { throw this.notImplemented('submitToolResult') }

  private notImplemented(method: string): CyreneError {
    return new CyreneError(CyreneErrorCode.NOT_IMPLEMENTED, `RealBackend.${method} 尚未实现(后续阶段落地)`)
  }
}
