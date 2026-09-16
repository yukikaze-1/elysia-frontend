// apps/desktop/src/main/ipc/executor.ts
import { type ZodType } from 'zod'
import { type IpcResult } from '@shared/contracts'
import { CyreneError } from '@shared/errors'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { ToolServiceError } from '../tools/tool-execution-contract'   // 批次 C（Task 6，F-17）：工具域结构化错误上提（工具域契约 ↔ ipc 单向，无环）

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

const REVISION_DETAIL_CODES = new Set(['CHARACTER_REVISION_CONFLICT', 'USER_PROFILE_REVISION_CONFLICT'])
/** D-2（2026-09-15 裁决「前端补两处」）：状态版本冲突码白名单——此前 `CHARACTER_STATE_VERSION_CONFLICT`
 *  既不在本表也不被 renderer 识别 ⇒ mock 后端发的该码会**静默降级**为泛化错误（用户看不到「版本已变」）。
 *  前端只认 `CHARACTER_STATE_CONFLICT`、mock 发 `CHARACTER_STATE_VERSION_CONFLICT`，两者现同时纳入。 */
const STATE_VERSION_DETAIL_CODES = new Set(['CHARACTER_STATE_VERSION_CONFLICT', 'CHARACTER_STATE_CONFLICT'])
const VALIDATION_DETAIL_CODES = new Set(['CHARACTER_VALIDATION', 'CHARACTER_RESERVED_CONTENT'])

export interface IpcHandlerOptions { sanitize: MessageSanitizer; channel?: string; logger?: Logger }

export function createIpcHandler<TReq, TRes>(
  requestSchema: ZodType<TReq>,
  responseSchema: ZodType<TRes>,
  fn: (req: TReq) => TRes | Promise<TRes>,
  options: IpcHandlerOptions
): (raw: unknown) => Promise<IpcResult<TRes>> {
  return async (raw: unknown): Promise<IpcResult<TRes>> => {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: '参数校验失败' } }
    try {
      const data = await fn(parsed.data)
      const out = responseSchema.safeParse(data)
      if (!out.success) {
        const summary = out.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}:${i.message}`).join('; ')
        // 摘要已限 3 条且只含 path+message，不含 data 全文；channel 可选，缺省时省略字段（LogFields 不允许 undefined）
        options.logger?.error('ipc:response-invalid', { ...(options.channel !== undefined ? { channel: options.channel } : {}), summary })
        return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: `响应校验失败: ${summary}` } }
      }
      return { ok: true, data: out.data }
    } catch (e: unknown) {
      if (e instanceof CyreneError && typeof e.code === 'string' && typeof e.message === 'string') {
        const msg = e.message.length > 65536 ? '<message-too-long>' : truncateCodepoints(options.sanitize(e.message), 500)
        // 结构化上提仅允许公开白名单字段；原始 backendDetails 不跨 contextBridge。
        const details = (e.details ?? {}) as {
          backendCode?: string; code?: string; retryable?: boolean; requestId?: string
          clientRequestId?: string; retryAfterMs?: number; idempotencyDurable?: boolean
          currentRevision?: number
          currentStateVersion?: number
          issues?: unknown
        }
        const backendCode = details.backendCode ?? details.code   // 兼容既有 error 帧路径 details.code
        const error: import('@shared/contracts').IpcErrorBody = { code: e.code, message: msg }
        if (backendCode) error.backendCode = backendCode
        if (typeof details.retryable === 'boolean') error.retryable = details.retryable
        if (details.requestId) error.requestId = details.requestId
        if (details.clientRequestId) error.clientRequestId = details.clientRequestId
        if (typeof details.retryAfterMs === 'number') error.retryAfterMs = details.retryAfterMs
        if (typeof details.idempotencyDurable === 'boolean') error.idempotencyDurable = details.idempotencyDurable
        if (backendCode && REVISION_DETAIL_CODES.has(backendCode) && Number.isSafeInteger(details.currentRevision) && (details.currentRevision ?? 0) >= 1) error.currentRevision = details.currentRevision
        // D-2：状态版本冲突的版本号（同一白名单纪律：仅已知码 + 安全整数 + ≥1 才上提）
        if (backendCode && STATE_VERSION_DETAIL_CODES.has(backendCode) && Number.isSafeInteger(details.currentStateVersion) && (details.currentStateVersion ?? 0) >= 1) error.currentStateVersion = details.currentStateVersion
        if (backendCode && VALIDATION_DETAIL_CODES.has(backendCode) && Array.isArray(details.issues)) {
          const issues = details.issues.slice(0, 20).flatMap((item) => {
            if (!item || typeof item !== 'object') return []
            const issue = item as Record<string, unknown>
            if ((issue.severity !== 'error' && issue.severity !== 'warning') || typeof issue.code !== 'string' || typeof issue.path !== 'string' || typeof issue.message !== 'string') return []
            if (!issue.path.startsWith('/') || issue.path.includes('\\') || issue.path.includes('://') || /^\/[a-zA-Z]:/.test(issue.path)) return []
            // 同 public-error.ts：收窄结果要用显式标注的中间量承接，不能靠 `as`（该断言会被
            // `no-unnecessary-type-assertion` 自动删掉，删掉后对象字面量把 severity 拓宽成 string ⇒ typecheck 红）
            const severity: 'error' | 'warning' = issue.severity
            return [{
              severity,
              code: truncateCodepoints(options.sanitize(issue.code), 80),
              path: truncateCodepoints(options.sanitize(issue.path), 300),
              message: truncateCodepoints(options.sanitize(issue.message), 500)
            }]
          })
          if (issues.length) error.issues = issues
        }
        return { ok: false, error }
      }
      // 批次 C（Task 6，F-17/V-28）：ToolServiceError 结构化上提——工具域错误码（GRANT_NOT_FOUND/TOOL_STATE_INVALID/
      // PATH_UNSAFE 等）须穿透 IPC 供 Renderer 展示；非 CyreneError 子类故单独分支；message 同款脱敏截断。
      if (e instanceof ToolServiceError) {
        const msg = e.message.length > 65536 ? '<message-too-long>' : truncateCodepoints(options.sanitize(e.message), 500)
        return { ok: false, error: { code: e.code, message: msg } }
      }
      return { ok: false, error: { code: 'UNKNOWN', message: '内部错误' } }
    }
  }
}
