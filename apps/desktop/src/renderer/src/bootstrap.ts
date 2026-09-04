// src/renderer/src/bootstrap.ts
// P0-01:Renderer 启动水合编排——push 与启动 snapshot 用同一 applyChatState 消费;
// 启动代次守卫(epoch)防迟到 snapshot 覆盖已收到的新 push(D1,不改 ConnectionState 契约)。
// G2(P1-1/P2-2):先 hydratePersistence 水合 draft/cache,再取连接 snapshot——disconnected 分支离线水合,
// connected 分支缓存不进入 messageStore(只作内存储备,由 initializeConnected+activate 覆盖)。
import type { BackendEvent, CharacterCatalogChangedEvent, CharacterStateChangedEvent, ConnectionState, Conversation, Live2DDirectiveEvent, SessionPersistenceState } from '@shared/contracts'
import type { PublicError } from './utils/public-error'
import type { DesktopApiLike } from './stores/desktop-api.types'

export interface BootstrapStores {
  connection: { setState(s: ConnectionState): void; setError(e: PublicError): void }
  message: { applyEvent(e: unknown): void; handleConnectionStateChange(s: ConnectionState): void; loadReplay(conversationId: string, messages: unknown[]): void }
  conversation: {
    onConnected(connectionId?: string): Promise<void>
    onActiveConversationAppeared(activeId: string): Promise<void>
    setOfflineCache(conversations: Conversation[]): void
    activateLocal(id: string): Promise<void>
    setConnectionState?(state: ConnectionState): void
  }
  draft: { hydrate(state: SessionPersistenceState): void }
  cache: { hydrate(state: SessionPersistenceState): void }
  // P4-B：voiceStore 独立订阅（D-P10）/断线 reset（Important-2）；settingsStore 启动水合（fail-open 不阻塞）
  voice: { init(): void; reset(): void }
  settings: { hydrate(): void }
  // FE-C：角色能力在每个连接世代独立初始化；store 内部吞掉并公开错误，bootstrap 不产生未处理 rejection。
  identity?: { setConnectionEpoch(epoch: number): void; load(force?: boolean): Promise<void> }
  characterCatalog?: {
    setConnectionEpoch(epoch: number): void
    loadList(input?: { status?: 'active' | 'archived' }, options?: { force?: boolean }): Promise<void>
    handleCatalogChanged(event: CharacterCatalogChangedEvent): boolean
  }
  // FE-D2：编辑器保留本地草稿，但远端 validate/preview/save 仅在 connected 可用。
  characterEditor?: {
    setConnectionEpoch(epoch: number): void
    setConnectionState(status: ConnectionState['status'], features?: ConnectionState['features']): void
    handleCharacterArchived(characterId: string): Promise<number>
  }
  // FE-F1：公开角色状态由独立 runtime store 接收；character.state.changed
  // 不进入 messageStore。连接世代由 bootstrap 的 capability signature 驱动。
  characterRuntime?: {
    setConnectionEpoch(epoch: number, connectionScopeId?: string): void
    /** Adopt the desktop-local source scope before a new connection becomes connected. */
    setConnectionScopeId?(connectionScopeId?: string, forceNew?: boolean): void
    setActiveBinding(binding: import('@shared/contracts').CharacterBindingSnapshot | undefined, conversationId?: string): void
    loadState(instanceId: string, expected?: import('@shared/contracts').CharacterBindingSnapshot): Promise<void>
    handleStateChanged(event: CharacterStateChangedEvent, eventEpoch?: number): void
  }
  // FE-F1：活动会话→公开状态 binding 协调器，不把角色状态塞进 conversation/live2d store。
  characterRuntimeCoordinator?: { start(): void }
  // 批次 C（C3）：live2dStore handleDirective——live2d.directive 与消息流同通道（onChatEvent）到达，经
  // applyEvent 分发路径旁路到 Live2D 消费（不产生消息副作用）。live2d 为可选（未接线/未初始化时 no-op）。
  live2d?: { handleDirective(e: Live2DDirectiveEvent): void }
  // 阶段 6 批次 B（Task 7）：toolStore——tool.* 事件旁路（判别键 event，代码 H5；stores 注入模式，
  // 与 live2d.directive 旁路同款——消息 store 不依赖工具框架）+ generation.started 清终态接线（M6）。
  tools?: { init(): void; applyBackendEvent(e: BackendEvent): void; clearForGeneration(): void; setActiveConversationId(id: string | undefined): void }
}

export function createRendererBootstrap(api: DesktopApiLike, stores: BootstrapStores): { register(): void } {
  let stateEpoch = 0
  let prevStatus: ConnectionState['status'] = 'disconnected'
  // 启动 snapshot 与 push 可能交错。记录最后一个真正应用的状态，
  // 让迟到 snapshot 不能覆盖 connected push，同时 disconnected push
  // 仍能触发离线水合。
  let latestAppliedState: ConnectionState | undefined
  let characterEpoch = 0
  let characterConnectionSignature: string | undefined
  let characterCapabilityActive = false
  let characterStateStreamActive = false
  /** Current desktop-local source, if the adapter can prove one. */
  let characterSourceScope: string | undefined
  const normalizeServerUrl = (raw: string | undefined): string | null => {
    const value = raw?.trim()
    if (!value) return null
    try {
      const parsed = new URL(value)
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
      // URL.origin is "null" for custom schemes (for example mock://a).
      // Keep protocol + host in that case so mock://a and mock://b cannot
      // share a character epoch merely because both have an opaque origin.
      const authority = parsed.origin === 'null'
        ? `${parsed.protocol}//${parsed.host}`
        : parsed.origin
      return `${authority.toLowerCase()}${pathname}`
    } catch {
      // Invalid endpoints are still isolated from valid endpoints. Keep a
      // deterministic identity rather than throwing from bootstrap.
      return value.replace(/\/+$/, '').toLowerCase() || null
    }
  }
  const normalizeConnectionScope = (raw: string | undefined): string | undefined => {
    const value = raw?.trim()
    return value || undefined
  }
  const eventBelongsToCurrentCharacterSource = (event: { connectionScopeId?: string }): boolean => {
    const eventScope = normalizeConnectionScope(event.connectionScopeId)
    // A concrete current source requires an exact concrete event scope. If
    // both sides are unknown, preserve the legacy adapter behavior; a scoped
    // event must never silently enter that legacy path.
    return characterSourceScope !== undefined
      ? eventScope === characterSourceScope
      : eventScope === undefined
  }
  const characterSignatureFor = (s: ConnectionState): string => {
    const scope = normalizeConnectionScope(s.connectionScopeId)
    // A local scope is the only source identity.  For a legacy adapter that
    // has no scope, retain the conservative endpoint/connection signature for
    // duplicate suppression; it is never used as a replacement source fence.
    return scope
      ? JSON.stringify(['scope', scope, s.features?.characterProfiles === true, s.features?.characterStateStream === true])
      : JSON.stringify(['legacy', normalizeServerUrl(s.serverUrl), s.connectionId?.trim() || null, s.features?.characterProfiles === true, s.features?.characterStateStream === true])
  }
  const applyChatState = (s: ConnectionState): void => {
    latestAppliedState = s
    const previousStatus = prevStatus
    const characterCapabilityAvailable = s.status === 'connected' && s.features?.characterProfiles === true
    const leavingCharacterConnection = characterCapabilityActive && !characterCapabilityAvailable
    const scope = normalizeConnectionScope(s.connectionScopeId)
    const nextCharacterSignature = characterSignatureFor(s)
    // A legacy adapter can emit a second connected notification without an
    // intermediate connecting/reconnecting state. There is no source proof in
    // that shape, so treat every direct connected→connected capability notice
    // as a new unknown source (security takes precedence over deduplication).
    const legacyDirectConnectedReentry = characterCapabilityAvailable
      && scope === undefined
      && previousStatus === 'connected'
    const enteringCharacterConnection = characterCapabilityAvailable && (
      !characterCapabilityActive || nextCharacterSignature !== characterConnectionSignature
      || legacyDirectConnectedReentry
    )

    // A concrete scope is available as soon as explicit connect() enters its
    // connecting state. Clear source-owned runtime data at that boundary so
    // an old snapshot cannot remain visible while the new account/backend is
    // still handshaking. Missing scope is intentionally handled below on each
    // legacy capability re-entry with forceNew=true.
    characterSourceScope = scope
    const legacySourceFenced = scope === undefined
      && ((s.status === 'connecting' && previousStatus !== 'connecting')
        || (s.status === 'reconnecting' && previousStatus !== 'reconnecting'))
    if (scope) stores.characterRuntime?.setConnectionScopeId?.(scope)
    else if (legacySourceFenced) {
      // A legacy adapter offers no proof that this reconnect belongs to the
      // prior account/backend. Fence it at the transport re-entry itself so
      // an old public snapshot cannot remain visible while handshaking.
      stores.characterRuntime?.setConnectionScopeId?.(undefined, true)
    }

    // Character capability has its own connection generation.  Resolve its
    // enter/leave transition independently from the chat connection below:
    // feature flags may change while chat remains connected.
    if (enteringCharacterConnection) {
      characterConnectionSignature = nextCharacterSignature
      characterCapabilityActive = true
      characterStateStreamActive = s.features?.characterStateStream === true
      characterEpoch++
      stores.identity?.setConnectionEpoch(characterEpoch)
      stores.characterCatalog?.setConnectionEpoch(characterEpoch)
      stores.characterEditor?.setConnectionEpoch(characterEpoch)
      if (stores.characterRuntime?.setConnectionScopeId) {
        // A legacy adapter cannot prove that this re-entry is the same source;
        // force a new unknown source and fail closed. Concrete scopes were
        // already adopted above and therefore remain stale across auto-
        // reconnects instead of being discarded again. Legacy transports are
        // intentionally fenced again at capability entry because their
        // connecting/reconnecting state cannot prove source continuity.
        if (scope === undefined) stores.characterRuntime.setConnectionScopeId(undefined, true)
        stores.characterRuntime.setConnectionEpoch(characterEpoch)
      } else {
        // Keep old renderer adapters source-safe at the epoch boundary as far
        // as their historical API allows. New runtime stores use the branch
        // above and receive the explicit forceNew legacy behavior.
        if (scope !== undefined) stores.characterRuntime?.setConnectionEpoch(characterEpoch, scope)
        else stores.characterRuntime?.setConnectionEpoch(characterEpoch)
      }
      void Promise.allSettled([
        stores.identity?.load(true) ?? Promise.resolve(),
        stores.characterCatalog?.loadList({ status: 'active' }, { force: true }) ?? Promise.resolve()
      ])
    }
    if (leavingCharacterConnection) {
      characterConnectionSignature = undefined
      characterEpoch++
      characterStateStreamActive = false
      stores.identity?.setConnectionEpoch(characterEpoch)
      stores.characterCatalog?.setConnectionEpoch(characterEpoch)
      stores.characterEditor?.setConnectionEpoch(characterEpoch)
      stores.characterRuntime?.setConnectionEpoch(characterEpoch)
    }
    characterCapabilityActive = characterCapabilityAvailable

    stores.connection.setState(s)
    stores.conversation.setConnectionState?.(s)
    stores.characterEditor?.setConnectionState(s.status, s.features)
    stores.tools?.setActiveConversationId(s.activeConversationId)   // 阶段 6 联调收口：实时工具卡片按活动会话过滤
    stores.message.handleConnectionStateChange(s)
    if (s.status === 'connected') {
      void stores.conversation.onConnected(s.connectionId)
      if (s.activeConversationId) void stores.conversation.onActiveConversationAppeared(s.activeConversationId)
    } else {
      // Important-2：连接离开 connected → 停采集 + 取消语音会话 + 清态 + 停 TTS（voiceStore.reset 幂等）
      if (previousStatus === 'connected') void stores.voice.reset()
    }
    prevStatus = s.status
  }
  const register = (): void => {
    api.onChatEvent((e) => {
      // 批次 C（C3）：live2d.directive 与消息流同通道（preload parseBackendEvent 已收得）——在 applyEvent 分发
      // 路径旁路到 live2dStore.handleDirective（live2d 未接线时照常落到 messageStore.applyEvent 的默认忽略）。
      // 刻意不放进 messageStore.applyEvent 内部：消息 store 不依赖 Live2D 框架模块（避免无关单测被
      // Live2DCubismCore 全局缺失拖挂）。
      if (stores.live2d && e && typeof e === 'object' && (e as { event?: unknown }).event === 'live2d.directive') {
        stores.live2d.handleDirective(e as Live2DDirectiveEvent)
        return
      }
      if (e && typeof e === 'object') {
        const kind = (e as { event?: unknown }).event
        // 角色目录事件只由角色域消费；不进入 messageStore，避免在聊天时间线上制造
        // 假消息。只有 catalog store 接受了 revision/sequence fence 后，归档事件才清理
        // 当前编辑器及其本地恢复草稿。
        if (kind === 'character.catalog.changed') {
          // Concrete sources must match exactly. With legacy adapters both the
          // current state and event lack a proof scope, so retain the legacy
          // no-scope path; capabilityActive still prevents pre-connect events.
          if (!characterCapabilityActive || !eventBelongsToCurrentCharacterSource(e as { connectionScopeId?: string })) return
          const catalogEvent = e as CharacterCatalogChangedEvent
          const accepted = stores.characterCatalog?.handleCatalogChanged(catalogEvent) === true
          if (accepted && catalogEvent.status === 'archived') {
            try {
              void Promise.resolve(stores.characterEditor?.handleCharacterArchived(catalogEvent.characterId)).catch(() => {})
            } catch {
              // Local recovery cleanup is best-effort; a synchronous editor
              // failure must not break the event subscription.
            }
          }
          return
        }
        // FE-F1：公开状态旁路。事件属于当前 Main 已栅栏的连接世代；
        // Runtime store 继续做 instance/character/revision/stateVersion 守卫。
        if (kind === 'character.state.changed') {
          if (characterCapabilityActive && characterStateStreamActive
            && eventBelongsToCurrentCharacterSource(e as { connectionScopeId?: string })) {
            stores.characterRuntime?.handleStateChanged(e as CharacterStateChangedEvent, characterEpoch)
          }
          return
        }
        // 阶段 6 批次 B（Task 7）：tool 事件旁路到 toolStore（判别键 event，代码 H5；live2d 旁路先例）。
        // 工具事件完全由 toolStore 消费，不产生消息副作用；tools 未接线时照常落 messageStore 默认忽略。
        if (kind === 'tool.request' || kind === 'tool.started' || kind === 'tool.completed') {
          if (stores.tools) { stores.tools.applyBackendEvent(e as BackendEvent); return }
        } else if (kind === 'generation.started') {
          // 完整 M6：generation.started 先于 applyEvent 清工具实时区终态（A9 只清终态，awaiting 跨代保留）；
          // 消息 store 仍需消费 generation.started（本事件自带 conversationId），此处只做旁路钩子不 return。
          stores.tools?.clearForGeneration()
        }
      }
      stores.message.applyEvent(e)
    })
    api.onChatState((s) => { stateEpoch++; applyChatState(s) })
    api.onChatReplay(({ conversationId, messages }) => stores.message.loadReplay(conversationId, messages))
    api.onChatError((err) => stores.connection.setError(err))
    // 启动水合：先 hydratePersistence（draft/cache store），再取连接 snapshot 判离线/在线分支。
    // snapshot 若迟到，只丢弃它本身的 apply；离线判断依据最后一个已应用的
    // 状态，从而同时覆盖 connected push→迟到 disconnected snapshot，以及
    // disconnected push→迟到 snapshot 的离线水合。
    const captured = stateEpoch
    void api.hydratePersistence().then((state) => {
      stores.draft.hydrate(state)
      stores.cache.hydrate(state)
      return api.getConnectionState().then((snapshot) => {
        if (stateEpoch === captured) applyChatState(snapshot)
        const finalState = latestAppliedState ?? snapshot
        if (finalState.status === 'disconnected') {
          // 离线水合（P2-2 只发生在 disconnected 分支；connected 分支缓存不进入 messageStore）
          stores.conversation.setOfflineCache(state.conversations)
          const ids = new Set(state.conversations.map((c) => c.id))
          const target = state.lastActiveConversationId && ids.has(state.lastActiveConversationId)
            ? state.lastActiveConversationId
            : state.conversations[0]?.id
          if (target) void stores.conversation.activateLocal(target) // P1-1：绕过 api.activate/getMessages 载入快照
        }
      }).catch((e) => {
        stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
      })
    }).catch((e) => {
      // 持久化水合失败 fail-open：不影响启动，随后连接建立由后端全量调和
      stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
    })
    // P4-B：settings 水合 + voice 独立订阅（D-P10，与 messageStore 订阅并存，voice 事件互不干扰）。
    // 均不阻塞启动：settings.hydrate 内部 fail-open；voice.init 返回退订（常驻订阅，不持有）。
    void stores.settings.hydrate()
    stores.voice.init()
    // 阶段 6 批次 B（Task 7）：toolStore 常驻订阅 tool:event（与 voiceStore.init 同款位置；可选，未接线 no-op）
    stores.tools?.init()
    stores.characterRuntimeCoordinator?.start()
  }
  return { register }
}
