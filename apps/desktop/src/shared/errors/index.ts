/** 公开错误码:跨进程传输时只暴露 code + message,不泄漏堆栈与秘密参数 */
export enum CyreneErrorCode {
  UNKNOWN = 'UNKNOWN',
  INVALID_INPUT = 'INVALID_INPUT',
  SCHEMA_VALIDATION_FAILED = 'SCHEMA_VALIDATION_FAILED',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  PROTOCOL_MISMATCH = 'PROTOCOL_MISMATCH',
  NOT_CONNECTED = 'NOT_CONNECTED',
  GENERATION_CONFLICT = 'GENERATION_CONFLICT',
  CREDENTIAL_UNAVAILABLE = 'CREDENTIAL_UNAVAILABLE',
  CREDENTIAL_LOCKED = 'CREDENTIAL_LOCKED',
  UNSUPPORTED_VERSION = 'UNSUPPORTED_VERSION',
  TIMEOUT = 'TIMEOUT',
  NOT_FOUND = 'NOT_FOUND',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  BACKEND_REJECTED = 'BACKEND_REJECTED'
}

export class CyreneError extends Error {
  readonly code: CyreneErrorCode
  readonly details?: unknown

  constructor(code: CyreneErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'CyreneError'
    this.code = code
    this.details = details
  }
}
