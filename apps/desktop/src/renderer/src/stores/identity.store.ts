import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { UpdateUserIdentityCommand, UserIdentityProfile } from '@shared/contracts'
import { api } from './desktop-api'
import { parsePublicError, type PublicError } from '../utils/public-error'

export type IdentityLoadState = 'idle' | 'loading' | 'ready' | 'error'
export type IdentitySaveState = 'idle' | 'saving' | 'success' | 'error' | 'conflict'
export type IdentityDraft = Omit<UpdateUserIdentityCommand, 'expectedRevision'>

export const USER_PROFILE_REVISION_CONFLICT = 'USER_PROFILE_REVISION_CONFLICT'

function missingApiError(): Error {
  return new Error('[CHARACTER_PROFILES_UNAVAILABLE] 角色档案 API 尚未装配')
}

/**
 * 用户身份 store。load/save 分离；profile 仅驻留 Renderer 内存，不写 localStorage/session cache。
 * profile 以连接 epoch 归属，断线/换连接后旧读取和旧写入都不会回填新连接。
 */
export const useIdentityStore = defineStore('character-identity', () => {
  const profile = ref<UserIdentityProfile>()
  const status = ref<IdentityLoadState>('idle')
  const error = ref<PublicError>()
  const saveStatus = ref<IdentitySaveState>('idle')
  const saveError = ref<PublicError>()
  const draft = ref<IdentityDraft>()
  const dirty = ref(false)
  const connectionEpoch = ref(0)
  const requestSequence = ref(0)
  const saveSequence = ref(0)
  let identityGeneration = 0
  let loadedEpoch = -1
  let pending: Promise<void> | undefined
  let pendingSave: Promise<boolean> | undefined

  const initialized = computed(() => profile.value?.initialized === true)
  const defaultCharacterId = computed(() => profile.value?.defaultCharacterId)

  function setConnectionEpoch(epoch: number): void {
    if (!Number.isFinite(epoch) || epoch < 0) return
    const next = Math.floor(epoch)
    if (next === connectionEpoch.value) return
    // A connection epoch invalidates the authoritative profile and every
    // in-flight request, but it must not erase user-authored form input.  The
    // next successful GET supplies the new revision baseline while load()
    // deliberately leaves a dirty draft untouched.  Clean drafts are derived
    // data and may be rebuilt from the new backend profile.
    const retainedDraft = dirty.value && draft.value ? { ...draft.value } : undefined
    connectionEpoch.value = next
    identityGeneration++
    requestSequence.value++
    saveSequence.value++
    pending = undefined
    pendingSave = undefined
    profile.value = undefined
    draft.value = retainedDraft
    dirty.value = retainedDraft !== undefined
    loadedEpoch = -1
    status.value = 'idle'
    error.value = undefined
    saveStatus.value = 'idle'
    saveError.value = undefined
  }

  function invalidate(): void {
    setConnectionEpoch(connectionEpoch.value + 1)
  }

  function load(force = false): Promise<void> {
    if (!force && loadedEpoch === connectionEpoch.value && status.value === 'ready') return Promise.resolve()
    if (!force && pending) return pending

    const epoch = connectionEpoch.value
    const generation = identityGeneration
    const request = ++requestSequence.value
    status.value = 'loading'
    error.value = undefined
    const getter = api && api.getMe
    // 保持调用在本 tick 发起（调用方可能马上推进 epoch/释放 deferred），
    // 同时把同步抛错转成 rejected Promise，统一由下面的 catch 收口。
    let operation: Promise<UserIdentityProfile>
    try {
      operation = getter ? Promise.resolve(getter()) : Promise.reject(missingApiError())
    } catch (cause) {
      operation = Promise.reject(cause)
    }
    const task = operation
      .then((nextProfile) => {
        if (epoch !== connectionEpoch.value || generation !== identityGeneration || request !== requestSequence.value) return
        profile.value = nextProfile
        loadedEpoch = epoch
        status.value = 'ready'
        if (!dirty.value) resetDraftFromProfile(nextProfile)
      })
      .catch((cause: unknown) => {
        if (epoch !== connectionEpoch.value || generation !== identityGeneration || request !== requestSequence.value) return
        error.value = parsePublicError(cause instanceof Error ? cause.message : String(cause))
        status.value = 'error'
      })
      .finally(() => {
        if (pending === task) pending = undefined
      })
    pending = task
    return task
  }

  function beginEdit(timezoneSuggestion?: string): void {
    if (profile.value) {
      resetDraftFromProfile(profile.value)
      return
    }
    draft.value = {
      displayName: '',
      locale: 'zh-CN',
      timezone: timezoneSuggestion || 'UTC'
    }
    dirty.value = false
  }

  function updateDraft(patch: Partial<IdentityDraft>): void {
    if (!draft.value) beginEdit()
    draft.value = { ...draft.value!, ...patch }
    dirty.value = true
    saveStatus.value = 'idle'
    saveError.value = undefined
  }

  function discardDraft(): void {
    if (profile.value) resetDraftFromProfile(profile.value)
    else draft.value = undefined
    dirty.value = false
    saveStatus.value = 'idle'
    saveError.value = undefined
  }

  function save(): Promise<boolean> {
    if (!profile.value || !draft.value) return Promise.resolve(false)
    return runSave({ expectedRevision: profile.value.revision, ...draft.value }, { syncDraft: true })
  }

  function setDefaultCharacter(characterId: string): Promise<boolean> {
    const current = profile.value
    if (!current) return Promise.resolve(false)
    const command: UpdateUserIdentityCommand = {
      expectedRevision: current.revision,
      displayName: current.displayName,
      locale: current.locale,
      timezone: current.timezone,
      ...(current.preferredAddress !== undefined ? { preferredAddress: current.preferredAddress } : {}),
      ...(current.pronouns !== undefined ? { pronouns: current.pronouns } : {}),
      defaultCharacterId: characterId
    }
    return runSave(command, { syncDraft: false, selectedDefaultCharacterId: characterId })
  }

  function runSave(
    command: UpdateUserIdentityCommand,
    options: { syncDraft: boolean; selectedDefaultCharacterId?: string }
  ): Promise<boolean> {
    if (pendingSave) return pendingSave
    const updater = api && api.updateMe
    if (!updater) {
      saveError.value = parsePublicError(missingApiError().message)
      saveStatus.value = 'error'
      return Promise.resolve(false)
    }
    const epoch = connectionEpoch.value
    const request = ++saveSequence.value
    // 保存开始即使更早的 profile GET 失效，避免旧读取在写成功后覆盖新 profile。
    identityGeneration++
    requestSequence.value++
    pending = undefined
    saveStatus.value = 'saving'
    saveError.value = undefined
    // 保持调用在本 tick 发起；同步抛错也转成 rejected Promise，避免
    // saveStatus 卡在 saving 并让 finally 失去机会。
    let operation: Promise<UserIdentityProfile>
    try {
      operation = Promise.resolve(updater(command))
    } catch (cause) {
      operation = Promise.reject(cause)
    }
    const task = operation
      .then((nextProfile) => {
        if (epoch !== connectionEpoch.value || request !== saveSequence.value) return false
        if (profile.value && nextProfile.revision < profile.value.revision) {
          saveError.value = {
            code: 'BACKEND_REJECTED',
            backendCode: USER_PROFILE_REVISION_CONFLICT,
            currentRevision: profile.value.revision,
            message: '档案已被更新，较旧的保存结果已丢弃'
          }
          saveStatus.value = 'conflict'
          if (!pending) status.value = profile.value ? 'ready' : 'idle'
          return false
        }
        // 写开始后仍可能有人发起 force GET；写成功是更新鲜的事实，必须让这些同 epoch
        // 且早于成功落点的读取失效。此后新发起的读取会捕获新的 generation。
        identityGeneration++
        requestSequence.value++
        pending = undefined
        profile.value = nextProfile
        loadedEpoch = epoch
        status.value = 'ready'
        error.value = undefined
        saveStatus.value = 'success'
        if (options.syncDraft) {
          resetDraftFromProfile(nextProfile)
          saveStatus.value = 'success'
        } else if (draft.value && dirty.value && options.selectedDefaultCharacterId) {
          draft.value = { ...draft.value, defaultCharacterId: options.selectedDefaultCharacterId }
        } else if (!dirty.value) {
          resetDraftFromProfile(nextProfile)
          saveStatus.value = 'success'
        }
        return true
      })
      .catch((cause: unknown) => {
        if (epoch !== connectionEpoch.value || request !== saveSequence.value) return false
        const parsed = parsePublicError(cause instanceof Error ? cause.message : String(cause))
        saveError.value = parsed
        saveStatus.value = parsed.backendCode === USER_PROFILE_REVISION_CONFLICT ? 'conflict' : 'error'
        if (!pending) status.value = profile.value ? 'ready' : 'idle'
        return false
      })
      .finally(() => {
        if (pendingSave === task) pendingSave = undefined
      })
    pendingSave = task
    return task
  }

  function resetDraftFromProfile(value: UserIdentityProfile): void {
    draft.value = {
      displayName: value.displayName,
      locale: value.locale,
      timezone: value.timezone,
      ...(value.preferredAddress !== undefined ? { preferredAddress: value.preferredAddress } : {}),
      ...(value.pronouns !== undefined ? { pronouns: value.pronouns } : {}),
      ...(value.defaultCharacterId !== undefined ? { defaultCharacterId: value.defaultCharacterId } : {})
    }
    dirty.value = false
  }

  function clearSaveFeedback(): void {
    saveStatus.value = 'idle'
    saveError.value = undefined
  }

  /** 角色归档等服务端原子操作携带的权威 profile；同连接内只接受不降级 revision。 */
  function applyServerProfile(nextProfile: UserIdentityProfile, epoch = connectionEpoch.value): boolean {
    if (epoch !== connectionEpoch.value) return false
    if (profile.value && nextProfile.revision < profile.value.revision) return false
    identityGeneration++
    requestSequence.value++
    pending = undefined
    profile.value = nextProfile
    loadedEpoch = epoch
    status.value = 'ready'
    error.value = undefined
    if (!dirty.value) resetDraftFromProfile(nextProfile)
    return true
  }

  return {
    profile,
    status,
    error,
    saveStatus,
    saveError,
    draft,
    dirty,
    connectionEpoch,
    initialized,
    defaultCharacterId,
    load,
    beginEdit,
    updateDraft,
    discardDraft,
    save,
    setDefaultCharacter,
    clearSaveFeedback,
    applyServerProfile,
    invalidate,
    setConnectionEpoch
  }
})
