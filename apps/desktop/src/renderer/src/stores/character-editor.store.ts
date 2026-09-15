// FE-D2：角色编辑器领域状态（无 UI）。
//
// 当前 store 只保存 Renderer 内存中的编辑会话和未提交草稿；完整草稿经
// Main 的具名 IPC 恢复，不使用 localStorage/sessionStorage。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CharacterDetail,
  CharacterDraft,
  CharacterDraftSummary,
  CharacterEditorMode,
  CharacterMutationResult,
  CharacterPreviewCommand,
  CharacterPreviewResult,
  CharacterStatePolicy,
  CharacterValidationResult,
  PersistedCharacterDraft,
  UpdateCharacterCommand
} from '@shared/contracts'
import { CharacterDraftKeySchema, CharacterDraftSummarySchema, PersistedCharacterDraftSchema } from '@shared/schemas'
import { api } from './desktop-api'
import { parsePublicError, type PublicError } from '../utils/public-error'
import { cloneValue } from '@shared/domain'

export const CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS = 800

export type CharacterEditorOperationStatus = 'idle' | 'loading' | 'success' | 'error'
export type CharacterEditorSaveStatus = 'idle' | 'saving' | 'success' | 'error' | 'conflict'

export interface CharacterEditorConflict {
  /** 已知冲突码三种：`CHARACTER_REVISION_CONFLICT`／`CHARACTER_STATE_CONFLICT`／
   *  `CHARACTER_STATE_VERSION_CONFLICT`（D-2 2026-09-15：mock 后端实际发带 VERSION 的码，此前未认）。
   *  原写成 `'A' | 'B' | string` —— 字面量被 `string` 吞掉，属冗余类型成分
   *  （`no-redundant-type-constituents`，2026-09-13 type-aware 全集）；已知取值写在注释里，
   *  判据（是否冲突、走哪条提示）由消费侧按值比较，不靠类型面。 */
  backendCode: string
  currentRevision?: number
  /** D-2：状态版本冲突码携带的当前 `stateVersion`（与 currentRevision 不同源） */
  currentStateVersion?: number
  message: string
}

export interface CharacterEditorSnapshot {
  key: string
  mode: CharacterEditorMode
  characterId?: string
  baseRevision?: number
  statePolicy: CharacterStatePolicy
  draft: CharacterDraft
  editorGeneration: number
  draftGeneration: number
  connectionEpoch: number
}

type SavedCharacter = CharacterDetail | CharacterMutationResult

interface SaveFlight {
  key: string
  editorGeneration: number
  connectionEpoch: number
  promise: Promise<SavedCharacter | undefined>
}

function publicError(cause: unknown): PublicError {
  return parsePublicError(cause instanceof Error ? cause.message : String(cause))
}

function offlineError(): Error {
  return new Error('[NOT_CONNECTED] [backendCode=CHARACTER_OFFLINE] 当前未连接，角色远端操作不会排队')
}

function missingApiError(name: string): Error {
  return new Error(`[CHARACTER_PROFILES_UNAVAILABLE] [backendCode=CHARACTER_PROFILES_UNAVAILABLE] 角色${name} API 尚未装配`)
}

function emptyDraft(displayName = '新角色'): CharacterDraft {
  return {
    displayName,
    description: '',
    aliases: [],
    promptProfile: {
      corePersonality: '', relationshipStyle: '', emotionStyle: '', speakingStyle: '',
      conversationInitiative: '', examples: []
    },
    runtimeDefaults: {
      voice: {}, emotion: { idleExpressions: [] }, wakeWords: [],
      proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
    },
    presentation: {}
  }
}

function draftFromDetail(detail: CharacterDetail): CharacterDraft {
  const current = detail.current
  return cloneValue({
    displayName: current.displayName,
    description: current.description,
    aliases: current.aliases,
    promptProfile: current.promptProfile,
    runtimeDefaults: current.runtimeDefaults,
    presentation: current.presentation,
    ...(current.openingMessage !== undefined ? { openingMessage: current.openingMessage } : {})
  })
}

function errorFromValidation(result: CharacterValidationResult): PublicError {
  return { code: 'BACKEND_REJECTED', backendCode: 'CHARACTER_VALIDATION', message: 'LOCAL:CHARACTER_VALIDATION', issues: cloneValue(result.issues) }
}

function isRevisionConflict(error: PublicError): boolean {
  return error.backendCode === 'CHARACTER_REVISION_CONFLICT' || error.backendCode === 'CHARACTER_STATE_CONFLICT'
    || error.backendCode === 'CHARACTER_STATE_VERSION_CONFLICT'   // D-2：mock 后端实发码，此前落到非冲突分支
}

export const useCharacterEditorStore = defineStore('character-editor', () => {
  const draftKey = ref<string>()
  const mode = ref<CharacterEditorMode>()
  const baseCharacterId = ref<string>()
  const baseRevision = ref<number>()
  const draft = ref<CharacterDraft>()
  const statePolicy = ref<CharacterStatePolicy>('preserve')
  const dirty = ref(false)

  const validation = ref<CharacterValidationResult>()
  const validationStatus = ref<CharacterEditorOperationStatus>('idle')
  const validationError = ref<PublicError>()
  const preview = ref<CharacterPreviewResult>()
  const previewUserMessage = ref('')
  const previewStatus = ref<CharacterEditorOperationStatus>('idle')
  const previewError = ref<PublicError>()
  const saveStatus = ref<CharacterEditorSaveStatus>('idle')
  const saveError = ref<PublicError>()
  const persistenceStatus = ref<CharacterEditorOperationStatus>('idle')
  const persistenceError = ref<PublicError>()
  const recoveryStatus = ref<CharacterEditorOperationStatus>('idle')
  const recoveryError = ref<PublicError>()
  const recoverySummaries = ref<CharacterDraftSummary[]>([])
  const conflict = ref<CharacterEditorConflict>()
  const lastPersistedAt = ref<string>()
  const lastSaved = ref<SavedCharacter>()
  const connectionEpoch = ref(0)
  const remoteAvailable = ref(false)

  // Independent operation tokens: a preview must not make an in-flight validation
  // appear stale (or leave it stuck at loading), and duplicate saves share a flight.
  let editorGeneration = 0
  let draftGeneration = 0
  let validationSequence = 0
  let saveValidationSequence = 0
  let previewSequence = 0
  let saveSequence = 0
  let recoverySequence = 0
  let persistSequence = 0
  let keySerial = 0
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  let saveInFlight: SaveFlight | undefined
  const pendingPersists = new Map<string, Set<Promise<boolean>>>()
  const persistTails = new Map<string, Promise<boolean>>()

  const hasEditor = computed(() => draft.value !== undefined && mode.value !== undefined && draftKey.value !== undefined)
  const hasValidationErrors = computed(() => validation.value?.issues.some((issue) => issue.severity === 'error') === true)

  function cancelPersistTimer(): void {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer)
      persistTimer = undefined
    }
  }

  function resetOperationState(): void {
    validation.value = undefined
    validationStatus.value = 'idle'
    validationError.value = undefined
    preview.value = undefined
    previewUserMessage.value = ''
    previewStatus.value = 'idle'
    previewError.value = undefined
    saveStatus.value = 'idle'
    saveError.value = undefined
    persistenceStatus.value = 'idle'
    persistenceError.value = undefined
    conflict.value = undefined
    lastSaved.value = undefined
    // A session switch invalidates any in-flight recovery request.  Do not leave
    // the recovery pane showing a spinner after its result has been discarded.
    recoveryStatus.value = 'idle'
    recoveryError.value = undefined
  }

  function invalidateAsyncOperations(): void {
    validationSequence++
    saveValidationSequence++
    previewSequence++
    saveSequence++
    recoverySequence++
    // Local draft persistence is deliberately independent from the remote
    // connection token.  An epoch/availability change invalidates remote
    // operations, but must not invalidate an already scheduled recovery write.
    if (recoveryStatus.value === 'loading') {
      recoveryStatus.value = 'idle'
      recoveryError.value = undefined
    }
  }

  function clearEditorState(): void {
    draftKey.value = undefined
    mode.value = undefined
    baseCharacterId.value = undefined
    baseRevision.value = undefined
    draft.value = undefined
    statePolicy.value = 'preserve'
    dirty.value = false
    lastPersistedAt.value = undefined
    resetOperationState()
  }

  function createDraftKey(editorMode: CharacterEditorMode, characterId: string | undefined): string {
    if (characterId && editorMode === 'edit') return `edit:${characterId}`
    keySerial++
    return `${editorMode}:${Date.now().toString(36)}:${keySerial.toString(36)}`
  }

  function replaceEditor(input: {
    key?: string
    mode: CharacterEditorMode
    characterId?: string
    baseRevision?: number
    draft: CharacterDraft
    dirty: boolean
    updatedAt?: string
    policy?: CharacterStatePolicy
  }): void {
    cancelPersistTimer()
    invalidateAsyncOperations()
    editorGeneration++
    draftGeneration++
    draftKey.value = input.key ?? createDraftKey(input.mode, input.characterId)
    mode.value = input.mode
    baseCharacterId.value = input.characterId
    baseRevision.value = input.baseRevision
    statePolicy.value = input.policy ?? 'preserve'
    draft.value = cloneValue(input.draft)
    dirty.value = input.dirty
    lastPersistedAt.value = input.updatedAt
    resetOperationState()
  }

  function beginCreate(initial?: CharacterDraft): void {
    replaceEditor({ mode: 'create', draft: initial ? cloneValue(initial) : emptyDraft(), dirty: false })
  }

  function beginEdit(detail: CharacterDetail, recovered?: PersistedCharacterDraft): void {
    if (recovered) {
      replaceEditor({
        key: recovered.key,
        mode: 'edit',
        characterId: recovered.characterId ?? detail.summary.characterId,
        baseRevision: recovered.baseRevision ?? detail.summary.currentRevision,
        draft: recovered.draft,
        dirty: true,
        updatedAt: recovered.updatedAt,
        policy: recovered.statePolicy ?? 'preserve'
      })
      return
    }
    replaceEditor({ mode: 'edit', characterId: detail.summary.characterId, baseRevision: detail.current.revision, draft: draftFromDetail(detail), dirty: false })
  }

  function beginClone(detail: CharacterDetail, displayName?: string): void {
    const next = draftFromDetail(detail)
    if (displayName !== undefined) next.displayName = displayName
    replaceEditor({ mode: 'clone', characterId: detail.summary.characterId, baseRevision: detail.current.revision, draft: next, dirty: displayName !== undefined })
  }

  const startCreate = beginCreate
  const startEdit = beginEdit
  const startClone = beginClone

  function captureSnapshot(): CharacterEditorSnapshot | undefined {
    if (!draftKey.value || !mode.value || !draft.value) return undefined
    return {
      key: draftKey.value,
      mode: mode.value,
      ...(baseCharacterId.value !== undefined ? { characterId: baseCharacterId.value } : {}),
      ...(baseRevision.value !== undefined ? { baseRevision: baseRevision.value } : {}),
      statePolicy: statePolicy.value,
      draft: cloneValue(draft.value),
      editorGeneration,
      draftGeneration,
      connectionEpoch: connectionEpoch.value
    }
  }

  function isSessionCurrent(snapshot: CharacterEditorSnapshot): boolean {
    return snapshot.key === draftKey.value && snapshot.editorGeneration === editorGeneration && snapshot.connectionEpoch === connectionEpoch.value
  }

  function isSnapshotCurrent(snapshot: CharacterEditorSnapshot): boolean {
    return isSessionCurrent(snapshot) && snapshot.draftGeneration === draftGeneration
  }

  function isValidationCurrent(snapshot: CharacterEditorSnapshot, sequence: number): boolean {
    return isSnapshotCurrent(snapshot) && sequence === validationSequence
  }

  function isSaveValidationCurrent(snapshot: CharacterEditorSnapshot, sequence: number): boolean {
    // A save validates the immutable snapshot captured at click time. It may
    // finish after the user edits the same session; in that case the result is
    // still useful to the save, but must not overwrite the newer form state.
    return isSessionCurrent(snapshot) && sequence === saveValidationSequence
  }

  function isSaveValidationSnapshotCurrent(snapshot: CharacterEditorSnapshot, sequence: number): boolean {
    return isSaveValidationCurrent(snapshot, sequence) && snapshot.draftGeneration === draftGeneration
  }

  function isPreviewCurrent(snapshot: CharacterEditorSnapshot, sequence: number): boolean {
    return isSnapshotCurrent(snapshot) && sequence === previewSequence
  }

  function isSaveCurrent(snapshot: CharacterEditorSnapshot, sequence: number): boolean {
    // Save owns its captured payload; editing the same session while it is in flight
    // is intentionally allowed and is rebased after the remote success.
    return isSessionCurrent(snapshot) && sequence === saveSequence
  }

  function isPersistSnapshotCurrent(snapshot: CharacterEditorSnapshot, sequence: number): boolean {
    // Unlike remote operations, local recovery writes do not require the same
    // connection epoch.  They remain valid across reconnect/disconnect events
    // as long as the editor session and draft generation are still current.
    return snapshot.key === draftKey.value && snapshot.editorGeneration === editorGeneration && snapshot.draftGeneration === draftGeneration && sequence === persistSequence
  }

  function updateDraft(patch: Partial<CharacterDraft>): void {
    if (!draft.value) beginCreate()
    draft.value = cloneValue({ ...draft.value!, ...cloneValue(patch) })
    draftGeneration++
    dirty.value = true
    validation.value = undefined
    validationSequence++
    validationStatus.value = 'idle'
    validationError.value = undefined
    preview.value = undefined
    previewSequence++
    previewStatus.value = 'idle'
    previewError.value = undefined
    if (saveStatus.value !== 'saving') {
      saveStatus.value = 'idle'
      saveError.value = undefined
    }
    conflict.value = undefined
    schedulePersist()
  }

  /** JSON Pointer/dot path field update, restricted to own data properties. */
  function updateField(path: string, value: unknown): void {
    const current = draft.value ? cloneValue(draft.value) : emptyDraft()
    const segments = path.startsWith('/')
      ? path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      : path.split('.')
    if (!segments.length || segments.some((part) => !part || part === '__proto__' || part === 'prototype' || part === 'constructor')) return
    let target: Record<string, unknown> | unknown[] = current as unknown as Record<string, unknown>
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index]
      if (Array.isArray(target)) {
        const arrayIndex = Number(segment)
        if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= target.length) return
        const child = target[arrayIndex]
        if (!child || typeof child !== 'object') return
        target = child as Record<string, unknown> | unknown[]
      } else {
        const child = target[segment]
        if (!child || typeof child !== 'object') return
        target = child as Record<string, unknown> | unknown[]
      }
    }
    const leaf = segments[segments.length - 1]
    if (Array.isArray(target)) {
      const arrayIndex = Number(leaf)
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= target.length) return
      target[arrayIndex] = cloneValue(value)
    } else {
      if (!Object.prototype.hasOwnProperty.call(target, leaf)) return
      target[leaf] = cloneValue(value)
    }
    updateDraft(current)
  }

  const setField = updateField

  function setStatePolicy(policy: CharacterStatePolicy): void {
    if (policy !== 'preserve' && policy !== 'reset_evolution') return
    if (statePolicy.value === policy) return
    statePolicy.value = policy
    draftGeneration++
    dirty.value = true
    validation.value = undefined
    validationSequence++
    validationStatus.value = 'idle'
    preview.value = undefined
    previewSequence++
    previewStatus.value = 'idle'
    saveStatus.value = saveStatus.value === 'saving' ? 'saving' : 'idle'
    saveError.value = undefined
    conflict.value = undefined
    schedulePersist()
  }

  function setConnectionEpoch(epoch: number): void {
    if (!Number.isFinite(epoch) || epoch < 0) return
    const next = Math.floor(epoch)
    if (next === connectionEpoch.value) return
    connectionEpoch.value = next
    invalidateAsyncOperations()
    validationStatus.value = 'idle'
    previewStatus.value = 'idle'
    if (saveStatus.value === 'saving') saveStatus.value = 'idle'
    schedulePersistIfDirty()
  }

  function setOnline(value: boolean): void {
    remoteAvailable.value = value
    if (!value) {
      invalidateAsyncOperations()
      if (saveStatus.value === 'saving') saveStatus.value = 'idle'
      if (validationStatus.value === 'loading') validationStatus.value = 'idle'
      if (previewStatus.value === 'loading') previewStatus.value = 'idle'
      schedulePersistIfDirty()
    }
  }

  function setConnectionState(status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error', features?: { characterProfiles?: boolean }): void {
    const available = status === 'connected' && features?.characterProfiles === true
    const changed = remoteAvailable.value !== available
    remoteAvailable.value = available
    if (changed && !available) {
      invalidateAsyncOperations()
      if (saveStatus.value === 'saving') saveStatus.value = 'idle'
      if (validationStatus.value === 'loading') validationStatus.value = 'idle'
      if (previewStatus.value === 'loading') previewStatus.value = 'idle'
      schedulePersistIfDirty()
    }
  }

  function setConnectionStatus(status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'): void {
    setConnectionState(status)
  }

  async function persistSnapshot(snapshot: CharacterEditorSnapshot, sequence: number): Promise<boolean> {
    if (!isPersistSnapshotCurrent(snapshot, sequence)) return false
    // `.bind(api)`：把这几个方法从 `api` 对象上**显式**摘下来（`unbound-method`，2026-09-13 type-aware 全集）。
    // 这些方法声明在接口上是「方法」，脱离对象引用时 `this` 不再保证指向 `api`；绑定后语义与直接调用一致。
    const saver = api?.saveCharacterDraft?.bind(api)
    if (!saver) {
      if (isPersistSnapshotCurrent(snapshot, sequence)) {
        persistenceStatus.value = 'error'
        persistenceError.value = publicError(missingApiError('草稿保存'))
      }
      return false
    }
    const record: PersistedCharacterDraft = {
      key: snapshot.key,
      mode: snapshot.mode,
      ...(snapshot.characterId !== undefined ? { characterId: snapshot.characterId } : {}),
      ...(snapshot.baseRevision !== undefined ? { baseRevision: snapshot.baseRevision } : {}),
      displayName: snapshot.draft.displayName,
      updatedAt: new Date().toISOString(),
      draft: cloneValue(snapshot.draft),
      statePolicy: snapshot.statePolicy
    }
    const parsed = PersistedCharacterDraftSchema.safeParse(record)
    if (!parsed.success) {
      if (isPersistSnapshotCurrent(snapshot, sequence)) {
        persistenceStatus.value = 'error'
        persistenceError.value = { code: 'SCHEMA_VALIDATION_FAILED', message: 'LOCAL:draft_invalid' }
      }
      return false
    }
    if (isPersistSnapshotCurrent(snapshot, sequence)) {
      persistenceStatus.value = 'loading'
      persistenceError.value = undefined
    }
    try {
      await Promise.resolve().then(() => saver(cloneValue(parsed.data)))
      if (!isPersistSnapshotCurrent(snapshot, sequence)) return true
      persistenceStatus.value = 'success'
      lastPersistedAt.value = parsed.data.updatedAt
      return true
    } catch (cause) {
      if (!isPersistSnapshotCurrent(snapshot, sequence)) return false
      persistenceStatus.value = 'error'
      persistenceError.value = publicError(cause)
      return false
    }
  }

  function trackPersist(snapshot: CharacterEditorSnapshot, sequence: number): Promise<boolean> {
    const previous = persistTails.get(snapshot.key)
    const task = (previous ?? Promise.resolve(true)).catch(() => true).then(() => persistSnapshot(snapshot, sequence))
    persistTails.set(snapshot.key, task)
    const tasks = pendingPersists.get(snapshot.key) ?? new Set<Promise<boolean>>()
    tasks.add(task)
    pendingPersists.set(snapshot.key, tasks)
    void task.then(() => {
      const current = pendingPersists.get(snapshot.key)
      current?.delete(task)
      if (current && current.size === 0) pendingPersists.delete(snapshot.key)
    }, () => {
      const current = pendingPersists.get(snapshot.key)
      current?.delete(task)
      if (current && current.size === 0) pendingPersists.delete(snapshot.key)
    })
    void task.then(() => {
      if (persistTails.get(snapshot.key) === task) persistTails.delete(snapshot.key)
    }, () => {
      if (persistTails.get(snapshot.key) === task) persistTails.delete(snapshot.key)
    })
    return task
  }

  async function waitForPendingPersists(key: string): Promise<void> {
    const tasks = pendingPersists.get(key)
    if (tasks?.size) await Promise.allSettled([...tasks])
  }

  /**
   * Drain a captured write before deleting its recovery record. Edit keys are
   * deterministic, so a same-key editor opened while this awaits must win; a
   * different key cannot be the new editor's recovery record.
   */
  async function deleteDraftAfterPending(
    key: string,
    owner?: { editorGeneration: number; draftGeneration?: number }
  ): Promise<boolean> {
    await waitForPendingPersists(key)
    if (owner && draftKey.value === key && (
      editorGeneration !== owner.editorGeneration ||
      (owner.draftGeneration !== undefined && draftGeneration !== owner.draftGeneration)
    )) return false
    return deleteDraft(key)
  }

  function schedulePersist(): void {
    cancelPersistTimer()
    const snapshot = captureSnapshot()
    if (!snapshot) return
    const sequence = ++persistSequence
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      if (isPersistSnapshotCurrent(snapshot, sequence)) void trackPersist(snapshot, sequence)
    }, CHARACTER_EDITOR_DRAFT_DEBOUNCE_MS)
  }

  function schedulePersistIfDirty(): void {
    if (!draft.value || !draftKey.value || !mode.value || !dirty.value) return
    schedulePersist()
  }

  async function flushDraft(): Promise<boolean> {
    cancelPersistTimer()
    const snapshot = captureSnapshot()
    if (!snapshot) return true
    const sequence = ++persistSequence
    return trackPersist(snapshot, sequence)
  }

  const flush = flushDraft
  const persistNow = flushDraft

  async function listDrafts(): Promise<CharacterDraftSummary[]> {
    const request = ++recoverySequence
    const lister = api?.listCharacterDrafts?.bind(api)
    recoveryStatus.value = 'loading'
    recoveryError.value = undefined
    if (!lister) {
      if (request === recoverySequence) {
        recoveryStatus.value = 'error'
        recoveryError.value = publicError(missingApiError('草稿列表'))
      }
      return []
    }
    try {
      const result = await Promise.resolve().then(() => lister())
      if (!Array.isArray(result)) throw new Error('[SCHEMA_VALIDATION_FAILED] LOCAL:draft_list_invalid')
      const valid = result.flatMap((item) => {
        const parsed = CharacterDraftSummarySchema.safeParse(item)
        return parsed.success ? [cloneValue(parsed.data)] : []
      })
      if (request !== recoverySequence) return cloneValue(recoverySummaries.value)
      recoverySummaries.value = valid
      recoveryStatus.value = valid.length ? 'success' : 'idle'
      return cloneValue(valid)
    } catch (cause) {
      if (request !== recoverySequence) return cloneValue(recoverySummaries.value)
      recoveryStatus.value = 'error'
      recoveryError.value = publicError(cause)
      return []
    }
  }

  async function recoverDraft(key: string): Promise<boolean> {
    const request = ++recoverySequence
    const capturedEditorGeneration = editorGeneration
    const capturedDraftGeneration = draftGeneration
    const capturedKey = draftKey.value
    const getter = api?.getCharacterDraft?.bind(api)
    recoveryStatus.value = 'loading'
    recoveryError.value = undefined
    if (!CharacterDraftKeySchema.safeParse(key).success) {
      if (request === recoverySequence) {
        recoveryStatus.value = 'error'
        recoveryError.value = { code: 'SCHEMA_VALIDATION_FAILED', message: 'LOCAL:draft_key_invalid' }
      }
      return false
    }
    if (!getter) {
      if (request === recoverySequence) {
        recoveryStatus.value = 'error'
        recoveryError.value = publicError(missingApiError('草稿恢复'))
      }
      return false
    }
    try {
      const record = await Promise.resolve().then(() => getter(key))
      if (!record) {
        if (request === recoverySequence) recoveryStatus.value = 'idle'
        return false
      }
      const parsed = PersistedCharacterDraftSchema.safeParse(record)
      if (!parsed.success) {
        if (request === recoverySequence) {
          recoveryStatus.value = 'error'
          recoveryError.value = { code: 'SCHEMA_VALIDATION_FAILED', message: 'LOCAL:draft_invalid' }
        }
        return false
      }
      if (request !== recoverySequence || capturedEditorGeneration !== editorGeneration || capturedDraftGeneration !== draftGeneration || capturedKey !== draftKey.value) return false
      replaceEditor({
        key: parsed.data.key,
        mode: parsed.data.mode,
        ...(parsed.data.characterId !== undefined ? { characterId: parsed.data.characterId } : {}),
        ...(parsed.data.baseRevision !== undefined ? { baseRevision: parsed.data.baseRevision } : {}),
        draft: parsed.data.draft,
        dirty: true,
        updatedAt: parsed.data.updatedAt,
        policy: parsed.data.statePolicy ?? 'preserve'
      })
      recoveryStatus.value = 'success'
      return true
    } catch (cause) {
      if (request !== recoverySequence) return false
      recoveryStatus.value = 'error'
      recoveryError.value = publicError(cause)
      return false
    }
  }

  const loadDraft = recoverDraft
  const restoreDraft = recoverDraft

  async function deleteDraft(key: string): Promise<boolean> {
    if (!CharacterDraftKeySchema.safeParse(key).success) {
      persistenceStatus.value = 'error'
      persistenceError.value = { code: 'SCHEMA_VALIDATION_FAILED', message: 'LOCAL:draft_key_invalid' }
      return false
    }
    const deleter = api?.deleteCharacterDraft?.bind(api)
    if (!deleter) {
      persistenceStatus.value = 'error'
      persistenceError.value = publicError(missingApiError('草稿删除'))
      return false
    }
    try {
      await Promise.resolve().then(() => deleter(key))
      recoverySummaries.value = recoverySummaries.value.filter((item) => item.key !== key)
      if (draftKey.value === key) lastPersistedAt.value = undefined
      return true
    } catch (cause) {
      persistenceStatus.value = 'error'
      persistenceError.value = publicError(cause)
      return false
    }
  }

  async function discardDraft(): Promise<boolean> {
    cancelPersistTimer()
    const key = draftKey.value
    const oldGeneration = editorGeneration
    invalidateAsyncOperations()
    editorGeneration++
    draftGeneration++
    clearEditorState()
    if (!key) return true
    await waitForPendingPersists(key)
    // The caller may have opened a new editor while the old write was draining.
    // A different key is safe to delete; only a same-key editor generation is
    // protected from accidental deletion.
    if (draftKey.value === key && editorGeneration !== oldGeneration + 1) return true
    return deleteDraft(key)
  }

  const discard = discardDraft

  async function clearArchivedCharacterDrafts(characterId: string): Promise<number> {
    const currentMatches = baseCharacterId.value === characterId
    const oldKey = currentMatches ? draftKey.value : undefined
    const oldGeneration = editorGeneration
    if (currentMatches) {
      cancelPersistTimer()
      invalidateAsyncOperations()
      editorGeneration++
      draftGeneration++
      clearEditorState()
    }
    const summaries = await listDrafts()
    const targets = new Set(summaries.filter((item) => item.characterId === characterId).map((item) => item.key))
    if (oldKey) targets.add(oldKey)
    let deleted = 0
    for (const key of targets) {
      await waitForPendingPersists(key)
      if (oldKey === key && draftKey.value === key && editorGeneration !== oldGeneration + 1) continue
      if (await deleteDraft(key)) deleted++
    }
    return deleted
  }

  const handleCharacterArchived = clearArchivedCharacterDrafts

  async function requestValidation(snapshot: CharacterEditorSnapshot, sequence: number, owner: 'standalone' | 'save'): Promise<CharacterValidationResult | undefined> {
    const validator = api?.validateCharacter?.bind(api)
    const current = () => owner === 'standalone' ? isValidationCurrent(snapshot, sequence) : isSaveValidationCurrent(snapshot, sequence)
    const exact = () => owner === 'standalone' ? isValidationCurrent(snapshot, sequence) : isSaveValidationSnapshotCurrent(snapshot, sequence)
    if (exact()) {
      validationStatus.value = 'loading'
      validationError.value = undefined
    }
    if (!remoteAvailable.value) {
      const error = offlineError()
      if (current()) { validationStatus.value = 'error'; validationError.value = publicError(error) }
      throw error
    }
    if (!validator) {
      const error = missingApiError('校验')
      if (current()) { validationStatus.value = 'error'; validationError.value = publicError(error) }
      throw error
    }
    try {
      const result = await Promise.resolve().then(() => validator(cloneValue(snapshot.draft)))
      if (!current()) return undefined
      if (exact()) {
        validation.value = cloneValue(result)
        validationStatus.value = 'success'
      }
      return cloneValue(result)
    } catch (cause) {
      if (!current()) return undefined
      if (exact()) { validationStatus.value = 'error'; validationError.value = publicError(cause) }
      throw cause
    }
  }

  async function validate(): Promise<CharacterValidationResult | undefined> {
    const snapshot = captureSnapshot()
    if (!snapshot) return undefined
    const sequence = ++validationSequence
    try { return await requestValidation(snapshot, sequence, 'standalone') } catch (cause) {
      if (isValidationCurrent(snapshot, sequence)) validationError.value = publicError(cause)
      throw cause
    }
  }

  async function previewCharacter(input: string | CharacterPreviewCommand): Promise<CharacterPreviewResult | undefined> {
    const snapshot = captureSnapshot()
    if (!snapshot) return undefined
    // Object callers can provide only the message. The draft always comes from the
    // current editor, preventing stale/unrelated payload injection.
    const command: CharacterPreviewCommand = {
      draft: cloneValue(snapshot.draft),
      userMessage: typeof input === 'string' ? input : input.userMessage
    }
    const sequence = ++previewSequence
    const previewer = api?.previewCharacter?.bind(api)
    if (!remoteAvailable.value) {
      const error = offlineError()
      if (isPreviewCurrent(snapshot, sequence)) { previewStatus.value = 'error'; previewError.value = publicError(error) }
      throw error
    }
    if (!previewer) {
      const error = missingApiError('预览')
      if (isPreviewCurrent(snapshot, sequence)) { previewStatus.value = 'error'; previewError.value = publicError(error) }
      throw error
    }
    if (isPreviewCurrent(snapshot, sequence)) {
      previewStatus.value = 'loading'
      previewError.value = undefined
      previewUserMessage.value = command.userMessage
    }
    try {
      const result = await Promise.resolve().then(() => previewer(cloneValue(command)))
      if (!isPreviewCurrent(snapshot, sequence)) return undefined
      preview.value = cloneValue(result)
      previewStatus.value = 'success'
      return cloneValue(result)
    } catch (cause) {
      if (!isPreviewCurrent(snapshot, sequence)) return undefined
      previewStatus.value = 'error'
      previewError.value = publicError(cause)
      throw cause
    }
  }

  async function finishSaveSuccess(snapshot: CharacterEditorSnapshot, sequence: number, saved: SavedCharacter): Promise<SavedCharacter | undefined> {
    if (!isSaveCurrent(snapshot, sequence)) {
      // The old editor may have been switched away while the request ran. Its
      // record is safe to remove unless a same-key generation has been reopened.
      await deleteDraftAfterPending(snapshot.key, { editorGeneration: snapshot.editorGeneration, draftGeneration: snapshot.draftGeneration })
      return cloneValue(saved)
    }

    const authoritative = 'character' in saved ? saved.character : saved
    // Drain the captured snapshot before rebasing. If the user switches editor
    // while waiting, do not touch the new editor; only clean the old key safely.
    await waitForPendingPersists(snapshot.key)
    if (!isSaveCurrent(snapshot, sequence)) {
      await deleteDraftAfterPending(snapshot.key, { editorGeneration: snapshot.editorGeneration, draftGeneration: snapshot.draftGeneration })
      return cloneValue(saved)
    }

    const editedDuringSave = snapshot.draftGeneration !== draftGeneration
    const currentDraft = editedDuringSave && draft.value ? cloneValue(draft.value) : undefined
    const currentStatePolicy = editedDuringSave ? statePolicy.value : snapshot.statePolicy
    const nextKey = `edit:${authoritative.summary.characterId}`

    // Rebase first, then use the post-rebase generation/draft generation as the
    // cleanup owner. A later same-key edit/reopen changes one of these values and
    // is therefore protected from deletion.
    editorGeneration++
    draftGeneration++
    validationSequence++
    saveValidationSequence++
    previewSequence++
    recoverySequence++
    persistSequence++
    draftKey.value = nextKey
    mode.value = 'edit'
    baseCharacterId.value = authoritative.summary.characterId
    baseRevision.value = authoritative.current.revision
    statePolicy.value = currentStatePolicy
    draft.value = currentDraft ?? draftFromDetail(authoritative)
    dirty.value = currentDraft !== undefined
    lastSaved.value = cloneValue(saved)
    saveStatus.value = 'success'
    saveError.value = undefined
    conflict.value = undefined
    if (currentDraft !== undefined) schedulePersist()
    else { persistenceStatus.value = 'success'; lastPersistedAt.value = undefined }

    const rebasedOwner = { editorGeneration, draftGeneration }
    // Old captured key is always cleaned when safe. For edit/update clean save it
    // equals nextKey; for create/clone it is the old create key.
    if (!(currentDraft !== undefined && snapshot.key === nextKey)) await deleteDraftAfterPending(snapshot.key, rebasedOwner)
    // There should be no record at a clean migrated key, but clean it idempotently
    // for records written by older versions. Never remove a dirty rebased draft.
    if (!currentDraft && nextKey !== snapshot.key) await deleteDraftAfterPending(nextKey, rebasedOwner)
    return cloneValue(saved)
  }

  async function executeSave(snapshot: CharacterEditorSnapshot, sequence: number, validationSequenceForSave: number): Promise<SavedCharacter | undefined> {
    try {
      const result = await requestValidation(snapshot, validationSequenceForSave, 'save')
      if (!result || !isSaveCurrent(snapshot, sequence)) {
        // The remote operation may have been invalidated by a newer editor,
        // save, or connection epoch.  The current dirty editor still needs a
        // local recovery write even when the stale result is discarded.
        schedulePersistIfDirty()
        return undefined
      }
      const hasErrors = result.issues.some((issue) => issue.severity === 'error')
      // valid=false is authoritative; warnings pass only when valid=true.
      if (!result.valid || hasErrors) {
        const error = errorFromValidation(result)
        if (isSaveCurrent(snapshot, sequence)) { saveStatus.value = 'error'; saveError.value = error }
        throw new Error(`[CHARACTER_VALIDATION] ${error.message}`)
      }
      let saved: SavedCharacter
      if (snapshot.mode === 'edit') {
        if (!snapshot.characterId || snapshot.baseRevision === undefined) throw new Error('[INVALID_INPUT] 编辑草稿缺少 revision 基线')
        const command: UpdateCharacterCommand = { characterId: snapshot.characterId, expectedRevision: snapshot.baseRevision, statePolicy: snapshot.statePolicy, draft: cloneValue(snapshot.draft) }
        saved = await Promise.resolve().then(() => api.updateCharacter!(command))
      } else {
        if (!api?.createCharacter) throw missingApiError('创建')
        saved = await Promise.resolve().then(() => api.createCharacter!(/* clone avoids reactive payload */ { draft: cloneValue(snapshot.draft) }))
      }
      return await finishSaveSuccess(snapshot, sequence, saved)
    } catch (cause) {
      if (!isSaveCurrent(snapshot, sequence)) {
        schedulePersistIfDirty()
        return undefined
      }
      const parsed = cause instanceof Error && cause.message.startsWith('[CHARACTER_VALIDATION]') ? saveError.value ?? publicError(cause) : publicError(cause)
      saveError.value = parsed
      if (isRevisionConflict(parsed)) {
        saveStatus.value = 'conflict'
        conflict.value = { backendCode: parsed.backendCode ?? parsed.code, ...(parsed.currentRevision !== undefined ? { currentRevision: parsed.currentRevision } : {}), ...(parsed.currentStateVersion !== undefined ? { currentStateVersion: parsed.currentStateVersion } : {}), message: parsed.message }
      } else if (saveStatus.value !== 'error') saveStatus.value = 'error'
      schedulePersistIfDirty()
      throw cause
    }
  }

  function save(): Promise<SavedCharacter | undefined> {
    const snapshot = captureSnapshot()
    if (!snapshot) return Promise.resolve(undefined)
    if (saveInFlight && saveInFlight.key === snapshot.key && saveInFlight.editorGeneration === snapshot.editorGeneration && saveInFlight.connectionEpoch === snapshot.connectionEpoch) return saveInFlight.promise
    const sequence = ++saveSequence
    const validationSequenceForSave = ++saveValidationSequence
    if (!remoteAvailable.value) {
      const error = offlineError()
      schedulePersistIfDirty()
      saveStatus.value = 'error'; saveError.value = publicError(error)
      return Promise.reject(error)
    }
    if ((snapshot.mode === 'create' || snapshot.mode === 'clone') && !api?.createCharacter) {
      const error = missingApiError('创建'); schedulePersistIfDirty(); saveStatus.value = 'error'; saveError.value = publicError(error); return Promise.reject(error)
    }
    if (snapshot.mode === 'edit' && !api?.updateCharacter) {
      const error = missingApiError('更新'); schedulePersistIfDirty(); saveStatus.value = 'error'; saveError.value = publicError(error); return Promise.reject(error)
    }
    cancelPersistTimer()
    persistSequence++
    saveStatus.value = 'saving'
    saveError.value = undefined
    conflict.value = undefined
    const promise = Promise.resolve().then(() => executeSave(snapshot, sequence, validationSequenceForSave))
    const flight: SaveFlight = { key: snapshot.key, editorGeneration: snapshot.editorGeneration, connectionEpoch: snapshot.connectionEpoch, promise }
    saveInFlight = flight
    void promise.then(() => { if (saveInFlight === flight) saveInFlight = undefined }, () => { if (saveInFlight === flight) saveInFlight = undefined })
    return promise
  }

  function reloadAfterCallerConfirm(detail: CharacterDetail, confirmed: boolean): boolean {
    if (!confirmed) return false
    const oldKey = draftKey.value
    const oldGeneration = editorGeneration
    replaceEditor({ key: `edit:${detail.summary.characterId}:reload:${(++keySerial).toString(36)}`, mode: 'edit', characterId: detail.summary.characterId, baseRevision: detail.current.revision, draft: draftFromDetail(detail), dirty: false })
    if (oldKey && oldKey !== draftKey.value) {
      void deleteDraftAfterPending(oldKey, { editorGeneration: oldGeneration, draftGeneration: undefined })
    }
    return true
  }

  function saveAsNew(): Promise<SavedCharacter | undefined> {
    if (!draft.value) return Promise.resolve(undefined)
    if (!remoteAvailable.value) {
      const error = offlineError()
      schedulePersistIfDirty()
      saveStatus.value = 'error'
      saveError.value = publicError(error)
      return Promise.reject(error)
    }
    const oldKey = draftKey.value
    const oldGeneration = editorGeneration
    const copy = cloneValue(draft.value)
    replaceEditor({ mode: 'create', draft: copy, dirty: true, policy: statePolicy.value })
    if (oldKey && oldKey !== draftKey.value) {
      void deleteDraftAfterPending(oldKey, { editorGeneration: oldGeneration, draftGeneration: undefined })
    }
    return save()
  }

  return {
    draftKey, mode, baseCharacterId, baseRevision, draft, statePolicy, dirty,
    validation, validationStatus, validationError, hasValidationErrors,
    preview, previewUserMessage, previewStatus, previewError,
    saveStatus, saveError, persistenceStatus, persistenceError,
    recoveryStatus, recoveryError, recoverySummaries, conflict, lastPersistedAt, lastSaved,
    connectionEpoch, remoteAvailable, online: remoteAvailable, hasEditor,
    beginCreate, beginEdit, beginClone, startCreate, startEdit, startClone,
    updateDraft, updateField, setField, setStatePolicy,
    setConnectionEpoch, setOnline, setConnectionState, setConnectionStatus,
    schedulePersist, persistSnapshot, flushDraft, flush, persistNow,
    listDrafts, recoverDraft, loadDraft, restoreDraft, deleteDraft, discardDraft, discard,
    clearArchivedCharacterDrafts, handleCharacterArchived,
    validate, previewCharacter, save, reloadAfterCallerConfirm, saveAsNew
  }
})
