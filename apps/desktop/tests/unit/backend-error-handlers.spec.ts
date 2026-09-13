// apps/desktop/tests/unit/backend-error-handlers.spec.ts
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { buildBackendErrorHandlers } from '../../src/main/chat/backend-error-handlers'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'
import type { AuditEvent } from '../../src/main/diagnostics/audit'

const noopSanitize = (m: string): string => m

// Logger 结构 mock(满足 Logger 全方法签名;仅 error/warn 被断言)
const makeLogger = () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  flush: vi.fn(),
  close: vi.fn()
})

describe('buildBackendErrorHandlers', () => {
  it('onError → logger.error(backend:error, {code,message,+pub})', () => {
    const logger = makeLogger()
    const send = vi.fn()
    const h = buildBackendErrorHandlers({ logger, sanitize: noopSanitize, send, mode: 'real', getBuild: () => ({}) })
    h.onError(new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '队列满', { backendCode: 'QUEUE_FULL', retryable: true, clientRequestId: 'cr-1', retryAfterMs: 1000, idempotencyDurable: false }))
    const expected = { code: 'BACKEND_REJECTED', message: '队列满', backendCode: 'QUEUE_FULL', retryable: true, clientRequestId: 'cr-1', retryAfterMs: 1000, idempotencyDurable: false }
    expect(logger.error).toHaveBeenCalledWith('backend:error', expected)
    expect(send).toHaveBeenCalledWith('chat:error', expected)
  })
  it('onError message 经 sanitize;details 兼容 {code} 写法', () => {
    const sanitize = (m: string) => m.replace(/sk-\w+/g, '[REDACTED]')
    const logger = makeLogger()
    const h = buildBackendErrorHandlers({ logger, sanitize, send: vi.fn(), mode: 'real', getBuild: () => ({}) })
    h.onError(new CyreneError(CyreneErrorCode.UNKNOWN, 'bad sk-abc123', { code: 'WS_ERROR' }))
    expect(logger.error).toHaveBeenCalledWith('backend:error', { code: 'UNKNOWN', message: 'bad [REDACTED]', backendCode: 'WS_ERROR' })
  })
  it('onProtocolWarning → logger.warn(protocol:warning, {code,message,mode,+build})', () => {
    const logger = makeLogger()
    const h = buildBackendErrorHandlers({ logger, sanitize: noopSanitize, send: vi.fn(), mode: 'real', getBuild: () => ({ serverVersion: 'v1', protocolVersion: '2.0' }) })
    h.onProtocolWarning({ code: 'RAW_FRAME_INVALID', message: '帧校验失败' })
    expect(logger.warn).toHaveBeenCalledWith('protocol:warning', { code: 'RAW_FRAME_INVALID', message: '帧校验失败', mode: 'real', serverVersion: 'v1', protocolVersion: '2.0' })
  })
  it('onProtocolWarning message 经 sanitize', () => {
    const sanitize = (m: string) => m.replace(/sk-\w+/g, '[REDACTED]')
    const logger = makeLogger()
    const h = buildBackendErrorHandlers({ logger, sanitize, send: vi.fn(), mode: 'mock', getBuild: () => ({}) })
    h.onProtocolWarning({ code: 'RAW_FRAME_INVALID', message: 'token sk-abc123 校验失败' })
    expect(logger.warn).toHaveBeenCalledWith('protocol:warning', { code: 'RAW_FRAME_INVALID', message: 'token [REDACTED] 校验失败', mode: 'mock' })
  })
  it('onError → audit connection:error（含 backendCode/retryable，summary 无原始 details）', () => {
    const logger = makeLogger()
    // 审计回调按 backend-error-handlers 的真实签名 `(event: Omit<AuditEvent,'ts'>) => void` 标注——
    // 裸 `vi.fn()` 的调用实参是 `any`，标注后 `audit.mock.calls[0][0]` 才是受检的审计载荷
    const audit: Mock<(event: Omit<AuditEvent, 'ts'>) => void> = vi.fn()
    const h = buildBackendErrorHandlers({ logger, sanitize: noopSanitize, send: vi.fn(), mode: 'real', getBuild: () => ({}), audit })
    h.onError(new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '队列满', { backendCode: 'QUEUE_FULL', retryable: true }))
    // `expect.objectContaining`/`expect.stringContaining` 的返回类型被 vitest 声明成 `any`；
    // 改为按调用序取审计实参断言（等价：三条断言分别落在 summary 的 code/backendCode/retryable 上）
    const audited = audit.mock.calls[0][0]
    expect(audited.type).toBe('connection:error')
    expect(audited.summary).toContain('BACKEND_REJECTED')
    expect(audited.summary).toContain('QUEUE_FULL')
    expect(audited.summary).toContain('retryable')
  })
})
