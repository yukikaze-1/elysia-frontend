export type ToolRuntime = 'backend' | 'desktop' | 'local_worker'

/** 工具生命周期:终态(rejected/cancelled/timeout/completed/failed)不再进入执行 */
export type ToolStatus =
  | 'requested'
  | 'awaiting_permission'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timeout'

/** 工具调用(前端展示模型,Backend Runtime 只展示、Desktop 经 Main 执行) */
export interface ToolCall {
  callId: string
  toolId: string
  name: string
  runtime: ToolRuntime
  status: ToolStatus
  summary?: string
  createdAt: string
}
