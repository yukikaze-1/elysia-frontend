// src/main/tools/tool-executors.ts（Task 2 最小面——Task 3 实装）
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
/** Task 2 用到的 deps 最小面（内联类型避免与 tool-service 循环 import，M10 注记） */
interface ExecutorDeps {
  pickFile?: (opts: { title: string; filters: { name: string; extensions: string[] }[] }) => Promise<{ canceled: boolean; path?: string }>
  selectedAdd?: (realPath: string) => void
}
/** Task 2 最小面：file.select 经 pickFile 完成选择并回调 selectedAdd（A-14——选中路径入 selected-set，重连清空）；
 * read/write/capture 执行器 Task 3 实装（本 task 恒抛 NOT_IMPLEMENTED）。 */
export function createExecutors(deps: unknown): { execute(rec: unknown, realPath?: string): Promise<ExecResult> } {
  const d = deps as ExecutorDeps
  return {
    async execute(rec, _realPath) {
      const toolName = (rec as { toolName?: string })?.toolName
      if (toolName === 'desktop.file.select') {
        if (!d.pickFile) throw new ToolExecError('NOT_IMPLEMENTED', 'Task 3 实装')
        const res = await d.pickFile({ title: '选择文件', filters: [] })
        if (res.canceled) return { output: {}, summary: '用户取消选择' }
        if (!res.path) throw new ToolExecError('SELECT_FAILED', '未选择文件')
        d.selectedAdd?.(res.path)   // A-14：选中路径入 selected-set（豁免后续 read）
        return { output: { path: res.path }, summary: '已选择文件' }
      }
      throw new ToolExecError('NOT_IMPLEMENTED', 'Task 3 实装')
    },
  }
}
