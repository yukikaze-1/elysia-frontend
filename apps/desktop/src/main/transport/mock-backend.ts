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
  TestModelProfileCommand,
  ToolResult,
  VoiceInputSession
} from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput, Page, PageQuery } from '@shared/contracts/conversation'
import type { BackendEvent } from '@shared/contracts/events'
import type { ClientRequestRef, SendMessageInput } from '@shared/contracts/message'
import type { ModelProfile, ModelServiceType } from '@shared/contracts/model'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { parseBackendEvent } from '@shared/schemas'
import type { BackendAdapter, BackendEventHandler, UploadContent } from './backend-adapter'
import type { AttachmentInfo, AttachmentSignResult } from '@shared/contracts/attachments'
import fixtureRaw from '../fixtures/domain/streaming-reply.jsonl?raw'

/** 上传 MIME → kind 提示值（Mock 确定性；真实后端以魔数真值为准） */
function kindFromMimeForMock(mime: string): string {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

export interface MockBackendOptions {
  /** 每个事件的触发间隔(毫秒) */
  emitDelayMs?: number
  /** 覆盖内置夹具(测试用) */
  fixtureRaw?: string
  /** 连接状态变化回调(connect/disconnect 时触发) */
  onConnectionStateChange?: (state: ConnectionState) => void
  /** 唯一 ID 工厂（测试确定性）：默认实例内单调计数器+时间前缀（禁裸 Date.now 同 ms 碰撞） */
  idFactory?: () => string
  /** 时钟（测试确定性）：默认 new Date() */
  now?: () => Date
}

const MOCK_SESSION: BackendSession = {
  sessionId: 'mock-session-1',
  protocolVersion: '0.1',
  serverUrl: 'mock://local'
}

/** 默认会话模板：与旧模块级 MOCK_CONVERSATIONS 完全一致（conv-1001 首位），每次调用返回全新数组 */
function createMockConversations(): Conversation[] {
  return [
    { id: 'conv-1001', title: '流式回复演示', updatedAt: '2026-08-08T08:00:00.000Z', preview: '好的，我来回答…' },
    { id: 'conv-1002', title: '历史会话示例', updatedAt: '2026-08-07T10:30:00.000Z' }
  ]
}

/**
 * Mock Backend:按夹具回放流式事件,用于阶段 0 UI 与测试。
 * 真实后端协议未联调前,一切经 Mock 的任务标记为"已开发、未联调"。
 */
export class MockBackend implements BackendAdapter {
  private handler?: BackendEventHandler
  private connected = false
  private readonly fixture: BackendEvent[]
  private readonly emitDelayMs: number
  private readonly onConnectionStateChange?: (state: ConnectionState) => void
  private readonly idFactory: () => string
  private readonly now: () => Date
  private readonly conversations: Conversation[] = createMockConversations()
  private activeConversationId?: string
  private generationTimers = new Map<string, ReturnType<typeof setTimeout>[]>()
  private idCounter = 0

  constructor(options: MockBackendOptions = {}) {
    this.emitDelayMs = options.emitDelayMs ?? 30
    this.onConnectionStateChange = options.onConnectionStateChange
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? (() => `mock-${Date.now()}-${++this.idCounter}`)
    const raw = options.fixtureRaw ?? fixtureRaw
    this.fixture = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) => {
        const parsed = parseBackendEvent(JSON.parse(line))
        if (!parsed.success) {
          throw new CyreneError(
            CyreneErrorCode.SCHEMA_VALIDATION_FAILED,
            `MockBackend 夹具第 ${index + 1} 行不符合事件 Schema`,
            { line: index + 1, issues: parsed.error.issues }
          )
        }
        return parsed.data
      })
  }

  subscribe(handler: BackendEventHandler): () => void {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = undefined
    }
  }

  async connect(input: ConnectInput): Promise<BackendSession> {
    this.connected = true
    this.onConnectionStateChange?.({ status: 'connected' })
    return { ...MOCK_SESSION, serverUrl: input.serverUrl }
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.clearTimers()
    this.onConnectionStateChange?.({ status: 'disconnected' })
  }

  getConnectionState(): ConnectionState {
    return { status: this.connected ? 'connected' : 'disconnected' }
  }

  async listConversations(_input: PageQuery): Promise<Page<Conversation>> {
    return { items: this.conversations.map((c) => ({ ...c })), hasMore: false }
  }

  async getConversation(input: GetConversationQuery): Promise<ConversationDetail> {
    const conv = this.conversations.find((c) => c.id === input.conversationId)
    if (!conv) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${input.conversationId}`)
    return { ...conv }
  }

  async getConversationMessages(_input: ConversationMessagesQuery): Promise<MessagePage> {
    return { items: [], hasMore: false }
  }

  async getMessageContext(_input: MessageContextQuery): Promise<MessagePage> {
    return { items: [], hasMore: false }
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const conv: Conversation = { id: this.idFactory(), title: input.title ?? '新会话', updatedAt: this.now().toISOString() }
    this.conversations.push(conv)
    return { ...conv }
  }

  async activateConversation(conversationId: string): Promise<ActivateConversationResult> {
    if (!this.conversations.some((c) => c.id === conversationId)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${conversationId}`)
    this.activeConversationId = conversationId
    return { conversationId }
  }

  async renameConversation(id: string, title: string): Promise<Conversation> {
    const conv = this.conversations.find((c) => c.id === id)
    if (!conv) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${id}`)
    conv.title = title
    conv.updatedAt = this.now().toISOString()
    return { ...conv }
  }

  async deleteConversation(id: string): Promise<void> {
    const idx = this.conversations.findIndex((c) => c.id === id)
    if (idx < 0) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${id}`)
    this.conversations.splice(idx, 1)
    if (this.activeConversationId === id) this.activeConversationId = undefined
  }

  async sendMessage(input: SendMessageInput): Promise<ClientRequestRef> {
    if (!this.connected) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'MockBackend 未连接')
    }
    this.scheduleReplay(input.conversationId)
    return { clientRequestId: input.clientRequestId }
  }

  // —— 阶段 3 G3 附件确定性（spec §3.2）——
  async uploadAttachments(files: UploadContent[]): Promise<AttachmentInfo[]> {
    if (!this.connected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'MockBackend 未连接')
    return files.map((f) => {
      const attachmentId = `att_${this.idFactory().replace(/[^A-Za-z0-9_-]/g, '')}`
      const kind = f.kind ?? kindFromMimeForMock(f.mediaType)
      return { attachmentId, kind, mime: f.mediaType, size: f.size, url: `/api/attachments/${attachmentId}`, filename: f.name }
    })
  }

  async signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult> {
    const base = 'https://mock.local'
    // P2-2：返回精确 AttachmentSignResult 形状（{url,expiresAt}）——多余 attachmentId 属字面量超集，TS excess property 报错
    return { url: `${base}/api/attachments/${encodeURIComponent(attachmentId)}?sig=mock&exp=1`, expiresAt: this.now().toISOString() }
  }

  async cancelGeneration(input: CancelGenerationInput): Promise<void> {
    const genTimers = this.generationTimers.get(input.generationId)
    if (!genTimers) return // 未知 genId no-op
    genTimers.forEach((timer) => clearTimeout(timer))
    this.generationTimers.delete(input.generationId)
  }

  async listModelProfiles(_type?: ModelServiceType): Promise<ModelProfile[]> {
    return [
      {
        id: 'llm-1',
        type: 'llm',
        provider: 'mock-provider',
        modelId: 'cyrene-llm-v1',
        executionLocation: 'backend',
        builtIn: true,
        name: 'Mock LLM'
      }
    ]
  }

  async testModelProfile(_input: TestModelProfileCommand): Promise<ModelProfileTestResult> {
    return { ok: true, latencyMs: 96 }
  }

  async activateModelProfile(_input: ActivateModelProfileCommand): Promise<void> {
    // Mock 无操作
  }

  async queryChatHistory(_input: ChatHistoryQuery): Promise<ChatHistoryPage> {
    return { items: [], hasMore: false }
  }

  async startVoiceInput(_input: StartVoiceInputInput): Promise<VoiceInputSession> {
    return { sessionId: 'mock-voice-1' }
  }

  async stopVoiceInput(_input: StopVoiceInputInput): Promise<void> {
    // Mock 无操作
  }

  async startDictation(_input: StartDictationInput): Promise<DictationSession> {
    return { sessionId: 'mock-dictation-1' }
  }

  async stopDictation(_input: StopDictationInput): Promise<void> {
    // Mock 无操作
  }

  async submitToolResult(_input: ToolResult): Promise<void> {
    // Mock 无操作
  }

  /** 释放定时器(测试清理用) */
  dispose(): void {
    this.clearTimers()
  }

  private scheduleReplay(conversationId: string): void {
    const genId = this.idFactory()
    const msgId = this.idFactory()
    const rspId = this.idFactory()
    const segmentMap = new Map<string, string>()
    const genTimers: ReturnType<typeof setTimeout>[] = []
    this.fixture.forEach((event, index) => {
      const fresh: Record<string, unknown> = { ...event }
      fresh.eventId = this.idFactory()
      if ('generationId' in event) fresh.generationId = genId
      if ('messageId' in event) fresh.messageId = msgId
      if ('responseId' in event) fresh.responseId = rspId
      if ('conversationId' in event) fresh.conversationId = conversationId
      if ('segmentId' in event && typeof event.segmentId === 'string') {
        let mapped = segmentMap.get(event.segmentId)
        if (!mapped) {
          mapped = this.idFactory()
          segmentMap.set(event.segmentId, mapped)
        }
        fresh.segmentId = mapped
      }
      // BackendEvent 是接口联合，需 as unknown as 双转（TS2352）
      const timer = setTimeout(() => {
        this.emit(fresh as unknown as BackendEvent)
      }, index * this.emitDelayMs)
      genTimers.push(timer)
    })
    this.generationTimers.set(genId, genTimers)
  }

  private clearTimers(): void {
    this.generationTimers.forEach((timers) => timers.forEach((t) => clearTimeout(t)))
    this.generationTimers.clear()
  }

  private emit(event: BackendEvent): void {
    this.handler?.(event)
  }
}
