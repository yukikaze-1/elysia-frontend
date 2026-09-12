/** 模型服务类型:恰好三类,输入法转写不构成第四类 */
export type ModelServiceType = 'llm' | 'stt' | 'tts'
/** 模型执行位置(区别于 ToolRuntime,模型调用不进入工具状态机) */
export type ModelExecutionLocation = 'backend' | 'desktop' | 'local_worker'
export type ModelProfileSource = 'built_in' | 'custom'
export type ModelCredentialStatus = 'missing' | 'configured' | 'expired'

/** 模型 Profile（可激活模型级展开；id 可直接作为 switch_model.model，spec D-A3） */
export interface ModelProfile {
  id: string                    // 内置 "<provider>/<model>"，custom "custom/<name>"
  type: ModelServiceType
  displayName: string           // provider 名（内置）或 custom name
  source: ModelProfileSource
  provider: string              // test body provider 字段（内置名 或 'custom'）
  model: string                 // test body model 字段（内置 model 名 / custom name）
  models: string[]              // 该 provider 全量模型列表（custom 展示用）
  executionLocation: ModelExecutionLocation
  credentialStatus: ModelCredentialStatus
  enabled: boolean              // ← services.*.enabled（P4-A 仅展示）
  capabilities: string[]        // ← capabilities 键名展开（稳定排序）
  endpointLabel?: string        // custom base_url host 部分（脱敏展示）
  baseUrl?: string              // P4-A final review：custom base_url 全量（scheme/path 保留；非密钥，编辑向导回填用）
  builtIn: boolean              // source 快捷派生（兼容既有消费方）
}

/** 自定义 Profile 保存命令（doc 02 UpsertCustomModelProfileCommand；apiKey 一次性） */
export interface UpsertModelProfileCommand {
  type: ModelServiceType
  name: string                  // custom 条目名
  baseUrl?: string
  apiKey?: string               // 一次性：成功/失败后 Renderer 立即清除
  apiKeyEnv?: string
  models?: string[]
  executionLocation?: ModelExecutionLocation  // 缺省 backend；UI 不发送 desktop/local
  capabilities?: string[]
  makeActive?: boolean          // 保存成功后可选立即切换
}

/** 类型化测试命令（test body 拆 provider/model，spec D-A3/D-A7） */
export interface ModelProfileTestCommand {
  service: ModelServiceType
  provider: string              // 内置名 或 'custom'
  model: string
  level: 'connectivity' | 'usable'
  baseUrl?: string
  apiKey?: string               // 一次性：测试用明文，成功/失败后清除
}

export interface ModelProfileTestResult {
  profileId: string
  service: ModelServiceType
  level: 'connectivity' | 'usable'
  ok: boolean
  latencyMs?: number
  error?: string
  detail?: string
}

/** 激活命令（switch_model 需要 service；由 store 从 profile.type 填） */
export interface ActivateModelProfileCommand {
  profileId: string
  service: ModelServiceType
}

export interface TtsVoice { id: string; name?: string; languages: string[]; capabilities: string[] }
export interface TtsVoiceListResult { voices: TtsVoice[]; current?: string; source: 'static' | 'api'; error?: string }
export interface TtsPreviewCommand { voiceId?: string }   // 领域 camelCase；real-backend 映射 wire {voice_id}
export interface TtsPreviewOutcome { ok: boolean; audioUrl?: string; durationMs?: number; error?: string }
export interface SetTtsVoiceCommand { voice: string }

export interface ActiveModelSelection {
  llmProfileId?: string
  voiceSttProfileId?: string
  ttsProfileId?: string
  dictationSttProfileId?: string    // P4-B 消费；P4-A 仅类型占位
}
