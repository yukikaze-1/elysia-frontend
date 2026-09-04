import { watch, type WatchStopHandle } from 'vue'
import type { CharacterBindingSnapshot, CharacterPublicState, ConnectionState } from '@shared/contracts'
import type { CharacterRuntimeLoadState } from './character-runtime.store'

/**
 * The small bridge between the session domain and the character runtime
 * domain.  It intentionally knows only the authoritative session binding and
 * connection capability; it does not inspect titles, Live2D models, or
 * character names to infer an identity.
 */
export interface CharacterRuntimeCoordinatorConversation {
  currentId?: string
  currentCharacter?: CharacterBindingSnapshot
}

export interface CharacterRuntimeCoordinatorConnection {
  state: ConnectionState
}

export interface CharacterRuntimeCoordinatorRuntime {
  activeBinding?: CharacterBindingSnapshot
  setActiveBinding(binding: CharacterBindingSnapshot | undefined, conversationId?: string): void
  loadState(instanceId: string, expected?: CharacterBindingSnapshot): Promise<void>
}

export interface CharacterRuntimeCoordinator {
  /** Start the reactive binding watcher. Calling start repeatedly is safe. */
  start(): void
  stop(): void
  /** Synchronously reconcile the current authoritative session binding. */
  sync(): void
}

function sameBinding(left: CharacterBindingSnapshot | undefined, right: CharacterBindingSnapshot | undefined): boolean {
  if (!left || !right) return left === right
  return left.characterId === right.characterId
    && left.characterInstanceId === right.characterInstanceId
    && left.characterRevision === right.characterRevision
    && left.displayName === right.displayName
    && JSON.stringify(left.presentation) === JSON.stringify(right.presentation)
}

/**
 * Create the activity-session → runtime binding coordinator.
 *
 * Only connected + characterProfiles=true may issue a REST snapshot request.
 * The runtime store owns request/epoch/identity guards; this coordinator owns
 * when a request is appropriate and keeps the active binding current while
 * the user is offline, so stale cached state remains displayable.
 */
export function createCharacterRuntimeCoordinator(
  conversation: CharacterRuntimeCoordinatorConversation,
  connection: CharacterRuntimeCoordinatorConnection,
  runtime: CharacterRuntimeCoordinatorRuntime
): CharacterRuntimeCoordinator {
  let stopWatch: WatchStopHandle | undefined
  let syncScheduled = false
  let active = false
  let lifecycleGeneration = 0

  function sync(): void {
    const conversationId = conversation.currentId
    const binding = conversationId ? conversation.currentCharacter : undefined
    const previous = runtime.activeBinding
    if (!sameBinding(previous, binding)) runtime.setActiveBinding(binding, conversationId)
    else if (conversationId !== undefined && previous) runtime.setActiveBinding(previous, conversationId)

    const state = connection.state
    if (!conversationId || !binding || state.status !== 'connected' || state.features?.characterProfiles !== true) return

    // A ready state for the same binding is deduplicated by the runtime store.
    // Capturing the binding object here is important: a quick A→B switch may
    // settle A after B is active, but the runtime response must still validate
    // itself against A's identity and can never populate B's view.
    void Promise.resolve(runtime.loadState(binding.characterInstanceId, binding)).catch(() => {})
  }

  function scheduleSync(): void {
    // Vue's watch callback is already batched, but the explicit microtask keeps
    // a synchronous cascade of currentId/currentCharacter updates at one
    // coherent binding boundary in tests and in activation flows.
    if (syncScheduled) return
    syncScheduled = true
    const scheduledGeneration = lifecycleGeneration
    queueMicrotask(() => {
      syncScheduled = false
      if (!active || scheduledGeneration !== lifecycleGeneration) return
      sync()
    })
  }

  return {
    start(): void {
      if (stopWatch) return
      active = true
      lifecycleGeneration++
      stopWatch = watch(
        () => ({
          conversationId: conversation.currentId,
          binding: conversation.currentCharacter,
          status: connection.state.status,
          serverUrl: connection.state.serverUrl,
          connectionScopeId: connection.state.connectionScopeId,
          connectionId: connection.state.connectionId,
          characterProfiles: connection.state.features?.characterProfiles === true,
          characterStateStream: connection.state.features?.characterStateStream === true
        }),
        scheduleSync,
        { deep: true }
      )
      sync()
    },
    stop(): void {
      stopWatch?.()
      stopWatch = undefined
      active = false
      lifecycleGeneration++
      syncScheduled = false
    },
    sync
  }
}

// Keep these aliases available to component/tests without coupling them to
// the concrete Pinia store implementation.
export type CharacterRuntimeView = {
  state?: CharacterPublicState
  status: CharacterRuntimeLoadState
}
