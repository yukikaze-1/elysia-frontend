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
  TOOL_UPLOAD_FAILED = 'TOOL_UPLOAD_FAILED',
  /**
   * H-11b renderer 半边（2026-09-13）：本地持久化进入**降级态**（损坏文件隔离失败 → 拒绝一切写入以保现场）。
   * 与 `PERSISTENCE_WRITE_FAILED`（单次写失败）不同，这是**本进程内不会自愈**的持续状态，
   * 此前只到「Main 拒绝写入 + 日志/诊断计数」，Renderer 收到的是一句泛化的 `UNKNOWN/内部错误`
   * ——用户看不到「草稿其实没存住」，故单列一码供 UI 区分并给出正确的建议（重启前先备份）。
   */
  PERSISTENCE_DEGRADED = 'PERSISTENCE_DEGRADED',
  /**
   * H-11b renderer 半边（2026-09-13）：一次写入失败（磁盘满/权限/只读目录等）。
   * message 只带 errno 码，**不带任何路径**（Main 是路径边界，见 docs/07）。
   */
  PERSISTENCE_WRITE_FAILED = 'PERSISTENCE_WRITE_FAILED',
  /**
   * M-19（2026-09-13）：**设置**保存失败（settings.json 写不进去）。
   * 与会话域的 `PERSISTENCE_WRITE_FAILED` 分开，是为了让 UI 能说"设置没保存"而不是
   * "草稿/缓存没保存"——两类改动在用户眼里是不同的事。同样只带 errno 码、不带路径。
   * 注：设置域**隔离失败**（降级、不可自愈）复用 `PERSISTENCE_DEGRADED`，不另立码——
   * 那句话（"本地保存已停用…为避免覆盖现场已停止一切写入"）对两个域同样成立。
   */
  SETTINGS_SAVE_FAILED = 'SETTINGS_SAVE_FAILED'
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
