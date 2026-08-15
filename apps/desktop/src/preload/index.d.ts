import type {
  ActivateConversationResult,
  ActivateModelProfileCommand,
  ActiveModelSelection,
  AppInfo,
  AttachmentCheckResult,
  AttachmentsUploadResponse,
  BackendEvent,
  BackendSession,
  CacheMessagesInput,
  CancelGenerationInput,
  ChatHistoryPage,
  ChatHistoryQuery,
  ClientRequestRef,
  ConnectionState,
  Conversation,
  ConversationMessagesQuery,
  CreateConversationInput,
  CredentialStatus,
  FileValidationResult,
  Message,
  MessageContextQuery,
  MessagePage,
  ModelProfile,
  ModelProfileTestCommand,
  ModelProfileTestResult,
  ModelServiceType,
  Page,
  PageQuery,
  PersistSessionInput,
  PersistSessionResult,
  RuntimeInfo,
  SendMessageInput,
  SessionPersistenceState,
  SetTtsVoiceCommand,
  TtsPreviewCommand,
  TtsPreviewOutcome,
  TtsVoiceListResult,
  UpsertModelProfileCommand
} from '@shared/contracts'
import type { StickerManifest } from '@shared/contracts/sticker'

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
      // —— 阶段 3 G4 历史查看器/表情面 ——
      queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage>
      getMessageContext(input: MessageContextQuery): Promise<MessagePage>
      listStickers(): Promise<StickerManifest>
      onChatEvent(handler: (event: BackendEvent) => void): () => void
      onChatState(handler: (state: ConnectionState) => void): () => void
      onChatReplay(handler: (payload: { conversationId: string; messages: Message[] }) => void): () => void
      onChatError(handler: (err: import('./desktop-api').PublicErrorShape) => void): () => void
      // —— 阶段 3 G2 持久化面（类型先行，运行时装配在 preload/desktop-api.ts）——
      hydratePersistence(): Promise<SessionPersistenceState>
      persistSession(input: PersistSessionInput): Promise<PersistSessionResult>
      cacheMessages(input: CacheMessagesInput): Promise<void>
      openExternal(url: string): Promise<void>
      // —— 阶段 3 G3 attachments 面 ——
      attachmentsValidate(input: { files: Array<import('./desktop-api').AttachmentInputFile> }): Promise<FileValidationResult[]>
      attachmentsUpload(input: { uploadId: string; files: Array<import('./desktop-api').AttachmentInputFile> }): Promise<AttachmentsUploadResponse>
      attachmentsCancel(uploadId: string): Promise<void>
      attachmentsCheck(attachmentId: string): Promise<AttachmentCheckResult>
      // —— 阶段 4 批次 A 模型服务/TTS 面 ——
      listModelProfiles(input?: { type?: ModelServiceType }): Promise<ModelProfile[]>
      saveModelProfile(input: UpsertModelProfileCommand): Promise<ModelProfile>
      deleteModelProfile(service: ModelServiceType, name: string): Promise<void>
      testModelProfile(input: ModelProfileTestCommand): Promise<ModelProfileTestResult>
      activateModelProfile(input: ActivateModelProfileCommand): Promise<void>
      getActiveModelSelection(): Promise<ActiveModelSelection>
      listTtsVoices(): Promise<TtsVoiceListResult>
      previewTts(input: TtsPreviewCommand): Promise<TtsPreviewOutcome>
      setTtsVoice(input: SetTtsVoiceCommand): Promise<void>
    }
  }
}

export {}
