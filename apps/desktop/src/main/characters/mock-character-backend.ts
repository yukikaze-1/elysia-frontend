import type {
  CharacterDetail,
  CharacterArchiveResult,
  CharacterBindingSnapshot,
  CharacterDraft,
  CharacterListQuery,
  CharacterMutationResult,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterPublicState,
  CharacterRevisionQuery,
  CharacterRevisionSummary,
  CharacterSummary,
  CharacterValidationResult,
  CloneCharacterCommand,
  CreateCharacterCommand,
  ResetCharacterEvolutionCommand,
  ResetCharacterEvolutionResult,
  RollbackCharacterCommand,
  UpdateCharacterCommand,
  UpdateUserIdentityCommand,
  UserIdentityProfile
} from '@shared/contracts'
import type { Page } from '@shared/contracts/conversation'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import {
  CharacterDetailSchema,
  CharacterArchiveResultSchema,
  CharacterDraftSchema,
  CharacterMutationResultSchema,
  CharacterPreviewCommandSchema,
  CharacterPreviewResultSchema,
  CharacterPublicStateSchema,
  CharacterRevisionSummarySchema,
  CharacterValidationResultSchema,
  CloneCharacterCommandSchema,
  CreateCharacterCommandSchema,
  ResetCharacterEvolutionCommandSchema,
  ResetCharacterEvolutionResultSchema,
  RollbackCharacterCommandSchema,
  UpdateCharacterCommandSchema,
  UpdateUserIdentityCommandSchema,
  UserIdentityProfileSchema
} from '@shared/schemas'
import type { CharacterServiceBackendPort } from './character-backend-port'
import { cloneValue } from '@shared/domain'

const MOCK_NOW = '2026-08-31T00:00:00.000Z'

export const MOCK_CHARACTER_BACKEND_CODES = {
  invalidCursor: 'CHARACTER_CURSOR_INVALID',
  profileRevisionConflict: 'USER_PROFILE_REVISION_CONFLICT',
  defaultCharacterInvalid: 'USER_PROFILE_DEFAULT_CHARACTER_INVALID',
  revisionConflict: 'CHARACTER_REVISION_CONFLICT',
  immutable: 'CHARACTER_IMMUTABLE',
  notFound: 'CHARACTER_NOT_FOUND',
  archived: 'CHARACTER_ARCHIVED'
} as const

function invalidData(label: string, details: unknown): never {
  throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, `Mock 角色数据无效: ${label}`, details)
}

function parseStrict<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown } }, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  return invalidData(label, result.error)
}

export interface MockCharacterBackendOptions {
  /** 供单测确定时间；生产 mock 缺省使用固定 UTC 时间，避免数据随时钟漂移。 */
  now?: () => string
  /** 单测/Story 可注入未初始化档案；仍会经过完整 strict schema。 */
  initialProfile?: Partial<UserIdentityProfile>
}

/**
 * 隔离的角色 Mock 端口。
 *
 * 它不扩展聊天 MockBackend，也不改变 RealBackend。所有内置数据先经过严格
 * domain schema，再在每次返回时深拷贝，防止 Renderer/Service 调用方反向改写
 * Mock 的事实源。分页 cursor 是 Mock 自己生成的 opaque offset，仅供开发闭环。
 */
export class MockCharacterBackend implements CharacterServiceBackendPort {
  readonly features = { characterProfiles: true, characterStateStream: true } as const
  private profile: UserIdentityProfile
  private readonly now: () => string
  private readonly characters: CharacterDetail[]
  private readonly histories = new Map<string, CharacterDetail['current'][]>()
  private nextCustomId = 1
  private readonly states: Map<string, CharacterPublicState>
  /** Mock 发出的数字 offset 仍是 opaque：只有本实例为同一查询 scope 签发过才可使用。 */
  private readonly issuedCursorScopes = new Map<string, Set<string>>()

  constructor(options: MockCharacterBackendOptions = {}) {
    this.now = options.now ?? (() => MOCK_NOW)
    const now = this.now()
    const profile = {
      userId: 'user-mock',
      displayName: '旅行者',
      preferredAddress: '你',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      initialized: true,
      defaultCharacterId: 'builtin/elysia',
      revision: 1,
      createdAt: now,
      updatedAt: now
    }
    this.profile = parseStrict(UserIdentityProfileSchema, { ...profile, ...options.initialProfile }, 'profile')

    const elysia = this.makeCharacter({
      id: 'builtin/elysia', name: 'Elysia', aliases: ['爱莉希雅', '爱莉'], color: '#f2a7c6',
      description: '温柔、明亮而善于倾听的陪伴角色。', now,
      prompt: '以温柔、明亮且真诚的方式陪伴用户，优先理解情绪再给出回应。',
      relationship: '把用户视为值得珍惜的朋友，尊重边界并保持平等。',
      speaking: '自然、亲切、简洁，必要时使用轻松的语气。',
      opening: '今天也要好好照顾自己呀。'
    })
    const cyrene = this.makeCharacter({
      id: 'builtin/cyrene', name: 'Cyrene', aliases: ['赛琳'], color: '#8db7f2',
      description: '冷静、可靠，擅长把复杂的事情讲清楚。', now,
      prompt: '先澄清用户真正需要什么，再用可靠、清晰的方式提供帮助。',
      relationship: '把用户视为可以共同解决问题的伙伴，坦诚说明不确定性。',
      speaking: '清晰、稳重、克制，避免不必要的夸张和说教。',
      opening: '我在这里。我们可以从你现在最在意的事情开始。'
    })
    this.characters = [elysia, cyrene]
    for (const detail of this.characters) {
      const initial = { ...cloneValue(detail.current), revision: 1, checksum: `${detail.current.checksum}-initial` }
      this.histories.set(detail.summary.characterId, [initial, cloneValue(detail.current)])
    }
    this.states = new Map([
      ['instance-elysia', this.makeState(elysia, 'instance-elysia', now, '平静', 0.62)],
      ['instance-cyrene', this.makeState(cyrene, 'instance-cyrene', now, '专注', 0.48)]
    ])
  }

  getMe(): Promise<UserIdentityProfile> {
    return Promise.resolve(cloneValue(this.profile))
  }

  /**
   * Mock-only composition seam for the chat adapter.  The chat mock receives
   * immutable binding snapshots, rather than reaching into this character
   * backend or importing its catalog rules.
   */
  getConversationBinding(characterId: string): CharacterBindingSnapshot | undefined {
    const detail = this.characters.find((item) => item.summary.characterId === characterId)
    if (!detail || detail.summary.status !== 'active') return undefined
    const instanceId = this.instanceIdFor(detail.summary.characterId)
    return {
      characterId: detail.summary.characterId,
      characterInstanceId: instanceId,
      characterRevision: detail.current.revision,
      displayName: detail.current.displayName,
      presentation: cloneValue(detail.current.presentation)
    }
  }

  getConversationBindings(): Record<string, CharacterBindingSnapshot> {
    const bindings: Record<string, CharacterBindingSnapshot> = {}
    for (const detail of this.characters) {
      const binding = this.getConversationBinding(detail.summary.characterId)
      if (binding) bindings[detail.summary.characterId] = binding
    }
    return bindings
  }

  updateMe(input: UpdateUserIdentityCommand): Promise<UserIdentityProfile> {
    return Promise.resolve().then(() => {
      const command = parseStrict(UpdateUserIdentityCommandSchema, input, 'update-me')
      if (command.expectedRevision !== this.profile.revision) {
        throw new CyreneError(
          CyreneErrorCode.BACKEND_REJECTED,
          '用户档案已在其他位置更新，请刷新后确认修改',
          { backendCode: MOCK_CHARACTER_BACKEND_CODES.profileRevisionConflict, currentRevision: this.profile.revision }
        )
      }
      if (command.defaultCharacterId !== undefined) {
        const character = this.characters.find((item) => item.summary.characterId === command.defaultCharacterId)
        if (!character || character.summary.status !== 'active') {
          throw new CyreneError(
            CyreneErrorCode.INVALID_INPUT,
            '默认角色必须来自当前 active 角色目录',
            { backendCode: MOCK_CHARACTER_BACKEND_CODES.defaultCharacterInvalid }
          )
        }
      }
      const updatedAt = this.now()
      this.profile = parseStrict(UserIdentityProfileSchema, {
        ...this.profile,
        displayName: command.displayName,
        locale: command.locale,
        timezone: command.timezone,
        initialized: true,
        revision: this.profile.revision + 1,
        updatedAt,
        ...(command.preferredAddress !== undefined ? { preferredAddress: command.preferredAddress } : {}),
        ...(command.pronouns !== undefined ? { pronouns: command.pronouns } : {}),
        ...(command.defaultCharacterId !== undefined ? { defaultCharacterId: command.defaultCharacterId } : {})
      }, 'profile:update')
      if (command.preferredAddress === undefined) delete this.profile.preferredAddress
      if (command.pronouns === undefined) delete this.profile.pronouns
      if (command.defaultCharacterId === undefined) delete this.profile.defaultCharacterId
      return cloneValue(this.profile)
    })
  }

  listCharacters(input: CharacterListQuery = {}): Promise<Page<CharacterSummary>> {
    const search = input.search?.trim().toLocaleLowerCase()
    const candidates = this.characters
      .map((character) => character.summary)
      .filter((summary) => (input.status ? summary.status === input.status : summary.status === 'active'))
      .filter((summary) => input.source ? summary.source === input.source : true)
      .filter((summary) => {
        if (!search) return true
        return [summary.displayName, summary.description, ...summary.aliases]
          .some((part) => part.toLocaleLowerCase().includes(search))
      })
    return Promise.resolve().then(() => this.page(candidates, input.cursor, input.limit, this.listCursorScope(input)))
  }

  getCharacter(characterId: string): Promise<CharacterDetail> {
    const character = this.characters.find((item) => item.summary.characterId === characterId)
    if (!character) return Promise.reject(this.notFound('CHARACTER_NOT_FOUND', `角色不存在: ${characterId}`))
    return Promise.resolve(cloneValue(character))
  }

  createCharacter(input: CreateCharacterCommand): Promise<CharacterDetail> {
    return Promise.resolve().then(() => {
      const command = parseStrict(CreateCharacterCommandSchema, input, 'create-character')
      const id = `custom/mock-${this.nextCustomId++}`
      const detail = this.detailFromDraft(id, command.draft, 1, 'user')
      this.characters.push(detail)
      this.histories.set(id, [cloneValue(detail.current)])
      this.ensureStateFor(detail)   // H-07：自建角色必须同时有公开状态（否则状态卡片永久 CHARACTER_INSTANCE_NOT_FOUND）
      return parseStrict(CharacterDetailSchema, cloneValue(detail), 'create-result')
    })
  }

  updateCharacter(input: UpdateCharacterCommand): Promise<CharacterMutationResult> {
    return Promise.resolve().then(() => {
      const command = parseStrict(UpdateCharacterCommandSchema, input, 'update-character')
      const detail = this.mutableCharacter(command.characterId)
      this.assertRevision(detail, command.expectedRevision)
      const next = this.detailFromDraft(command.characterId, command.draft, detail.current.revision + 1, 'user')
      this.replaceCharacter(next)
      this.histories.get(command.characterId)!.push(cloneValue(next.current))
      // H-07：revision 推进后必须让公开状态跟上——否则 follow_latest 绑定到新 revision 时，
      // 渲染层身份栅栏（state.characterRevision !== expected）必然抛错，且重试不会自愈。
      this.ensureStateFor(next, command.statePolicy)
      return parseStrict(CharacterMutationResultSchema, {
        character: cloneValue(next), stateImpact: this.stateImpact(command.characterId, command.statePolicy)
      }, 'update-result')
    })
  }

  cloneCharacter(input: CloneCharacterCommand): Promise<CharacterDetail> {
    return Promise.resolve().then(() => {
      const command = parseStrict(CloneCharacterCommandSchema, input, 'clone-character')
      const source = this.findCharacter(command.characterId)
      const id = `custom/mock-${this.nextCustomId++}`
      const draft = this.draftFrom(source.current)
      if (command.displayName !== undefined) draft.displayName = command.displayName
      const detail = this.detailFromDraft(id, draft, 1, 'user')
      this.characters.push(detail)
      this.histories.set(id, [cloneValue(detail.current)])
      this.ensureStateFor(detail)   // H-07：克隆出的角色同样必须有公开状态
      return parseStrict(CharacterDetailSchema, cloneValue(detail), 'clone-result')
    })
  }

  archiveCharacter(characterId: string): Promise<CharacterArchiveResult> {
    return Promise.resolve().then(() => {
      const detail = this.mutableCharacter(characterId)
      detail.summary.status = 'archived'
      detail.summary.updatedAt = this.now()
      let userProfile: UserIdentityProfile | undefined
      if (this.profile.defaultCharacterId === characterId) {
        this.profile = parseStrict(UserIdentityProfileSchema, {
          ...this.profile,
          defaultCharacterId: 'builtin/elysia',
          revision: this.profile.revision + 1,
          updatedAt: this.now()
        }, 'archive-profile-fallback')
        userProfile = cloneValue(this.profile)
      }
      return parseStrict(CharacterArchiveResultSchema, {
        character: cloneValue(detail.summary), ...(userProfile ? { userProfile } : {})
      }, 'archive-result')
    })
  }

  rollbackCharacter(input: RollbackCharacterCommand): Promise<CharacterMutationResult> {
    return Promise.resolve().then(() => {
      const command = parseStrict(RollbackCharacterCommandSchema, input, 'rollback-character')
      const detail = this.mutableCharacter(command.characterId)
      this.assertRevision(detail, command.expectedRevision)
      const target = this.histories.get(command.characterId)?.find((item) => item.revision === command.targetRevision)
      if (!target) throw this.notFound('CHARACTER_REVISION_NOT_FOUND', `角色版本不存在: ${command.targetRevision}`)
      const next = this.detailFromDraft(command.characterId, this.draftFrom(target), detail.current.revision + 1, 'user')
      this.replaceCharacter(next)
      this.histories.get(command.characterId)!.push(cloneValue(next.current))
      this.ensureStateFor(next, command.statePolicy)   // H-07：回滚也推进 revision，公开状态必须跟上
      return parseStrict(CharacterMutationResultSchema, {
        character: cloneValue(next), stateImpact: this.stateImpact(command.characterId, command.statePolicy)
      }, 'rollback-result')
    })
  }

  validateCharacter(draft: CharacterDraft): Promise<CharacterValidationResult> {
    const parsed = CharacterDraftSchema.safeParse(draft)
    const issues: CharacterValidationResult['issues'] = parsed.success ? [] : parsed.error.issues.map((issue) => ({
      severity: 'error' as const,
      code: 'CHARACTER_DRAFT_INVALID',
      path: `/${issue.path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`,
      message: issue.message
    }))
    if (parsed.success && parsed.data.description.trim() === '') issues.push({ severity: 'warning', code: 'DESCRIPTION_EMPTY', path: '/description', message: '建议填写角色简介' })
    return Promise.resolve(parseStrict(CharacterValidationResultSchema, {
      valid: !issues.some((issue) => issue.severity === 'error'), issues,
      estimatedPromptChars: parsed.success ? JSON.stringify(parsed.data.promptProfile).length : undefined
    }, 'validate-result'))
  }

  previewCharacter(input: CharacterPreviewCommand): Promise<CharacterPreviewResult> {
    return Promise.resolve().then(() => {
      const command = parseStrict(CharacterPreviewCommandSchema, input, 'preview-character')
      return parseStrict(CharacterPreviewResultSchema, {
        ephemeral: true, reply: `${command.draft.displayName}：我听见了。`
      }, 'preview-result')
    })
  }

  listCharacterRevisions(input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>> {
    const character = this.characters.find((item) => item.summary.characterId === input.characterId)
    if (!character) return Promise.reject(this.notFound('CHARACTER_NOT_FOUND', `角色不存在: ${input.characterId}`))
    const revisions: CharacterRevisionSummary[] = [...(this.histories.get(input.characterId) ?? [])].reverse().map((current) =>
      ({ revision: current.revision, checksum: current.checksum, createdBy: current.createdBy, createdAt: current.createdAt }))
    const validated = revisions.map((revision) => parseStrict(CharacterRevisionSummarySchema, revision, 'revision'))
    return Promise.resolve().then(() => this.page(validated, input.cursor, input.limit, `revisions:${input.characterId}`))
  }

  /**
   * H-07（2026-09-11）：角色 → 实例 id 的**唯一**推导点。
   *
   * 此前该推导内联在 `getConversationBinding` 里，而 `this.states` 只在构造时喂了两个内置实例，
   * 于是 mock 下**每一个用户自建角色**都拿不到公开状态：
   * `createCharacter`/`cloneCharacter` 把角色推进 `characters` 与 `histories`，却**从不写 `states`**，
   * 而会话绑定（`getConversationBinding`）已经指向 `instance-custom-mock-N` ⇒
   * `getCharacterState('instance-custom-mock-1')` 永久 `CHARACTER_INSTANCE_NOT_FOUND`，
   * 公开状态卡片对自建角色永久报错。全仓原本**没有任何** `instance-custom*` 用例，故从未被发现。
   * 现提取为单一来源，创建/克隆/更新三处共用，推导不可能再与绑定分叉。
   */
  private instanceIdFor(characterId: string): string {
    if (characterId === 'builtin/elysia') return 'instance-elysia'
    if (characterId === 'builtin/cyrene') return 'instance-cyrene'
    return `instance-${characterId.replace(/[^A-Za-z0-9_-]/g, '-')}`
  }

  /**
   * 确保该角色**存在**公开状态，并把 `characterRevision` 对齐到角色当前 revision。
   *
   * 第二个缺陷（同属 H-07）：`states` 的 `characterRevision` 在构造时定死、此后**永不更新**，
   * 而 `updateCharacter` 会推进 `detail.current.revision`；follow_latest 绑定到新 revision 后，
   * 渲染层的身份栅栏（`state.characterRevision !== expected.characterRevision`）必然抛错 ⇒
   * 「读取失败且不会自愈」（重试也只在 Main 的 15s TTL 内拿回同一个旧 revision 值）。
   *
   * `statePolicy` 语义与契约一致：`preserve` 保留情绪等演化字段，只推进 revision；
   * `reset_evolution` 额外把情绪重置为初始值（与 resetCharacterEvolution 同款形状）。
   */
  private ensureStateFor(detail: CharacterDetail, statePolicy: 'preserve' | 'reset_evolution' = 'preserve'): void {
    const characterId = detail.summary.characterId
    const instanceId = this.instanceIdFor(characterId)
    const revision = detail.current.revision
    const existing = this.states.get(instanceId)
    const now = this.now()
    if (!existing) {
      // 新角色（create/clone）：建一份初始状态，revision 对齐当前
      this.states.set(instanceId, this.makeState(detail, instanceId, now, '平静', 0.5))
      return
    }
    if (existing.characterRevision === revision && statePolicy === 'preserve') return   // 无需变更
    const next = parseStrict(CharacterPublicStateSchema, {
      ...cloneValue(existing),
      characterRevision: revision,
      stateVersion: existing.stateVersion + 1,
      ...(statePolicy === 'reset_evolution'
        ? { mood: { label: '平静', intensity: 0, updatedAt: now }, currentActivity: '等待交流', lastInteractionAt: now }
        : {}),
      updatedAt: now
    }, `state:${instanceId}`)
    this.states.set(instanceId, next)
  }

  getCharacterState(instanceId: string): Promise<CharacterPublicState> {
    const state = this.states.get(instanceId)
    if (!state) return Promise.reject(this.notFound('CHARACTER_INSTANCE_NOT_FOUND', `角色实例不存在: ${instanceId}`))
    return Promise.resolve(cloneValue(state))
  }

  resetCharacterEvolution(input: ResetCharacterEvolutionCommand): Promise<ResetCharacterEvolutionResult> {
    return Promise.resolve().then(() => {
      const command = parseStrict(ResetCharacterEvolutionCommandSchema, input, 'reset-evolution')
      const current = this.states.get(command.characterInstanceId)
      if (!current) throw this.notFound('CHARACTER_INSTANCE_NOT_FOUND', `角色实例不存在: ${command.characterInstanceId}`)
      if (current.stateVersion !== command.expectedStateVersion) {
        throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '角色状态版本冲突', {
          backendCode: 'CHARACTER_STATE_VERSION_CONFLICT', currentStateVersion: current.stateVersion
        })
      }
      const now = this.now()
      const next = parseStrict(CharacterPublicStateSchema, {
        ...cloneValue(current),
        stateVersion: current.stateVersion + 1,
        mood: { label: '平静', intensity: 0, updatedAt: now },
        currentActivity: '等待交流',
        lastInteractionAt: now,
        updatedAt: now
      }, `state:${command.characterInstanceId}`)
      this.states.set(command.characterInstanceId, next)
      return parseStrict(ResetCharacterEvolutionResultSchema, {
        state: cloneValue(next),
        resetFields: ['self_l2', 'state_l3', 'speaking_style_c6', 'reflector', 'mood']
      }, 'reset-evolution-result')
    })
  }

  private makeCharacter(input: {
    id: string; name: string; aliases: string[]; color: string; description: string; now: string;
    prompt: string; relationship: string; speaking: string; opening: string
  }): CharacterDetail {
    const summary: CharacterSummary = {
      characterId: input.id,
      source: 'builtin',
      mutable: false,
      status: 'active',
      currentRevision: 2,
      displayName: input.name,
      description: input.description,
      aliases: input.aliases,
      presentation: { themeColor: input.color },
      updatedAt: input.now
    }
    const detail: CharacterDetail = {
      summary,
      current: {
        characterId: input.id,
        revision: 2,
        schemaVersion: 1,
        displayName: input.name,
        description: input.description,
        aliases: input.aliases,
        promptProfile: {
          corePersonality: input.prompt,
          relationshipStyle: input.relationship,
          emotionStyle: '',
          speakingStyle: input.speaking,
          conversationInitiative: '',
          examples: [{ user: '我今天有点累。', assistant: '辛苦了。先慢下来，我陪你聊一会儿。' }]
        },
        runtimeDefaults: {
          voice: {},
          emotion: { idleExpressions: ['idle'] },
          wakeWords: [input.name],
          proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
        },
        presentation: { themeColor: input.color },
        openingMessage: input.opening,
        checksum: `mock-${input.id.replace('/', '-')}`,
        compilerVersion: 1,
        createdBy: 'system',
        createdAt: input.now
      }
    }
    parseStrict(CharacterDetailSchema, detail, `character:${input.id}`)
    return detail
  }

  private makeState(character: CharacterDetail, instanceId: string, now: string, label: string, intensity: number): CharacterPublicState {
    const state: CharacterPublicState = {
      characterId: character.summary.characterId,
      characterInstanceId: instanceId,
      characterRevision: character.current.revision,
      stateVersion: 1,
      mood: { label, intensity, updatedAt: now },
      currentActivity: '等待交流',
      lastInteractionAt: now,
      proactiveEnabled: false,
      updatedAt: now
    }
    return parseStrict(CharacterPublicStateSchema, state, `state:${instanceId}`)
  }

  private detailFromDraft(id: string, draftInput: CharacterDraft, revision: number, createdBy: 'user' | 'system'): CharacterDetail {
    const draft = parseStrict(CharacterDraftSchema, draftInput, 'draft')
    const now = this.now()
    return parseStrict(CharacterDetailSchema, {
      summary: {
        characterId: id, source: 'custom', mutable: true, status: 'active', currentRevision: revision,
        displayName: draft.displayName, description: draft.description, aliases: draft.aliases,
        presentation: draft.presentation, updatedAt: now
      },
      current: {
        characterId: id, revision, schemaVersion: 1, ...draft,
        checksum: `mock-${id.replace('/', '-')}-r${revision}`, compilerVersion: 1, createdBy, createdAt: now
      }
    }, `detail:${id}`)
  }

  private draftFrom(content: CharacterDetail['current']): CharacterDraft {
    return parseStrict(CharacterDraftSchema, {
      displayName: content.displayName, description: content.description, aliases: content.aliases,
      promptProfile: content.promptProfile, runtimeDefaults: content.runtimeDefaults,
      presentation: content.presentation, ...(content.openingMessage !== undefined ? { openingMessage: content.openingMessage } : {})
    }, 'revision-draft')
  }

  private findCharacter(id: string): CharacterDetail {
    const detail = this.characters.find((item) => item.summary.characterId === id)
    if (!detail) throw this.notFound(MOCK_CHARACTER_BACKEND_CODES.notFound, `角色不存在: ${id}`)
    return detail
  }

  private mutableCharacter(id: string): CharacterDetail {
    const detail = this.findCharacter(id)
    if (!detail.summary.mutable) throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '内置角色不可修改', { backendCode: MOCK_CHARACTER_BACKEND_CODES.immutable })
    if (detail.summary.status === 'archived') throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '角色已归档', { backendCode: MOCK_CHARACTER_BACKEND_CODES.archived })
    return detail
  }

  private assertRevision(detail: CharacterDetail, expected: number): void {
    if (detail.current.revision !== expected) throw new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '角色版本冲突', {
      backendCode: MOCK_CHARACTER_BACKEND_CODES.revisionConflict, currentRevision: detail.current.revision
    })
  }

  private replaceCharacter(next: CharacterDetail): void {
    const index = this.characters.findIndex((item) => item.summary.characterId === next.summary.characterId)
    this.characters[index] = next
  }

  private stateImpact(characterId: string, statePolicy: 'preserve' | 'reset_evolution') {
    const affectedInstances = [...this.states.values()].filter((state) => state.characterId === characterId).length
    return {
      statePolicy, affectedInstances, pendingInstances: 0,
      resetFields: statePolicy === 'preserve' ? [] : ['self_l2', 'state_l3', 'speaking_style_c6', 'reflector', 'mood']
    }
  }

  private notFound(backendCode: string, message: string): CyreneError {
    return new CyreneError(CyreneErrorCode.NOT_FOUND, message, { backendCode })
  }

  private listCursorScope(input: CharacterListQuery): string {
    return `list:${JSON.stringify({
      source: input.source ?? null,
      status: input.status ?? null,
      search: input.search?.trim().toLocaleLowerCase() ?? null
    })}`
  }

  private parseCursor(cursor: string | undefined, scope: string): number {
    if (cursor === undefined) return 0
    const issuedScopes = this.issuedCursorScopes.get(cursor)
    if (!issuedScopes?.has(scope) || !/^(0|[1-9]\d*)$/.test(cursor)) {
      throw new CyreneError(
        CyreneErrorCode.INVALID_INPUT,
        '角色分页游标无效',
        { backendCode: MOCK_CHARACTER_BACKEND_CODES.invalidCursor }
      )
    }
    const offset = Number(cursor)
    if (!Number.isSafeInteger(offset)) {
      throw new CyreneError(
        CyreneErrorCode.INVALID_INPUT,
        '角色分页游标无效',
        { backendCode: MOCK_CHARACTER_BACKEND_CODES.invalidCursor }
      )
    }
    return offset
  }

  private issueCursor(offset: number, scope: string): string {
    const cursor = String(offset)
    const scopes = this.issuedCursorScopes.get(cursor) ?? new Set<string>()
    scopes.add(scope)
    this.issuedCursorScopes.set(cursor, scopes)
    return cursor
  }

  private page<T>(items: T[], cursor: string | undefined, limit: number | undefined, scope: string): Page<T> {
    const start = this.parseCursor(cursor, scope)
    const size = Math.max(1, Math.min(100, limit ?? 20))
    const selected = items.slice(start, start + size)
    const end = start + selected.length
    return {
      items: cloneValue(selected),
      hasMore: end < items.length,
      ...(end < items.length ? { nextCursor: this.issueCursor(end, scope) } : {})
    }
  }
}
