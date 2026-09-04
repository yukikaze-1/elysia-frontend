// apps/desktop/src/preload/desktop-api.ts
import { ipcRenderer, webUtils } from 'electron'
import { BACKEND_TOKEN_KEY, IpcChannels, PushChannels, type CredentialStatus, type IpcChannelName, type IpcResult } from '@shared/contracts'
import type { AppInfo } from '@shared/contracts'
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
  CharacterRevisionQuery,
  CharacterRevisionSummary,
  CharacterSummary,
  CharacterMutationResult,
  PersistedCharacterDraft,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterValidationResult,
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
  PublicToolEvent,
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
import type { StickerManifest } from '@shared/contracts/sticker'
import { parseBackendEvent } from '@shared/schemas'
import { z } from 'zod'
import {
  ActivateConversationResultSchema,
  ActiveModelSelectionSchema,
  AttachmentCheckResultSchema,
  AttachmentsUploadResponseSchema,
  BackendSessionSchema,
  CharacterGetMeRequestSchema,
  CharacterGetMeResponseSchema,
  CharacterUpdateMeRequestSchema,
  CharacterUpdateMeResponseSchema,
  CharacterGetRequestSchema,
  CharacterGetResponseSchema,
  CharacterListRequestSchema,
  CharacterListResponseSchema,
  CharacterListRevisionsRequestSchema,
  CharacterListRevisionsResponseSchema,
  CharacterStateRequestSchema,
  CharacterStateResponseSchema,
  CharacterCreateRequestSchema, CharacterCreateResponseSchema,
  CharacterUpdateRequestSchema, CharacterUpdateResponseSchema,
  CharacterCloneRequestSchema, CharacterCloneResponseSchema,
  CharacterArchiveRequestSchema, CharacterArchiveResponseSchema,
  CharacterRollbackRequestSchema, CharacterRollbackResponseSchema,
  CharacterValidateRequestSchema, CharacterValidateResponseSchema,
  CharacterPreviewRequestSchema, CharacterPreviewResponseSchema,
  CharacterDraftListRequestSchema, CharacterDraftListResponseSchema,
  CharacterDraftGetRequestSchema, CharacterDraftGetResponseSchema,
  CharacterDraftSaveRequestSchema, CharacterDraftSaveResponseSchema,
  CharacterDraftDeleteRequestSchema, CharacterDraftDeleteResponseSchema,
  ChatHistoryPageSchema,
  ClientRequestRefSchema,
  ConnectionStateSchema,
  ConversationSchema,
  DiagnosticsDevEventSchema,
  DiagnosticsExportResultSchema,
  DiagnosticsStateSchema,
  EndpointResponseSchema,
  FileValidationResultSchema,
  GrantDirectoryResponseSchema,
  GrantListResponseSchema,
  HistoryResponseSchema,
  Live2DModelSummarySchema,
  MessagePageSchema,
  MessageSchema,
  ModelProfileSchema,
  ModelProfileTestResultSchema,
  ModelProfilesSchema,
  PageSchema,
  PersistSessionResultSchema,
  PublicToolEventSchema,
  RendererCrashEventSchema,
  RuntimeInfoSchema,
  SessionPersistenceStateSchema,
  SettingsStateSchema,
  StickerManifestSchema,
  ToolListResponseSchema,
  TtsPreviewOutcomeSchema,
  TtsVoiceListResultSchema
} from '@shared/schemas'

async function invoke<T>(channel: IpcChannelName): Promise<IpcResult<T>> {
  try {
    return (await ipcRenderer.invoke(channel)) as IpcResult<T>
  } catch {
    throw new Error('[IPC_ERROR] IPC 调用失败')
  }
}

async function invokeWithArgs<T>(channel: IpcChannelName, payload?: unknown): Promise<IpcResult<T>> {
  try {
    return (await (payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload))) as IpcResult<T>
  } catch { throw new Error('[IPC_ERROR] IPC 调用失败') }
}

/**
 * 跨 contextBridge 错误 message 前缀：结构化字段并入 message（Electron contextBridge 只可靠保留 message，
 * own property / instanceof 不保真）。Renderer 用 parsePublicError 反解。
 * 格式：`[code] [backendCode=XX] [retryable=true] [retryAfterMs=1000] ... message`
 */
function formatIpcError(error: import('@shared/contracts').IpcErrorBody): Error {
  const parts = [error.code]
  if (error.backendCode) parts.push(`backendCode=${error.backendCode}`)
  if (typeof error.retryable === 'boolean') parts.push(`retryable=${error.retryable}`)
  if (error.requestId) parts.push(`requestId=${error.requestId}`)
  if (error.clientRequestId) parts.push(`clientRequestId=${error.clientRequestId}`)
  if (typeof error.retryAfterMs === 'number') parts.push(`retryAfterMs=${error.retryAfterMs}`)
  if (typeof error.idempotencyDurable === 'boolean') parts.push(`idempotencyDurable=${error.idempotencyDurable}`)
  if (typeof error.currentRevision === 'number') parts.push(`currentRevision=${error.currentRevision}`)
  if (error.issues?.length) {
    // 结构化错误来自 Main，但仍需防 malformed surrogate / 非可序列化替身
    // 让 contextBridge 错误格式化本身抛错；超出预算时安全省略 issues。
    try {
      const serialized = JSON.stringify(error.issues)
      const encoded = encodeURIComponent(serialized)
      if (encoded.length <= 32_768) parts.push(`issues=${encoded}`)
    } catch { /* fail closed: 主错误仍可展示，但不把 issues 拼入 message。 */ }
  }
  return new Error(`[${parts.join('] [')}] ${error.message}`)
}

function isAppInfo(v: unknown): v is AppInfo {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as AppInfo).name === 'string' && typeof (v as AppInfo).version === 'string' &&
    typeof (v as AppInfo).platform === 'string'
}

async function getAppInfo(): Promise<AppInfo> {
  const res = await invoke<AppInfo>(IpcChannels.appGetInfo)
  // 完整信封守卫：res 必须先判为对象（非信封值不崩 res.ok）；ok:true 且 data 为 AppInfo；ok:false 带 error{code,message}
  if (res && typeof res === 'object' && res.ok === true && res.data !== undefined && res.data !== null && isAppInfo(res.data)) return res.data
  if (res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
    throw formatIpcError(res.error)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

const STATUS_ENUM = ['unavailable', 'locked', 'empty', 'available'] as const
function isCredentialStatus(v: unknown): v is CredentialStatus {
  return typeof v === 'string' && (STATUS_ENUM as readonly string[]).includes(v)
}

interface CredentialStatusResponse { status: CredentialStatus; key: string }

function unwrapStatus(res: IpcResult<CredentialStatusResponse>): CredentialStatus {
  if (res && typeof res === 'object' && res.ok === true &&
      res.data && typeof res.data === 'object' && isCredentialStatus(res.data.status)) return res.data.status
  if (res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
    throw formatIpcError(res.error)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

// —— chat 面：通用信封解包 + 方法 + 推送订阅 ——

/** 信封解包 + 防御性 data 校验：ok:true → schema.safeParse(data)，失败抛 SCHEMA_VALIDATION_FAILED；
 *  ok:false → throw `[code] message`；畸形信封（ok:true 缺 data / ok:false 缺 error）→ throw。
 *  data 形状由各方法传入的 responseSchema 绑定（镜像 spec §4.1.2 表格；void 命令 z.undefined()）。 */
function unwrap<T>(res: IpcResult<T>, schema: z.ZodType<T>): T {
  if (res && typeof res === 'object' && res.ok === true) {
    if (!('data' in res)) throw new Error('[IPC_ERROR] IPC 返回格式异常')
    const parsed = schema.safeParse(res.data)
    if (!parsed.success) throw new Error('[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败')
    return parsed.data
  }
  if (res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
    throw formatIpcError(res.error)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

/** FE-B 角色请求也在 Preload 侧先 strict 解析，避免把未声明字段送入 Main。 */
function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error('[SCHEMA_VALIDATION_FAILED] IPC 请求校验失败')
  return parsed.data
}

/** ConnectionState 纯守卫：ConnectionStateSchema 全字段校验（status 必填 + optional 字段类型），非法返回 false */
function isConnectionState(v: unknown): v is ConnectionState {
  return ConnectionStateSchema.safeParse(v).success
}

/** 会话回放推送载荷：{conversationId, messages}（RealBackend onSessionReplay 桥接） */
interface ReplayPayload {
  conversationId: string
  messages: Message[]
}

function isReplayPayload(v: unknown): v is ReplayPayload {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as ReplayPayload).conversationId === 'string' &&
    Array.isArray((v as ReplayPayload).messages)
}

/** 会话回放逐条过滤（E2：不整批拒绝）：MessageSchema.safeParse 逐条校验，非法条目丢弃 + warn，
 *  合法条目保留；返回仅含合法 Message 的回放载荷（conversationId 原样保留）。 */
function filterReplayMessages(payload: ReplayPayload): ReplayPayload {
  const messages: Message[] = []
  payload.messages.forEach((msg, index) => {
    const parsed = MessageSchema.safeParse(msg)
    if (parsed.success) messages.push(parsed.data)
    else console.warn('cyrene:replay:drop-invalid-message', { conversationId: payload.conversationId, index })
  })
  return { conversationId: payload.conversationId, messages }
}

/** connect 无参：endpoint/token 由 Main 侧 connection-config 持有，renderer 不再传任意 URL */
async function connect(): Promise<BackendSession> {
  return unwrap(await invoke<BackendSession>(IpcChannels.chatConnect), BackendSessionSchema)
}
async function setEndpoint(url: string): Promise<{ endpoint: string }> {
  return unwrap(await invokeWithArgs<{ endpoint: string }>(IpcChannels.chatSetEndpoint, { serverUrl: url }), z.object({ endpoint: z.string() }))
}
async function getEndpoint(): Promise<{ endpoint?: string }> {
  return unwrap(await invoke<{ endpoint?: string }>(IpcChannels.chatGetEndpoint), EndpointResponseSchema)
}
async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return unwrap(await invoke<RuntimeInfo>(IpcChannels.chatGetRuntimeInfo), RuntimeInfoSchema)
}
async function disconnect(): Promise<void> {
  unwrap(await invoke<void>(IpcChannels.chatDisconnect), z.undefined())
}
async function listConversations(input: PageQuery): Promise<Page<Conversation>> {
  return unwrap(await invokeWithArgs<Page<Conversation>>(IpcChannels.chatListConversations, input), PageSchema(ConversationSchema))
}
async function getMessages(input: ConversationMessagesQuery): Promise<MessagePage> {
  return unwrap(await invokeWithArgs<MessagePage>(IpcChannels.chatGetMessages, input), MessagePageSchema)
}
async function send(input: SendMessageInput): Promise<ClientRequestRef> {
  return unwrap(await invokeWithArgs<ClientRequestRef>(IpcChannels.chatSend, input), ClientRequestRefSchema)
}
async function cancel(input: CancelGenerationInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.chatCancel, input), z.undefined())
}
async function activate(id: string): Promise<ActivateConversationResult> {
  return unwrap(await invokeWithArgs<ActivateConversationResult>(IpcChannels.chatActivate, { conversationId: id }), ActivateConversationResultSchema)
}
async function createConversation(input: CreateConversationInput): Promise<Conversation> {
  return unwrap(await invokeWithArgs<Conversation>(IpcChannels.chatCreate, input), ConversationSchema)
}
async function renameConversation(input: { conversationId: string; title: string }): Promise<Conversation> {
  return unwrap(await invokeWithArgs<Conversation>(IpcChannels.chatRename, input), ConversationSchema)
}
async function deleteConversation(id: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.chatDelete, { conversationId: id }), z.undefined())
}
async function getConnectionState(): Promise<ConnectionState> {
  return unwrap(await invoke<ConnectionState>(IpcChannels.chatGetState), ConnectionStateSchema)
}

// —— 多角色角色域（具名 IPC；请求/响应两端共用 strict schema）——
async function getMe(): Promise<UserIdentityProfile> {
  // 以 schema 解析无参请求，保证此面不会意外扩展为任意 payload。
  parseRequest(CharacterGetMeRequestSchema, undefined)
  return unwrap(await invoke<UserIdentityProfile>(IpcChannels.profileGetMe), CharacterGetMeResponseSchema)
}
async function updateMe(input: UpdateUserIdentityCommand): Promise<UserIdentityProfile> {
  const request = parseRequest(CharacterUpdateMeRequestSchema, input)
  return unwrap(await invokeWithArgs<UserIdentityProfile>(IpcChannels.profileUpdateMe, request), CharacterUpdateMeResponseSchema)
}
async function listCharacters(input: CharacterListQuery = {}): Promise<Page<CharacterSummary>> {
  const request = parseRequest(CharacterListRequestSchema, input)
  return unwrap(await invokeWithArgs<Page<CharacterSummary>>(IpcChannels.charactersList, request), CharacterListResponseSchema)
}
async function getCharacter(characterId: string): Promise<CharacterDetail> {
  const request = parseRequest(CharacterGetRequestSchema, { characterId })
  return unwrap(await invokeWithArgs<CharacterDetail>(IpcChannels.charactersGet, request), CharacterGetResponseSchema)
}
async function listCharacterRevisions(input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>> {
  const request = parseRequest(CharacterListRevisionsRequestSchema, input)
  return unwrap(await invokeWithArgs<Page<CharacterRevisionSummary>>(IpcChannels.charactersListRevisions, request), CharacterListRevisionsResponseSchema)
}
async function getCharacterState(characterInstanceId: string): Promise<CharacterPublicState> {
  const request = parseRequest(CharacterStateRequestSchema, { characterInstanceId })
  return unwrap(await invokeWithArgs<CharacterPublicState>(IpcChannels.characterInstancesGetState, request), CharacterStateResponseSchema)
}
async function createCharacter(input: CreateCharacterCommand): Promise<CharacterDetail> {
  const request = parseRequest(CharacterCreateRequestSchema, input)
  return unwrap(await invokeWithArgs<CharacterDetail>(IpcChannels.charactersCreate, request), CharacterCreateResponseSchema)
}
async function updateCharacter(input: UpdateCharacterCommand): Promise<CharacterMutationResult> {
  const request = parseRequest(CharacterUpdateRequestSchema, input)
  return unwrap(await invokeWithArgs<CharacterMutationResult>(IpcChannels.charactersUpdate, request), CharacterUpdateResponseSchema)
}
async function cloneCharacter(input: CloneCharacterCommand): Promise<CharacterDetail> {
  const request = parseRequest(CharacterCloneRequestSchema, input)
  return unwrap(await invokeWithArgs<CharacterDetail>(IpcChannels.charactersClone, request), CharacterCloneResponseSchema)
}
async function archiveCharacter(characterId: string): Promise<CharacterArchiveResult> {
  const request = parseRequest(CharacterArchiveRequestSchema, { characterId })
  return unwrap(await invokeWithArgs<CharacterArchiveResult>(IpcChannels.charactersArchive, request), CharacterArchiveResponseSchema)
}
async function rollbackCharacter(input: RollbackCharacterCommand): Promise<CharacterMutationResult> {
  const request = parseRequest(CharacterRollbackRequestSchema, input)
  return unwrap(await invokeWithArgs<CharacterMutationResult>(IpcChannels.charactersRollback, request), CharacterRollbackResponseSchema)
}
async function validateCharacter(draft: CharacterDraft): Promise<CharacterValidationResult> {
  const request = parseRequest(CharacterValidateRequestSchema, draft)
  return unwrap(await invokeWithArgs<CharacterValidationResult>(IpcChannels.charactersValidate, request), CharacterValidateResponseSchema)
}
async function previewCharacter(input: CharacterPreviewCommand): Promise<CharacterPreviewResult> {
  const request = parseRequest(CharacterPreviewRequestSchema, input)
  return unwrap(await invokeWithArgs<CharacterPreviewResult>(IpcChannels.charactersPreview, request), CharacterPreviewResponseSchema)
}

// —— FE-D2 未提交角色草稿：list 仅摘要，get 才返回完整 authored draft ——
async function listCharacterDrafts(): Promise<CharacterDraftSummary[]> {
  parseRequest(CharacterDraftListRequestSchema, undefined)
  return unwrap(await invoke<CharacterDraftSummary[]>(IpcChannels.characterDraftsList), CharacterDraftListResponseSchema)
}
async function getCharacterDraft(key: string): Promise<PersistedCharacterDraft | undefined> {
  const request = parseRequest(CharacterDraftGetRequestSchema, { key })
  return unwrap(await invokeWithArgs<PersistedCharacterDraft | undefined>(IpcChannels.characterDraftsGet, request), CharacterDraftGetResponseSchema)
}
async function saveCharacterDraft(input: PersistedCharacterDraft): Promise<void> {
  const request = parseRequest(CharacterDraftSaveRequestSchema, input)
  unwrap(await invokeWithArgs<void>(IpcChannels.characterDraftsSave, request), CharacterDraftSaveResponseSchema)
}
async function deleteCharacterDraft(key: string): Promise<void> {
  const request = parseRequest(CharacterDraftDeleteRequestSchema, { key })
  unwrap(await invokeWithArgs<void>(IpcChannels.characterDraftsDelete, request), CharacterDraftDeleteResponseSchema)
}

// —— 阶段 3 G4 历史查看器/表情面：三通道信封解包（spec §4.3）——
async function queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage> {
  return unwrap(await invokeWithArgs<ChatHistoryPage>(IpcChannels.chatQueryHistory, input), ChatHistoryPageSchema)
}
async function getMessageContext(input: MessageContextQuery): Promise<MessagePage> {
  return unwrap(await invokeWithArgs<MessagePage>(IpcChannels.chatGetMessageContext, input), MessagePageSchema)
}
async function listStickers(): Promise<StickerManifest> {
  return unwrap(await invoke<StickerManifest>(IpcChannels.chatListStickers), StickerManifestSchema)
}

// —— 阶段 3 G2 持久化面：四通道信封解包（spec §4.2）——
async function hydratePersistence(): Promise<SessionPersistenceState> {
  return unwrap(await invoke<SessionPersistenceState>(IpcChannels.chatHydratePersistence), SessionPersistenceStateSchema)
}
async function persistSession(input: PersistSessionInput): Promise<PersistSessionResult> {
  return unwrap(await invokeWithArgs<PersistSessionResult>(IpcChannels.chatPersistSession, input), PersistSessionResultSchema)
}
async function cacheMessages(input: CacheMessagesInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.chatCacheMessages, input), z.undefined())
}
async function openExternal(url: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.appOpenExternal, { url }), z.undefined())
}

// —— 阶段 3 G3 attachments 面（spec §4.2，D5：path 仅 Preload 注入，不入返回面）——
export interface AttachmentInputFile { localId: string; name: string; size: number; mediaType: string; source: 'picker' | 'drag_drop' | 'paste'; kind?: 'image' | 'video' | 'audio' | 'file' | 'link'; file?: File; bytes?: ArrayBuffer }

function toIpcDescriptor(f: AttachmentInputFile): Omit<import('@shared/contracts').UploadFileDescriptor, 'path' | 'bytes'> & { path?: string; bytes?: Uint8Array } {
  const out: Record<string, unknown> = { localId: f.localId, name: f.name, size: f.size, mediaType: f.mediaType, source: f.source }
  if (f.kind) out.kind = f.kind
  // P2-7：优先 path（真实文件）；仅 path 为空才填 bytes——保证 path/bytes 二选一（zod refine 不整条拒）。
  // 旧两个独立 if：粘贴项同时带真实 path（getPathForFile 命中）与 bytes 时二者都填 → refine 判 SCHEMA_VALIDATION_FAILED 整批拒。
  // JS 构造 File（粘贴项）getPathForFile 返 '' → 视为 pathless，bytes 保留（P1-2 语义不变）。
  if (f.file) {
    const p = webUtils.getPathForFile(f.file)
    if (p) out.path = p
    else if (f.bytes) out.bytes = new Uint8Array(f.bytes)
  } else if (f.bytes) {
    out.bytes = new Uint8Array(f.bytes)
  }
  return out as ReturnType<typeof toIpcDescriptor>
}

async function attachmentsValidate(input: { files: AttachmentInputFile[] }): Promise<FileValidationResult[]> {
  return unwrap(await invokeWithArgs<FileValidationResult[]>(IpcChannels.attachmentsValidate, { files: input.files.map(toIpcDescriptor) }), z.array(FileValidationResultSchema))
}
async function attachmentsUpload(input: { uploadId: string; files: AttachmentInputFile[] }): Promise<AttachmentsUploadResponse> {
  return unwrap(await invokeWithArgs<AttachmentsUploadResponse>(IpcChannels.attachmentsUpload, { uploadId: input.uploadId, files: input.files.map(toIpcDescriptor) }), AttachmentsUploadResponseSchema)
}
async function attachmentsCancel(uploadId: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.attachmentsCancel, { uploadId }), z.undefined())
}
async function attachmentsCheck(attachmentId: string): Promise<AttachmentCheckResult> {
  return unwrap(await invokeWithArgs<AttachmentCheckResult>(IpcChannels.attachmentsCheck, { attachmentId }), AttachmentCheckResultSchema)
}

// —— 阶段 4 批次 A 模型服务/TTS 面（spec §4.6）：九通道信封解包；apiKey 仅存在于请求侧，出参永不含凭据 ——
async function listModelProfiles(input?: { type?: ModelServiceType }): Promise<ModelProfile[]> {
  // 通道 arity 1（registry 校验恰好 1 参）：无参调用须补空对象以满足 arity（modelsListProfilesSchema type optional 接受 {}）
  return unwrap(await invokeWithArgs<ModelProfile[]>(IpcChannels.modelsListProfiles, input ?? {}), ModelProfilesSchema)
}
async function saveModelProfile(input: UpsertModelProfileCommand): Promise<ModelProfile> {
  return unwrap(await invokeWithArgs<ModelProfile>(IpcChannels.modelsSaveProfile, input), ModelProfileSchema)
}
async function deleteModelProfile(service: ModelServiceType, name: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.modelsDeleteProfile, { service, name }), z.undefined())
}
async function testModelProfile(input: ModelProfileTestCommand): Promise<ModelProfileTestResult> {
  return unwrap(await invokeWithArgs<ModelProfileTestResult>(IpcChannels.modelsTestProfile, input), ModelProfileTestResultSchema)
}
async function activateModelProfile(input: ActivateModelProfileCommand): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.modelsActivateProfile, input), z.undefined())
}
async function getActiveModelSelection(): Promise<ActiveModelSelection> {
  return unwrap(await invoke<ActiveModelSelection>(IpcChannels.modelsGetActiveSelection), ActiveModelSelectionSchema)
}
async function listTtsVoices(): Promise<TtsVoiceListResult> {
  return unwrap(await invoke<TtsVoiceListResult>(IpcChannels.ttsListVoices), TtsVoiceListResultSchema)
}
async function previewTts(input: TtsPreviewCommand): Promise<TtsPreviewOutcome> {
  return unwrap(await invokeWithArgs<TtsPreviewOutcome>(IpcChannels.ttsPreview, input), TtsPreviewOutcomeSchema)
}
async function setTtsVoice(input: SetTtsVoiceCommand): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.ttsSetVoice, input), z.undefined())
}

// —— 阶段 4 批次 B 语音面（spec §5.4；11 控制帧 invoke + audio-chunk 单向二进制上行）——
async function voiceStartRecord(input: VoiceRecordStartInput): Promise<{ recordingId: string }> {
  return unwrap(await invokeWithArgs<{ recordingId: string }>(IpcChannels.voiceStartRecord, input), z.object({ recordingId: z.string() }))
}
async function voiceStopRecord(input: VoiceRecordStopInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.voiceStopRecord, input), z.undefined())
}
async function voiceCommit(input: VoiceCommitInput): Promise<ClientRequestRef> {
  return unwrap(await invokeWithArgs<ClientRequestRef>(IpcChannels.voiceCommit, input), ClientRequestRefSchema)
}
async function voiceDiscard(input: VoiceDiscardInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.voiceDiscard, input), z.undefined())
}
async function voiceStartRealtime(input: RealtimeVoiceStartInput): Promise<{ sessionId: string }> {
  return unwrap(await invokeWithArgs<{ sessionId: string }>(IpcChannels.voiceStartRealtime, input), z.object({ sessionId: z.string() }))
}
async function voiceStopRealtime(input: RealtimeVoiceControlInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.voiceStopRealtime, input), z.undefined())
}
async function voiceCancelRealtime(input: RealtimeVoiceControlInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.voiceCancelRealtime, input), z.undefined())
}
async function voiceStartDictation(input: DictationStartInput): Promise<{ clientRequestId: string }> {
  return unwrap(await invokeWithArgs<{ clientRequestId: string }>(IpcChannels.voiceStartDictation, input), z.object({ clientRequestId: z.string() }))
}
async function voiceStopDictation(input: DictationStopInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.voiceStopDictation, input), z.undefined())
}
async function voiceCancelDictation(input: DictationStopInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.voiceCancelDictation, input), z.undefined())
}
async function audioCancel(input: AudioCancelInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.audioCancel, input), z.undefined())
}

// —— 阶段 4 批次 B 设置面（spec §5.1 本地设置：load/save invoke，响应 SettingsStateSchema）——
async function settingsLoad(): Promise<SettingsState> {
  return unwrap(await invoke<SettingsState>(IpcChannels.settingsLoad), SettingsStateSchema)
}
async function settingsSave(patch: SettingsPatch): Promise<SettingsState> {
  return unwrap(await invokeWithArgs<SettingsState>(IpcChannels.settingsSave, patch), SettingsStateSchema)
}

// —— 阶段 5 批次 A Live2D 面（spec D5A-07）：live2d:list-models 摘要清单（arity-0 invoke）——
async function listLive2dModels(): Promise<Live2DModelSummary[]> {
  return unwrap(await invoke<Live2DModelSummary[]>(IpcChannels.live2dListModels), z.array(Live2DModelSummarySchema))
}

// —— 阶段 6 批次 B 工具面（Task 6，spec A-5/B-4/M5）：tool:event 推送订阅 + 四 invoke 通道（invokeWithArgs + unwrap 惯例）——
/** 订阅 tool:event（Main pushEvent → PushChannels.toolEvent）；PublicToolEventSchema 校验，非法丢弃 + warn；返回取消函数 */
function onToolEvent(handler: (ev: PublicToolEvent) => void): () => void {
  const wrapped = (_event: unknown, payload: unknown): void => {
    const parsed = PublicToolEventSchema.safeParse(payload)
    if (!parsed.success) { console.warn('[desktopApi] tool:event 非法载荷已丢弃'); return }
    handler(parsed.data)
  }
  ipcRenderer.on(PushChannels.toolEvent, wrapped)
  return () => ipcRenderer.removeListener(PushChannels.toolEvent, wrapped)
}
async function toolDecide(input: { callId: string; decision: 'allow_once' | 'deny' }): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.toolDecide, input), z.undefined())
}
async function toolCancel(callId: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.toolCancel, { callId }), z.undefined())
}
async function toolList(): Promise<PublicToolEvent[]> {
  // arity 1：恒带 {} 载荷（与 modelsListProfiles 同款惯例——registry 精确匹配 arity）
  return unwrap(await invokeWithArgs<PublicToolEvent[]>(IpcChannels.toolList, {}), ToolListResponseSchema)
}
async function toolPickSource(callId: string, sourceId: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.toolPickSource, { callId, sourceId }), z.undefined())
}
async function toolConfirmUpload(callId: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.toolConfirmUpload, { callId }), z.undefined())
}

// —— 阶段 6 批次 C（Task 6，D6C-12）：目录授权 + 审批历史四 invoke 通道（批次 B 工具面延续；invokeWithArgs + unwrap 惯例）——
async function toolGrantDirectory(input: { callId: string; ttlMs: number }): Promise<{ executed: boolean }> {
  return unwrap(await invokeWithArgs<{ executed: boolean }>(IpcChannels.toolGrantDirectory, input), GrantDirectoryResponseSchema)
}
async function toolListGrants(): Promise<PermissionGrant[]> {
  // arity 1：恒带 {} 载荷（与 toolList/modelsListProfiles 同款惯例）
  return unwrap(await invokeWithArgs<PermissionGrant[]>(IpcChannels.toolGrants, {}), GrantListResponseSchema)
}
async function toolRevokeGrant(id: string): Promise<void> {
  await unwrap(await invokeWithArgs<void>(IpcChannels.toolGrantRevoke, { id }), z.undefined())
}
async function toolListHistory(limit?: number): Promise<HistoryEntry[]> {
  return unwrap(await invokeWithArgs<HistoryEntry[]>(IpcChannels.toolHistory, limit === undefined ? {} : { limit }), HistoryResponseSchema)
}

// —— 阶段 7 批次 A（Task 5，spec §6.2）：诊断五 invoke 通道 + dev-event 推送订阅（契约 R2-1 定名）——
async function diagnosticsState(): Promise<DiagnosticsState> {
  return unwrap(await invoke<DiagnosticsState>(IpcChannels.diagnosticsState), DiagnosticsStateSchema)
}
async function diagnosticsDevModeSet(enabled: boolean): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.diagnosticsDevModeSet, { enabled }), z.undefined())
}
async function diagnosticsOpenLogDir(): Promise<void> {
  unwrap(await invoke<void>(IpcChannels.diagnosticsOpenLogDir), z.undefined())
}
async function diagnosticsClearLogs(): Promise<void> {
  unwrap(await invoke<void>(IpcChannels.diagnosticsClearLogs), z.undefined())
}
async function diagnosticsExport(): Promise<DiagnosticsExportResult> {
  return unwrap(await invoke<DiagnosticsExportResult>(IpcChannels.diagnosticsExport), DiagnosticsExportResultSchema)
}
/** 订阅 diagnostics:dev-event（Main webContents.send 推送——onToolEvent 先例直写，无 subscribePush 工具函数）；
 *  DiagnosticsDevEventSchema 校验（strict 未知键即失效载荷），非法丢弃 + warn；返回取消函数 */
function onDiagnosticsDevEvent(handler: (ev: DiagnosticsDevEvent) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    const parsed = DiagnosticsDevEventSchema.safeParse(payload)
    if (parsed.success) handler(parsed.data)
    else console.warn('[desktopApi] diagnostics:dev-event 非法载荷已丢弃')
  }
  ipcRenderer.on(PushChannels.diagnosticsDevEvent, listener)
  return () => ipcRenderer.removeListener(PushChannels.diagnosticsDevEvent, listener)
}

// —— 阶段 7 批次 B（Task 1）：Renderer 崩溃 marker invoke（诊断面延续；invoke + unwrap 惯例——响应 schema.nullable()）——
async function getLastCrash(): Promise<RendererCrashEvent | null> {
  return unwrap(await invoke<RendererCrashEvent | null>(IpcChannels.diagnosticsLastCrash), RendererCrashEventSchema.nullable())
}

/**
 * 音频二进制上行（单向 send，D-P18）：显式拷贝 bytes——reactive 代理/共享 ArrayBuffer
 * 直传 ipcRenderer.send 会因 contextBridge 结构化克隆对 exotic 对象抛 DataCloneError。
 * 拷贝用 Uint8Array.from（元素迭代）：`new Uint8Array(proxy)` 会因 TypedArray 内部槽检查对 Proxy 抛
 * "this is not a typed array"（Vue reactive 包装的 Uint8Array 命中）——from 走迭代/类数组路径，两者皆可。
 */
function voiceSendAudio(bytes: Uint8Array): void {
  ipcRenderer.send(IpcChannels.voiceAudioChunk, { bytes: Uint8Array.from(bytes) })
}

type ChatEventHandler = (event: BackendEvent) => void
type ChatStateHandler = (state: ConnectionState) => void
type ChatReplayHandler = (payload: ReplayPayload) => void

/** 订阅 chat:event；BackendEvent schema 校验，非法丢弃 + warn；返回取消函数 */
function onChatEvent(handler: ChatEventHandler): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    const parsed = parseBackendEvent(payload)
    if (parsed.success) handler(parsed.data)
    else console.warn('[desktopApi] chat:event 非法载荷已丢弃', parsed.error)
  }
  ipcRenderer.on(PushChannels.event, listener)
  return () => ipcRenderer.removeListener(PushChannels.event, listener)
}

/** 订阅 chat:state；isConnectionState 守卫，非法丢弃 + warn；返回取消函数 */
function onChatState(handler: ChatStateHandler): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    if (isConnectionState(payload)) handler(payload)
    else console.warn('[desktopApi] chat:state 非法载荷已丢弃')
  }
  ipcRenderer.on(PushChannels.state, listener)
  return () => ipcRenderer.removeListener(PushChannels.state, listener)
}

/** 订阅 chat:replay；isReplayPayload 纯守卫（结构），通过后逐条过滤（filterReplayMessages）再达 handler；返回取消函数 */
function onChatReplay(handler: ChatReplayHandler): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    if (isReplayPayload(payload)) handler(filterReplayMessages(payload))
    else console.warn('[desktopApi] chat:replay 非法载荷已丢弃')
  }
  ipcRenderer.on(PushChannels.replay, listener)
  return () => ipcRenderer.removeListener(PushChannels.replay, listener)
}

/** 聊天错误推送载荷：结构化公开字段，与 IpcErrorBody 同形；导出于此供 Renderer 订阅 */
export interface PublicErrorShape {
  code: string
  message: string
  backendCode?: string
  retryable?: boolean
  requestId?: string
  clientRequestId?: string
  retryAfterMs?: number
  idempotencyDurable?: boolean
}

function isPublicErrorShape(v: unknown): v is PublicErrorShape {
  return !!v && typeof v === 'object' && typeof (v as PublicErrorShape).code === 'string' && typeof (v as PublicErrorShape).message === 'string'
}

/** 订阅 chat:error；isPublicErrorShape 守卫，非法丢弃；返回取消函数 */
function onChatError(handler: (err: PublicErrorShape) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    if (isPublicErrorShape(payload)) handler(payload)
    else console.warn('[desktopApi] chat:error 非法载荷已丢弃')
  }
  ipcRenderer.on(PushChannels.error, listener)
  return () => ipcRenderer.removeListener(PushChannels.error, listener)
}

export const desktopApi = {
  getAppInfo,
  getCredentialStatus: async (): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsGetStatus)),
  setBackendToken: async (token: string): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsSet, { key: BACKEND_TOKEN_KEY, value: token })),
  clearBackendToken: async (): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsClear, { key: BACKEND_TOKEN_KEY })),
  // —— chat 面 ——
  connect,
  setEndpoint,
  getEndpoint,
  getRuntimeInfo,
  disconnect,
  listConversations,
  getMessages,
  send,
  cancel,
  activate,
  createConversation,
  renameConversation,
  deleteConversation,
  getConnectionState,
  // —— 多角色角色面 ——
  getMe,
  // —— 多角色身份与角色操作 ——
  updateMe,
  listCharacters,
  getCharacter,
  listCharacterRevisions,
  getCharacterState,
  createCharacter,
  updateCharacter,
  cloneCharacter,
  archiveCharacter,
  rollbackCharacter,
  validateCharacter,
  previewCharacter,
  listCharacterDrafts,
  getCharacterDraft,
  saveCharacterDraft,
  deleteCharacterDraft,
  queryChatHistory,
  getMessageContext,
  listStickers,
  onChatEvent,
  onChatState,
  onChatReplay,
  onChatError,
  // —— 阶段 3 G2 持久化面 ——
  hydratePersistence,
  persistSession,
  cacheMessages,
  openExternal,
  // —— 阶段 3 G3 attachments 面 ——
  attachmentsValidate,
  attachmentsUpload,
  attachmentsCancel,
  attachmentsCheck,
  // —— 阶段 4 批次 A 模型服务/TTS 面 ——
  listModelProfiles,
  saveModelProfile,
  deleteModelProfile,
  testModelProfile,
  activateModelProfile,
  getActiveModelSelection,
  listTtsVoices,
  previewTts,
  setTtsVoice,
  // —— 阶段 4 批次 B 语音面 ——
  voiceStartRecord,
  voiceStopRecord,
  voiceCommit,
  voiceDiscard,
  voiceStartRealtime,
  voiceStopRealtime,
  voiceCancelRealtime,
  voiceStartDictation,
  voiceStopDictation,
  voiceCancelDictation,
  audioCancel,
  voiceSendAudio,
  // —— 阶段 4 批次 B 设置面 ——
  settingsLoad,
  settingsSave,
  // —— 阶段 5 批次 A Live2D 面 ——
  listLive2dModels,
  // —— 阶段 6 批次 B/C 工具面 ——
  onToolEvent,
  toolDecide,
  toolCancel,
  toolList,
  toolPickSource,
  toolConfirmUpload,
  // —— 批次 C（D6C-12）：目录授权 + 审批历史 ——
  toolGrantDirectory,
  toolListGrants,
  toolRevokeGrant,
  toolListHistory,
  // —— 阶段 7 批次 A（Task 5）：诊断面 ——
  diagnosticsState,
  diagnosticsDevModeSet,
  diagnosticsOpenLogDir,
  diagnosticsClearLogs,
  diagnosticsExport,
  onDiagnosticsDevEvent,
  // —— 阶段 7 批次 B（Task 1）：Renderer 崩溃 marker ——
  getLastCrash
}

export type DesktopApi = typeof desktopApi
