/** 工具 Runtime（与 wire ToolRuntime 对齐；ModelExecutionLocation 是另一概念，勿混用） */
export type ToolRuntime = 'backend' | 'desktop' | 'local_worker'

/** 前端展示状态（doc 04 §4 单向前进；终态不重回执行态；wire tool.status 六态协议态映射见 spec D6A-05） */
export type ToolCallStatus =
  | 'requested' | 'awaiting_permission' | 'running'
  | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timeout'

/** 统一工具调用记录（权威键 id = sourceCallId = LLM tool_call_id，D6-03；实时易失 / 归档持久共型）。
 * toolVersion 有意不进记录（归档 wire 无版本源；批次 B tool.status 回传一致性由 Main 自 raw 缓存取值，D6-07）。 */
export interface ToolCallRecord {
  id: string
  toolName: string
  runtime: ToolRuntime
  status: ToolCallStatus
  desktopCallId?: string
  generationId?: string
  conversationId?: string
  reason?: string
  inputSummary?: string
  outputSummary?: string
  error?: { code?: string; message?: string }
  errorType?: string
  truncated?: boolean
  durationMs?: number
  startedAt?: string
  finishedAt?: string
  attachmentCount?: number          // 附件数（A10）
}

/** 差异行（diff 展示，D6B-11） */
export interface DiffLine { kind: 'added' | 'removed' | 'unchanged'; text: string }

/** 桌面工具公开事件（tool:event 载荷，D6B-09；无 arguments/paramHash/expiresAt/安全元数据，D6-07） */
export interface PublicToolEvent {
  id: string                        // sourceCallId（权威键）
  desktopCallId?: string            // 桥 callId
  toolName: string
  title: string                     // 注册表友好名（Renderer 无注册表）
  runtime: 'desktop'
  status: ToolCallStatus
  reason?: string
  inputSummary?: string             // 脱敏（redactToolArguments 产物）
  pathSummary?: string              // Main 派生路径展示摘要（仅权限窗/卡片；不进审计，H-1）
  resultSummary?: string
  error?: { code?: string; message?: string }
  truncated?: boolean
  durationMs?: number
  startedAt?: string
  finishedAt?: string
  attachmentCount?: number          // 卡片「含 N 个附件」数据源（A10）
  dataFlowNote?: string             // 注册表静态文案（「哪些数据发后端」）
  diff?: { lines: DiffLine[]; added: number; removed: number; truncated: boolean; totalLines: number; formatNote: string; isNewFile: boolean }   // totalLines（A-20/H2：接口与 schema/消费三方一致）
  captureSources?: Array<{ sourceId: string; sourceName: string; thumbnailDataUrl: string }>
  capturePreview?: { sourceId: string; previewDataUrl: string }
  occurredAt: string
}

/** 工具结果附件引用（wire ToolAttachment 直映） */
export interface ToolAttachment {
  url: string
  mimeType: string
  label?: string
}
