// —— 多角色 FE-A（character-contract-v1，docs/Cyrene-多角色与自定义角色前端架构设计 §5）——
// 角色域前端领域契约：Renderer 只消费这些类型（经 Main mapper 归一化），不接触 raw wire。
// 冻结点（§19）：raw 分页 {items,has_more,cursor?} 只在 Main 转 Page<T>；绑定/公开状态一律用
// characterRevision（无含义模糊的顶层 revision）；CharacterStatePolicy 只取 preserve|reset_evolution。
import type { Page } from './conversation'

// —— §5.1 ID 与基础枚举（V1 继续 string，不引入 branded type；ID 一律 .min(1)，不用 displayName 代替）——
export type CharacterId = string
export type CharacterInstanceId = string
export type CharacterSource = 'builtin' | 'custom'
export type CharacterStatus = 'active' | 'archived'
export type CharacterStatePolicy = 'preserve' | 'reset_evolution'

export interface CharacterListQuery {
  source?: CharacterSource
  status?: CharacterStatus
  search?: string
  cursor?: string
  limit?: number
}

export interface CharacterRevisionQuery {
  characterId: CharacterId
  cursor?: string
  limit?: number
}

// Page<T> 复用 contracts/conversation.ts 领域形状（items/hasMore/nextCursor?）；raw has_more/cursor 差异只在 Main mapper 消化。

// —— §5.2 类型化后端能力（wire character_profiles/character_state_stream === true 才映射 true；
// 缺省、字符串 "true"、数字 1 或其他形状一律 false；新连接整体替换，不做浅 merge）——
export interface BackendFeatureFlags {
  characterProfiles: boolean
  characterStateStream: boolean
}

// —— §5.3 用户身份档案（不增加生日/性别/真实姓名/住址等顺手收集字段；pronouns 自由文本）——
export interface UserIdentityProfile {
  userId: string
  displayName: string
  preferredAddress?: string
  pronouns?: string
  locale: string
  timezone: string
  initialized: boolean
  defaultCharacterId?: CharacterId
  revision: number
  createdAt: string
  updatedAt: string
}

/** PUT /api/me 完整最小身份替换：省略 preferredAddress/pronouns 表示清空，省略 defaultCharacterId 表示用内置默认角色 */
export interface UpdateUserIdentityCommand {
  expectedRevision: number
  displayName: string
  preferredAddress?: string
  pronouns?: string
  locale: string
  timezone: string
  defaultCharacterId?: CharacterId
}

// —— §5.4 表现与运行默认值（live2dModelId 是注册表 ID 不是路径；avatarAssetId 无受管解析端点前只显示占位）——
export interface CharacterPresentation {
  avatarAssetId?: string
  live2dModelId?: string
  themeColor?: string
}

export interface CharacterRuntimeDefaults {
  voice: {
    providerId?: string
    voiceId?: string
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

// —— §5.5 Prompt 档案与示例（用户 authored 数据；不是完整 System Prompt，
// 前端不得增加自定义 F1/F2/F3、Jinja 模板或原始 system prompt 输入框）——
export interface CharacterExample {
  user: string
  assistant: string
}

export interface CharacterPromptProfile {
  corePersonality: string
  relationshipStyle: string
  emotionStyle: string
  speakingStyle: string
  conversationInitiative: string
  examples: CharacterExample[]
}

// —— §5.6 角色摘要、详情与不可变版本（完整 authored 内容只在详情/编辑时加载，不随列表全量下发）——
export interface CharacterSummary {
  characterId: CharacterId
  source: CharacterSource
  mutable: boolean
  status: CharacterStatus
  currentRevision: number
  displayName: string
  description: string
  aliases: string[]
  presentation: CharacterPresentation
  updatedAt: string
}

export interface CharacterRevisionContent {
  characterId: CharacterId
  revision: number
  schemaVersion: number
  displayName: string
  description: string
  aliases: string[]
  promptProfile: CharacterPromptProfile
  runtimeDefaults: CharacterRuntimeDefaults
  presentation: CharacterPresentation
  openingMessage?: string
  checksum: string
  compilerVersion: number
  createdBy: 'system' | 'user' | 'migration'
  createdAt: string
}

export interface CharacterDetail {
  summary: CharacterSummary
  current: CharacterRevisionContent
}

export interface CharacterRevisionSummary {
  revision: number
  checksum: string
  createdBy: 'system' | 'user' | 'migration'
  createdAt: string
}

// —— §5.7 编辑草稿与保存命令（完整 draft 保存，不做字段级 PATCH；wire 上 Main 展平 draft，无包装层）——
export interface CharacterDraft {
  displayName: string
  description: string
  aliases: string[]
  promptProfile: CharacterPromptProfile
  runtimeDefaults: CharacterRuntimeDefaults
  presentation: CharacterPresentation
  openingMessage?: string
}

export interface CreateCharacterCommand {
  draft: CharacterDraft
}

export interface UpdateCharacterCommand {
  characterId: CharacterId
  expectedRevision: number
  statePolicy: CharacterStatePolicy
  draft: CharacterDraft
}

export interface CloneCharacterCommand {
  characterId: CharacterId
  displayName?: string
}

export interface RollbackCharacterCommand {
  characterId: CharacterId
  targetRevision: number
  expectedRevision: number
  statePolicy: CharacterStatePolicy
}

/** V1 reset 范围字段（后端返回权威列表，前端不得自行猜测重置范围） */
export type ResetField =
  | 'self_l2'
  | 'state_l3'
  | 'speaking_style_c6'
  | 'reflector'
  | 'mood'

/** affectedInstances=应受本次 revision 影响的 follow_latest instance 总数；pendingInstances=其中尚待原子应用的子集 */
export interface CharacterStateImpact {
  statePolicy: CharacterStatePolicy
  affectedInstances: number
  pendingInstances: number
  resetFields: ResetField[]
}

export interface CharacterMutationResult {
  character: CharacterDetail
  stateImpact: CharacterStateImpact
}

export interface CharacterArchiveResult {
  character: CharacterSummary
  userProfile?: UserIdentityProfile
}

// —— §5.8 校验与预览（validate 无效也是 200 + valid=false；preview 零持久化副作用，不进消息缓存/TTS/Live2D）——
export interface CharacterValidationIssue {
  severity: 'error' | 'warning'
  code: string
  /** JSON Pointer，如 /promptProfile/corePersonality */
  path: string
  message: string
}

export interface CharacterValidationResult {
  valid: boolean
  issues: CharacterValidationIssue[]
  estimatedPromptChars?: number
}

export interface CharacterPreviewCommand {
  draft: CharacterDraft
  userMessage: string
}

export interface CharacterPreviewResult {
  ephemeral: true
  reply: string
  model?: string
  usage?: {
    input?: number
    output?: number
    total?: number
  }
}

// —— §12.3 未提交角色草稿（仅 Main 本地恢复，不进入 SessionStore/消息缓存）——
export type CharacterEditorMode = 'create' | 'edit' | 'clone'

/** 恢复列表只返回摘要；不得把 authored prompt 放入列表响应。 */
export interface CharacterDraftSummary {
  key: string
  mode: CharacterEditorMode
  characterId?: CharacterId
  baseRevision?: number
  displayName: string
  updatedAt: string
}

/** 本地草稿完整记录；`characterId` 是 edit/clone 的来源角色，create 时省略。
 * statePolicy 仅存于完整记录（列表摘要不暴露）；旧版本缺省按 preserve 恢复。 */
export interface PersistedCharacterDraft extends CharacterDraftSummary {
  draft: CharacterDraft
  statePolicy?: CharacterStatePolicy
}

// —— §5.9 会话角色绑定摘要（迁移期 optional；character_profiles=true 后新建/已迁移会话必带，
// 缺失视为契约错误，不回退猜测）——
export interface CharacterBindingSnapshot {
  characterId: CharacterId
  characterInstanceId: CharacterInstanceId
  characterRevision: number
  displayName: string
  presentation: CharacterPresentation
}

// —— §5.10 消息与 generation 的角色审计（assistant 消息保存实际生成时快照；user/tool 通常省略；
// 兜底显示「角色」，绝不硬编码 Cyrene/Elysia）——
export interface CharacterGenerationRef {
  characterId: CharacterId
  characterInstanceId: CharacterInstanceId
  characterRevision: number
  displayName?: string
  presentation?: CharacterPresentation
}

// —— §5.11 公开状态（characterRevision 管内容版本、stateVersion 管演化 CAS；REST snapshot 不带 conversationId）——
export interface CharacterMood {
  label: string
  /** [0,1] 轻量表现用；不得推导亲密度或关系等级 */
  intensity: number
  updatedAt: string
}

export interface CharacterPublicStateView {
  mood?: CharacterMood
  currentActivity?: string
  lastInteractionAt?: string
  proactiveEnabled: boolean
  updatedAt: string
}

export interface CharacterPublicState extends CharacterPublicStateView {
  characterId: CharacterId
  characterInstanceId: CharacterInstanceId
  characterRevision: number
  stateVersion: number
}

export interface ResetCharacterEvolutionCommand {
  characterInstanceId: CharacterInstanceId
  expectedStateVersion: number
}

export interface ResetCharacterEvolutionResult {
  state: CharacterPublicState
  resetFields: ResetField[]
}

// —— §6.1 CharacterBackendPort（FE-A 先冻结形状；FE-B 把它接入 BackendAdapter 组合并实现 Main service。
// CharacterService 只依赖此接口，测试可注入 fake；MockBackend/RealBackend 分别实现）——
export interface CharacterBackendPort {
  getMe(): Promise<UserIdentityProfile>
  updateMe(input: UpdateUserIdentityCommand): Promise<UserIdentityProfile>

  listCharacters(input: CharacterListQuery): Promise<Page<CharacterSummary>>
  getCharacter(characterId: string): Promise<CharacterDetail>
  createCharacter(input: CreateCharacterCommand): Promise<CharacterDetail>
  updateCharacter(input: UpdateCharacterCommand): Promise<CharacterMutationResult>
  cloneCharacter(input: CloneCharacterCommand): Promise<CharacterDetail>
  archiveCharacter(characterId: string): Promise<CharacterArchiveResult>
  listCharacterRevisions(input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>>
  rollbackCharacter(input: RollbackCharacterCommand): Promise<CharacterMutationResult>
  validateCharacter(draft: CharacterDraft): Promise<CharacterValidationResult>
  previewCharacter(input: CharacterPreviewCommand): Promise<CharacterPreviewResult>

  getCharacterState(instanceId: string): Promise<CharacterPublicState>
  resetCharacterEvolution(input: ResetCharacterEvolutionCommand): Promise<ResetCharacterEvolutionResult>
}
