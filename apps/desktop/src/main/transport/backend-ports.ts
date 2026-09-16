// src/main/transport/backend-ports.ts —— 后端能力端口（架构整改 Prompt 3）。
//
// 本文件要解决的问题：`BackendAdapter` 此前既是**聚合面**又是**唯一注入面**——40 余个方法横跨
// 连接、会话、消息、历史、附件、模型服务、语音、桌面工具等领域，于是任何 Application Service
// 只要拿到它就理论上能调用几乎整个 Python 后端能力面（违反 Interface Segregation）。随着
// Memory / Schedule / Diary / Agent / Knowledge 这类领域继续加入，它会越来越像"整个后端 SDK"。
//
// 现在的分工：
//   · 本文件 = 按**稳定业务能力**（切分口径＝消费方能力簇，见下）划分的领域端口
//     （每个消费方只声明它真正需要的那几个）；
//   · `backend-adapter.ts` 的 `BackendAdapter` = 这些端口的**交集 + 传输层接线槽**，
//     只由 RealBackend / MockBackend 的实现声明与组合根（`bootstrap/**`）持有；
//   · Application Service **不再**依赖聚合面（`tests/unit/backend-capability-ports.spec.ts` 机械守卫）。
//
// 三条不变式（同由上面那条门禁守卫）：
//   ① 每个方法**恰好**属于一个端口——端口之间不重叠、不互相 extends，并集覆盖聚合面（不丢能力、不重复声明）；
//   ② RealBackend / MockBackend 都满足每一个端口——端口只是**同一实例的依赖视图**，
//      底层 WS / REST / 鉴权 / 重连 / 存活检测状态一份也不复制；
//   ③ 参数与返回值是**域/应用形状**（`@shared/contracts/*`），不是 raw wire payload——本模块只 import
//      `@shared/**`，因此结构上不可能引用 `protocol-v2/**` 的 raw schema / 帧 mapper / 后端 DTO。
//
// 为什么是 7 个端口而不是更多或更少（粒度依据见各端口头注）：
//   · 切分口径是**消费方能力簇**：一个端口 = 一批总是由同一组消费方一起使用的后端能力
//     （chat handler / 诊断事件源 / 字节处理方 / 模型服务 handler / voice handler / 工具回传方）；
//     不按后端模块切，也不按"一个方法一个接口"切（那只会把依赖面从 1 个宽接口变成 40 个窄接口）；
//   · 只在"调用图显示消费者确实各不相同"处切分——例如 voice 的 12 个方法全部由同一批
//     voice handler 消费且共享同一条"单活动语音会话"后端状态，故合成一个端口；
//   · 唯一的单方法端口是事件源：它的全部能力就是 subscribe，而它有两个需求不同的消费者
//     （chat 转发全部领域事件、diagnostics 只做开发态 tap）——并进连接端口会强迫
//     diagnostics 依赖 connect/disconnect，反而更宽；
//   · 被同一批 handler 使用但分属两件事的能力（TTS 配置 vs TTS 播放取消）按"哪批 handler 拥有
//     那条 IPC 面"归位：TTS Profile/声音清单/试听/切换在 `ModelBackendPort`，播放取消 `audioCancel`
//     与语音会话同属 `VoiceBackendPort`（见两处头注）。
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
  DesktopCallStatus,
  GetConversationQuery,
  MessageContextQuery,
  MessagePage,
  ModelProfileTestResult,
  ToolStatusCommand
} from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput, Page, PageQuery } from '@shared/contracts/conversation'
import type { BackendEvent } from '@shared/contracts/events'
import type { ClientRequestRef, SendMessageInput } from '@shared/contracts/message'
import type { AttachmentKind } from '@shared/contracts/message'
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

/** 后端事件回调（Renderer 只消费领域事件，不接触原始协议） */
export type BackendEventHandler = (event: BackendEvent) => void

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

/**
 * 连接生命周期端口（§10：跨领域能力，独立于任何业务域）。
 *
 * 消费者：ChatService（Main 侧连接的唯一持有者：connect/disconnect/状态快照）、退出编排
 * （disconnect）、错误处理器与只读探针（getConnectionState）。
 * 语义：`getConnectionState` 返回**当前快照**（每次调用重新读传输层状态，不是缓存副本），
 * 连接状态仍然只有传输层这一个权威来源。
 */
export interface BackendConnectionPort {
  connect(input: ConnectInput): Promise<BackendSession>
  disconnect(): Promise<void>

  /** 当前连接状态（快照；IPC 推送与 store 经此轮询/首拉） */
  getConnectionState(): ConnectionState
}

/**
 * 后端领域事件源端口（后端**发起**的事件，与上面的命令方向相反，故不并入连接端口）。
 *
 * 消费者：ChatService（把全部领域事件转发为 `chat:event`）、DiagnosticsService（开发态 tap）。
 * 返回取消订阅函数；实现方支持多槽订阅（同一实例可被多处同时订阅）。
 */
export interface BackendEventSourcePort {
  /** 订阅后端公开领域事件；返回取消订阅函数 */
  subscribe(handler: BackendEventHandler): () => void
}

/**
 * 会话与消息端口（会话 CRUD + 消息收发 + 历史检索 + 内置表情清单）。
 *
 * 消费者：ChatService（唯一）。会话与消息在这个后端里是同一份会话状态机的读写两面
 * （发送/取消/激活/删除都作用在同一会话上），拆开只会让 ChatService 同时依赖多个端口。
 */
export interface ChatBackendPort {
  listConversations(input: PageQuery): Promise<Page<Conversation>>
  /** 会话详情（当前无生产调用方：为会话详情页保留的后端能力；归档截图配对语义由 `real-backend.spec.ts` 覆盖） */
  getConversation(input: GetConversationQuery): Promise<ConversationDetail>
  getConversationMessages(input: ConversationMessagesQuery): Promise<MessagePage>
  getMessageContext(input: MessageContextQuery): Promise<MessagePage>
  createConversation(input: CreateConversationInput): Promise<Conversation>
  activateConversation(conversationId: string): Promise<ActivateConversationResult>
  renameConversation(id: string, title: string): Promise<Conversation>
  deleteConversation(id: string): Promise<void>

  sendMessage(input: SendMessageInput): Promise<ClientRequestRef>
  cancelGeneration(input: CancelGenerationInput): Promise<void>

  queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage>
  /** 阶段 3 G4：内置表情包清单（StickerManifest{stickers}，D8） */
  listStickers(): Promise<StickerManifest>
}

/**
 * 附件与媒体字节端口（上传 + 签名 URL 签发 + 归档桌面截图读取）。
 *
 * 消费者：UploadService（`uploadAttachments`）、MediaService（`signAttachmentUrl` + `readToolAttachment`）。
 * 归位判据是**消费方能力簇**：这三个方法的消费方都是"字节处理方"（把本地/远端字节搬进搬出，
 * 且字节与签名 URL 都不越进程边界），没有任何工具执行语义。
 *
 * `readToolAttachment` 与 `ToolBackendPort.uploadToolAttachment` 是同一条
 * `/api/uploads/desktop/{callId}` 资源的读/写两半——按后端资源归位本可放一起，但那样会让
 * 媒体路由（MediaService）反过来依赖工具域，且它返回的是纯字节（无状态、无策略、callId 只是 key）。
 * 故此处按消费方归位，并在 `ToolBackendPort` 头注交叉标注，避免边界看起来是随手放的。
 */
export interface AttachmentBackendPort {
  /** 批量 multipart 上传（batch 原子；AttachmentInfo.kind 权威；P1-1：opts.signal 为调用方取消信号，abort 后 reject cancelled） */
  uploadAttachments(files: UploadContent[], opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]>
  /** 签发短期签名 URL（Main 持有，不落 Renderer） */
  signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult>
  /** 已归档桌面截图读取（`uploadToolAttachment` 的读半边）：Main 持有 Bearer 并返回经 MIME/大小校验的字节；Renderer 不接触后端 URL/Token。 */
  readToolAttachment(callId: string): Promise<{ bytes: Uint8Array; mimeType: 'image/png' } | null>
}

/**
 * 模型服务端口（llm/stt/tts 三服务的 Profile 管理与激活 + TTS 声音清单/试听/切换）。
 *
 * 消费者：模型服务 IPC handler（`models/model-handlers.ts`，唯一）。
 * 归位判据同全局口径（消费方能力簇）：TTS 声音属于"模型服务选择"这一件事（声音就是 tts 服务的配置），
 * 与 Profile 管理由同一批 handler 注册，故不另立端口；TTS 的**播放取消**（`VoiceBackendPort.audioCancel`）
 * 属于另一批 handler（语音通道），刻意留在那边。
 */
export interface ModelBackendPort {
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
}

/**
 * 语音端口（普通录音 / 实时语音 / 输入法转写三类会话 + 音频上行与 TTS 播放取消）。
 *
 * 消费者：voice IPC handler（`voice/voice-handlers.ts`，唯一）。
 * 12 个方法刻意合成一个端口：三类会话共享**同一条后端约束**——任一时刻只允许一个活动语音会话
 * （传输层持 `activeVoice` 单例守卫，重入由后端 `VOICE_SESSION_CONFLICT` 兜底）；
 * `audioCancel`（TTS 播放取消）也在此，因为它由同一批 voice handler 拥有（`audio:cancel` 通道），
 * 拆走会让一个 handler 模块横跨两个端口，而共享的后端音频会话状态仍在一处。
 */
export interface VoiceBackendPort {
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
}

/**
 * 桌面工具端口（工具终态回传 + 归档附件上传 + 服务端调用状态查询）。
 *
 * 消费者：ToolStatusSender（`submitToolResult` / `uploadToolAttachment`）、工具服务的重连三分支
 * （`getToolCallStatus`，仅 real 注入）。归位判据同全局口径（消费方能力簇）：这三个方法都带工具语义
 * （终态、调用状态、工具附件），由工具域消费。
 *
 * 同一条 `/api/uploads/desktop/{callId}` 资源的**读半边**（`readToolAttachment`）在
 * `AttachmentBackendPort`——消费方是字节代理而非工具域，理由见该端口头注。
 *
 * `DesktopToolRequest` 的交付槽（`onToolRequest`）**也不在此端口**：它是传输层的**接线槽**
 * （组合根在装配期赋值，见 `bootstrap/transport.ts`），不是应用能力——本文件导出的类型里
 * 不含任何可变字段，端口一律只描述"能调用什么"。
 */
export interface ToolBackendPort {
  submitToolResult(input: ToolStatusCommand): Promise<void>
  /** 批次 C（D6C-11）：查询桌面调用服务端状态（GET /api/tools/calls/{callId}，BE-043）；缺端点/断连/非 2xx → null 降级 */
  getToolCallStatus(callId: string): Promise<DesktopCallStatus | null>
  /** 工具附件上传（阶段 6 批次 B Task 5：先 POST /api/uploads/desktop/{callId}（X-Client-Connection 持有者校验）
   *  拿 url 再回填 tool.status attachments，H1——响应仅 {url}，mimeType/label 本地回填） */
  uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment>
}
