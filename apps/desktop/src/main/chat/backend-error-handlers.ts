// apps/desktop/src/main/chat/backend-error-handlers.ts
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { PushChannels } from '@shared/contracts/ipc'
import type { CyreneError } from '@shared/errors'
import type { Logger } from '../diagnostics/logger'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import { safeAudit } from '../diagnostics/safe-audit'
import type { AuditEvent } from '../diagnostics/audit'

/**
 * 从 CyreneError.details 提取可公开字段(兼容 backendCode 与 code 两种后端写法)。
 * 只上提白名单字段,其余 details 一律不进日志/推送(防泄漏原始协议载荷)。
 */
const extractPublic = (d: unknown): {
  backendCode?: string; retryable?: boolean; requestId?: string; clientRequestId?: string
  retryAfterMs?: number; idempotencyDurable?: boolean
} => {
  const o = (d ?? {}) as Record<string, unknown>
  return {
    backendCode: typeof o.backendCode === 'string' ? o.backendCode : typeof o.code === 'string' ? o.code : undefined,
    retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
    requestId: typeof o.requestId === 'string' ? o.requestId : undefined,
    clientRequestId: typeof o.clientRequestId === 'string' ? o.clientRequestId : undefined,
    retryAfterMs: typeof o.retryAfterMs === 'number' ? o.retryAfterMs : undefined,
    idempotencyDurable: typeof o.idempotencyDurable === 'boolean' ? o.idempotencyDurable : undefined
  }
}

export interface BackendErrorHandlerDeps {
  logger: Logger
  sanitize: MessageSanitizer
  send: (channel: string, payload: unknown) => void   // webContents.send 包装
  mode: 'real' | 'mock'
  getBuild: () => { serverVersion?: string; protocolVersion?: string }
  audit?: (event: Omit<AuditEvent, 'ts'>) => void   // 连接错误审计（C2;fail-open,safeAudit 调用）
}

/**
 * 协议告警/后端错误的可见化处理:协议告警只落 warn 日志(不记正文/Token/原始帧),
 * 后端错误落 error 日志 + 推 chat:error 给 Renderer(供连接面板展示)。纯模块,依赖全注入,可单测。
 */
export function buildBackendErrorHandlers(deps: BackendErrorHandlerDeps): {
  onProtocolWarning(w: ProtocolWarning): void
  onError(err: CyreneError): void
} {
  return {
    onProtocolWarning(w) {
      const b = deps.getBuild()
      deps.logger.warn('protocol:warning', {
        code: w.code,
        message: deps.sanitize(w.message),
        mode: deps.mode,
        ...(b.serverVersion ? { serverVersion: b.serverVersion } : {}),
        ...(b.protocolVersion ? { protocolVersion: b.protocolVersion } : {})
      })
    },
    onError(err) {
      const pub = extractPublic(err.details)
      deps.logger.error('backend:error', { code: err.code, message: deps.sanitize(err.message), ...pub })
      deps.send(PushChannels.error, { code: err.code, message: err.message, ...pub })
      // C2:审计只上提白名单字段（code/backendCode/retryable),summary 不含原始 details 防泄漏
      safeAudit(deps.audit, {
        type: 'connection:error',
        summary: `code=${err.code}` + (pub.backendCode ? ` backend=${pub.backendCode}` : '') + (pub.retryable ? ' retryable' : '')
      })
    }
  }
}
