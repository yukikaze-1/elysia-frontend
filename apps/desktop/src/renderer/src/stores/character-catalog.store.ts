import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CharacterCatalogChangedEvent,
  CharacterDetail,
  CharacterArchiveResult,
  CharacterDraft,
  CharacterListQuery,
  CharacterRevisionQuery,
  CharacterRevisionSummary,
  CharacterSummary,
  CharacterMutationResult,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterValidationResult,
  CharacterPresentation,
  CloneCharacterCommand,
  CreateCharacterCommand,
  RollbackCharacterCommand,
  UpdateCharacterCommand,
  Page
} from '@shared/contracts'
import { api } from './desktop-api'
import { parsePublicError, type PublicError } from '../utils/public-error'
import { useIdentityStore } from './identity.store'
import { useCharacterEditorStore } from './character-editor.store'

export type CharacterCatalogLoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'stale' | 'error'

/** Display-only exact revision metadata.  It deliberately has no invented
 * instance id; message identity validation remains the message store's job. */
export interface CharacterRevisionIdentity {
  characterId: string
  characterRevision: number
  displayName: string
  presentation: CharacterPresentation
}

function missingApiError(): Error {
  return new Error('[CHARACTER_PROFILES_UNAVAILABLE] 角色目录 API 尚未装配')
}

function cloneValue<T>(value: T): T {
  const structured = (globalThis as { structuredClone?: <V>(input: V) => V }).structuredClone
  // Pinia/Vue refs expose reactive Proxies, which structuredClone rejects with
  // DataCloneError.  revisionIdentity() reads summaries straight out of this
  // store, so an unguarded call would throw from CyMessageList's render path
  // and collapse the message list.  Fall back to a plain JSON snapshot rather
  // than letting the clone error escape into rendering.
  if (structured) {
    try { return structured(value) } catch { /* Vue reactive proxies use the JSON fallback. */ }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function stableKey(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableKey(object[key])}`).join(',')}}`
}

/** 从 revision 查询的稳定 key 读取第一个、必填的 characterId 字段。
 * 不用 includes，避免目标 ID 恰好出现在另一个角色的 opaque cursor 中。 */
function revisionKeyCharacterId(key: string): string | undefined {
  const match = /^\{"characterId":((?:"(?:\\.|[^"\\])*")|undefined)/.exec(key)
  if (!match || match[1] === 'undefined') return undefined
  try {
    const id: unknown = JSON.parse(match[1])
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 角色目录 store：列表、详情、revision 分离管理，完整 detail 仅留内存，
 * Renderer 后续持久化若需要只应写摘要。所有异步结果以 epoch+request 序号守卫。
 */
export const useCharacterCatalogStore = defineStore('character-catalog', () => {
  const summaries = ref<CharacterSummary[]>([])
  const details = ref<Record<string, CharacterDetail>>({})
  const revisions = ref<Record<string, Page<CharacterRevisionSummary>>>({})
  /** Exact revision identity cache used by historical message rendering.  It
   * intentionally stores only display/presentation metadata, never compiled
   * prompts, and is not replaced by a newer catalog revision. */
  const revisionIdentityCache = ref<Record<string, CharacterRevisionIdentity>>({})
  const status = ref<CharacterCatalogLoadState>('idle')
  const detailStatus = ref<Record<string, CharacterCatalogLoadState>>({})
  const revisionStatus = ref<Record<string, CharacterCatalogLoadState>>({})
  /**
   * Lightweight per-id status fence for consumers such as the session picker.
   * It is intentionally separate from the filtered summaries list: a selected
   * character may be hidden by search, but an archived event must still revoke
   * that selection immediately.
   */
  const statusById = ref<Record<string, CharacterSummary['status']>>({})
  const error = ref<PublicError>()
  const connectionEpoch = ref(0)
  const hasMore = ref(false)
  const nextCursor = ref<string>()
  const lastQuery = ref<CharacterListQuery>({})
  const listRequestSequence = ref(0)
  /** clear()/epoch 切换代数；让已解除登记的旧 Promise 即使随后有新请求也不能复活数据。 */
  let invalidationGeneration = 0
  /** 仅由 catalog.changed 建立的 per-character revision/sequence fence，防迟到列表和事件降级。 */
  const revisionFences = new Map<string, {
    revision: number
    sequence: number
    status: CharacterSummary['status']
    updatedAt: string
  }>()
  const summaryById = computed(() => new Map(summaries.value.map((summary) => [summary.characterId, summary])))

  const pendingLists = new Map<string, Promise<void>>()
  const pendingDetails = new Map<string, Promise<void>>()
  const pendingRevisions = new Map<string, Promise<void>>()
  const detailRequests = new Map<string, number>()
  const revisionRequests = new Map<string, number>()
  const activeMutations = new Map<string, symbol>()
  const mutationSequences = new Map<string, number>()
  let previewSequence = 0

  function revisionIdentityKey(characterId: string, revision: number): string {
    return `${characterId}@${revision}`
  }

  function cacheRevisionIdentity(detail: CharacterDetail): void {
    const current = detail.current
    const ref: CharacterRevisionIdentity = {
      characterId: current.characterId,
      characterRevision: current.revision,
      displayName: current.displayName,
      presentation: cloneValue(current.presentation)
    }
    revisionIdentityCache.value[revisionIdentityKey(current.characterId, current.revision)] = ref
  }

  function revisionIdentity(characterId: string, revision: number): CharacterRevisionIdentity | undefined {
    const cached = revisionIdentityCache.value[revisionIdentityKey(characterId, revision)]
    if (cached) return cloneValue(cached)
    // A list summary is also an exact revision identity for its current
    // revision.  It contains only display metadata, so using it here does
    // not expose prompts or invent an instance identity.  Older revisions
    // still require an explicitly loaded detail/revision cache entry.
    const summary = summaries.value.find((item) => item.characterId === characterId && item.currentRevision === revision)
    if (!summary) return undefined
    return {
      characterId: summary.characterId,
      characterRevision: summary.currentRevision,
      displayName: summary.displayName,
      presentation: cloneValue(summary.presentation)
    }
  }

  function setConnectionEpoch(epoch: number): void {
    if (!Number.isFinite(epoch) || epoch < 0) return
    const next = Math.floor(epoch)
    if (next === connectionEpoch.value) return
    connectionEpoch.value = next
    invalidationGeneration++
    listRequestSequence.value++
    summaries.value = []
    details.value = {}
    revisions.value = {}
    revisionIdentityCache.value = {}
    detailStatus.value = {}
    revisionStatus.value = {}
    statusById.value = {}
    pendingLists.clear()
    pendingDetails.clear()
    pendingRevisions.clear()
    revisionFences.clear()
    activeMutations.clear()
    mutationSequences.clear()
    status.value = 'idle'
    error.value = undefined
    hasMore.value = false
    nextCursor.value = undefined
    lastQuery.value = {}
  }

  function invalidate(): void {
    setConnectionEpoch(connectionEpoch.value + 1)
  }

  function loadList(input: CharacterListQuery = {}, options: { append?: boolean; force?: boolean } = {}): Promise<void> {
    const append = options.append === true
    const requestInput: CharacterListQuery = append && input.cursor === undefined && nextCursor.value
      ? { ...input, cursor: nextCursor.value }
      : { ...input }
    const key = stableKey(requestInput)
    const existing = pendingLists.get(key)
    if (existing && !options.force) return existing

    const epoch = connectionEpoch.value
    const generation = invalidationGeneration
    const request = ++listRequestSequence.value
    status.value = append ? 'loading' : 'loading'
    error.value = undefined
    if (!append) lastQuery.value = { ...input }
    const getter = api && api.listCharacters
    let operation: Promise<Page<CharacterSummary>>
    try {
      operation = getter ? Promise.resolve(getter(requestInput)) : Promise.reject<Page<CharacterSummary>>(missingApiError())
    } catch (cause) {
      operation = Promise.reject(cause)
    }
    const task = operation
      .then((result) => {
        if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || request !== listRequestSequence.value) return
        const incoming = cloneValue(result.items)
        // 非 append 查询只保留新响应中出现的 id；但若同一 id 已被更高版本 fence
        // 保护，则用该 id 当前摘要替代旧响应，避免降级而不把其它旧 query 项带回。
        const merged = mergeSummaries(summaries.value, incoming, revisionFences, requestInput, append)
        summaries.value = merged
        // Only accepted/visible summaries may advance the lightweight status
        // index.  In particular, an archived fence can intentionally remove an
        // id from `merged`; copying raw incoming statuses here would resurrect
        // an archived selection when a late list still says `active`.
        const nextStatusById = { ...statusById.value }
        for (const summary of merged) nextStatusById[summary.characterId] = summary.status
        statusById.value = nextStatusById
        hasMore.value = result.hasMore
        nextCursor.value = result.nextCursor
        status.value = merged.length === 0 ? 'empty' : 'ready'
      })
      .catch((cause: unknown) => {
        if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || request !== listRequestSequence.value) return
        error.value = parsePublicError(cause instanceof Error ? cause.message : String(cause))
        status.value = 'error'
      })
      .finally(() => {
        if (pendingLists.get(key) === task) pendingLists.delete(key)
      })
    pendingLists.set(key, task)
    return task
  }

  function loadNextPage(): Promise<void> {
    if (!hasMore.value || !nextCursor.value) return Promise.resolve()
    return loadList({ ...lastQuery.value, cursor: nextCursor.value }, { append: true })
  }

  function loadDetail(characterId: string, force = false): Promise<void> {
    const existing = pendingDetails.get(characterId)
    if (existing && !force) return existing
    const epoch = connectionEpoch.value
    const generation = invalidationGeneration
    const request = (detailRequests.get(characterId) ?? 0) + 1
    detailRequests.set(characterId, request)
    detailStatus.value[characterId] = 'loading'
    const getter = api && api.getCharacter
    let operation: Promise<CharacterDetail>
    try {
      operation = getter ? Promise.resolve(getter(characterId)) : Promise.reject<CharacterDetail>(missingApiError())
    } catch (cause) {
      operation = Promise.reject(cause)
    }
      const task = operation
      .then((detail) => {
        if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || detailRequests.get(characterId) !== request) return
        const current = details.value[characterId]
        const floor = strongestCharacterRevision(characterId)
        if (detail.current.revision < floor) {
          // fence/summary 已经确认更高版本时，迟到 GET 只能收敛状态，不能
          // 回填旧 detail。若仍有不低于 floor 的 detail，它是可用事实；否则
          // 保留 stale 让 UI 知道需要重新获取，而不是把 loading 永久挂住。
          if (current && current.current.revision >= floor) {
            detailStatus.value[characterId] = 'ready'
          } else {
            delete details.value[characterId]
            detailStatus.value[characterId] = 'stale'
          }
          return
        }
        details.value[characterId] = cloneValue(detail)
        cacheRevisionIdentity(detail)
        const fence = revisionFences.get(characterId)
        const acceptedStatus = fence && detail.current.revision <= fence.revision ? fence.status : detail.summary.status
        statusById.value = { ...statusById.value, [characterId]: acceptedStatus }
        detailStatus.value[characterId] = 'ready'
      })
      .catch((cause: unknown) => {
        if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || detailRequests.get(characterId) !== request) return
        error.value = parsePublicError(cause instanceof Error ? cause.message : String(cause))
        detailStatus.value[characterId] = 'error'
      })
      .finally(() => {
        if (pendingDetails.get(characterId) === task) pendingDetails.delete(characterId)
      })
    pendingDetails.set(characterId, task)
    return task
  }

  function loadRevisions(input: CharacterRevisionQuery, force = false): Promise<void> {
    const key = stableKey(input)
    const existing = pendingRevisions.get(key)
    if (existing && !force) return existing
    const epoch = connectionEpoch.value
    const generation = invalidationGeneration
    const request = (revisionRequests.get(key) ?? 0) + 1
    revisionRequests.set(key, request)
    revisionStatus.value[key] = 'loading'
    const getter = api && api.listCharacterRevisions
    let operation: Promise<Page<CharacterRevisionSummary>>
    try {
      operation = getter ? Promise.resolve(getter(cloneValue(input))) : Promise.reject<Page<CharacterRevisionSummary>>(missingApiError())
    } catch (cause) {
      operation = Promise.reject(cause)
    }
    const task = operation
      .then((result) => {
        if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || revisionRequests.get(key) !== request) return
    revisions.value[key] = cloneValue(result)
        revisionStatus.value[key] = result.items.length === 0 ? 'empty' : 'ready'
      })
      .catch((cause: unknown) => {
        if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || revisionRequests.get(key) !== request) return
        error.value = parsePublicError(cause instanceof Error ? cause.message : String(cause))
        revisionStatus.value[key] = 'error'
      })
      .finally(() => {
        if (pendingRevisions.get(key) === task) pendingRevisions.delete(key)
      })
    pendingRevisions.set(key, task)
    return task
  }

  function markStale(): void {
    if (status.value !== 'loading') status.value = 'stale'
  }

  function createCharacter(input: CreateCharacterCommand): Promise<CharacterDetail | undefined> {
    return runMutation('catalog:create', () => requireApi('createCharacter')(input), (detail) => {
      invalidateCharacterReads(detail.summary.characterId)
      mergeDetail(detail)
    })
  }

  function cloneCharacter(input: CloneCharacterCommand): Promise<CharacterDetail | undefined> {
    return runMutation(`character:${input.characterId}`, () => requireApi('cloneCharacter')(input), (detail) => {
      invalidateCharacterReads(detail.summary.characterId)
      mergeDetail(detail)
    })
  }

  function updateCharacter(input: UpdateCharacterCommand): Promise<CharacterMutationResult | undefined> {
    return runMutation(`character:${input.characterId}`, () => requireApi('updateCharacter')(input), (result) => {
      invalidateCharacterReads(input.characterId)
      mergeDetail(result.character)
    })
  }

  function rollbackCharacter(input: RollbackCharacterCommand): Promise<CharacterMutationResult | undefined> {
    return runMutation(`character:${input.characterId}`, () => requireApi('rollbackCharacter')(input), (result) => {
      invalidateCharacterReads(input.characterId)
      mergeDetail(result.character)
    })
  }

  function archiveCharacter(characterId: string): Promise<CharacterArchiveResult | undefined> {
    const epoch = connectionEpoch.value
    let acceptedArchive = false
    const mutation = runMutation(`character:${characterId}`, () => requireApi('archiveCharacter')(characterId), (result) => {
      invalidateCharacterReads(characterId)
      const summary = mergeMutationSummary(result.character)
      // 更高版本 fence/摘要已经赢得当前事实时，迟到 archive 结果必须整体丢弃；
      // 不能让它清掉较新的 detail，也不能把 loading 重新变成错误的终态。
      if (!summary) return
      acceptedArchive = summary.status === 'archived'
      statusById.value = { ...statusById.value, [characterId]: summary.status }
      summaries.value = summaries.value.filter((item) => item.characterId !== characterId)
      if (matchesLastQuery(summary)) summaries.value = [...summaries.value, summary]
      delete details.value[characterId]
      delete detailStatus.value[characterId]
      markStale()
      if (result.userProfile) useIdentityStore().applyServerProfile(cloneValue(result.userProfile), epoch)
    })
    // 本地归档成功只在目录 store 接受并合并了 archived 权威结果后清理编辑器。
    // 清理是 best-effort；不能让本次远端归档变成失败，也不向事件总线制造消息。
    return mutation.then((result) => {
      if (acceptedArchive && result) {
        try {
          // Promise.resolve() only protects asynchronous failures; keep the
          // invocation itself inside try so a synchronous store failure cannot
          // turn an already successful archive into a rejected Promise.
          void Promise.resolve(useCharacterEditorStore().handleCharacterArchived(characterId)).catch(() => {})
        } catch {
          // Local recovery cleanup is best-effort and never changes archive
          // success semantics.
        }
      }
      return result
    })
  }

  function validateCharacter(draft: CharacterDraft): Promise<CharacterValidationResult> {
    return requireApi('validateCharacter')(cloneValue(draft))
  }

  async function previewCharacter(input: CharacterPreviewCommand): Promise<CharacterPreviewResult | undefined> {
    const epoch = connectionEpoch.value
    const generation = invalidationGeneration
    const request = ++previewSequence
    try {
      const result = await requireApi('previewCharacter')(cloneValue(input))
      if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || request !== previewSequence) return undefined
      return cloneValue(result)
    } catch (cause) {
      if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || request !== previewSequence) return undefined
      throw cause
    }
  }

  function mergeDetail(detail: CharacterDetail): void {
    const copy = cloneValue(detail)
    const current = details.value[copy.summary.characterId]
    const summary = mergeMutationSummary(copy.summary)
    if (!summary) {
      const fenceRevision = revisionFences.get(copy.summary.characterId)?.revision ?? 0
      // 如果已有 detail 本身不低于 fence 和迟到结果，保留它并结束 loading；
      // 只有 detail 确实落后于权威版本时才清掉，避免 stale mutation 擦除新事实。
      if (current && current.current.revision >= fenceRevision && current.current.revision >= copy.current.revision) {
        detailStatus.value[copy.summary.characterId] = 'ready'
      } else if (current) {
        delete details.value[copy.summary.characterId]
        delete detailStatus.value[copy.summary.characterId]
      }
      return
    }
    if (current && current.current.revision > copy.current.revision) {
      // 迟到的较旧 mutation/read 结果不能覆盖当前 detail；但它也不能把
      // 本次主动 fence 留下的 loading 状态永久挂住。
      detailStatus.value[copy.summary.characterId] = 'ready'
      return
    }
    copy.summary = summary
    cacheRevisionIdentity(copy)
    statusById.value = { ...statusById.value, [copy.summary.characterId]: copy.summary.status }
    details.value[copy.summary.characterId] = copy
    detailStatus.value[copy.summary.characterId] = 'ready'
    summaries.value = summaries.value.filter((item) => item.characterId !== copy.summary.characterId)
    if (matchesLastQuery(copy.summary)) summaries.value = [...summaries.value, copy.summary]
    for (const key of Object.keys(revisions.value)) {
      if (revisionKeyCharacterId(key) === copy.summary.characterId) delete revisions.value[key]
    }
    markStale()
  }

  function mergeMutationSummary(incoming: CharacterSummary): CharacterSummary | undefined {
    const current = summaryById.value.get(incoming.characterId)
    const currentDetail = details.value[incoming.characterId]
    const fence = revisionFences.get(incoming.characterId)
    const strongestRevision = Math.max(current?.currentRevision ?? 0, currentDetail?.current.revision ?? 0, fence?.revision ?? 0)
    if (incoming.currentRevision < strongestRevision) return undefined
    if (fence && incoming.currentRevision === fence.revision) {
      return { ...cloneValue(incoming), status: fence.status, updatedAt: fence.updatedAt }
    }
    return cloneValue(incoming)
  }

  /**
   * 角色读取结果允许回填的权威 revision 下限。
   *
   * 该下限同时覆盖当前 query 中的摘要、query 外缓存的 detail，以及
   * catalog.changed 建立的 mutation/event fence；普通 GET 不能越过其中任一
   * 更高版本。它不携带 sequence，避免把 detail 误当作事件顺序来源。
   */
  function strongestCharacterRevision(characterId: string): number {
    const summary = summaryById.value.get(characterId)
    const current = details.value[characterId]
    const fence = revisionFences.get(characterId)
    return Math.max(
      summary?.currentRevision ?? 0,
      current?.current.revision ?? 0,
      fence?.revision ?? 0
    )
  }

  function invalidateCharacterReads(characterId: string): void {
    listRequestSequence.value++
    pendingLists.clear()
    status.value = summaries.value.length ? 'stale' : 'idle'
    hasMore.value = false
    nextCursor.value = undefined
    const detailRequest = (detailRequests.get(characterId) ?? 0) + 1
    detailRequests.set(characterId, detailRequest)
    pendingDetails.delete(characterId)
    if (detailStatus.value[characterId] === 'loading') {
      detailStatus.value[characterId] = details.value[characterId] ? 'stale' : 'idle'
    }
    for (const key of new Set([...revisionRequests.keys(), ...pendingRevisions.keys(), ...Object.keys(revisions.value)])) {
      if (revisionKeyCharacterId(key) !== characterId) continue
      revisionRequests.set(key, (revisionRequests.get(key) ?? 0) + 1)
      pendingRevisions.delete(key)
      delete revisions.value[key]
      delete revisionStatus.value[key]
    }
  }

  function matchesLastQuery(summary: CharacterSummary): boolean {
    return matchesCharacterQuery(summary, lastQuery.value)
  }

  function matchesCharacterQuery(summary: CharacterSummary, query: CharacterListQuery): boolean {
    if (summary.status !== (query.status ?? 'active')) return false
    if (query.source && summary.source !== query.source) return false
    const search = query.search?.trim().toLocaleLowerCase()
    return !search || [summary.displayName, summary.description, ...summary.aliases].some((part) => part.toLocaleLowerCase().includes(search))
  }

  function requireApi<K extends 'createCharacter' | 'updateCharacter' | 'cloneCharacter' | 'archiveCharacter' | 'rollbackCharacter' | 'validateCharacter' | 'previewCharacter'>(name: K): NonNullable<(typeof api)[K]> {
    const method = api && api[name]
    if (!method) throw missingApiError()
    return method as NonNullable<(typeof api)[K]>
  }

  function runMutation<T>(key: string, operation: () => Promise<T>, apply: (result: T) => void): Promise<T | undefined> {
    if (activeMutations.has(key)) return Promise.reject(new Error('[BACKEND_REJECTED] [backendCode=CHARACTER_MUTATION_IN_PROGRESS] 角色正在被修改'))
    const token = Symbol(key)
    activeMutations.set(key, token)
    const epoch = connectionEpoch.value
    const generation = invalidationGeneration
    const request = (mutationSequences.get(key) ?? 0) + 1
    mutationSequences.set(key, request)
    return Promise.resolve().then(operation).then((result) => {
      if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || request !== mutationSequences.get(key)) return undefined
      apply(cloneValue(result))
      return cloneValue(result)
    }).catch((cause) => {
      if (epoch !== connectionEpoch.value || generation !== invalidationGeneration || request !== mutationSequences.get(key)) return undefined
      throw cause
    }).finally(() => {
      if (activeMutations.get(key) === token) activeMutations.delete(key)
    })
  }

  /** 目录事件仅失效/更新摘要，不把 authored detail 或 prompt 放入事件。 */
  function handleCatalogChanged(event: CharacterCatalogChangedEvent): boolean {
    const fence = revisionFences.get(event.characterId)
    const current = summaryById.value.get(event.characterId)
    const currentDetail = details.value[event.characterId]
    const strongestRevision = Math.max(current?.currentRevision ?? 0, currentDetail?.current.revision ?? 0, fence?.revision ?? 0)
    if (fence && event.currentRevision < fence.revision) return false
    if (fence && event.currentRevision === fence.revision && event.sequence <= fence.sequence) return false
    if (event.currentRevision < strongestRevision) return false
    invalidateCharacterReads(event.characterId)
    delete details.value[event.characterId]
    delete detailStatus.value[event.characterId]
    revisionFences.set(event.characterId, {
      revision: event.currentRevision,
      sequence: event.sequence,
      status: event.status,
      updatedAt: event.updatedAt
    })
    statusById.value = { ...statusById.value, [event.characterId]: event.status }
    if (current) {
      const next: CharacterSummary = {
        ...current,
        currentRevision: event.currentRevision,
        status: event.status,
        updatedAt: event.updatedAt
      }
      summaries.value = summaries.value.filter((item) => item.characterId !== event.characterId && matchesLastQuery(item))
      if (matchesLastQuery(next)) summaries.value = [...summaries.value, next]
    } else {
      summaries.value = summaries.value.filter(matchesLastQuery)
    }
    markStale()
    return true
  }

  function clear(): void {
    invalidationGeneration++
    pendingLists.clear()
    pendingDetails.clear()
    pendingRevisions.clear()
    detailRequests.clear()
    revisionRequests.clear()
    summaries.value = []
    details.value = {}
    revisions.value = {}
    revisionIdentityCache.value = {}
    detailStatus.value = {}
    revisionStatus.value = {}
    statusById.value = {}
    status.value = 'idle'
    error.value = undefined
    hasMore.value = false
    nextCursor.value = undefined
    lastQuery.value = {}
    revisionFences.clear()
    activeMutations.clear()
    mutationSequences.clear()
  }

  return {
    summaries,
    summaryById,
    statusById,
    characterStatus: (characterId: string): CharacterSummary['status'] | undefined => statusById.value[characterId],
    details,
    revisions,
    revisionIdentityCache,
    status,
    detailStatus,
    revisionStatus,
    error,
    connectionEpoch,
    hasMore,
    nextCursor,
    lastQuery,
    loadList,
    loadNextPage,
    loadDetail,
    loadRevisions,
    revisionIdentity,
    handleCatalogChanged,
    markStale,
    setConnectionEpoch,
    invalidate,
    clear,
    createCharacter, cloneCharacter, updateCharacter, rollbackCharacter, archiveCharacter,
    validateCharacter, previewCharacter
  }
})

function mergeSummaries(
  existing: CharacterSummary[],
  incoming: CharacterSummary[],
  revisionFences: Map<string, { revision: number; sequence: number; status: CharacterSummary['status']; updatedAt: string }>,
  query: CharacterListQuery,
  append: boolean
): CharacterSummary[] {
  const previous = new Map(existing.map((item) => [item.characterId, item]))
  const byId = new Map<string, CharacterSummary>(append ? existing.map((item) => [item.characterId, item]) : [])
  for (const summary of incoming) {
    const current = previous.get(summary.characterId)
    const fence = revisionFences.get(summary.characterId)
    if (current && summary.currentRevision < current.currentRevision) {
      // 即使没有 catalog.changed fence，普通列表也不能把已有较新 revision 降级。
      if (matchesCharacterQuery(current, query)) byId.set(summary.characterId, current)
      continue
    }
    if (fence && summary.currentRevision <= fence.revision) {
      if (current && current.currentRevision >= fence.revision) {
        // 事件已经把当前摘要推进到 fence；同版本/低版本普通 list 不能覆盖事件结果。
        if (matchesCharacterQuery(current, query)) byId.set(summary.characterId, current)
      } else if (summary.currentRevision === fence.revision) {
        // 事件先于该 id 首次进入当前 query：保留 list 的其它字段，但套用事件的
        // status/updatedAt，避免同 revision 的普通 list 抹掉更可信事件。
        const fenced = {
          ...summary,
          currentRevision: fence.revision,
          status: fence.status,
          updatedAt: fence.updatedAt
        }
        // 事件 fence 才是强权威：若它已将角色移出当前 query，不能被
        // 一份同版本但状态相反的普通 list 重新带回。
        if (matchesCharacterQuery(fenced, query)) byId.set(summary.characterId, fenced)
      }
      continue
    }
    byId.set(summary.characterId, summary)
  }
  return [...byId.values()]
}

function matchesCharacterQuery(summary: CharacterSummary, query: CharacterListQuery): boolean {
  if (summary.status !== (query.status ?? 'active')) return false
  if (query.source && summary.source !== query.source) return false
  const search = query.search?.trim().toLocaleLowerCase()
  return !search || [summary.displayName, summary.description, ...summary.aliases]
    .some((part) => part.toLocaleLowerCase().includes(search))
}
