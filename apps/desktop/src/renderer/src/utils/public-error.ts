// src/renderer/src/utils/public-error.ts
// 反解 desktop-api 跨 contextBridge 错误 message 前缀（Electron contextBridge 只保真 message）：
// '[code] [k=v]... message' → { code, message, ... }（message 剥离 [k=v] 段，如 '401 [detail]' 的 [detail] 非 k=v 不剥离）。

export interface PublicError {
  code: string
  message: string
  backendCode?: string
  retryable?: boolean
  requestId?: string
  clientRequestId?: string
  retryAfterMs?: number
  idempotencyDurable?: boolean
  currentRevision?: number
  issues?: Array<{ severity: 'error' | 'warning'; code: string; path: string; message: string }>
}

export function parsePublicError(message: string): PublicError {
  const text = message.startsWith('[') ? message : `[UNKNOWN] ${message}`
  const endBracket = text.indexOf(']')
  const code = endBracket > 0 ? text.slice(1, endBracket) : 'UNKNOWN'
  const rest = endBracket > 0 ? text.slice(endBracket + 1).trim() : text
  const out: PublicError = { code, message: rest }
  const kvRe = /\[([a-zA-Z]+)=([^\]]+)\]\s*/g
  let stripped = rest
  let m: RegExpExecArray | null
  while ((m = kvRe.exec(rest)) !== null) {
    stripped = stripped.replace(m[0], '')
    if (m[1] === 'backendCode') out.backendCode = m[2]
    else if (m[1] === 'retryable') out.retryable = m[2] === 'true'
    else if (m[1] === 'requestId') out.requestId = m[2]
    else if (m[1] === 'clientRequestId') out.clientRequestId = m[2]
    else if (m[1] === 'retryAfterMs') {
      const value = Number(m[2])
      if (Number.isFinite(value)) out.retryAfterMs = value
    } else if (m[1] === 'idempotencyDurable') out.idempotencyDurable = m[2] === 'true'
    else if (m[1] === 'currentRevision') {
      const value = Number(m[2])
      if (Number.isSafeInteger(value) && value >= 1) out.currentRevision = value
    } else if (m[1] === 'issues' && m[2].length <= 32_768) {
      try {
        const decoded: unknown = JSON.parse(decodeURIComponent(m[2]))
        if (Array.isArray(decoded) && decoded.length <= 20) {
          const issues = decoded.flatMap((item) => {
            if (!item || typeof item !== 'object') return []
            const issue = item as Record<string, unknown>
            if ((issue.severity !== 'error' && issue.severity !== 'warning') || typeof issue.code !== 'string' || typeof issue.path !== 'string' || typeof issue.message !== 'string') return []
            if (issue.code.length > 80 || issue.path.length > 300 || issue.message.length > 500) return []
            if (!issue.path.startsWith('/') || issue.path.includes('\\') || issue.path.includes('://') || /^\/[a-zA-Z]:/.test(issue.path)) return []
            // 2026-09-13（type-aware 全集）：`issue.severity` 已被上面的守卫收窄成字面量联合，但对象字面量
            // 本身没有上下文类型 ⇒ 属性会被拓宽回 `string`。原来靠 `as 'error' | 'warning'` 压住，而那正是
            // `no-unnecessary-type-assertion` 判为"多余"并**自动删掉**的地方（删掉后 typecheck 立刻红）。
            // 改为显式标注的中间量：不再需要断言，也不靠拓宽。
            const severity: 'error' | 'warning' = issue.severity
            return [{ severity, code: issue.code, path: issue.path, message: issue.message }]
          })
          if (issues.length === decoded.length && issues.length) out.issues = issues
        }
      } catch { /* 非法编码/JSON fail closed，不回退暴露原文。 */ }
    }
  }
  out.message = stripped.trim() || rest   // 无 kv 段时 rest 原样
  return out
}
