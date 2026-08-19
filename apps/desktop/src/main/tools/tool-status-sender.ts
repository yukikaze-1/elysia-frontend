import type { ToolStatusCommand } from '@shared/contracts/backend'
import type { ToolAttachment } from '@shared/contracts/tool'
import type { AuditEvent } from '../diagnostics/audit'
import { auditToolEvent } from './tool-audit'

export interface ToolStatusSenderDeps {
  adapter: { submitToolResult(input: ToolStatusCommand): Promise<void>; uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment> }
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
        await deps.adapter.submitToolResult(command)
        auditToolEvent(deps.audit, { type: 'tool:status-sent', callId: command.callId, status: command.status, summary: `已回传 ${command.status}` })
        return true
      } catch { return false }
    },
    async uploadToolAttachment(callId, bytes, mime, label) {
      const up = await deps.adapter.uploadToolAttachment(callId, bytes, mime, label)
      return { url: up.url, mimeType: mime, label }   // H1：响应仅 url，mimeType/label 本地回填
    },
  }
}
