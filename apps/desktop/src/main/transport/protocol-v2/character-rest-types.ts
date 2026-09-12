// —— 多角色 FE-A（character-contract-v1）：角色域 raw REST wire 类型（设计 §6.2）——
// 自包含（不 import shared contracts，类型与领域层禁止混用）；业务字段 camelCase（§6.2.1 冻结）；
// 列表/版本分页固定 {items, has_more, cursor?}；绑定快照固定 characterRevision。
// Main 发往后端的命令体按 §6.2 矩阵展平 draft（无 draft 包装层；preview 保留 {draft,userMessage}）。

/** 绑定快照（session summary/message 内嵌；CHAR-FE-06/07 与领域同形，flag=true 后非 legacy 必填） */
export interface RestCharacterBindingSnapshot {
  characterId: string
  characterInstanceId: string
  characterRevision: number
  displayName: string
  presentation: RestCharacterPresentation
}

export interface RestCharacterPresentation {
  avatarAssetId?: string | null
  live2dModelId?: string | null
  themeColor?: string | null
}

/** GET/PUT /api/me → UserIdentityProfile（CHAR-FE-01；可选自由文本可能为 null，mapper 归一 undefined） */
export interface RestUserIdentityProfile {
  userId: string
  displayName: string
  preferredAddress?: string | null
  pronouns?: string | null
  locale: string
  timezone: string
  initialized: boolean
  defaultCharacterId?: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

/** PUT /api/me 请求体：完整最小身份 + expectedRevision */
export interface RestUpdateMeBody {
  expectedRevision: number
  displayName: string
  preferredAddress?: string
  pronouns?: string
  locale: string
  timezone: string
  defaultCharacterId?: string
}

export interface RestCharacterListQuery {
  source?: 'builtin' | 'custom'
  status?: 'active' | 'archived'
  search?: string
  cursor?: string
  limit?: number
}

/** GET /api/characters/{id}/revisions query；characterId 由路径承载，不混入 query wire。 */
export interface RestCharacterRevisionQuery {
  cursor?: string
  limit?: number
}

/** 角色列表 / 版本列表 raw 分页（CHAR-FE-02；Main 转 Page<T>{items,hasMore,nextCursor?}） */
export interface RestCharacterListResponse {
  items: RestCharacterSummary[]
  has_more: boolean
  cursor?: string
}
export interface RestCharacterRevisionsResponse {
  items: RestCharacterRevisionSummary[]
  has_more: boolean
  cursor?: string
}

export interface RestCharacterSummary {
  characterId: string
  source: 'builtin' | 'custom'
  mutable: boolean
  status: 'active' | 'archived'
  currentRevision: number
  displayName: string
  description: string
  aliases: string[]
  presentation: RestCharacterPresentation
  updatedAt: string
}

export interface RestCharacterPromptProfile {
  corePersonality: string
  relationshipStyle: string
  emotionStyle: string
  speakingStyle: string
  conversationInitiative: string
  examples: RestCharacterExample[]
}
export interface RestCharacterExample {
  user: string
  assistant: string
}

export interface RestCharacterRuntimeDefaults {
  voice: {
    providerId?: string | null
    voiceId?: string | null
  }
  emotion: {
    idleExpressions: string[]
  }
  wakeWords: string[]
  proactive: {
    enabled: boolean
    intervalSeconds: number
    triggers: string[]
  }
}

/** 不可变版本正文（revision authored 字段中的 null 由 mapper 归一 undefined，§6.2.1） */
export interface RestCharacterRevisionContent {
  characterId: string
  revision: number
  schemaVersion: number
  displayName: string
  description: string
  aliases: string[]
  promptProfile: RestCharacterPromptProfile
  runtimeDefaults: RestCharacterRuntimeDefaults
  presentation: RestCharacterPresentation
  openingMessage?: string | null
  checksum: string
  compilerVersion: number
  createdBy: 'system' | 'user' | 'migration'
  createdAt: string
}

/** 详情固定 {summary,current}（CHAR-FE-02/03） */
export interface RestCharacterDetail {
  summary: RestCharacterSummary
  current: RestCharacterRevisionContent
}

export interface RestCharacterRevisionSummary {
  revision: number
  checksum: string
  createdBy: 'system' | 'user' | 'migration'
  createdAt: string
}

/** draft 形状（create/update 请求体展平复用；preview 内嵌保留包装） */
export interface RestCharacterDraft {
  displayName: string
  description: string
  aliases: string[]
  promptProfile: RestCharacterPromptProfile
  runtimeDefaults: RestCharacterRuntimeDefaults
  presentation: RestCharacterPresentation
  openingMessage?: string
}

/** POST /api/characters：wire 顶层完整 draft（§6.2 矩阵） */
export type RestCreateCharacterBody = RestCharacterDraft
/** POST /api/characters/validate：wire 顶层完整 draft（与 create 同形） */
export type RestValidateCharacterBody = RestCharacterDraft

/** PUT /api/characters/{id}：Main 展平 expectedRevision + statePolicy + 完整 draft */
export interface RestUpdateCharacterBody extends RestCharacterDraft {
  expectedRevision: number
  statePolicy: 'preserve' | 'reset_evolution'
}

export interface RestCloneCharacterBody {
  displayName?: string
}

export interface RestRollbackCharacterBody {
  targetRevision: number
  expectedRevision: number
  statePolicy: 'preserve' | 'reset_evolution'
}

/** preview 保留 {draft,userMessage} 包装（§5.7 冻结） */
export interface RestPreviewCharacterBody {
  draft: RestCharacterDraft
  userMessage: string
}

/** POST .../reset-evolution：{expectedStateVersion}（CHAR-FE-15） */
export interface RestResetEvolutionBody {
  expectedStateVersion: number
}

export interface RestCharacterStateImpact {
  statePolicy: 'preserve' | 'reset_evolution'
  affectedInstances: number
  pendingInstances: number
  resetFields: RestResetField[]
}
export type RestResetField = 'self_l2' | 'state_l3' | 'speaking_style_c6' | 'reflector' | 'mood'

/** update/rollback → CharacterMutationResult；archive → CharacterArchiveResult（CHAR-FE-03） */
export interface RestCharacterMutationResult {
  character: RestCharacterDetail
  stateImpact: RestCharacterStateImpact
}
export interface RestCharacterArchiveResult {
  character: RestCharacterSummary
  /** Unknown optional:后端未返回时省略，不以 null 表示缺省。 */
  userProfile?: RestUserIdentityProfile
}

/** validate：无效也是 200 + valid=false；path 为 JSON Pointer（CHAR-FE-04） */
export interface RestCharacterValidationIssue {
  severity: 'error' | 'warning'
  code: string
  path: string
  message: string
}
export interface RestCharacterValidationResult {
  valid: boolean
  issues: RestCharacterValidationIssue[]
  estimatedPromptChars?: number
}

/** preview：{ephemeral:true,reply,model?,usage?}；零持久化副作用（CHAR-FE-05） */
export interface RestCharacterPreviewResult {
  ephemeral: true
  reply: string
  model?: string
  usage?: {
    input?: number
    output?: number
    total?: number
  }
}

/** GET /api/character-instances/{id}/state：身份元数据 + 嵌套公开视图（无 conversationId——同一 instance 可绑多会话，CHAR-FE-09） */
export interface RestCharacterPublicState {
  characterId: string
  characterInstanceId: string
  characterRevision: number
  stateVersion: number
  state: RestCharacterPublicStateView
}
export interface RestCharacterPublicStateView {
  mood: RestCharacterMood
  currentActivity?: string | null
  lastInteractionAt?: string | null
  proactiveEnabled: boolean
  updatedAt: string
}
export interface RestCharacterMood {
  label: string
  intensity: number
  updatedAt: string
}

/** POST .../reset-evolution 响应：resetFields 以后端返回为权威（CHAR-FE-15） */
export interface RestResetEvolutionResult {
  state: RestCharacterPublicState
  resetFields: RestResetField[]
}
