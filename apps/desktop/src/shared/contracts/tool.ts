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
}

/** 工具结果附件引用（wire ToolAttachment 直映） */
export interface ToolAttachment {
  url: string
  mimeType: string
  label?: string
}
