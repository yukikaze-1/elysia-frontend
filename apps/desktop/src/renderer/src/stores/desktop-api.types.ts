// src/renderer/src/stores/desktop-api.types.ts
// Renderer store 消费的 desktopApi 窄接口(与 preload DesktopApi chat 面结构一致)。
// 纯类型文件,无运行时逻辑。
import type { PublicError } from '../utils/public-error'
import type {
  ActivateConversationResult,
  ActivateModelProfileCommand,
  ActiveModelSelection,
  AttachmentCheckResult,
  AttachmentsUploadResponse,
  AudioCancelInput,
  BackendEvent,
  BackendSession,
  CharacterDetail,
  CharacterArchiveResult,
  CharacterDraft,
  CharacterDraftSummary,
  CharacterListQuery,
  CharacterPublicState,
  ResetCharacterEvolutionCommand,
  ResetCharacterEvolutionResult,
  CharacterRevisionQuery,
  CharacterRevisionSummary,
  CharacterSummary,
  CharacterMutationResult,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterValidationResult,
  PersistedCharacterDraft,
  CloneCharacterCommand,
  CreateCharacterCommand,
  RollbackCharacterCommand,
  UpdateCharacterCommand,
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
  RendererCrashEvent,
  RuntimeInfo,
  SendMessageInput,
  SessionPersistenceState,
  SetTtsVoiceCommand,
  SettingsPatch,
  SettingsState,
  TtsPreviewCommand,
  TtsPreviewOutcome,
  TtsVoiceListResult,
  UpdateUserIdentityCommand,
  UserIdentityProfile,
  UpsertModelProfileCommand,
  VoiceCommitInput,
  VoiceDiscardInput,
  VoiceRecordStartInput,
  VoiceRecordStopInput
} from '@shared/contracts'
import type { PublicToolEvent } from '@shared/contracts/tool'
import type { StickerManifest } from '@shared/contracts/sticker'

/** Renderer 面附件输入文件（含 file?: File / bytes?: ArrayBuffer；真实路径由 Preload webUtils 注入，不在此面） */
export interface DesktopAttachmentInputFile { localId: string; name: string; size: number; mediaType: string; source: 'picker' | 'drag_drop' | 'paste'; kind?: 'image' | 'video' | 'audio' | 'file' | 'link'; file?: File; bytes?: ArrayBuffer }

export interface DesktopApiLike {
  // —— 凭据/连接装配 ——
  getCredentialStatus(): Promise<CredentialStatus>
  setBackendToken(token: string): Promise<CredentialStatus>
  clearBackendToken(): Promise<CredentialStatus>
  setEndpoint(url: string): Promise<{ endpoint: string }>
  getEndpoint(): Promise<{ endpoint?: string }>
  getRuntimeInfo(): Promise<RuntimeInfo>
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
  // —— 多角色角色面 ——
  getMe?(): Promise<UserIdentityProfile>
  updateMe?(input: UpdateUserIdentityCommand): Promise<UserIdentityProfile>
  listCharacters?(input?: CharacterListQuery): Promise<Page<CharacterSummary>>
  getCharacter?(characterId: string): Promise<CharacterDetail>
  listCharacterRevisions?(input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>>
  getCharacterState?(characterInstanceId: string): Promise<CharacterPublicState>
  resetCharacterEvolution?(input: ResetCharacterEvolutionCommand): Promise<ResetCharacterEvolutionResult>
  createCharacter?(input: CreateCharacterCommand): Promise<CharacterDetail>
  updateCharacter?(input: UpdateCharacterCommand): Promise<CharacterMutationResult>
  cloneCharacter?(input: CloneCharacterCommand): Promise<CharacterDetail>
  archiveCharacter?(characterId: string): Promise<CharacterArchiveResult>
  rollbackCharacter?(input: RollbackCharacterCommand): Promise<CharacterMutationResult>
  validateCharacter?(draft: CharacterDraft): Promise<CharacterValidationResult>
  previewCharacter?(input: CharacterPreviewCommand): Promise<CharacterPreviewResult>
  // —— FE-D2：未提交角色编辑草稿（Main app-cache；list 仅摘要）——
  listCharacterDrafts?(): Promise<CharacterDraftSummary[]>
  getCharacterDraft?(key: string): Promise<PersistedCharacterDraft | undefined>
  saveCharacterDraft?(input: PersistedCharacterDraft): Promise<void>
  deleteCharacterDraft?(key: string): Promise<void>
  // —— 阶段 3 G4 历史查看器/表情面 ——
  queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage>
  getMessageContext(input: MessageContextQuery): Promise<MessagePage>
  listStickers(): Promise<StickerManifest>
  onChatEvent(handler: (event: BackendEvent) => void): () => void
  onChatState(handler: (state: ConnectionState) => void): () => void
  onChatReplay(handler: (payload: { conversationId: string; messages: Message[] }) => void): () => void
  onChatError(handler: (err: PublicError) => void): () => void // P0-01:bootstrap 需消费 Main 错误推送
  // —— 阶段 3 G2 持久化面 ——
  hydratePersistence(): Promise<SessionPersistenceState>
  persistSession(input: PersistSessionInput): Promise<PersistSessionResult>
  cacheMessages(input: CacheMessagesInput): Promise<void>
  openExternal(url: string): Promise<void>
  // —— 阶段 3 G3 attachments 面 ——
  attachmentsValidate(input: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]>
  attachmentsUpload(input: { uploadId: string; files: DesktopAttachmentInputFile[] }): Promise<AttachmentsUploadResponse>
  attachmentsCancel(uploadId: string): Promise<void>
  attachmentsCheck(attachmentId: string): Promise<AttachmentCheckResult>
  // —— 阶段 4 批次 A 模型服务/TTS 面（apiKey 仅存在于请求侧，出参永不含凭据）——
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
  // —— 阶段 6 批次 B 工具面（Task 7，L3 修正）：tool:event 订阅 + 四 invoke 通道（Task 6 已实装 preload）——
  onToolEvent(handler: (event: PublicToolEvent) => void): () => void
  toolDecide(input: { callId: string; decision: 'allow_once' | 'deny' }): Promise<void>
  toolCancel(callId: string): Promise<void>
  toolList(): Promise<PublicToolEvent[]>
  toolPickSource(callId: string, sourceId: string): Promise<void>
  toolConfirmUpload(callId: string): Promise<void>
  // —— 阶段 6 批次 C 目录授权/审批历史面（Task 6，D6C-12；Renderer 消费为 Task 7）——
  toolGrantDirectory(input: { callId: string; ttlMs: number }): Promise<{ executed: boolean }>
  toolListGrants(): Promise<PermissionGrant[]>
  toolRevokeGrant(id: string): Promise<void>
  toolListHistory(limit?: number): Promise<HistoryEntry[]>
  // —— 阶段 7 批次 A（Task 5）：诊断面（preload 已实装；Renderer 消费为 Task 6 设置页「开发与诊断」子页）——
  diagnosticsState(): Promise<DiagnosticsState>
  diagnosticsDevModeSet(enabled: boolean): Promise<void>
  diagnosticsOpenLogDir(): Promise<void>
  diagnosticsClearLogs(): Promise<void>
  diagnosticsExport(): Promise<DiagnosticsExportResult>
  onDiagnosticsDevEvent(handler: (ev: DiagnosticsDevEvent) => void): () => void
  // —— 阶段 7 批次 B（Task 1，H1 修正）：Renderer 崩溃 marker（banner 组件 api.getLastCrash() 消费——DesktopApiLike 手写窄接口必须含它）——
  getLastCrash(): Promise<RendererCrashEvent | null>
}

// —— 编译期镜像校验（2026-09-10 门禁整改）——
//
// 本接口是 preload 暴露面的**手写镜像**，历史上与实现之间没有任何编译器关联。实测代价：
// `e9d2897` 给 preload 加了 `resetCharacterEvolution` 后，本文件与 `ipc-security.spec.ts` 的键表
// 都没跟上——后者是「暴露面不得未经 review 增长」的唯一哨兵，因此长期全红、保护意义归零，
// 直到 2026-09-10 才被发现（见 docs/review/2026-09-10-前端门禁体系评估与整改记录.md §4.1）。
//
// 现把镜像钉在 `window.desktopApi` 的声明上；而该声明（src/preload/index.d.ts）已改为直接引用
// 实现派生类型 `typeof desktopApi`。于是形成编译期链条：
//     实现 desktop-api.ts  →  Window['desktopApi']  →  本镜像
// 增删方法或改签名会在**任一处**直接报错。
//
// 方向说明（实测校准，不是想当然）：本镜像**有意**把「角色/档案面」18 个方法声明为可选
// （`getMe?`、`listCharacters?` … `deleteCharacterDraft?`），因为该 IPC 面按「是否装配角色服务」
// 在运行时判定——`character-catalog.store.ts` 的 `missingApiError()` 就依赖它
// （`'[CHARACTER_PROFILES_UNAVAILABLE] 角色目录 API 尚未装配'`）。因此断言不能直接比较可选性，
// 而是**先剥掉可选修饰**，再要求与实现同名成员的签名兼容：
//   - 镜像凭空多出实现没有的方法 → `Pick<…, keyof DesktopApiLike>` 里没有该键 → 报错；
//   - 某个方法的参数/返回类型写错 → 签名不兼容 → 报错；
//   - 有意保留的可选性不触发报错（那是运行时能力探测的合法表达）。
type AssertAssignable<A extends B, B> = A extends B ? true : never
type StripOptional<T> = { [K in keyof T]-?: NonNullable<T[K]> }

/** 若本类型报错，说明 DesktopApiLike 的方法集或签名与 preload 暴露面不一致——改镜像前先对照实现 */
export type DesktopApiLikeInSync = AssertAssignable<
  StripOptional<DesktopApiLike>,
  Pick<Window['desktopApi'], keyof DesktopApiLike>
>
