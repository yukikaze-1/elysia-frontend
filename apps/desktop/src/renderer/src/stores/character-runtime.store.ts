import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CharacterBindingSnapshot,
  CharacterPublicState,
  CharacterStateChangedEvent
} from '@shared/contracts'
import { api } from './desktop-api'
import { parsePublicError, type PublicError } from '../utils/public-error'
import { toRejection } from '../utils/rejection'
import { characterIdentityMismatch } from '../utils/character-identity'
import { cloneValue } from '@shared/domain'

export type CharacterRuntimeLoadState = 'idle' | 'loading' | 'ready' | 'stale' | 'error'

type CharacterStateExpectation = Pick<CharacterBindingSnapshot, 'characterId' | 'characterInstanceId' | 'characterRevision'>

function stateIdentityError(mismatch?: string): Error {
  // Do not include the returned payload in this error. A malformed/foreign
  // snapshot must be fail-closed without accidentally exposing backend data.
  // 只带**字段名**（不是值）：字段名是结构性信息，不泄露后端数据，却能让诊断区分
  // 「id 不符」「实例不符」「修订号不符」——此前三种情况共用一句无从区分的文案。
  return new Error(`[CHARACTER_STATE_IDENTITY_MISMATCH] 角色状态身份校验失败${mismatch ? `（字段：${mismatch}）` : ''}`)
}

function missingApiError(): Error {
  return new Error('[CHARACTER_PROFILES_UNAVAILABLE] 角色状态 API 尚未装配')
}

/**
 * State is canonical-instance data, but a snapshot is also revision-scoped
 * for the active conversation. Keep the instance map as a compatibility/latest
 * cache and keep the revision-keyed map as the source for activeState and the
 * active status/error accessors. An inactive revision can therefore never
 * replace the active conversation's view.
 */
function snapshotKey(value: CharacterStateExpectation): string {
  return JSON.stringify([value.characterInstanceId, value.characterId, value.characterRevision])
}

function wildcardKey(instanceId: string): string {
  return JSON.stringify([instanceId, '*', '*'])
}

function identitySnapshot(value: CharacterStateExpectation): CharacterStateExpectation {
  // The coordinator usually passes a reactive binding object. Capture only
  // the immutable identity fields so a later in-place binding update cannot
  // change which REST response this operation is allowed to commit.
  return {
    characterId: value.characterId,
    characterInstanceId: value.characterInstanceId,
    characterRevision: value.characterRevision
  }
}

export const useCharacterRuntimeStore = defineStore('character-runtime', () => {
  /** Latest accepted state per canonical instance; not the active UI view. */
  const statesByInstanceId = ref<Record<string, CharacterPublicState>>({})
  /** Revision-scoped snapshots used by active binding accessors. */
  const statesByBindingKey = ref<Record<string, CharacterPublicState>>({})
  const stateStatus = ref<Record<string, CharacterRuntimeLoadState>>({})
  const stateErrors = ref<Record<string, PublicError | undefined>>({})
  const statusByBindingKey = ref<Record<string, CharacterRuntimeLoadState>>({})
  const errorsByBindingKey = ref<Record<string, PublicError | undefined>>({})
  const activeBinding = ref<CharacterBindingSnapshot>()
  const activeConversationId = ref<string>()
  const connectionEpoch = ref(0)
  /**
   * Renderer-local source fence.  This is deliberately independent from the
   * backend's connectionId (which may be reused) and is never derived from a
   * token or endpoint.  A missing scope is kept as an explicit "unknown"
   * source once a capability connection has been observed; bootstrap can then
   * force every legacy re-entry to clear the cache.
   */
  const connectionScopeId = ref<string>()
  let connectionScopeObserved = false
  const activeState = computed(() => {
    const binding = activeBinding.value
    return binding ? statesByBindingKey.value[snapshotKey(binding)] : undefined
  })
  const activeStatus = computed<CharacterRuntimeLoadState>(() => {
    const binding = activeBinding.value
    if (!binding) return 'idle'
    const key = snapshotKey(binding)
    return statusByBindingKey.value[key] ?? (statesByBindingKey.value[key] ? 'ready' : 'idle')
  })
  const activeError = computed(() => {
    const binding = activeBinding.value
    return binding ? errorsByBindingKey.value[snapshotKey(binding)] : undefined
  })

  /** pending/requests are keyed by instance + expected identity, never instance alone. */
  const pending = new Map<string, Promise<void>>()
  const requests = new Map<string, number>()
  const bindingKeysByInstance = new Map<string, Set<string>>()
  const latestKeyByInstance = new Map<string, string>()
  /** 全量 clear 的代数；避免 clear 后立即重发请求时复用旧 request 序号。 */
  let clearGeneration = 0
  /** 单实例 clear 的代数；不让该实例旧请求在重载后复活。 */
  const instanceGenerations = new Map<string, number>()

  function trackKey(instanceId: string, key: string): void {
    const keys = bindingKeysByInstance.get(instanceId) ?? new Set<string>()
    keys.add(key)
    bindingKeysByInstance.set(instanceId, keys)
  }

  function isActiveKey(instanceId: string, key: string): boolean {
    const binding = activeBinding.value
    return binding?.characterInstanceId === instanceId && snapshotKey(binding) === key
  }

  /**
   * `stateVersion` is the CAS/order version of the canonical instance, not of
   * a character revision. The revision-keyed maps retain historical views, but
   * every incoming snapshot/event must advance the instance-wide high-water
   * mark. Deriving this from both maps also keeps the fence correct if a
   * legacy caller has only populated one compatibility view.
   */
  function latestStateVersion(instanceId: string): number | undefined {
    let latest = statesByInstanceId.value[instanceId]?.stateVersion
    for (const key of bindingKeysByInstance.get(instanceId) ?? []) {
      const version = statesByBindingKey.value[key]?.stateVersion
      if (version !== undefined && (latest === undefined || version > latest)) latest = version
    }
    return latest
  }

  function markSnapshotStale(instanceId: string, requestKey: string, actualKey: string): void {
    for (const key of new Set([requestKey, actualKey])) {
      trackKey(instanceId, key)
      statusByBindingKey.value[key] = 'stale'
      delete errorsByBindingKey.value[key]
    }
    projectInstance(instanceId)
  }

  /** Preserve old per-instance fields for callers while deriving them from the active revision. */
  function projectInstance(instanceId: string, preferredKey?: string): void {
    const active = activeBinding.value
    const key = active?.characterInstanceId === instanceId
      ? snapshotKey(active)
      : latestKeyByInstance.get(instanceId) ?? preferredKey ?? wildcardKey(instanceId)
    trackKey(instanceId, key)
    const state = statesByBindingKey.value[key]
    const status = statusByBindingKey.value[key]
    if (state) statesByInstanceId.value[instanceId] = state
    stateStatus.value[instanceId] = status ?? (state ? 'ready' : 'idle')
    stateErrors.value[instanceId] = errorsByBindingKey.value[key]
  }

  function markKeyStatus(instanceId: string, key: string, status: CharacterRuntimeLoadState, error?: PublicError): void {
    trackKey(instanceId, key)
    statusByBindingKey.value[key] = status
    if (error) errorsByBindingKey.value[key] = error
    else delete errorsByBindingKey.value[key]
    if (isActiveKey(instanceId, key) || activeBinding.value?.characterInstanceId !== instanceId) projectInstance(instanceId, key)
  }

  function setConnectionEpoch(epoch: number, sourceScopeId?: string): void {
    if (!Number.isFinite(epoch) || epoch < 0) return
    // Keep this overload for bootstrap integrations that carry the source
    // fence and epoch together.  `arguments.length` distinguishes an
    // explicitly unknown legacy scope from the historical one-argument API.
    if (arguments.length > 1) setConnectionScopeId(sourceScopeId, sourceScopeId === undefined)
    const next = Math.floor(epoch)
    // Epochs are fences, not a synchronisable counter. A stale caller must
    // never reopen requests or make old events current again.
    if (next <= connectionEpoch.value) return
    connectionEpoch.value = next
    const pendingInstances = [...new Set([...pending.keys()].flatMap((key) => {
      // 绑定键是 JSON 数组（[instanceId, revision]）：解析结果先落 unknown 再判型，
      // 原写法 `JSON.parse(key)[0]` 直接在 any 上取下标（2026-09-13 type-aware 全集）。
      try {
        const parsed: unknown = JSON.parse(key)
        if (!Array.isArray(parsed)) return []
        const first: unknown = parsed[0]
        return typeof first === 'string' ? [first] : []
      } catch { return [] }
    }))]
    pending.clear()
    const instances = new Set([...bindingKeysByInstance.keys(), ...Object.keys(statesByInstanceId.value), ...pendingInstances])
    for (const key of Object.keys(statusByBindingKey.value)) statusByBindingKey.value[key] = 'stale'
    for (const instanceId of instances) projectInstance(instanceId)
    for (const instanceId of Object.keys(stateErrors.value)) stateErrors.value[instanceId] = undefined
    for (const key of Object.keys(errorsByBindingKey.value)) delete errorsByBindingKey.value[key]
  }

  /** Clear all source-owned runtime data while preserving the active binding. */
  function clearSourceCache(): void {
    clearGeneration++
    pending.clear()
    requests.clear()
    bindingKeysByInstance.clear()
    latestKeyByInstance.clear()
    instanceGenerations.clear()
    statesByInstanceId.value = {}
    statesByBindingKey.value = {}
    stateStatus.value = {}
    stateErrors.value = {}
    statusByBindingKey.value = {}
    errorsByBindingKey.value = {}
  }

  /**
   * Adopt a local connection source.  A concrete scope change is a hard
   * source boundary even when endpoint, account, instance and revision all
   * happen to be identical.  `forceNew` is used for a legacy adapter that
   * cannot provide a scope: every capability re-entry is then fail-closed as
   * a new source rather than trusting connectionId as a substitute.
   */
  function setConnectionScopeId(scopeId?: string, forceNew = false): void {
    const normalized = typeof scopeId === 'string' && scopeId.trim() ? scopeId.trim() : undefined
    const same = connectionScopeObserved && connectionScopeId.value === normalized
    if (!forceNew && same) return
    // An initial unknown/offline state is not a source transition.  This lets
    // a cached snapshot remain visible while the app is offline; the first
    // connected capability state still calls with forceNew for legacy peers.
    if (!forceNew && normalized === undefined && !connectionScopeObserved) return
    clearSourceCache()
    connectionScopeId.value = normalized
    connectionScopeObserved = true
  }

  /** Alias with a source-oriented name for bootstrap/test doubles. */
  function setConnectionSource(scopeId?: string, forceNew = false): void {
    setConnectionScopeId(scopeId, forceNew)
  }

  function invalidate(): void {
    setConnectionEpoch(connectionEpoch.value + 1)
  }

  function currentRequest(owner: { key: string; instanceId: string; epoch: number; generation: number; instanceGeneration: number; request: number }): boolean {
    return owner.epoch === connectionEpoch.value
      && owner.generation === clearGeneration
      && owner.instanceGeneration === (instanceGenerations.get(owner.instanceId) ?? 0)
      && requests.get(owner.key) === owner.request
  }

  function loadState(instanceId: string, forceOrExpectation: boolean | CharacterStateExpectation = false, expectation?: CharacterStateExpectation): Promise<void> {
    // Keep the old `(instanceId, force)` call shape. The coordinator passes a
    // binding, while direct callers capture the current active binding.
    const force = typeof forceOrExpectation === 'boolean' ? forceOrExpectation : false
    const explicitExpected = typeof forceOrExpectation === 'boolean' ? expectation : forceOrExpectation
    const activeAtRequest = activeBinding.value
    const expectedSource = explicitExpected ?? (
      activeAtRequest?.characterInstanceId === instanceId
        ? activeAtRequest
        : undefined
    )
    const expected = expectedSource ? identitySnapshot(expectedSource) : undefined
    const key = expected ? snapshotKey(expected) : wildcardKey(instanceId)
    trackKey(instanceId, key)
    const current = expected
      ? statesByBindingKey.value[key]
      : statesByInstanceId.value[instanceId]
    const currentStatus = statusByBindingKey.value[key]
    if (!force && current && currentStatus === 'ready') return Promise.resolve()
    const existing = pending.get(key)
    if (existing && !force) return existing

    const owner = {
      key,
      instanceId,
      epoch: connectionEpoch.value,
      generation: clearGeneration,
      instanceGeneration: instanceGenerations.get(instanceId) ?? 0,
      request: (requests.get(key) ?? 0) + 1
    }
    requests.set(key, owner.request)
    markKeyStatus(instanceId, key, 'loading')
    // `.bind(api)`：显式摘取方法（`unbound-method`，2026-09-13 type-aware 全集）
    const getter = api ? api.getCharacterState?.bind(api) : undefined
    let operation: Promise<CharacterPublicState>
    try {
      operation = getter ? Promise.resolve(getter(instanceId)) : Promise.reject<CharacterPublicState>(missingApiError())
    } catch (cause) {
      operation = Promise.reject(toRejection(cause))
    }
    const task = operation
      .then((state) => {
        if (!currentRequest(owner)) return
        // H-06/H-07：身份判据收敛到 utils/character-identity（唯一来源）。
        // 本处的**反应**是 throw（fail-closed）；组件侧的同一判据反应是 return undefined——
        // 规则一处、反应各异，正是本次收敛的目标。
        if (state.characterInstanceId !== instanceId) throw stateIdentityError('characterInstanceId')
        if (expected !== undefined) {
          const mismatch = characterIdentityMismatch(state, expected)
          if (mismatch !== undefined) throw stateIdentityError(mismatch)
        }
        const existingState = statesByInstanceId.value[instanceId]
        if (existingState && existingState.characterId !== state.characterId) throw stateIdentityError()
        const actualKey = snapshotKey(state)
        trackKey(instanceId, actualKey)
        const existingRevisionState = statesByBindingKey.value[actualKey]
        const latestVersion = latestStateVersion(instanceId)
        if (latestVersion !== undefined && state.stateVersion <= latestVersion) {
          // The response is a valid identity but older than the canonical
          // instance high-water mark (possibly another revision). Keep the
          // newer cache and settle this request as stale; never create or
          // overwrite the lower revision-scoped snapshot.
          if (existingRevisionState && existingRevisionState.stateVersion >= state.stateVersion
            && existingRevisionState.stateVersion === latestVersion) {
            // A forced refresh may return the same snapshot that is already
            // cached for this exact identity. It is still a successful ready
            // read; the stale case is only for a lower revision/old version.
            statusByBindingKey.value[actualKey] = 'ready'
            delete errorsByBindingKey.value[actualKey]
            if (key !== actualKey) {
              statusByBindingKey.value[key] = 'ready'
              delete errorsByBindingKey.value[key]
            }
            projectInstance(instanceId)
          } else {
            markSnapshotStale(instanceId, key, actualKey)
          }
          return
        }
        // The global high-water check above normally subsumes this branch;
        // retain the explicit identity check for defensive compatibility with
        // callers that mutate the exposed cache between awaits.
        if (existingRevisionState && state.stateVersion <= existingRevisionState.stateVersion) {
          markSnapshotStale(instanceId, key, actualKey)
          return
        }
        const copy = cloneValue(state)
        statesByBindingKey.value[actualKey] = copy
        // The compatibility instance cache is only a latest canonical cache;
        // activeState never reads it.
        statesByInstanceId.value[instanceId] = copy
        latestKeyByInstance.set(instanceId, actualKey)
        statusByBindingKey.value[actualKey] = 'ready'
        delete errorsByBindingKey.value[actualKey]
        // If the wildcard request resolved to an exact identity, mirror its
        // terminal state to the request key for legacy per-instance callers.
        if (key !== actualKey) {
          statusByBindingKey.value[key] = 'ready'
          delete errorsByBindingKey.value[key]
        }
        projectInstance(instanceId)
      })
      .catch((cause: unknown) => {
        if (!currentRequest(owner)) return
        const error = parsePublicError(cause instanceof Error ? cause.message : String(cause))
        markKeyStatus(instanceId, key, 'error', error)
      })
      .finally(() => {
        if (pending.get(key) === task) pending.delete(key)
      })
    pending.set(key, task)
    return task
  }

  /** Binding selection is owned by the conversation coordinator, not by WS events. */
  function setActiveBinding(binding: CharacterBindingSnapshot | undefined, conversationId?: string): void {
    // L9（2026-09-15 Live2D 评审）：切到**另一个实例**时释放上一个实例的 revision 键控缓存。
    // 这些条目按 revision 累积（`follow_latest` 会话每次状态变更都可能落一个新键），此前只有断连/换 source
    // 才清空 ⇒ 长会话里持续增长、且每次事件都要遍历该实例的全部 revision 键。`clearInstance` 一直存在
    // 却**没有任何调用方**——这里补上它唯一的正确调用点（实例不再在前台，重进时会按需重新拉取）。
    const prevInstance = activeBinding.value?.characterInstanceId
    const nextInstance = binding?.characterInstanceId
    if (prevInstance && prevInstance !== nextInstance) clearInstance(prevInstance)
    activeBinding.value = binding ? cloneValue(binding) : undefined
    activeConversationId.value = conversationId
    if (binding) projectInstance(binding.characterInstanceId)
  }

  /** Apply a complete view only after instance, revision and stateVersion fences pass. */
  function handleStateChanged(event: CharacterStateChangedEvent, eventEpoch = connectionEpoch.value): void {
    if (eventEpoch !== connectionEpoch.value) return
    const existing = statesByInstanceId.value[event.characterInstanceId]
    const binding = activeBinding.value
    if (existing && existing.characterId !== event.characterId) return
    if (binding?.characterInstanceId === event.characterInstanceId) {
      if (binding.characterId !== event.characterId) return
      // An active conversation owns its revision. A non-active conversation
      // may still populate another revision key in the shared canonical cache.
      if (event.characterRevision !== binding.characterRevision
        && (!activeConversationId.value || event.conversationId === activeConversationId.value)) return
    }
    const latestVersion = latestStateVersion(event.characterInstanceId)
    if (latestVersion !== undefined && event.stateVersion <= latestVersion) return
    const key = snapshotKey(event)
    trackKey(event.characterInstanceId, key)
    const existingRevisionState = statesByBindingKey.value[key]
    if (existingRevisionState && event.stateVersion <= existingRevisionState.stateVersion) return
    const state: CharacterPublicState = {
      ...cloneValue(event.state),
      characterId: event.characterId,
      characterInstanceId: event.characterInstanceId,
      characterRevision: event.characterRevision,
      stateVersion: event.stateVersion
    }
    statesByBindingKey.value[key] = state
    const currentLatest = statesByInstanceId.value[event.characterInstanceId]
    if (!currentLatest || event.stateVersion > currentLatest.stateVersion) {
      statesByInstanceId.value[event.characterInstanceId] = state
      latestKeyByInstance.set(event.characterInstanceId, key)
    }
    statusByBindingKey.value[key] = 'ready'
    delete errorsByBindingKey.value[key]
    if (isActiveKey(event.characterInstanceId, key) || activeBinding.value?.characterInstanceId !== event.characterInstanceId) projectInstance(event.characterInstanceId)
    // Never update activeBinding here: only the authoritative conversation
    // binding coordinator may change the active revision.
  }

  function clearInstance(instanceId: string): void {
    instanceGenerations.set(instanceId, (instanceGenerations.get(instanceId) ?? 0) + 1)
    for (const key of bindingKeysByInstance.get(instanceId) ?? []) {
      pending.delete(key)
      requests.delete(key)
      delete statesByBindingKey.value[key]
      delete statusByBindingKey.value[key]
      delete errorsByBindingKey.value[key]
    }
    bindingKeysByInstance.delete(instanceId)
    latestKeyByInstance.delete(instanceId)
    delete statesByInstanceId.value[instanceId]
    delete stateStatus.value[instanceId]
    delete stateErrors.value[instanceId]
  }

  function clear(): void {
    clearGeneration++
    pending.clear()
    requests.clear()
    bindingKeysByInstance.clear()
    latestKeyByInstance.clear()
    instanceGenerations.clear()
    statesByInstanceId.value = {}
    statesByBindingKey.value = {}
    stateStatus.value = {}
    stateErrors.value = {}
    statusByBindingKey.value = {}
    errorsByBindingKey.value = {}
    activeBinding.value = undefined
    activeConversationId.value = undefined
    connectionScopeId.value = undefined
    connectionScopeObserved = false
  }

  return {
    statesByInstanceId,
    statesByBindingKey,
    stateStatus,
    stateErrors,
    statusByBindingKey,
    errorsByBindingKey,
    activeBinding,
    activeConversationId,
    activeState,
    activeStatus,
    activeError,
    connectionEpoch,
    connectionScopeId,
    loadState,
    setActiveBinding,
    handleStateChanged,
    setConnectionEpoch,
    setConnectionScopeId,
    setConnectionSource,
    invalidate,
    clearInstance,
    clear
  }
})
