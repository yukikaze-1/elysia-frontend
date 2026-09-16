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
  ToolStatusCommand
} from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput, Page, PageQuery } from '@shared/contracts/conversation'
import type { BackendEvent } from '@shared/contracts/events'
import type { ClientRequestRef, SendMessageInput } from '@shared/contracts/message'
import type {
  ActiveModelSelection,
  ModelProfile,
  ModelProfileTestCommand,
  ModelServiceType,
  SetTtsVoiceCommand,
  TtsPreviewCommand,
  TtsVoiceListResult,
  UpsertModelProfileCommand
} from '@shared/contracts/model'
import type { AttachmentInfo, AttachmentSignResult } from '@shared/contracts/attachments'
import type { ToolAttachment } from '@shared/contracts/tool'
import type { DesktopToolRequest } from '../tools/tool-execution-contract'   // 传输层只依赖工具域**执行契约**，不依赖 tool-service 实现（2026-09-17 架构整改 Prompt 1）
import type { AttachmentKind } from '@shared/contracts/message'
import type { StickerManifest } from '@shared/contracts/sticker'
import type {
  AudioCancelInput,
  DictationStartInput,
  DictationStopInput,
  RealtimeVoiceControlInput,
  RealtimeVoiceStartInput,
  VoiceCommitInput,
  VoiceDiscardInput,
  VoiceRecordStartInput,
  VoiceRecordStopInput
} from '@shared/contracts'

/**
 * 上传内容（**bytes-only**；kind 为客户端提示值，可省略由后端魔数判定）。
 *
 * H-01 结构性收窄（2026-09-14）：原为 `path?`/`bytes?` 二选一，其中 `path` 允许"调用方给路径、由传输层
 * 自己读盘"。那条路是**全仓第二个「从 descriptor 取路径直接读盘」的解析点**，而且那一层**没有** realpath、
 * userData 包含判定与敏感路径黑名单（守卫只在 `UploadService`）。实测该回退**从未执行**——`UploadService`
 * 是唯一构造点且两个分支都填 `bytes` ⇒ 删除属"删掉一段假能力"。现 `bytes` **必填**，把"路径不再离开
 * `UploadService`"从约定升级为**类型级不变量**。
 */
export interface UploadContent {
  name: string
  mediaType: string
  size: number
  kind?: AttachmentKind
  bytes: Uint8Array
}

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

  /** 批量 multipart 上传（batch 原子；AttachmentInfo.kind 权威；P1-1：opts.signal 为调用方取消信号，abort 后 reject cancelled） */
  uploadAttachments(files: UploadContent[], opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]>
  /** 签发短期签名 URL（Main 持有，不落 Renderer） */
  signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult>

  listModelProfiles(type?: ModelServiceType): Promise<ModelProfile[]>
  /** 保存自定义 Profile（apiKey 一次性，仅存在于请求侧；出参 ModelProfile 永不含凭据） */
  saveModelProfile(input: UpsertModelProfileCommand): Promise<ModelProfile>
  deleteModelProfile(service: ModelServiceType, name: string): Promise<void>
  testModelProfile(input: ModelProfileTestCommand): Promise<ModelProfileTestResult>
  activateModelProfile(input: ActivateModelProfileCommand): Promise<void>
  /** 当前激活选择快照（llm/stt/tts 每服务 profile id，取自 server_info.services） */
  getActiveModelSelection(): ActiveModelSelection
  /** TTS 声音清单（静态清单 / API 拉取；source 区分） */
  listTtsVoices(): Promise<TtsVoiceListResult>
  /** TTS 试听：返回 raw（bytes 二进制仅 Main 内流转，由 IPC handler 写入 MediaService；传输面不越 Main） */
  previewTts(input: TtsPreviewCommand): Promise<{ ok: boolean; mime?: string; bytes?: Uint8Array; durationMs?: number; error?: string }>
  /** TTS 声音切换（wire set_tts_voice；单 in-flight，重入 supersede 旧 pending） */
  setTtsVoice(input: SetTtsVoiceCommand): Promise<void>

  queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage>
  /** 阶段 3 G4：内置表情包清单（StickerManifest{stickers}，D8） */
  listStickers(): Promise<StickerManifest>

  // —— P4-B 语音（spec §5.4 方法集；Task 4/7 实现，Task 3 仅重写签名） ——
  startRecordVoice(input: VoiceRecordStartInput): Promise<{ recordingId: string }>
  stopRecordVoice(input: VoiceRecordStopInput): Promise<void>
  commitVoice(input: VoiceCommitInput): Promise<ClientRequestRef>
  discardVoice(input: VoiceDiscardInput): Promise<void>
  startRealtimeVoice(input: RealtimeVoiceStartInput): Promise<{ sessionId: string }>
  stopRealtimeVoice(input: RealtimeVoiceControlInput): Promise<void>
  cancelRealtimeVoice(input: RealtimeVoiceControlInput): Promise<void>
  startDictation(input: DictationStartInput): Promise<{ clientRequestId: string }>
  stopDictation(input: DictationStopInput): Promise<void>
  cancelDictation(input: DictationStopInput): Promise<void>
  sendAudioBytes(bytes: Uint8Array): void
  audioCancel(input: AudioCancelInput): Promise<void>

  submitToolResult(input: ToolStatusCommand): Promise<void>
  /** 批次 C（D6C-11）：查询桌面调用服务端状态（GET /api/tools/calls/{callId}，BE-043）；缺端点/断连/非 2xx → null 降级 */
  getToolCallStatus(callId: string): Promise<import('@shared/contracts/backend').DesktopCallStatus | null>
  /** 工具附件上传（阶段 6 批次 B Task 5：先 POST /api/uploads/desktop/{callId}（X-Client-Connection 持有者校验）
   *  拿 url 再回填 tool.status attachments，H1——响应仅 {url}，mimeType/label 本地回填） */
  uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment>
  /** 已归档桌面截图读取：Main 持有 Bearer 并返回经 MIME/大小校验的字节；Renderer 不接触后端 URL/Token。 */
  readToolAttachment(callId: string): Promise<{ bytes: Uint8Array; mimeType: 'image/png' } | null>
  /** 桌面工具请求钩子（阶段 6 批次 B Task 6，D6B-08/D6B-15）：real 专用——handleFrame case 'tool.request'
   *  路由至此（不再 emit 领域事件）；index.ts 在 adapter 构造后注入（避免构造环）。mock 不实现（MockBackend 经
   *  toolRequestSink 构造注入，D6B-15）。 */
  onToolRequest?: (req: DesktopToolRequest) => void

  /** 订阅后端公开领域事件;返回取消订阅函数 */
  subscribe(handler: BackendEventHandler): () => void
}
