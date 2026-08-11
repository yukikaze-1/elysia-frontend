// apps/desktop/src/main/ipc/executor.ts
import { type ZodType } from 'zod'
import { type IpcResult } from '@shared/contracts'
import { CyreneError } from '@shared/errors'
import type { MessageSanitizer } from '../diagnostics/sanitize'

function truncateCodepoints(s: string, max: number): string {
  let count = 0
  let out = ''
  for (const ch of s) {
    if (count >= max) break
    out += ch
    count++
  }
  return out
}

export function createIpcHandler<TReq, TRes>(
  requestSchema: ZodType<TReq>,
  responseSchema: ZodType<TRes>,
  fn: (req: TReq) => TRes | Promise<TRes>,
  options: { sanitize: MessageSanitizer }
): (raw: unknown) => Promise<IpcResult<TRes>> {
  return async (raw: unknown): Promise<IpcResult<TRes>> => {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: '参数校验失败' } }
    try {
      const data = await fn(parsed.data)
      const out = responseSchema.safeParse(data)
      if (!out.success) return { ok: false, error: { code: 'UNKNOWN', message: '内部错误' } }
      return { ok: true, data: out.data }
    } catch (e: unknown) {
      if (e instanceof CyreneError && typeof e.code === 'string' && typeof e.message === 'string') {
        const msg = e.message.length > 65536 ? '<message-too-long>' : truncateCodepoints(options.sanitize(e.message), 500)
        // 结构化上提：details.backendCode/retryable/requestId 进入 IpcErrorBody（跨 contextBridge 仅 message 保真，前置拼接由 preload formatIpcError 负责）
        const details = (e.details ?? {}) as { backendCode?: string; code?: string; retryable?: boolean; requestId?: string }
        const backendCode = details.backendCode ?? details.code   // 兼容既有 error 帧路径 details.code
        const error: { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string } = { code: e.code, message: msg }
        if (backendCode) error.backendCode = backendCode
        if (typeof details.retryable === 'boolean') error.retryable = details.retryable
        if (details.requestId) error.requestId = details.requestId
        return { ok: false, error }
      }
      return { ok: false, error: { code: 'UNKNOWN', message: '内部错误' } }
    }
  }
}
