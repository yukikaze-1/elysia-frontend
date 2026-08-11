// apps/desktop/tests/unit/ipc-executor.spec.ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'

const sanitize = (m: string): string => m.replace(/\/home\/alice/g, '~')
const noopSanitize = (m: string): string => m

describe('createIpcHandler', () => {
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
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw null }, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })
  it('message 超长 → <message-too-long>（64KB 门在 executor）', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new CyreneError(CyreneErrorCode.UNKNOWN, 'x'.repeat(70000)) }, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { message: '<message-too-long>' } })
  })
  it('响应过 responseSchema 失败 → UNKNOWN', async () => {
    const h = createIpcHandler(z.undefined(), z.string(), () => ({ bad: true }) as never, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })
  it('CyreneError.details 的 backendCode/retryable/requestId 上提进 IpcErrorBody', async () => {
    const fn = () => { throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '队列已满', { backendCode: 'QUEUE_FULL', retryable: true }) }
    const handler = createIpcHandler(z.undefined(), z.unknown(), fn, { sanitize: (s: string) => s })
    const res = await handler(undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('BACKEND_REJECTED')
      expect(res.error.backendCode).toBe('QUEUE_FULL')
      expect(res.error.retryable).toBe(true)
    }
  })
  it('兼容 details.code（error 帧路径）', async () => {
    const fn = () => { throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'x', { code: 'BAD_FRAME' }) }
    const handler = createIpcHandler(z.undefined(), z.unknown(), fn, { sanitize: (s: string) => s })
    const res = await handler(undefined)
    if (!res.ok) expect(res.error.backendCode).toBe('BAD_FRAME')
  })
})
