// apps/desktop/tests/unit/ipc-executor.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'
import { ToolServiceError } from '../../src/main/tools/tool-execution-contract'   // 批次 C（Task 6 review LOW-3）：工具域结构化错误上提直测（Prompt 1 起定义在契约模块）

const sanitize = (m: string): string => m.replace(/\/home\/alice/g, '~')
const noopSanitize = (m: string): string => m

describe('createIpcHandler', () => {
  it('角色错误 details 按 backendCode 白名单公开，恶意 revision/issues/raw 不上行', async () => {
    const allowed = createIpcHandler(z.undefined(), z.undefined(), () => {
      throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, 'validation', {
        backendCode: 'CHARACTER_VALIDATION', currentRevision: 99, rawBody: 'SECRET',
        issues: [
          { severity: 'error', code: 'REQUIRED', path: '/promptProfile/core', message: '必填' },
          { severity: 'error', code: 'PATH', path: '/C:/Users/secret.txt', message: 'leak' }
        ]
      })
    }, { sanitize: noopSanitize })
    expect(await allowed(undefined)).toEqual({
      ok: false,
      error: {
        code: 'BACKEND_REJECTED', message: 'validation', backendCode: 'CHARACTER_VALIDATION',
        issues: [{ severity: 'error', code: 'REQUIRED', path: '/promptProfile/core', message: '必填' }]
      }
    })

    const denied = createIpcHandler(z.undefined(), z.undefined(), () => {
      throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, 'other', {
        backendCode: 'OTHER_ERROR', currentRevision: 7,
        issues: [{ severity: 'error', code: 'X', path: '/x', message: 'secret' }], rawBody: 'SECRET'
      })
    }, { sanitize: noopSanitize })
    expect(await denied(undefined)).toEqual({ ok: false, error: { code: 'BACKEND_REJECTED', message: 'other', backendCode: 'OTHER_ERROR' } })

    const revision = createIpcHandler(z.undefined(), z.undefined(), () => {
      throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, 'conflict', {
        backendCode: 'CHARACTER_REVISION_CONFLICT', currentRevision: 4,
        issues: [{ severity: 'error', code: 'NO', path: '/x', message: 'not allowed here' }]
      })
    }, { sanitize: noopSanitize })
    expect(await revision(undefined)).toEqual({ ok: false, error: { code: 'BACKEND_REJECTED', message: 'conflict', backendCode: 'CHARACTER_REVISION_CONFLICT', currentRevision: 4 } })
  })
  it('合法入参 → ok:true 带 data', async () => {
    const h = createIpcHandler(z.undefined(), z.object({ name: z.string() }), () => ({ name: 'Cyrene' }), { sanitize: noopSanitize })
    expect(await h(undefined)).toEqual({ ok: true, data: { name: 'Cyrene' } })
  })
  it('非法入参 → SCHEMA_VALIDATION_FAILED', async () => {
    const h = createIpcHandler(z.string(), z.undefined(), () => undefined, { sanitize: noopSanitize })
    expect(await h(42)).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
  })
  it('fn 抛 CyreneError → 提取 code + 脱敏 message', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'open /home/alice/x 失败') }, { sanitize })
    const res = await h(undefined)
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED', message: 'open ~/x 失败' } })
  })
  it('fn 抛 new Error() → UNKNOWN', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new Error('disk full') }, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })
  it('fn 抛 null → UNKNOWN（非对象不崩 catch）', async () => {
    // 原为 `throw null`（only-throw-error：抛的不是 Error）；本用例要的是「catch 到的不是 Error 实例」这条路径，
    // 故包成 Error 并把它作为 cause 保留——executor 的两个结构化分支（CyreneError/ToolServiceError）都不命中，
    // 仍落 UNKNOWN 兜底，语义与原用例一致
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new Error('non-object throw', { cause: null }) }, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })
  it('message 超长 → <message-too-long>（64KB 门在 executor）', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new CyreneError(CyreneErrorCode.UNKNOWN, 'x'.repeat(70000)) }, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { message: '<message-too-long>' } })
  })
  it('响应过 responseSchema 失败 → SCHEMA_VALIDATION_FAILED + 摘要', async () => {
    const h = createIpcHandler(z.undefined(), z.string(), () => ({ bad: true }) as never, { sanitize: noopSanitize })
    const res = await h(undefined)
    expect(res).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    if (!res.ok) expect(res.error.message).toContain('响应校验失败')
  })
  it('responseSchema 校验失败 → SCHEMA_VALIDATION_FAILED + 字段摘要 + 日志(channel/logger 注入)', async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
    const handler = createIpcHandler(z.undefined(), z.object({ ok: z.boolean() }), () => ({ bad: 1 }) as never, { sanitize: (m) => m, channel: 'chat:get-state', logger: logger })
    const res = await handler(undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) { expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED'); expect(res.error.message).toContain('响应校验失败'); expect(res.error.message).toContain('ok') }
    expect(logger.error).toHaveBeenCalledWith('ipc:response-invalid', expect.objectContaining({ channel: 'chat:get-state' }))
  })
  it('不传 logger/channel 也正常(向后兼容)', async () => {
    const h = createIpcHandler(z.undefined(), z.object({ ok: z.boolean() }), () => ({ bad: 1 }) as never, { sanitize: noopSanitize })
    const res = await h(undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('CyreneError.details 的公开契约字段上提进 IpcErrorBody', async () => {
    const fn = () => { throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '队列已满', { backendCode: 'QUEUE_FULL', retryable: true, clientRequestId: 'cr-1', retryAfterMs: 1000, idempotencyDurable: false, backendDetails: { secret: 'not-forwarded' } }) }
    const handler = createIpcHandler(z.undefined(), z.unknown(), fn, { sanitize: (s: string) => s })
    const res = await handler(undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('BACKEND_REJECTED')
      expect(res.error.backendCode).toBe('QUEUE_FULL')
      expect(res.error.retryable).toBe(true)
      expect(res.error.clientRequestId).toBe('cr-1')
      expect(res.error.retryAfterMs).toBe(1000)
      expect(res.error.idempotencyDurable).toBe(false)
      expect(res.error).not.toHaveProperty('backendDetails')
    }
  })
  it('兼容 details.code（error 帧路径）', async () => {
    const fn = () => { throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'x', { code: 'BAD_FRAME' }) }
    const handler = createIpcHandler(z.undefined(), z.unknown(), fn, { sanitize: (s: string) => s })
    const res = await handler(undefined)
    if (!res.ok) expect(res.error.backendCode).toBe('BAD_FRAME')
  })
  it('批次 C（Task 6 review LOW-3）：fn 抛 ToolServiceError → code 原样上提 + message 经 sanitize（GRANT_NOT_FOUND/TOOL_STATE_INVALID 穿透）', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new ToolServiceError('GRANT_NOT_FOUND', 'grant 不存在') }, { sanitize: noopSanitize })
    const res = await h(undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('GRANT_NOT_FOUND')   // 工具域错误码原样上提（F-17/V-28——非 CyreneError 时不再落 UNKNOWN）
      expect(res.error.message).toBe('grant 不存在')
    }
    const h2 = createIpcHandler(z.undefined(), z.undefined(), () => { throw new ToolServiceError('TOOL_STATE_INVALID', 'callId 不在等待授权态') }, { sanitize })
    const res2 = await h2(undefined)
    if (!res2.ok) {
      expect(res2.error.code).toBe('TOOL_STATE_INVALID')
      expect(res2.error.message).toBe('callId 不在等待授权态')   // 无敏感路径字样（sanitize 无命中）
    }
  })
})
