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
  }
  out.message = stripped.trim() || rest   // 无 kv 段时 rest 原样
  return out
}
