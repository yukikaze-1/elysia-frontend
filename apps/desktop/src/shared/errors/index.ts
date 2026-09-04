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
  CREDENTIAL_STORE_CLOSED = 'CREDENTIAL_STORE_CLOSED',
  TIMEOUT = 'TIMEOUT',
  NOT_FOUND = 'NOT_FOUND',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  BACKEND_REJECTED = 'BACKEND_REJECTED',
  DRAFT_LIMIT_EXCEEDED = 'DRAFT_LIMIT_EXCEEDED',   // G2：单草稿 UTF-8 >100KB（Main 权威校验）
  CHARACTER_DRAFT_STORAGE_UNAVAILABLE = 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE', // FE-D2：角色草稿本地存储失败
  IPC_MESSAGE_TOO_LARGE = 'IPC_MESSAGE_TOO_LARGE',  // G2：单条 IPC 消息超 MAX_IPC_MESSAGE_BYTES（docs/07 §6.3）
  /** 语音族 IPC 错误码（Task 3 R-S4-03，对齐 wire VoiceErrorCode）：录音 discard recordingId 不匹配（另一录音活跃）→ 拒绝不误清 */
  VOICE_RECORDING_NOT_FOUND = 'VOICE_RECORDING_NOT_FOUND',
  /** 语音族 IPC 错误码（Task 3 R-S4-03，对齐 wire VoiceErrorCode）：realtime/dictation 活跃时 discard 普通录音 → 拒绝不动 */
  VOICE_SESSION_CONFLICT = 'VOICE_SESSION_CONFLICT',
  /** 阶段 6 批次 B（Task 5）：工具附件上传失败（uploadToolAttachment REST 上传非 2xx / 未连接缺 connectionId） */
  TOOL_UPLOAD_FAILED = 'TOOL_UPLOAD_FAILED'
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
