import type { ToolStatusCommand } from '@shared/contracts/backend'
import type { ToolAttachment } from '@shared/contracts/tool'
import type { ToolBackendPort } from '../transport/backend-ports'
import type { AuditEvent } from '../diagnostics/audit'
import { auditToolEvent } from './tool-audit'

/**
 * 工具状态回传方的后端能力面（架构整改 Prompt 3）：只需工具端口的两个方法——
 * 终态回传与工具附件上传。`getToolCallStatus` 由工具服务自己的重连分支消费，不经此处。
 */
export type ToolStatusBackendPort = Pick<ToolBackendPort, 'submitToolResult' | 'uploadToolAttachment'>

export interface ToolStatusSenderDeps {
  backend: ToolStatusBackendPort
  audit: (ev: AuditEvent) => void
}
export interface ToolStatusSender {
  send(command: ToolStatusCommand): Promise<boolean>       // false=发送失败（调用方置 statusSent=false）
  uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment>
}
export function createToolStatusSender(deps: ToolStatusSenderDeps): ToolStatusSender {
  return {
    async send(command) {
      try {
        await deps.backend.submitToolResult(command)
        auditToolEvent(deps.audit, { type: 'tool:status-sent', callId: command.callId, status: command.status, summary: `已回传 ${command.status}` })
        return true
      } catch { return false }
    },
    async uploadToolAttachment(callId, bytes, mime, label) {
      const up = await deps.backend.uploadToolAttachment(callId, bytes, mime, label)
      return { url: up.url, mimeType: mime, label }   // H1：响应仅 url，mimeType/label 本地回填
    },
  }
}
