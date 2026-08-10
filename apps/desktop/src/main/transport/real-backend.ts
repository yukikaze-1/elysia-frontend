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
import { RestMapper } from './protocol-v2/rest-mapper'
import { parseRestActivateResult, parseRestMessagesPage, parseRestSessionDetail, parseRestSessions, RestSessionSummarySchema } from './protocol-v2/rest-schemas'
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
  reconnectBaseDelayMs?: number  // 默认 1000;测试注入缩短值避免慢测试
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

/** REST HTTP 状态 + 后端 code → 领域错误码(spec §5.3 REST 错误映射)。
 *  400 CONTRACT_VALIDATION → INVALID_INPUT;401/403 → AUTHENTICATION_FAILED;404 → NOT_FOUND;其余 → UNKNOWN。 */
function mapHttpError(status: number, code: string): CyreneErrorCode {
  if (status === 400 && code === 'CONTRACT_VALIDATION') return CyreneErrorCode.INVALID_INPUT
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
  private lastSocketClosedAt?: number
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
      this.ws?.close() // 版本不符 fail-closed:关闭已建立的 socket,避免后续帧继续被分派/泄漏
      this.ws = undefined
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

  private warn(code: ProtocolWarningCode, message: string): void {
    this.options.onProtocolWarning?.({ code, message })
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

  /** 非 101 升级响应:仅 400/401/403 fail-fast(协议/认证硬错);429 RATE_LIMITED/503 超限等瞬态状态码 → 走重连退避,
   *  避免限流下全 fail-fast 让重连永久失效(F3,whole-branch review) */
  private onUnexpectedResponse(res: unknown): void {
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
      this.state = { status: 'error', lastError: err.message, serverUrl: this.serverUrl }
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
      this.state = { status: 'error', lastError: err.message, serverUrl: this.serverUrl }
      this.connectReject?.(err)
      this.connectResolve = undefined
      this.connectReject = undefined
      this.options.onError?.(err)
      return
    }
    this.state = { status: 'reconnecting', serverUrl: this.serverUrl }
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
    this.state = { status: 'disconnected' }
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

  // —— REST 会话方法(Task 5)——
  /** 统一 REST 请求:serverUrl 尾斜杠剥除 + Authorization Bearer + content-type;非 2xx → CyreneError(mapHttpError) */
  private async restFetch(path: string, init?: RequestInit): Promise<Response> {
    if (!this.serverUrl) {
      // F1:spec B-G6⑤——REST 方法需先 connect(serverUrl 自 connect 记录),connect 前调用显式失败而非打到空 url
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'REST 方法需先 connect')
    }
    const url = `${(this.serverUrl ?? '').replace(/\/$/, '')}${path}`
    const res = await (this.options.fetchImpl ?? fetch)(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const code = (body as { code?: string }).code ?? 'HTTP_ERROR'
      throw new CyreneError(mapHttpError(res.status, code), (body as { message?: string }).message ?? `HTTP ${res.status}`, body)
    }
    return res
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
    this.state = { ...this.state, activeConversationId: parsed.data.activeConversationId }
    if (this.state.status === 'connected' && this.ws) {
      // 回放走 WS activate_session(仅 connected 发送;未连接时只 REST 切 active)
      this.ws.send(JSON.stringify({ type: 'activate_session', conversationId }))
    }
    return { conversationId: parsed.data.activeConversationId }
  }

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
