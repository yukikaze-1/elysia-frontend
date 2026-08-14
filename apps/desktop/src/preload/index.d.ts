import type {
  ActivateConversationResult,
  AppInfo,
  BackendEvent,
  BackendSession,
  CacheMessagesInput,
  CancelGenerationInput,
  ClientRequestRef,
  ConnectionState,
  Conversation,
  ConversationMessagesQuery,
  CreateConversationInput,
  CredentialStatus,
  Message,
  MessagePage,
  Page,
  PageQuery,
  PersistSessionInput,
  PersistSessionResult,
  RuntimeInfo,
  SendMessageInput,
  SessionPersistenceState
} from '@shared/contracts'

declare global {
  interface Window {
    desktopApi: {
      getAppInfo(): Promise<AppInfo>
      getCredentialStatus(): Promise<CredentialStatus>
      setBackendToken(token: string): Promise<CredentialStatus>
      clearBackendToken(): Promise<CredentialStatus>
      // —— 连接装配 ——
      setEndpoint(url: string): Promise<{ endpoint: string }>
      getEndpoint(): Promise<{ endpoint?: string }>
      getRuntimeInfo(): Promise<RuntimeInfo>
      // —— chat 面 ——
      connect(): Promise<BackendSession>
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
      onChatError(handler: (err: import('./desktop-api').PublicErrorShape) => void): () => void
      // —— 阶段 3 G2 持久化面（类型先行，运行时装配在 preload/desktop-api.ts）——
      hydratePersistence(): Promise<SessionPersistenceState>
      persistSession(input: PersistSessionInput): Promise<PersistSessionResult>
      cacheMessages(input: CacheMessagesInput): Promise<void>
      openExternal(url: string): Promise<void>
    }
  }
}

export {}
