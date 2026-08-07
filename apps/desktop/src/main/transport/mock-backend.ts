import type {
  ActivateModelProfileCommand,
  BackendSession,
  CancelGenerationInput,
  ChatHistoryPage,
  ChatHistoryQuery,
  ConnectInput,
  ConversationDetail,
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
import type { BackendAdapter, BackendEventHandler } from './backend-adapter'
import fixtureRaw from '../fixtures/streaming-reply.jsonl?raw'

export interface MockBackendOptions {
  /** 每个事件的触发间隔(毫秒) */
  emitDelayMs?: number
  /** 覆盖内置夹具(测试用) */
  fixtureRaw?: string
}

const MOCK_SESSION: BackendSession = {
  sessionId: 'mock-session-1',
  protocolVersion: '0.1',
  serverUrl: 'mock://local'
}

const MOCK_CONVERSATIONS: Conversation[] = [
  { id: 'conv-1001', title: '流式回复演示', updatedAt: '2026-08-08T08:00:00.000Z', preview: '好的，我来回答…' },
  { id: 'conv-1002', title: '历史会话示例', updatedAt: '2026-08-07T10:30:00.000Z' }
]

/**
 * Mock Backend:按夹具回放流式事件,用于阶段 0 UI 与测试。
 * 真实后端协议未联调前,一切经 Mock 的任务标记为"已开发、未联调"。
 */
export class MockBackend implements BackendAdapter {
  private handler?: BackendEventHandler
  private timers: ReturnType<typeof setTimeout>[] = []
  private connected = false
  private readonly fixture: BackendEvent[]
  private readonly emitDelayMs: number

  constructor(options: MockBackendOptions = {}) {
    this.emitDelayMs = options.emitDelayMs ?? 30
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
    return { ...MOCK_SESSION, serverUrl: input.serverUrl }
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.clearTimers()
  }

  async listConversations(_input: PageQuery): Promise<Page<Conversation>> {
    return { items: MOCK_CONVERSATIONS, hasMore: false }
  }

  async getConversation(_input: GetConversationQuery): Promise<ConversationDetail> {
    return { ...MOCK_CONVERSATIONS[0] }
  }

  async getMessageContext(_input: MessageContextQuery): Promise<MessagePage> {
    return { items: [], hasMore: false }
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    return {
      id: `conv-${Date.now()}`,
      title: input.title ?? '新会话',
      updatedAt: new Date().toISOString()
    }
  }

  async deleteConversation(_id: string): Promise<void> {
    // Mock 无操作
  }

  async sendMessage(input: SendMessageInput): Promise<ClientRequestRef> {
    if (!this.connected) {
      throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'MockBackend 未连接')
    }
    this.scheduleReplay()
    return { clientRequestId: input.clientRequestId }
  }

  async cancelGeneration(_input: CancelGenerationInput): Promise<void> {
    this.clearTimers()
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

  private scheduleReplay(): void {
    this.fixture.forEach((event, index) => {
      this.timers.push(
        setTimeout(() => {
          this.emit(event)
        }, index * this.emitDelayMs)
      )
    })
  }

  private clearTimers(): void {
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers = []
  }

  private emit(event: BackendEvent): void {
    this.handler?.(event)
  }
}
