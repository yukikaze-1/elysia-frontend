// src/main/tools/tool-executors.ts（Task 2 stub——Task 3 实装）
import type { ToolAttachment } from '@shared/contracts/tool'

export class ToolExecError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
export interface ExecResult {
  output: Record<string, unknown>
  summary: string
  attachments?: ToolAttachment[]
  attachmentCount?: number
  captureSession?: boolean
}
export function createExecutors(_deps: unknown): { execute(rec: unknown, realPath?: string): Promise<ExecResult> } {
  return { async execute() { throw new ToolExecError('NOT_IMPLEMENTED', 'Task 3 实装') } }
}
