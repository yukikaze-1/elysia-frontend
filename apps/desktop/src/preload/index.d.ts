import type {
  ActivateConversationResult,
  ActivateModelProfileCommand,
  ActiveModelSelection,
  AppInfo,
  AttachmentCheckResult,
  AttachmentsUploadResponse,
  AudioCancelInput,
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
  DictationStartInput,
  DictationStopInput,
  DiagnosticsDevEvent,
  DiagnosticsExportResult,
  DiagnosticsState,
  FileValidationResult,
  HistoryEntry,
  Live2DModelSummary,
  Message,
  MessageContextQuery,
  MessagePage,
  ModelProfile,
  ModelProfileTestCommand,
  ModelProfileTestResult,
  ModelServiceType,
  Page,
  PageQuery,
  PermissionGrant,
  PersistSessionInput,
  PersistSessionResult,
  RealtimeVoiceControlInput,
  RealtimeVoiceStartInput,
  RuntimeInfo,
  SendMessageInput,
  SessionPersistenceState,
  SetTtsVoiceCommand,
  SettingsPatch,
  SettingsState,
  TtsPreviewCommand,
  TtsPreviewOutcome,
  TtsVoiceListResult,
  UpsertModelProfileCommand,
  VoiceCommitInput,
  VoiceDiscardInput,
  VoiceRecordStartInput,
  VoiceRecordStopInput
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
      // —— 阶段 4 批次 B 语音面 ——
      voiceStartRecord(input: VoiceRecordStartInput): Promise<{ recordingId: string }>
      voiceStopRecord(input: VoiceRecordStopInput): Promise<void>
      voiceCommit(input: VoiceCommitInput): Promise<ClientRequestRef>
      voiceDiscard(input: VoiceDiscardInput): Promise<void>
      voiceStartRealtime(input: RealtimeVoiceStartInput): Promise<{ sessionId: string }>
      voiceStopRealtime(input: RealtimeVoiceControlInput): Promise<void>
      voiceCancelRealtime(input: RealtimeVoiceControlInput): Promise<void>
      voiceStartDictation(input: DictationStartInput): Promise<{ clientRequestId: string }>
      voiceStopDictation(input: DictationStopInput): Promise<void>
      voiceCancelDictation(input: DictationStopInput): Promise<void>
      audioCancel(input: AudioCancelInput): Promise<void>
      voiceSendAudio(bytes: Uint8Array): void
      // —— 阶段 4 批次 B 设置面 ——
      settingsLoad(): Promise<SettingsState>
      settingsSave(patch: SettingsPatch): Promise<SettingsState>
      // —— 阶段 5 批次 A Live2D 面 ——
      listLive2dModels(): Promise<Live2DModelSummary[]>
      // —— 阶段 6 批次 B 工具面（Task 6/7：preload 已实装；Renderer DesktopApiLike 消费面镜像）——
      onToolEvent(handler: (event: import('@shared/contracts/tool').PublicToolEvent) => void): () => void
      toolDecide(input: { callId: string; decision: 'allow_once' | 'deny' }): Promise<void>
      toolCancel(callId: string): Promise<void>
      toolList(): Promise<import('@shared/contracts/tool').PublicToolEvent[]>
      toolPickSource(callId: string, sourceId: string): Promise<void>
      toolConfirmUpload(callId: string): Promise<void>
      // —— 阶段 6 批次 C 目录授权/审批历史面（Task 6，D6C-12）——
      toolGrantDirectory(input: { callId: string; ttlMs: number }): Promise<{ executed: boolean }>
      toolListGrants(): Promise<PermissionGrant[]>
      toolRevokeGrant(id: string): Promise<void>
      toolListHistory(limit?: number): Promise<HistoryEntry[]>
      // —— 阶段 7 批次 A（Task 5，契约 R2-1 定名：diagnosticsExport——export 为 JS 保留字不可作方法名）——
      diagnosticsState(): Promise<DiagnosticsState>
      diagnosticsDevModeSet(enabled: boolean): Promise<void>
      diagnosticsOpenLogDir(): Promise<void>
      diagnosticsClearLogs(): Promise<void>
      diagnosticsExport(): Promise<DiagnosticsExportResult>
      onDiagnosticsDevEvent(handler: (ev: DiagnosticsDevEvent) => void): () => void
    }
  }
}

export {}
