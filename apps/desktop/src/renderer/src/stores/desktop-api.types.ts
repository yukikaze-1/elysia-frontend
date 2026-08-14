// src/renderer/src/stores/desktop-api.types.ts
// Renderer store 消费的 desktopApi 窄接口(与 preload DesktopApi chat 面结构一致)。
// 纯类型文件,无运行时逻辑。
import type { PublicError } from '../utils/public-error'
import type {
  ActivateConversationResult,
  AttachmentCheckResult,
  AttachmentsUploadResponse,
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
  FileValidationResult,
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
}
