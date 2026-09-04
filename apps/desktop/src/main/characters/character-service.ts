import type {
  BackendFeatureFlags,
  CharacterDetail,
  CharacterArchiveResult,
  CharacterDraft,
  CharacterId,
  CharacterListQuery,
  CharacterRevisionQuery,
  CharacterRevisionSummary,
  CharacterPublicState,
  CharacterSummary,
  CharacterMutationResult,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterValidationResult,
  CloneCharacterCommand,
  CreateCharacterCommand,
  RollbackCharacterCommand,
  UpdateCharacterCommand,
  UpdateUserIdentityCommand,
  UserIdentityProfile
} from '@shared/contracts'
import type { Page } from '@shared/contracts/conversation'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { CharacterServiceBackendPort } from './character-backend-port'

/** 角色服务向 Renderer/IPC 暴露的稳定 backendCode。 */
export const CHARACTER_SERVICE_BACKEND_CODES = {
  profilesUnavailable: 'CHARACTER_PROFILES_UNAVAILABLE',
  backendUnavailable: 'CHARACTER_BACKEND_UNAVAILABLE',
  staleConnection: 'CHARACTER_CONNECTION_EPOCH_STALE',
  mutationInProgress: 'CHARACTER_MUTATION_IN_PROGRESS'
} as const

export interface CharacterServiceOptions {
  /** 角色领域端口；所有角色/身份能力都通过领域端口收敛，不得传入 transport raw adapter。 */
  backend: CharacterServiceBackendPort
  /** server_info 能力快照。缺省即全部 false（Real 未实现角色 REST 时的安全默认）。 */
  getFeatures?: () => BackendFeatureFlags | undefined
  /** 连接世代。每次新连接/断线/重连必须变化；没有 provider 时可由 setConnectionEpoch 手动驱动。 */
  getConnectionEpoch?: () => number
  /** 单元测试可控时间；默认 Date.now。 */
  now?: () => number
  /** 角色 GET 内存缓存 TTL；默认 15 秒。 */
  cacheTtlMs?: number
}

type CacheEntry = {
  epoch: number
  expiresAt: number
  value: unknown
}

type InFlightEntry = {
  epoch: number
  cacheGeneration: number
  scopeGeneration: number
  promise: Promise<unknown>
}

function cloneValue<T>(value: T): T {
  // Main 运行时为 Node 22；保留 JSON fallback 只为测试环境/旧 Electron 兼容，
  // 不把任何 authored prompt 写入磁盘或日志。
  const structured = (globalThis as { structuredClone?: <V>(input: V) => V }).structuredClone
  if (structured) return structured(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function stableKey(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableKey(object[key])}`).join(',')}}`
}

/** 读取 revisions cache key 的首个必填 characterId，避免用 includes 误判 cursor。 */
function revisionKeyCharacterId(key: string): string | undefined {
  const match = /^revisions:\{"characterId":((?:"(?:\\.|[^"\\])*")|undefined)/.exec(key)
  if (!match || match[1] === 'undefined') return undefined
  try {
    const id: unknown = JSON.parse(match[1])
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

function staleConnectionError(): CyreneError {
  return new CyreneError(
    CyreneErrorCode.NOT_CONNECTED,
    '连接已变化，角色读取结果已丢弃',
    { backendCode: CHARACTER_SERVICE_BACKEND_CODES.staleConnection }
  )
}

/**
 * Main 角色领域服务。
 *
 * 这里是领域端口与 IPC handler 之间唯一的角色编排层：能力门禁、读取缓存、
 * 写入互斥和连接世代保护都在此收敛。它不认识 URL、raw DTO 或 Electron，
 * 也不提供离线队列或乐观 revision。
 */
export class CharacterService {
  private readonly backend: CharacterServiceBackendPort
  private readonly getFeatures?: () => BackendFeatureFlags | undefined
  private readonly getConnectionEpoch?: () => number
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, InFlightEntry>()
  private observedEpoch: number
  /** cache invalidation 的独立代数；不冒充连接 epoch，也不改变错误语义。 */
  private cacheGeneration = 0
  private profileGeneration = 0
  private catalogGeneration = 0
  private stateGeneration = 0
  private readonly characterGenerations = new Map<string, number>()
  /** 未注入连接世代 provider 时的唯一手动事实源。 */
  private ownedEpoch = 0
  private readonly activeMutations = new Map<string, number>()

  constructor(options: CharacterServiceOptions) {
    this.backend = options.backend
    this.getFeatures = options.getFeatures
    this.getConnectionEpoch = options.getConnectionEpoch
    this.now = options.now ?? (() => Date.now())
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 15_000)
    this.observedEpoch = this.readEpoch()
  }

  /** 连接编排方可显式推进世代；推进后旧 cache/in-flight 绝不会污染新连接。 */
  setConnectionEpoch(epoch: number): void {
    if (!Number.isFinite(epoch) || epoch < 0) return
    // 真实宿主注入 getConnectionEpoch 后，provider 是唯一事实源；setter 仅为
    // 没有宿主编排器的 fake/单测保留，避免手动值永久遮蔽后续真实 provider 变化。
    if (this.getConnectionEpoch) {
      this.syncEpoch(this.readEpoch())
      return
    }
    this.ownedEpoch = Math.floor(epoch)
    this.syncEpoch(this.ownedEpoch)
  }

  /** 断线/重连没有可用 connectionId 时的便捷世代推进。 */
  invalidateConnection(): void {
    if (this.getConnectionEpoch) {
      // provider 不能由 service 反向修改；由连接编排器推进，service 只观察。
      this.syncEpoch(this.readEpoch())
      return
    }
    this.setConnectionEpoch(this.ownedEpoch + 1)
  }

  /**
   * 只清空本服务内存 cache；不触碰任何 Renderer 持久化或会话数据。
   *
   * 同时推进独立 cache generation 并解除旧 in-flight 登记：旧请求仍可把结果
   * 返回给它原本的调用方，但不会重新写入 cache，也不会被 clear 后的新读取复用。
   */
  clearCache(): void {
    this.cacheGeneration++
    this.cache.clear()
    this.inFlight.clear()
  }

  getMe(): Promise<UserIdentityProfile> {
    return this.read('profile', () => this.backend.getMe())
  }

  updateMe(input: UpdateUserIdentityCommand): Promise<UserIdentityProfile> {
    try {
      this.requireProfiles()
    } catch (error) {
      return Promise.reject(error)
    }
    const epoch = this.readEpoch()
    this.syncEpoch(epoch)
    return Promise.resolve()
      .then(() => this.backend.updateMe(cloneValue(input)))
      .then((profile) => {
        if (this.readEpoch() !== epoch) throw staleConnectionError()
        this.invalidateProfileAndCatalog()
        return cloneValue(profile)
      })
  }

  createCharacter(input: CreateCharacterCommand): Promise<CharacterDetail> {
    return this.mutate('catalog:create', undefined, () => this.backend.createCharacter(cloneValue(input)), (detail) => {
      this.invalidateCharacter(detail.summary.characterId)
    })
  }

  updateCharacter(input: UpdateCharacterCommand): Promise<CharacterMutationResult> {
    return this.mutate(`character:${input.characterId}`, input.characterId, () => this.backend.updateCharacter(cloneValue(input)))
  }

  cloneCharacter(input: CloneCharacterCommand): Promise<CharacterDetail> {
    return this.mutate(`character:${input.characterId}`, undefined, () => this.backend.cloneCharacter(cloneValue(input)), (detail) => {
      this.invalidateCharacter(detail.summary.characterId)
    })
  }

  archiveCharacter(characterId: CharacterId): Promise<CharacterArchiveResult> {
    return this.mutate(`character:${characterId}`, characterId, () => this.backend.archiveCharacter(characterId), (result) => {
      if (result.userProfile) this.invalidateProfileAndCatalog()
    })
  }

  rollbackCharacter(input: RollbackCharacterCommand): Promise<CharacterMutationResult> {
    return this.mutate(`character:${input.characterId}`, input.characterId, () => this.backend.rollbackCharacter(cloneValue(input)))
  }

  validateCharacter(draft: CharacterDraft): Promise<CharacterValidationResult> {
    return this.epochOperation(() => this.backend.validateCharacter(cloneValue(draft)))
  }

  previewCharacter(input: CharacterPreviewCommand): Promise<CharacterPreviewResult> {
    return this.epochOperation(() => this.backend.previewCharacter(cloneValue(input)))
  }

  listCharacters(input: CharacterListQuery = {}): Promise<Page<CharacterSummary>> {
    return this.read(`catalog:${stableKey(input)}`, () => this.backend.listCharacters(cloneValue(input)))
  }

  getCharacter(characterId: CharacterId): Promise<CharacterDetail> {
    return this.read(`detail:${characterId}`, () => this.backend.getCharacter(characterId))
  }

  listCharacterRevisions(input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>> {
    return this.read(`revisions:${stableKey(input)}`, () => this.backend.listCharacterRevisions(cloneValue(input)))
  }

  getCharacterState(instanceId: string): Promise<CharacterPublicState> {
    return this.read(`state:${instanceId}`, () => this.backend.getCharacterState(instanceId))
  }

  private read<T>(key: string, operation: () => Promise<T>): Promise<T> {
    try {
      this.requireProfiles()
    } catch (error) {
      return Promise.reject(error)
    }
    const epoch = this.readEpoch()
    this.syncEpoch(epoch)
    const cacheGeneration = this.cacheGeneration
    const scopeGeneration = this.scopeGeneration(key)

    const cached = this.cache.get(key)
    if (cached && cached.epoch === epoch && cached.expiresAt > this.now()) {
      return Promise.resolve(cloneValue(cached.value as T))
    }
    if (cached) this.cache.delete(key)

    const pending = this.inFlight.get(key)
    if (pending && pending.epoch === epoch) return pending.promise.then((value) => cloneValue(value as T))

    const promise = Promise.resolve()
      .then(operation)
      .then((value) => {
        // 关键门禁：请求返回前再次读取世代，迟到结果既不写 cache，也不返回给调用方。
        if (this.readEpoch() !== epoch) throw staleConnectionError()
        if (this.cacheGeneration === cacheGeneration && this.scopeGeneration(key) === scopeGeneration) {
          this.cache.set(key, { epoch, expiresAt: this.now() + this.cacheTtlMs, value: cloneValue(value) })
        }
        return cloneValue(value)
      })
      .finally(() => {
        const current = this.inFlight.get(key)
        if (current?.promise === promise) this.inFlight.delete(key)
      })
    this.inFlight.set(key, { epoch, cacheGeneration, scopeGeneration, promise })
    return promise
  }

  private epochOperation<T>(operation: () => Promise<T>): Promise<T> {
    try { this.requireProfiles() } catch (error) { return Promise.reject(error) }
    const epoch = this.readEpoch()
    this.syncEpoch(epoch)
    return Promise.resolve().then(operation).then((value) => {
      if (this.readEpoch() !== epoch) throw staleConnectionError()
      return cloneValue(value)
    })
  }

  private mutate<T>(key: string, characterId: string | undefined, operation: () => Promise<T>, after?: (value: T) => void): Promise<T> {
    const epoch = this.readEpoch()
    this.syncEpoch(epoch)
    if (this.activeMutations.get(key) === epoch) {
      return Promise.reject(new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '角色正在被修改', {
        backendCode: CHARACTER_SERVICE_BACKEND_CODES.mutationInProgress
      }))
    }
    this.activeMutations.set(key, epoch)
    return this.epochOperation(operation).then((value) => {
      if (characterId) this.invalidateCharacter(characterId)
      after?.(value)
      return cloneValue(value)
    }).finally(() => {
      if (this.activeMutations.get(key) === epoch) this.activeMutations.delete(key)
    })
  }

  private requireProfiles(): void {
    if (this.getFeatures?.()?.characterProfiles === true) return
    throw new CyreneError(
      CyreneErrorCode.NOT_IMPLEMENTED,
      '当前后端未启用角色档案能力',
      { backendCode: CHARACTER_SERVICE_BACKEND_CODES.profilesUnavailable }
    )
  }

  /** 档案写成功后只失效 profile/catalog；detail/revision/state 缓存继续有效。 */
  private invalidateProfileAndCatalog(): void {
    this.profileGeneration++
    this.catalogGeneration++
    for (const key of this.cache.keys()) {
      if (key === 'profile' || key.startsWith('catalog:')) this.cache.delete(key)
    }
    for (const key of this.inFlight.keys()) {
      if (key === 'profile' || key.startsWith('catalog:')) this.inFlight.delete(key)
    }
  }

  private scopeGeneration(key: string): number {
    if (key === 'profile') return this.profileGeneration
    if (key.startsWith('catalog:')) return this.catalogGeneration
    if (key.startsWith('state:')) return this.stateGeneration
    if (key.startsWith('detail:')) return this.characterGenerations.get(key.slice('detail:'.length)) ?? 0
    if (key.startsWith('revisions:')) {
      const characterId = revisionKeyCharacterId(key)
      return characterId === undefined ? 0 : this.characterGenerations.get(characterId) ?? 0
    }
    return 0
  }

  private invalidateCharacter(characterId: string): void {
    this.catalogGeneration++
    this.stateGeneration++
    this.characterGenerations.set(characterId, (this.characterGenerations.get(characterId) ?? 0) + 1)
    for (const key of this.cache.keys()) {
      if (key.startsWith('catalog:') || key === `detail:${characterId}` || revisionKeyCharacterId(key) === characterId || key.startsWith('state:')) this.cache.delete(key)
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith('catalog:') || key === `detail:${characterId}` || revisionKeyCharacterId(key) === characterId || key.startsWith('state:')) this.inFlight.delete(key)
    }
  }

  private readEpoch(): number {
    const supplied = this.getConnectionEpoch?.()
    // provider 一旦存在就是唯一连接世代事实源；否则使用 service 自有世代。
    const epoch = supplied ?? this.ownedEpoch
    return Number.isFinite(epoch) && epoch >= 0 ? Math.floor(epoch) : 0
  }

  private syncEpoch(epoch: number): void {
    if (epoch === this.observedEpoch) return
    this.observedEpoch = epoch
    this.cacheGeneration++
    this.cache.clear()
    // 不能取消底层 Promise，但删掉旧登记使新连接能立即发起自己的同键 GET；
    // 旧 Promise 的 finally 只会删除仍指向自身的条目。
    for (const [key, entry] of this.inFlight) {
      if (entry.epoch !== epoch) this.inFlight.delete(key)
    }
  }
}

export function createCharacterService(options: CharacterServiceOptions): CharacterService {
  return new CharacterService(options)
}

/** Real 模式的显式不可用端口：不添加任何角色 REST URL，也不伪装成功。 */
export class UnavailableCharacterBackend implements CharacterServiceBackendPort {
  private fail(): CyreneError {
    return new CyreneError(
      CyreneErrorCode.NOT_IMPLEMENTED,
      '当前运行模式尚未接入角色后端',
      { backendCode: CHARACTER_SERVICE_BACKEND_CODES.backendUnavailable }
    )
  }

  getMe(): Promise<UserIdentityProfile> { return Promise.reject(this.fail()) }
  updateMe(_input: UpdateUserIdentityCommand): Promise<UserIdentityProfile> { return Promise.reject(this.fail()) }
  createCharacter(_input: CreateCharacterCommand): Promise<CharacterDetail> { return Promise.reject(this.fail()) }
  updateCharacter(_input: UpdateCharacterCommand): Promise<CharacterMutationResult> { return Promise.reject(this.fail()) }
  cloneCharacter(_input: CloneCharacterCommand): Promise<CharacterDetail> { return Promise.reject(this.fail()) }
  archiveCharacter(_characterId: string): Promise<CharacterArchiveResult> { return Promise.reject(this.fail()) }
  rollbackCharacter(_input: RollbackCharacterCommand): Promise<CharacterMutationResult> { return Promise.reject(this.fail()) }
  validateCharacter(_draft: CharacterDraft): Promise<CharacterValidationResult> { return Promise.reject(this.fail()) }
  previewCharacter(_input: CharacterPreviewCommand): Promise<CharacterPreviewResult> { return Promise.reject(this.fail()) }
  listCharacters(_input: CharacterListQuery): Promise<Page<CharacterSummary>> { return Promise.reject(this.fail()) }
  getCharacter(_characterId: string): Promise<CharacterDetail> { return Promise.reject(this.fail()) }
  listCharacterRevisions(_input: CharacterRevisionQuery): Promise<Page<CharacterRevisionSummary>> { return Promise.reject(this.fail()) }
  getCharacterState(_instanceId: string): Promise<CharacterPublicState> { return Promise.reject(this.fail()) }
}
