import { createHash } from 'node:crypto'

const SENSITIVE_KEY = /(?:token|secret|password|passwd|authorization|cookie|credential|api[-_]?key)/iu
const PATH_KEY = /(?:^|[-_])(path|appdata|userdata|outputdir|screenshot|cwd|directory)(?:$|[-_])/iu
const ID_KEY = /(?:^|[-_])(?:id|uuid|identifier|marker)(?:$|[-_])/iu

/** Stable, non-reversible label for an opaque ID in evidence. */
export function hashOpaque(value: string): string {
  return `id:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

/**
 * Redact values that may accidentally occur in Playwright/Electron error text.
 * This function intentionally does not try to be a complete secret scanner; the
 * runner never receives a token and the evidence boundary is defence in depth.
 */
export function redactText(value: string, roots: readonly string[] = [], values: readonly string[] = []): string {
  let text = value
  // Values such as the scenario marker may be echoed by a backend error or
  // response.  Replace the exact values before the broader scanners run so
  // they cannot cross the evidence boundary, even when a caller supplied a
  // deliberately unusual but valid opaque marker.
  for (const candidate of values) {
    if (candidate) text = text.split(candidate).join('<redacted>')
  }
  for (const root of roots) {
    if (root) text = text.split(root).join('<path>')
  }
  return text
    .replace(/Bearer\s+[^\s,;\]}\)]+/giu, 'Bearer [REDACTED]')
    .replace(/(?:sk|sess|rk)-[A-Za-z0-9._-]{8,}/gu, '[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/gu, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .replace(/\[requestId=[^\]]+\]/giu, '[requestId=<redacted>]')
    // Windows absolute paths and common Unix home/tmp paths; do not match URLs.
    .replace(/(?<![A-Za-z0-9+.-])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|var|private|mnt)\/)[^\s"'<>()[\]{};,]*/gu, '<path>')
}

function keyKind(key: string | undefined): 'secret' | 'path' | 'id' | 'plain' {
  if (!key) return 'plain'
  if (SENSITIVE_KEY.test(key)) return 'secret'
  if (PATH_KEY.test(key)) return 'path'
  if (ID_KEY.test(key) || /(?:character|conversation|generation|instance|session|request|call)id/iu.test(key)) return 'id'
  return 'plain'
}

export interface EvidenceRedactOptions {
  roots?: readonly string[]
  values?: readonly string[]
}

/** Recursively make arbitrary scenario details safe for a committed/attached summary. */
export function redactForEvidence(value: unknown, options: EvidenceRedactOptions = {}, key?: string): unknown {
  const kind = keyKind(key)
  if (kind === 'secret') return '[REDACTED]'
  if (kind === 'path') return '<path>'
  if (kind === 'id') {
    if (typeof value === 'string') return hashOpaque(value)
    if (value === null || value === undefined) return value
    return '<opaque-id>'
  }
  if (typeof value === 'string') return redactText(value, options.roots ?? [], options.values ?? [])
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => redactForEvidence(item, options))
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redactForEvidence(childValue, options, childKey)
    }
    return output
  }
  // 走到这里只剩 function／symbol／bigint（对象已在上面被递归处理）：
  // 逐支显式处理而不是 `String(value)`——后者在"可能含对象"的类型上会被 `no-base-to-string` 判为
  // 可能产出 '[object Object]'，而显式分支把这件事变成不可能（2026-09-13 type-aware 全集）。
  if (typeof value === 'function') return '[函数]'
  if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString()
  return '[不可序列化的值]'
}

export interface SafeError {
  code?: string
  backendCode?: string | null
  retryable?: boolean
  message: string
}

/** Keep only actionable error semantics, never request IDs, paths, or credentials. */
export function safeError(cause: unknown, roots: readonly string[] = [], values: readonly string[] = []): SafeError {
  const raw = redactText(String(cause), roots, values)
  return {
    backendCode: raw.match(/\[backendCode=([^\]]+)\]/iu)?.[1] ?? null,
    retryable: /\[retryable=true\]/iu.test(raw),
    message: raw.replace(/^Error:\s*(?:page\.evaluate:\s*Error:\s*)?/u, '').slice(0, 1000)
  }
}
