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

/** 模型 Profile 凭据元数据（阶段 4 模型密钥 UI 消费）：Renderer 只见状态,永远看不到明文。
 *  注意区别于 contracts/credentials.ts 的 4 值 `CredentialStatus`（unavailable/locked/empty/available）——
 *  此处是模型 Profile 的凭据详情元数据，两者命名曾冲突，本类型更名为 ModelCredentialInfo 避免 barrel 重名。 */
export interface ModelCredentialInfo {
  configured: boolean
  originLabel?: string
  expiresAt?: string
  accountLabel?: string
}
