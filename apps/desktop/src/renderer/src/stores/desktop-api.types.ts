// src/renderer/src/stores/desktop-api.types.ts
// Renderer store 消费的 desktopApi 窄接口(与 preload DesktopApi chat 面结构一致)。
// 纯类型文件,无运行时逻辑。
import type {
  ActivateConversationResult,
  BackendEvent,
  BackendSession,
  CancelGenerationInput,
  ClientRequestRef,
  ConnectionState,
  Conversation,
  ConversationMessagesQuery,
  CreateConversationInput,
  Message,
  MessagePage,
  Page,
  PageQuery,
  SendMessageInput
} from '@shared/contracts'

export interface DesktopApiLike {
  connect(serverUrl: string): Promise<BackendSession>
  disconnect(): Promise<void>
  listConversations(input: PageQuery): Promise<Page<Conversation>>
  getMessages(input: ConversationMessagesQuery): Promise<MessagePage>
  send(input: SendMessageInput): Promise<ClientRequestRef>
  cancel(input: CancelGenerationInput): Promise<void>
  activate(id: string): Promise<ActivateConversationResult>
  createConversation(input: CreateConversationInput): Promise<Conversation>
  renameConversation(input: { conversationId: string; title: string }): Promise<Conversation>
  deleteConversation(id: string): Promise<void>
  getConnectionState(): Promise<ConnectionState>
  onChatEvent(handler: (event: BackendEvent) => void): () => void
  onChatState(handler: (state: ConnectionState) => void): () => void
  onChatReplay(handler: (payload: { conversationId: string; messages: Message[] }) => void): () => void
}
