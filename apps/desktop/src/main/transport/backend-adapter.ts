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
  ModelProfileTestResult,
  StartDictationInput,
  StartVoiceInputInput,
  StopDictationInput,
  StopVoiceInputInput,
  TestModelProfileCommand,
  ToolResult,
  VoiceInputSession,
  DictationSession
} from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput, Page, PageQuery } from '@shared/contracts/conversation'
import type { BackendEvent } from '@shared/contracts/events'
import type { ClientRequestRef, SendMessageInput } from '@shared/contracts/message'
import type { ModelProfile, ModelServiceType } from '@shared/contracts/model'

/** 后端事件回调(Renderer 只消费领域事件,不接触原始协议) */
export type BackendEventHandler = (event: BackendEvent) => void

/**
 * 后端适配器接口(对应 docs/01 §6.1)。
 * 所有协议差异(URL、字段名、WS/SSE、ID)都由实现类消化;UI 只依赖此接口。
 */
export interface BackendAdapter {
  connect(input: ConnectInput): Promise<BackendSession>
  disconnect(): Promise<void>

  /** 当前连接状态(快照;IPC 推送与 store 经此轮询/首拉) */
  getConnectionState(): ConnectionState

  listConversations(input: PageQuery): Promise<Page<Conversation>>
  getConversation(input: GetConversationQuery): Promise<ConversationDetail>
  getConversationMessages(input: ConversationMessagesQuery): Promise<MessagePage>
  getMessageContext(input: MessageContextQuery): Promise<MessagePage>
  createConversation(input: CreateConversationInput): Promise<Conversation>
  activateConversation(conversationId: string): Promise<ActivateConversationResult>
  renameConversation(id: string, title: string): Promise<Conversation>
  deleteConversation(id: string): Promise<void>

  sendMessage(input: SendMessageInput): Promise<ClientRequestRef>
  cancelGeneration(input: CancelGenerationInput): Promise<void>

  listModelProfiles(type?: ModelServiceType): Promise<ModelProfile[]>
  testModelProfile(input: TestModelProfileCommand): Promise<ModelProfileTestResult>
  activateModelProfile(input: ActivateModelProfileCommand): Promise<void>

  queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage>

  startVoiceInput(input: StartVoiceInputInput): Promise<VoiceInputSession>
  stopVoiceInput(input: StopVoiceInputInput): Promise<void>
  startDictation(input: StartDictationInput): Promise<DictationSession>
  stopDictation(input: StopDictationInput): Promise<void>

  submitToolResult(input: ToolResult): Promise<void>

  /** 订阅后端公开领域事件;返回取消订阅函数 */
  subscribe(handler: BackendEventHandler): () => void
}
