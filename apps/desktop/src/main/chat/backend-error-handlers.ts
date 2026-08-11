// apps/desktop/src/main/chat/backend-error-handlers.ts
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { PushChannels } from '@shared/contracts/ipc'
import type { CyreneError } from '@shared/errors'
import type { Logger } from '../diagnostics/logger'
import type { MessageSanitizer } from '../diagnostics/sanitize'

/**
 * 从 CyreneError.details 提取可公开字段(兼容 backendCode 与 code 两种后端写法)。
 * 只上提白名单字段,其余 details 一律不进日志/推送(防泄漏原始协议载荷)。
 */
const extractPublic = (d: unknown): { backendCode?: string; retryable?: boolean; requestId?: string } => {
  const o = (d ?? {}) as Record<string, unknown>
  return {
    backendCode: typeof o.backendCode === 'string' ? o.backendCode : typeof o.code === 'string' ? o.code : undefined,
    retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
    requestId: typeof o.requestId === 'string' ? o.requestId : undefined
  }
}

export interface BackendErrorHandlerDeps {
  logger: Logger
  sanitize: MessageSanitizer
  send: (channel: string, payload: unknown) => void   // webContents.send 包装
  mode: 'real' | 'mock'
  getBuild: () => { serverVersion?: string; protocolVersion?: string }
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
    }
  }
}
