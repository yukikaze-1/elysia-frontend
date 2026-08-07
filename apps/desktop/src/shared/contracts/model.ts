/** 模型服务类型:恰好三类,输入法转写不构成第四类 */
export type ModelServiceType = 'llm' | 'stt' | 'tts'

/** 模型执行位置(区别于 ToolRuntime,模型调用不进入工具状态机) */
export type ModelExecutionLocation = 'backend' | 'desktop' | 'local_worker'

/** 模型 Profile(前端可见的非敏感配置) */
export interface ModelProfile {
  id: string
  type: ModelServiceType
  provider: string
  modelId: string
  executionLocation: ModelExecutionLocation
  builtIn: boolean
  name: string
}

/** 凭据状态:Renderer 只见状态,永远看不到明文 */
export interface CredentialStatus {
  configured: boolean
  originLabel?: string
  expiresAt?: string
  accountLabel?: string
}
