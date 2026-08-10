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
  TestModelProfileCommand,
  ToolResult,
  VoiceInputSession
} from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput, Page, PageQuery } from '@shared/contracts/conversation'
import type { ClientRequestRef, Message, SendMessageInput } from '@shared/contracts/message'
import type { ModelProfile, ModelServiceType } from '@shared/contracts/model'
import type { ProtocolWarning } from '@shared/contracts/protocol'
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
import { RestMapper } from './protocol-v2/rest-mapper'
import type { BackendAdapter, BackendEventHandler } from './backend-adapter'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
export interface ConnectionState {
  status: ConnectionStatus
  serverUrl?: string
  protocolVersion?: string
  serverVersion?: string
  connectionId?: string
  activeConversationId?: string
  lastError?: string
}
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
  ackTimeoutMs?: number   // 默认 15000;测试注入小值
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

/**
 * RealBackend:真实后端适配器(WS 连接核心)。
 * 协议差异全部收敛在此(URL/字段名/WS 帧),UI 只消费领域事件。
 * Task 4 实现 connect/握手/帧分派/session 回放/心跳重连/ack 关联/error 路由;
 * REST 会话方法与模型/语音/工具方法抛 NOT_IMPLEMENTED 占位(Task 5/阶段 3/4/6)。
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
  private disconnected = false
  private serverUrl = ''
  private token = ''
  private connectResolve?: (s: BackendSession) => void
  private connectReject?: (e: unknown) => void

  constructor(options: RealBackendOptions = {}) { this.options = options }

  getConnectionState(): ConnectionState { return this.state }
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
      case 'user_message.ack': this.handleAck(frame); return
      case 'error': this.handleErrorFrame(frame); return
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
      this.state = { ...this.state, activeConversationId: frame.conversationId }
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
    if (frame.protocol_version !== PROTOCOL_VERSION_WIRE) {
      const err = new CyreneError(CyreneErrorCode.PROTOCOL_MISMATCH, `后端协议版本 ${frame.protocol_version} 不兼容,要求 ${PROTOCOL_VERSION_WIRE}`)
      this.state = { status: 'error', lastError: err.message, serverUrl: this.serverUrl }
      this.connectReject?.(err)
      this.connectResolve = undefined
      this.connectReject = undefined
      this.options.onError?.(err)
      return
    }
    this.reconnectAttempts = 0
    this.state = {
      status: 'connected',
      serverUrl: this.serverUrl,
      protocolVersion: frame.protocol_version,
      serverVersion: frame.server_version,
      connectionId: frame.connectionId,
      activeConversationId: this.state.activeConversationId,
      lastError: undefined
    }
    this.connectResolve?.({
      sessionId: frame.connectionId ?? 'local',
      protocolVersion: frame.protocol_version,
      serverUrl: this.serverUrl
    })
    this.connectResolve = undefined
    this.connectReject = undefined
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
      const err = frame.error
        ? new CyreneError(CyreneErrorCode.INVALID_INPUT, frame.error.message, { code: frame.error.code, retryable: frame.error.retryable })
        : new CyreneError(CyreneErrorCode.INVALID_INPUT, '消息被后端拒绝')
      pending.reject(err)
    }
  }

  private handleErrorFrame(frame: RawErrorMessage): void {
    const err = new CyreneError(CyreneErrorCode.UNKNOWN, frame.message, {
      code: frame.code,
      requestId: frame.requestId,
      retryable: frame.retryable,
      ...(frame.details !== undefined ? { details: frame.details } : {})
    })
    this.warn('WS_ERROR_FRAME', `后端 error 帧: ${frame.code ?? '(无 code)'} ${frame.message}`)
    this.options.onError?.(err)
  }

  private warn(code: string, message: string): void {
    this.options.onProtocolWarning?.({ code, message } as ProtocolWarning)
  }

  private emit(event: BackendEvent): void { for (const h of this.handler) h(event) }

  // —— 连接生命周期 ——
  async connect(input: ConnectInput): Promise<BackendSession> {
    if (!input.token) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '缺少 token: 2B 要求建立认证连接', { reason: 'token_missing' })
    }
    this.serverUrl = input.serverUrl
    this.token = input.token
    this.reconnectAttempts = 0
    this.disconnected = false
    return new Promise<BackendSession>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      this.state = { status: 'connecting', serverUrl: this.serverUrl }
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
    const ws = factory ? factory(wsBase, headers) : new WebSocket(wsBase, { headers })
    this.ws = ws
    this.mapper = new FrameMapper({ connectionId: this.serverUrl, onProtocolWarning: this.options.onProtocolWarning })
    ws.on('message', (arg?: unknown) => {
      if (arg === undefined) return
      const text = typeof arg === 'string' ? arg : arg instanceof Buffer ? arg.toString('utf8') : String(arg)
      this.handleFrame(text)
    })
    ws.on('close', () => { this.onSocketClosed() })
    ws.on('error', () => { this.onSocketClosed() })
    ws.on('unexpected-response', (_req, res) => { this.onUnexpectedResponse(res) })
  }

  /** 非 101 升级响应(401/403 认证失败、400 协议拒绝)→ fail-fast error,不重连 */
  private onUnexpectedResponse(res: unknown): void {
    const statusCode = typeof res === 'object' && res !== null && 'statusCode' in res
      ? (res as { statusCode?: number }).statusCode
      : undefined
    const err = new CyreneError(CyreneErrorCode.AUTHENTICATION_FAILED, `WebSocket 升级被拒绝(HTTP ${statusCode ?? '未知状态码'})`, { statusCode })
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    this.ws = undefined
    this.state = { status: 'error', lastError: err.message, serverUrl: this.serverUrl }
    this.connectReject?.(err)
    this.connectResolve = undefined
    this.connectReject = undefined
    this.options.onError?.(err)
  }

  private onSocketClosed(): void {
    if (this.disconnected) return
    if (this.state.status === 'error') return // unexpected-response/版本不符 fail-fast 后,后续 close/error 不再翻回 reconnecting
    this.ws = undefined
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
      this.state = { status: 'error', lastError: err.message, serverUrl: this.serverUrl }
      this.connectReject?.(err)
      this.connectResolve = undefined
      this.connectReject = undefined
      this.options.onError?.(err)
      return
    }
    this.state = { status: 'reconnecting', serverUrl: this.serverUrl }
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.establishWs()
    }, delay)
  }

  async disconnect(): Promise<void> {
    this.disconnected = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer)
      pending.reject(new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开,ack 未完成'))
    }
    this.pendingAcks.clear()
    this.ws?.close()
    this.ws = undefined
    this.connectResolve = undefined
    this.connectReject = undefined
    this.state = { status: 'disconnected' }
  }

  // —— WS 发送 ——
  async sendMessage(input: SendMessageInput): Promise<ClientRequestRef> {
    if (this.state.status !== 'connected' || !this.ws) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '未连接,无法发送消息')
    }
    const ackTimeoutMs = this.options.ackTimeoutMs ?? ACK_TIMEOUT_DEFAULT_MS
    const promise = new Promise<ClientRequestRef>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(input.clientRequestId)
        reject(new CyreneError(CyreneErrorCode.TIMEOUT, `user_message.ack 超时(${ackTimeoutMs}ms): ${input.clientRequestId}`))
      }, ackTimeoutMs)
      this.pendingAcks.set(input.clientRequestId, { resolve, reject, timer })
    })
    const payload = { type: 'text', content: input.text, clientRequestId: input.clientRequestId, conversationId: input.conversationId }
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

  // —— REST 会话方法(Task 5 实现)——
  async listConversations(_input: PageQuery): Promise<Page<Conversation>> { throw this.notImplemented('listConversations') }
  async getConversation(_input: GetConversationQuery): Promise<ConversationDetail> { throw this.notImplemented('getConversation') }
  async getConversationMessages(_input: ConversationMessagesQuery): Promise<MessagePage> { throw this.notImplemented('getConversationMessages') }
  async createConversation(_input: CreateConversationInput): Promise<Conversation> { throw this.notImplemented('createConversation') }
  async activateConversation(_conversationId: string): Promise<ActivateConversationResult> { throw this.notImplemented('activateConversation') }
  async renameConversation(_id: string, _title: string): Promise<Conversation> { throw this.notImplemented('renameConversation') }
  async deleteConversation(_id: string): Promise<void> { throw this.notImplemented('deleteConversation') }

  // —— 非目标方法(阶段 3/4/6 实现,不 Mock 假装)——
  async getMessageContext(_input: MessageContextQuery): Promise<MessagePage> { throw this.notImplemented('getMessageContext') }
  async listModelProfiles(_type?: ModelServiceType): Promise<ModelProfile[]> { throw this.notImplemented('listModelProfiles') }
  async testModelProfile(_input: TestModelProfileCommand): Promise<ModelProfileTestResult> { throw this.notImplemented('testModelProfile') }
  async activateModelProfile(_input: ActivateModelProfileCommand): Promise<void> { throw this.notImplemented('activateModelProfile') }
  async queryChatHistory(_input: ChatHistoryQuery): Promise<ChatHistoryPage> { throw this.notImplemented('queryChatHistory') }
  async startVoiceInput(_input: StartVoiceInputInput): Promise<VoiceInputSession> { throw this.notImplemented('startVoiceInput') }
  async stopVoiceInput(_input: StopVoiceInputInput): Promise<void> { throw this.notImplemented('stopVoiceInput') }
  async startDictation(_input: StartDictationInput): Promise<DictationSession> { throw this.notImplemented('startDictation') }
  async stopDictation(_input: StopDictationInput): Promise<void> { throw this.notImplemented('stopDictation') }
  async submitToolResult(_input: ToolResult): Promise<void> { throw this.notImplemented('submitToolResult') }

  private notImplemented(method: string): CyreneError {
    return new CyreneError(CyreneErrorCode.NOT_IMPLEMENTED, `RealBackend.${method} 尚未实现(后续阶段落地)`)
  }
}
