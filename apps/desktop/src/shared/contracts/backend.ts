import type { Conversation, PageQuery } from './conversation'
import type { Message } from './message'

/** 建立连接后的会话标识(协议版本协商) */
export interface BackendSession {
  sessionId: string
  protocolVersion: string
  serverUrl: string
}

/** 连接状态机 status(由适配器各状态机路径维护;IPC 推送与 store 消费) */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
export interface ConnectionState {
  status: ConnectionStatus
  serverUrl?: string
  protocolVersion?: string
  serverVersion?: string
  connectionId?: string
  activeConversationId?: string
  lastError?: string
}

export interface ConnectInput {
  serverUrl: string
  token?: string
}

/** 装配模式信息（renderer 连接面板展示：打包恒 real，未打包默认 real + CYRENE_BACKEND=mock 显式 mock） */
export interface RuntimeInfo {
  mode: 'real' | 'mock'
  packaged: boolean
  /** 批次 C（C1）：mock 模式下的合成包络源选择（CYRENE_MOCK_MOUTH_LEVEL env 经 Main 水合；真实模式不填充）。
   *  live2dStore 据此选 step/sine 合成口型源替代真实 Analyser（CI 无音频设备/mock TTS 静音）。 */
  mockMouthLevel?: 'step' | 'sine'
}

export interface GetConversationQuery {
  conversationId: string
}

export interface ConversationDetail extends Conversation {
  messages?: Message[]
}

export interface MessageContextQuery {
  conversationId: string
  messageId: string
  before?: number
  after?: number
}

/** 会话消息分页查询(游标为后端 _id opaque 串) */
export interface ConversationMessagesQuery {
  conversationId: string
  before?: string   // _id opaque cursor(倒序)
  after?: string    // _id opaque cursor(正序增量)
  limit?: number
}

/** 激活会话结果(后端返回的权威会话标识) */
export interface ActivateConversationResult {
  conversationId: string
}

/** 消息上下文页(历史查看器跳转来源) */
export interface MessagePage {
  items: Message[]
  nextCursor?: string
  hasMore: boolean
}

export interface CancelGenerationInput {
  generationId: string
}

/** 模型服务 Profile 命令/结果统一收敛在 contracts/model.ts（Task 1：ModelProfile 对齐后移出 backend.ts） */
export type {
  ModelProfileTestResult,
  ModelProfileTestCommand,
  ActivateModelProfileCommand,
  ModelServiceType,
  ModelProfile
} from './model'

/** 历史分类（D2 对齐 docs/02 §19 后端六分类；image_video 为查看器「图片/视频」tab） */
export type HistoryCategory = 'all' | 'image_video' | 'sticker' | 'file' | 'audio' | 'link'

/** 查询范围（scope=当前会话传 conversationId；全部会话不传） */
export type ChatHistoryScope =
  | { type: 'conversation'; conversationId: string }
  | { type: 'all_conversations' }

/** 统一聊天历史查看器查询（D2：收敛到 docs/02 §19 形状，废弃占位 keyword/fromDate/toDate） */
export interface ChatHistoryQuery extends PageQuery {
  scope: ChatHistoryScope
  query?: string              // 关键词（空串不传）
  localDate?: string          // YYYY-MM-DD（用户本地自然日）；同时必须传 timeZone
  timeZone: string            // IANA 时区名
  category: HistoryCategory
  cursor?: string             // 不透明游标
  limit: number               // 必填（后端上限 100；默认 50）
}

/** 历史命中项（Adapter 归一化；hitId/sortKey 由 Adapter 派生稳定键） */
export interface ChatHistoryItem {
  hitId: string               // `${conversationId}:${messageId}:${segmentId ?? ''}`
  conversationId: string
  messageId: string           // 必可跳转（D-06）
  responseId?: string         // 仅供展示兼容；跳转回复组根用 messageId
  segmentId?: string          // 分段命中尽量返回
  senderLabel: string         // user/assistant/系统/工具
  snippet?: string            // 命中片段
  resource?: ConversationResource
  createdAt: string
  sortKey: string             // `${createdAt}|${messageId}` 稳定排序键
}

/** 后端资源分类（六分类，docs/02 §19） */
export interface ConversationResource {
  messageId: string
  timestamp: string
  kind: 'image' | 'link' | 'video' | 'audio' | 'file' | 'sticker'
  url: string                 // 后端资源项 URL（贴图渲染经受信协议，D9）
  stickerId?: string          // P3-3：sticker 项渲染专用（后端可直接返回则跳过解析；缺省由 resource.url 末段提取）
}

export interface ChatHistoryPage {
  items: ChatHistoryItem[]
  nextCursor?: string
  hasMore: boolean
  snapshotId?: string         // 可选：避免查询期间新消息致分页重复/漏项
}

/** 工具结果回传 */
export interface ToolResult {
  callId: string
  status: 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timeout'
  summary?: string
}
