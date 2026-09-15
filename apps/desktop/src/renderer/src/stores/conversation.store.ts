// src/renderer/src/stores/conversation.store.ts
// 会话列表/当前会话/激活/历史。activate 里 resetConversation(id) + 拉第一页历史(loadPage 去重按 messageId,P1-3)。
// 批次B T8:初始化编排(FE-P1-03 §4.1)+ epoch 守卫(FE-P1-04 §4.2.3/4)+ ready/busy/error + 补激活(§4.1.3)。
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { ConnectionState, Conversation } from '@shared/contracts'
import { ConversationSchema, PageSchema } from '@shared/schemas'
import { api } from './desktop-api'
import { useMessageStore } from './message.store'
import { useAttachmentStore } from './attachment.store'
import { useConnectionStore } from './connection.store'
import { useCacheStore } from './cache.store'
import { useDraftStore } from './draft.store'
import { useVoiceStore } from './voice.store'
import { useIdentityStore } from './identity.store'
import { parsePublicError, type PublicError } from '../utils/public-error'
import { cloneValue } from '@shared/domain'
import { setActiveCharacterBinding, setConversationsSnapshot, setCurrentConversationId } from './session'

/** F8:messageOf 仅在 message.store 内定义(非导出),conversation.store 自定模块内 helper */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 会话激活被后端串行化门禁拒绝时，给用户一个稳定且可操作的提示。
 *
 * REST 的 AGENT_BUSY 会以 CyreneError.details.backendCode 穿过 IPC，
 * preload 再编码为 `[backendCode=AGENT_BUSY]`，所以这里只按解析后的
 * code/backendCode 精确匹配；CHARACTER_BUSY 等角色域错误必须继续沿用
 * 后端原文，避免把两类忙状态混成一个会话提示。
 */
const AGENT_BUSY_ACTIVATE_MESSAGE = '当前回复或语音仍在收尾，请稍后再切换会话'

function parseActivationError(e: unknown): PublicError {
  const parsed = parsePublicError(messageOf(e))
  if (parsed.code === 'AGENT_BUSY' || parsed.backendCode === 'AGENT_BUSY') {
    return { ...parsed, message: AGENT_BUSY_ACTIVATE_MESSAGE }
  }
  return parsed
}

type BackendIdentity = {
  key: string
  /** URL-derived identities are authoritative enough to isolate old data. */
  authoritative: boolean
}

/**
 * A connection id identifies a transport incarnation, not a backend.  Binding
 * snapshots are immutable within one backend, so use a normalized server URL
 * as the primary identity and only use the connection id as a conservative
 * fallback when the endpoint is not available (for example during startup).
 */
function backendIdentity(state: ConnectionState): BackendIdentity | undefined {
  const rawUrl = state.serverUrl?.trim()
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl)
      const origin = parsed.origin === 'null'
        ? `${parsed.protocol}//${parsed.host}`
        : parsed.origin
      // The configured base URL is the backend fact domain.  Preserve its
      // pathname (while normalising a trailing slash) so two distinct
      // gateways on the same host are not treated as one authority.  Query
      // and fragment are intentionally excluded: they are transport options,
      // not a different backend.
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
      if (origin && origin !== 'null') return { key: `url:${origin.toLowerCase()}${pathname}`, authoritative: true }
    } catch {
      // Invalid endpoint: fall through to the non-authoritative connection
      // identity rather than throwing from state hydration.
    }
  }
  const connectionId = state.connectionId?.trim()
  return connectionId ? { key: `connection:${connectionId}`, authoritative: false } : undefined
}

function connectionSignature(state: ConnectionState): string {
  return JSON.stringify([
    state.status,
    state.connectionId ?? null,
    backendIdentity(state)?.key ?? null,
    state.features?.characterProfiles === true
  ])
}

function protocolError(message: string): Error {
  return new Error(`[CHARACTER_CONVERSATION_PROTOCOL] ${message}`)
}

function parseConversation(value: unknown, profilesEnabled: boolean, requestedCharacterId?: string): Conversation {
  const parsed = ConversationSchema.safeParse(value)
  if (!parsed.success) throw protocolError('新建会话响应格式无效')
  const conversation = parsed.data
  if (profilesEnabled) {
    if (!conversation.character) throw protocolError('角色模式的会话响应缺少角色绑定')
    if (requestedCharacterId && conversation.character.characterId !== requestedCharacterId) {
      throw protocolError('会话响应的角色绑定与请求不一致')
    }
  }
  return cloneValue(conversation)
}

function parseCreatedConversation(value: unknown, requestedCharacterId?: string, profilesEnabled = false): Conversation {
  return parseConversation(value, profilesEnabled, requestedCharacterId)
}

const ConversationPageSchema = PageSchema(ConversationSchema)

/**
 * 角色能力开启后，列表也是角色绑定协议的一部分，而不是只有 create
 * 才需要校验。先完整解析整页，再交给调用方合并，确保坏页不会半写入
 * items/cache。
 */
function parseConversationPage(value: unknown, profilesEnabled: boolean): { items: Conversation[]; hasMore: boolean; nextCursor?: string } {
  const parsed = ConversationPageSchema.safeParse(value)
  if (!parsed.success) throw protocolError('会话列表响应格式无效')
  return {
    items: parsed.data.items.map((item) => parseConversation(item, profilesEnabled)),
    hasMore: parsed.data.hasMore,
    ...(parsed.data.nextCursor !== undefined ? { nextCursor: parsed.data.nextCursor } : {})
  }
}

function bindingConflict(left: NonNullable<Conversation['character']>, right: NonNullable<Conversation['character']>): 'identity' | 'revision' | 'snapshot' | undefined {
  // A session's character/instance is immutable, but follow_latest sessions
  // may advance to a newer content revision between turns.  Same-revision
  // display changes are not a valid way to rewrite an existing snapshot.
  if (left.characterId !== right.characterId || left.characterInstanceId !== right.characterInstanceId) return 'identity'
  if (right.characterRevision < left.characterRevision) return 'revision'
  if (right.characterRevision === left.characterRevision && (
    left.displayName !== right.displayName || JSON.stringify(left.presentation) !== JSON.stringify(right.presentation)
  )) return 'snapshot'
  return undefined
}

/** 会话 binding 是创建时不可变快照；列表刷新不得用冲突快照覆盖权威结果。 */
function assertNoBindingConflict(existing: Conversation[], incoming: Conversation[], compareBindings: boolean): void {
  const byId = new Map(existing.map((item) => [item.id, item]))
  const seenIncoming = new Set<string>()
  for (const next of incoming) {
    // Duplicates in one response are a protocol error even when the binding
    // happens to be identical.  Silently keeping one would leave title/order
    // selection dependent on Vue's duplicate-key reconciliation.
    if (seenIncoming.has(next.id)) throw protocolError('会话列表同页包含重复会话')
    seenIncoming.add(next.id)
    const previous = byId.get(next.id)
    if (compareBindings && previous?.character && next.character) {
      const conflict = bindingConflict(previous.character, next.character)
      if (conflict) throw protocolError(`会话列表返回了冲突的角色绑定快照(${conflict})`)
    }
    byId.set(next.id, next)
  }
}

export const useConversationStore = defineStore('conversation', () => {
  const items = ref<Conversation[]>([])
  const currentId = ref<string>()
  const hasMore = ref(false)
  const nextCursor = ref<string>()
  const initializedFor = ref<string>()   // 本次连接(connectionId)的初始化标记
  const ready = ref(false)               // 初始化完成(D13):连接后列表/活动会话/首屏就绪才 true
  const error = ref<PublicError>()       // 会话操作错误(供 UI 展示,§4.2.4/I2)
  const busy = ref(false)                // 会话操作进行中(D22,供按钮 loading/防重复)
  const offlineView = ref(false) // 离线视图：activateLocal/setOfflineCache 置位，恢复后 false
  const blockReason = ref<string>()      // D-P5：语音会话活跃时切换/新建被拒的 UI 提示（同附件 canSend.blockReason 短横幅语义）
  const currentCharacter = computed(() => items.value.find((item) => item.id === currentId.value)?.character)
  // 会话身份单例同步（解循环依赖，2026-09-10）：本 store 是 currentId 的唯一写方，
  // 通过 watch(sync) 单点镜像到 stores/session.ts，供 message/settings/voice 等读取。
  // 用 watch 而非在 7 处赋值点插调用：赋值点分散（activate/create/remove/离线水合/onConnected），
  // 逐处插调用迟早漏改；watch 保证「只要有写入就同步」，是新写入路径的天然兜底。
  // immediate 保证 store 创建时（含测试 setActivePinia 后）镜像已就位。
  watch(currentId, (id) => { setCurrentConversationId(id) }, { immediate: true, flush: 'sync' })
  // 当前会话的角色绑定一并镜像：voice.store 的事件归属校验需要它，而 voice 不得 import 本 store
  // （否则 conversation ↔ voice 成环）。同 watch 单点镜像，避免新增派生路径漏同步。
  watch(currentCharacter, (binding) => { setActiveCharacterBinding(binding) }, { immediate: true, flush: 'sync' })
  // 会话列表镜像：message.store 需按 conversationId 反查角色绑定，镜像后无需 import 本 store。
  // items 的全部写入点均为整数组重新赋值（无原地 push/splice），故浅 watch 足以覆盖。
  watch(items, (list) => { setConversationsSnapshot(list) }, { immediate: true, flush: 'sync' })
  // Minor-3：语音 mode 回 idle 时归口清除切换守卫横幅——停止/删除录音、实时会话结束、转写取消后
  // 「请先结束当前语音会话」不得残留（activate/create 开头的 idle 清除只覆盖「放行路径」）。
  watch(
    () => useVoiceStore().mode,
    (m) => { if (m === 'idle') blockReason.value = undefined }
  )
  let epoch = 0                          // 激活竞态守卫(§4.2.3/D6):数字递增,最新请求才提交
  let initializingFor: string | undefined
  let initializationPromise: Promise<void> | undefined
  let createEpoch = 0
  let createInFlight: Promise<Conversation | undefined> | undefined
  let connectionGeneration = 0
  let knownConnectionSignature = connectionSignature(useConnectionStore().state)
  const initialBackendIdentity = backendIdentity(useConnectionStore().state)
  /** Last authoritative endpoint.  Missing/invalid URL states are only
   * transport intermediates and must never overwrite this fact. */
  let knownBackendIdentity = initialBackendIdentity?.authoritative
    ? initialBackendIdentity
    : undefined
  let lastNonAuthoritativeIdentity = initialBackendIdentity?.authoritative
    ? undefined
    : initialBackendIdentity
  /** Provenance of the currently retained list/cache.  Undefined means an
   * offline/startup snapshot whose backend has not been established. */
  let dataBackendIdentity: BackendIdentity | undefined
  /** The generation that introduced each in-memory list item. */
  const conversationGenerations = new Map<string, number>()

  type OperationOwner = { generation: number }
  const operationOwners = new Map<symbol, OperationOwner>()

  function syncBusy(): void {
    busy.value = operationOwners.size > 0
  }

  function acquireOperation(): symbol {
    const token = Symbol('conversation-operation')
    operationOwners.set(token, { generation: connectionGeneration })
    syncBusy()
    return token
  }

  function releaseOperation(token: symbol): void {
    if (operationOwners.delete(token)) syncBusy()
  }

  function releaseStaleOperations(): void {
    for (const [token, owner] of operationOwners) {
      if (owner.generation < connectionGeneration) operationOwners.delete(token)
    }
    syncBusy()
  }

  /** Remove list/cache/message provenance when an authoritative endpoint changes. */
  function clearBackendData(): void {
    const cache = useCacheStore()
    const messageStore = useMessageStore()
    const oldCurrentId = currentId.value
    const oldIds = new Set([
      ...items.value.map((item) => item.id),
      ...cache.conversations.map((item) => item.id),
      ...Object.keys(cache.snapshots)
    ])
    const oldMessageConversationIds = new Set(
      messageStore.order
        .map((messageId) => messageStore.byId[messageId]?.conversationId)
        .filter((id): id is string => typeof id === 'string')
    )
    items.value = []
    currentId.value = undefined
    hasMore.value = false
    nextCursor.value = undefined
    offlineView.value = false
    ready.value = false
    initializedFor.value = undefined
    error.value = undefined
    conversationGenerations.clear()
    dataBackendIdentity = undefined
    cache.syncConversations([])
    for (const id of oldIds) cache.purge(id)
    if (oldCurrentId) oldMessageConversationIds.add(oldCurrentId)
    for (const id of oldMessageConversationIds) messageStore.resetConversation(id)
    // Any in-flight activation belongs to the old backend even if the
    // transport happened to reuse a connection id.
    epoch++
  }

  function advanceConnectionGeneration(next: string, state: ConnectionState = useConnectionStore().state): void {
    const nextIdentity = backendIdentity(state)
    if (nextIdentity?.authoritative) {
      // A first authoritative connection must not inherit an unproven startup
      // cache.  Once an authoritative endpoint is known, temporary states
      // without serverUrl do not replace it; a genuinely different endpoint
      // is the only transition that clears retained facts.
      if (
        (knownBackendIdentity && knownBackendIdentity.key !== nextIdentity.key)
        || (!knownBackendIdentity && hasRetainedConversationData() && dataBackendIdentity?.authoritative !== true)
      ) clearBackendData()
      knownBackendIdentity = nextIdentity
      lastNonAuthoritativeIdentity = undefined
    } else if (nextIdentity) {
      // With no authoritative provenance, two different connection-only
      // identities cannot be assumed to share a backend.  If an authoritative
      // identity already exists this is merely a transient transport state.
      if (!knownBackendIdentity) {
        const identityChanged = lastNonAuthoritativeIdentity && lastNonAuthoritativeIdentity.key !== nextIdentity.key
        const unprovenRetainedData = hasRetainedConversationData()
          && (!dataBackendIdentity || dataBackendIdentity.key !== nextIdentity.key)
        if (identityChanged || unprovenRetainedData) clearBackendData()
      }
      if (!knownBackendIdentity) lastNonAuthoritativeIdentity = nextIdentity
    }
    if (next === knownConnectionSignature) return
    knownConnectionSignature = next
    connectionGeneration++
    createEpoch++
    // 旧连接上的 create 可能永远不 resolve。解除登记让新世代可以
    // 立即创建；旧任务 finally 通过 identity check 不会清掉新任务的 busy。
    if (createInFlight) {
      createInFlight = undefined
    }
    releaseStaleOperations()
  }

  function hasRetainedConversationData(): boolean {
    const cache = useCacheStore()
    const messageStore = useMessageStore()
    return items.value.length > 0
      || currentId.value !== undefined
      || cache.conversations.length > 0
      || Object.keys(cache.snapshots).length > 0
      || messageStore.order.length > 0
  }

  /** A transport-only/intermediate state is not proof of a new backend.  Do
   * not let it replace the last known URL authority's provenance; otherwise a
   * transient reconnect could make an unrelated list look continuous. */
  function rememberDataBackendIdentity(identity: BackendIdentity | undefined): void {
    if (!identity) return
    if (!identity.authoritative && knownBackendIdentity) return
    dataBackendIdentity = identity
  }

  /**
   * A connection-id fallback is useful while no endpoint has ever been
   * established, but it is not evidence that a connected, URL-less state is
   * the same backend as the last authoritative URL.  Keep that intermediate
   * state read-only with respect to retained authoritative data: otherwise a
   * reconnect snapshot with a fresh connection id could overwrite the old
   * list and its immutable binding before the real endpoint is known.
   */
  function canCommitFromBackend(identity: BackendIdentity | undefined): boolean {
    return !(knownBackendIdentity && (!identity || !identity.authoritative))
  }

  /** Binding conflicts are meaningful only inside the same provable fact
   * domain.  Unknown identities may compare within the same transport
   * incarnation; once an authoritative URL exists, a URL-less fallback must
   * never be compared with or overwrite that domain. */
  function canCompareBindings(left: BackendIdentity | undefined, right: BackendIdentity | undefined): boolean {
    if (!left || !right || left.key !== right.key) return false
    if (left.authoritative && right.authoritative) return true
    return !knownBackendIdentity
  }

  function observeConnectionState(): void {
    const state = useConnectionStore().state
    advanceConnectionGeneration(connectionSignature(state), state)
  }

  function currentProfilesEnabled(): boolean {
    const state = useConnectionStore().state
    return state.status === 'connected' && state.features?.characterProfiles === true
  }

  function conversationStateIsCurrent(signature: string, generation: number, requireConnected = false): boolean {
    const state = useConnectionStore().state
    return connectionSignature(state) === signature && connectionGeneration === generation && (!requireConnected || state.status === 'connected')
  }

  function upsertConversation(conversation: Conversation): void {
    const next = cloneValue(conversation)
    const existingIndex = items.value.findIndex((item) => item.id === next.id)
    if (existingIndex < 0) items.value = [...items.value, next]
    else items.value = items.value.map((item, index) => index === existingIndex ? next : item)
    conversationGenerations.set(next.id, connectionGeneration)
    rememberDataBackendIdentity(backendIdentity(useConnectionStore().state))
    useCacheStore().syncConversations(items.value)
  }

  function removeCreatedConversation(id: string, expectedGeneration?: number): void {
    if (expectedGeneration !== undefined && conversationGenerations.get(id) !== expectedGeneration) return
    items.value = items.value.filter((item) => item.id !== id)
    conversationGenerations.delete(id)
    useCacheStore().syncConversations(items.value)
    if (currentId.value === id) currentId.value = undefined
  }

  /** Bootstrap 将每个连接状态交给会话域；跨世代时让新建操作的迟到响应失效。 */
  function setConnectionState(state: ConnectionState): void {
    advanceConnectionGeneration(connectionSignature(state), state)
  }

  /** §4.2.4:list 包 try/catch 写 error 不抛 + busy */
  async function list(): Promise<boolean> {
    observeConnectionState()
    const capturedState = useConnectionStore().state
    const capturedSignature = connectionSignature(capturedState)
    const capturedGeneration = connectionGeneration
    const capturedBackend = backendIdentity(capturedState)
    const capturedProfilesEnabled = capturedState.status === 'connected' && capturedState.features?.characterProfiles === true
    const previousItems = cloneValue(items.value)
    const owner = acquireOperation()
    try {
      const p = await api.listConversations({})
      if (connectionSignature(useConnectionStore().state) !== capturedSignature || connectionGeneration !== capturedGeneration) return false
      if (!canCommitFromBackend(capturedBackend)) return false
      const page = parseConversationPage(p, capturedProfilesEnabled)
      const currentBackend = backendIdentity(useConnectionStore().state)
      assertNoBindingConflict(
        previousItems,
        page.items,
        capturedProfilesEnabled && canCompareBindings(capturedBackend, currentBackend)
      )
      items.value = cloneValue(page.items)
      conversationGenerations.clear()
      for (const item of items.value) conversationGenerations.set(item.id, connectionGeneration)
      hasMore.value = page.hasMore
      nextCursor.value = page.nextCursor
      rememberDataBackendIdentity(capturedBackend)
      useCacheStore().syncConversations(items.value) // 在线列表 → 内存缓存（供离线切换判定；持久化列表由 Main 派生）
      error.value = undefined   // F1:成功清旧错误(短横幅语义,防残留)
      return true
    } catch (e) {
      if (connectionSignature(useConnectionStore().state) !== capturedSignature || connectionGeneration !== capturedGeneration) return false
      error.value = parsePublicError(messageOf(e))
      return false
    } finally {
      releaseOperation(owner)
    }
  }

  /** §4.2.4:safeList —— busy 包裹 list;list 已吞错,safeList catch 为兜底 */
  async function safeList(): Promise<boolean> {
    // list owns the error/status guard.  Keep this wrapper side-effect free so
    // an unexpected late rejection cannot write a newer connection's error.
    try { return await list() } catch { return false }
  }

  async function initializeConnected(key: string): Promise<void> {
    ready.value = false
    try {
      if (currentId.value) {
        // 重连/已有活动会话:只刷新列表 + reconcile 活动会话,不动已有历史(replay 按 messageId 去重合并)
        if (!await safeList()) return
        if (offlineView.value) {
          // P1-1 在线恢复：离线快照视图 → 真实 activate 拉后端首屏覆盖 + 清 offlineView
          offlineView.value = false
          initializedFor.value = key
          ready.value = true // P2-3：恢复即就绪（快照已可视；activate 异步拉首屏覆盖，不阻塞就绪门控）
          void activate(currentId.value)
          return
        }
        const activeId = useConnectionStore().state.activeConversationId
        if (activeId && activeId !== currentId.value) await activate(activeId)   // I4:后端活动会话变了 → 切过去
        initializedFor.value = key
        ready.value = true
        return
      }
      // 首次:完整初始化
      if (!await safeList()) return
      initializedFor.value = key
      ready.value = true            // 就绪门控(D13):列表成功后才就绪(N1:不依赖 activate)
      if (currentId.value) return   // m6:safeList 期间用户已手动切会话,不再覆盖
      const activeId = useConnectionStore().state.activeConversationId
      if (activeId) await activate(activeId)   // 同步出现的 active:activate(applyPendingReplay + getMessages 首屏)
      // active 晚到(session 帧晚于 safeList):由 onActiveConversationAppeared 补激活(§4.1.3),此处不设 currentId
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
      initializedFor.value = undefined
      ready.value = false
    }
  }

  /** §4.1.1 onConnected:成功后幂等；失败不写 initializedFor，同 connectionId 可重试。 */
  async function onConnected(connectionId?: string): Promise<void> {
    const key = connectionId ?? ''
    if (initializedFor.value === key && ready.value) return
    if (initializingFor === key && initializationPromise !== undefined) {
      await initializationPromise
      return
    }
    const promise = initializeConnected(key)
    initializingFor = key
    initializationPromise = promise
    try {
      await promise
    } finally {
      if (initializationPromise === promise) {
        initializingFor = undefined
        initializationPromise = undefined
      }
    }
  }

  /** §4.1.3 补激活:currentId 已设/busy → 不动;否则 activate(applyPendingReplay + 首屏) */
  async function onActiveConversationAppeared(activeId: string): Promise<void> {
    if (currentId.value) return   // 已激活/用户已手动切,不动
    if (busy.value) return        // 初始化/操作进行中,由激活流程覆盖
    await activate(activeId)
  }

  /** §4.2.3 activate:epoch 大者胜;后端确认后提交 currentId;resetConversation + applyPendingReplay + 拉首屏。
   *  G4 扩展（D5）：anchor 存在时改拉 loadContextWindow 上下文窗口（替代首页）+ setHighlight；anchor 缺省行为完全不变。 */
  async function activate(id: string, anchor?: { messageId: string; segmentId?: string }): Promise<void> {
    // D-P5 会话切换守卫：语音会话活跃（mode≠idle）→ 禁止切换，UI 提示先结束（实时模式同理）
    if (useVoiceStore().mode !== 'idle') {
      blockReason.value = '请先结束当前语音会话'
      return
    }
    blockReason.value = undefined
    if (offlineView.value && useConnectionStore().state.status === 'disconnected') {
      // 多套 UI 基础：message 只放诊断标识，用户文案由 utils/error-message 按 code 映射
      error.value = { code: 'OFFLINE_VIEW', message: 'LOCAL:OFFLINE_VIEW' }
      return
    }
    offlineView.value = false
    observeConnectionState()
    const capturedSignature = connectionSignature(useConnectionStore().state)
    const capturedGeneration = connectionGeneration
    const myEpoch = ++epoch
    const owner = acquireOperation()
    const messageStore = useMessageStore()
    try {
      // TTS 不属于 voice mode 守卫。切换前主动取消旧会话的播放流；否则后端可能因
      // 尚在合成而返回 AGENT_BUSY，且旧会话音频可能在目标会话中迟到播放。
      if (currentId.value !== id) await useVoiceStore().stopTtsPlayback()
      if (myEpoch !== epoch || !conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
      await api.activate(id)
      if (myEpoch !== epoch || !conversationStateIsCurrent(capturedSignature, capturedGeneration)) return    // 已被更新的切换/连接取代,不提交
      // Backend activation is the authority boundary.  Keeping the previous
      // currentId until this point prevents a rejected activation from leaving
      // Renderer on a conversation that Backend never activated.
      currentId.value = id
      messageStore.resetConversation(id)
      messageStore.applyPendingReplay(id)
      if (anchor) {
        const ok = await messageStore.loadContextWindow(anchor.messageId)
        if (myEpoch !== epoch || !conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
        if (ok) messageStore.setHighlight(anchor.messageId, anchor.segmentId)
        error.value = ok ? undefined : parsePublicError('无法定位消息')
      } else {
        const p = await api.getMessages({ conversationId: id })
        if (myEpoch !== epoch || !conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
        if (!messageStore.loadPage(p)) return
        messageStore.setPageMeta(p) // 首页 nextCursor → 更早一页游标（G2）
        error.value = undefined   // F1:激活成功清旧错误
      }
    } catch (e) {
      if (myEpoch !== epoch || !conversationStateIsCurrent(capturedSignature, capturedGeneration)) return    // 被取代的请求失败不打扰
      error.value = parseActivationError(e)
    } finally {
      releaseOperation(owner)
    }
  }

  /** 来源跳转（D5）：当前会话直接上下文窗口；跨会话走 activate(anchor)。失败经 error（聊天区横幅，两分支统一；不清空聊天内容）。 */
  async function jumpToMessage(conversationId: string, messageId: string, segmentId?: string): Promise<boolean> {
    if (currentId.value === conversationId) {
      const ok = await useMessageStore().loadContextWindow(messageId)
      if (ok) useMessageStore().setHighlight(messageId, segmentId)
      else error.value = parsePublicError('无法定位消息')
      return ok
    }
    await activate(conversationId, { messageId, segmentId })
    return true   // 失败已由 activate 写 error（横幅）
  }

  /** §4.2.4 getMore:try/catch 写 error + busy */
  async function getMore(): Promise<void> {
    if (!nextCursor.value) return
    observeConnectionState()
    const capturedSignature = connectionSignature(useConnectionStore().state)
    const capturedGeneration = connectionGeneration
    const capturedProfilesEnabled = currentProfilesEnabled()
    const previousItems = cloneValue(items.value)
    const capturedBackend = backendIdentity(useConnectionStore().state)
    const owner = acquireOperation()
    try {
      const p = await api.listConversations({ cursor: nextCursor.value })
      if (connectionSignature(useConnectionStore().state) !== capturedSignature || connectionGeneration !== capturedGeneration) return
      if (!canCommitFromBackend(capturedBackend)) return
      const page = parseConversationPage(p, capturedProfilesEnabled)
      const currentBackend = backendIdentity(useConnectionStore().state)
      assertNoBindingConflict(
        previousItems,
        page.items,
        capturedProfilesEnabled && canCompareBindings(capturedBackend, currentBackend)
      )
      const mergedById = new Map(items.value.map((item) => [item.id, item]))
      // A repeated id in a later page is unusual but can carry a newer
      // follow_latest revision.  Keep one row and replace only when the
      // already-validated page is the newer authoritative snapshot.
      for (const item of page.items) {
        const existing = mergedById.get(item.id)
        if (!existing || !existing.character || !item.character || item.character.characterRevision >= existing.character.characterRevision) {
          mergedById.set(item.id, item)
        }
      }
      items.value = [...mergedById.values()]
      for (const item of page.items) conversationGenerations.set(item.id, connectionGeneration)
      hasMore.value = page.hasMore
      nextCursor.value = page.nextCursor
      rememberDataBackendIdentity(capturedBackend)
      useCacheStore().syncConversations(items.value)
      error.value = undefined   // F1:成功清旧错误
    } catch (e) {
      if (connectionSignature(useConnectionStore().state) !== capturedSignature || connectionGeneration !== capturedGeneration) return
      error.value = parsePublicError(messageOf(e))
    } finally {
      releaseOperation(owner)
    }
  }

  /**
   * 新建会话：迁移期 legacy 仍调用 createConversation({})；角色能力开启后必须
   * 带明确 characterId，并把后端返回的 binding 当作协议事实校验后才落入列表/缓存。
   * 创建成功先合并权威结果，再 best-effort 刷新列表，避免 safeList 失败抹掉已创建会话。
   */
  function create(characterId?: string): Promise<Conversation | undefined> {
    // 兼容调用方只更新 connectionStore.state、尚未来得及经过 bootstrap
    // 的场景；这也释放不会 settle 的旧世代 create 锁。
    observeConnectionState()
    if (createInFlight) return createInFlight
    // D-P5 会话切换守卫：语音会话活跃（mode≠idle）→ 禁止新建会话，UI 提示先结束
    if (useVoiceStore().mode !== 'idle') {
      blockReason.value = '请先结束当前语音会话'
      return Promise.resolve(undefined)
    }
    blockReason.value = undefined
    const profilesEnabled = currentProfilesEnabled()
    const requestedCharacterId = typeof characterId === 'string' && characterId.trim() ? characterId : undefined
    if (profilesEnabled && !requestedCharacterId) {
      error.value = { code: 'CHARACTER_REQUIRED', message: 'LOCAL:CHARACTER_REQUIRED' }
      return Promise.resolve(undefined)
    }
    if (profilesEnabled && useIdentityStore().profile?.initialized !== true) {
      error.value = { code: 'IDENTITY_REQUIRED', message: 'LOCAL:IDENTITY_REQUIRED' }
      return Promise.resolve(undefined)
    }

    const myEpoch = ++createEpoch
    const capturedState = useConnectionStore().state
    const capturedSignature = connectionSignature(capturedState)
    const capturedGeneration = connectionGeneration
    const owner = acquireOperation()
    const input = requestedCharacterId ? { characterId: requestedCharacterId } : {}
    const task = Promise.resolve()
      .then(async () => {
        const created = await api.createConversation(input)
        if (myEpoch !== createEpoch || !conversationStateIsCurrent(capturedSignature, capturedGeneration, profilesEnabled)) return undefined
        const conversation = parseCreatedConversation(created, requestedCharacterId, profilesEnabled)
        // 先记录权威 create 结果；刷新列表即使失败也不能抹掉它。
        upsertConversation(conversation)
        currentId.value = conversation.id
        // Do not start a new-generation list just because the old create
        // response happened to settle after its transport fence.  The guard
        // below is intentionally immediately before safeList: a state push
        // can arrive after the create response but before the list request,
        // and that list must never reconcile an old create against the new
        // backend.  The generation-qualified removal only removes this
        // create result; a newer generation's same-id item is left intact.
        if (myEpoch !== createEpoch || !conversationStateIsCurrent(capturedSignature, capturedGeneration, profilesEnabled)) {
          removeCreatedConversation(conversation.id, capturedGeneration)
          return undefined
        }
        const listed = await safeList()
        if (myEpoch !== createEpoch || !conversationStateIsCurrent(capturedSignature, capturedGeneration, profilesEnabled)) {
          // safeList 期间若连接/能力跨代，刚才的 create 结果属于旧世代，
          // 不能留在新连接的列表、缓存或 currentId 中。
          removeCreatedConversation(conversation.id, capturedGeneration)
          return undefined
        }
        // The create response is the authoritative binding for this new
        // session.  A list response racing the create may omit the binding or
        // carry a different revision/snapshot.  `list()` already refuses a
        // malformed page; restore the create snapshot as well when a valid
        // page contains a conflicting copy, so safeList can never rewrite the
        // just-created session before the caller receives it.
        const listedConversation = items.value.find((item) => item.id === conversation.id)
        if (listed && profilesEnabled && conversation.character && listedConversation?.character) {
          // During the create handshake even a higher revision is ambiguous:
          // it may be a stale/rewritten copy for the same id rather than the
          // just-created authority.  The subsequent normal list path may
          // advance follow_latest sessions, but this create result must stay
          // intact until the next explicit reconciliation.
          const conflict = conversation.character.characterRevision !== listedConversation.character.characterRevision
            ? 'revision'
            : bindingConflict(conversation.character, listedConversation.character)
          if (conflict) {
            upsertConversation(conversation)
            error.value = parsePublicError(`会话响应返回了冲突的角色绑定快照(${conflict})`)
            return conversation
          }
        }
        if (listed && !items.value.some((item) => item.id === conversation.id)) upsertConversation(conversation)
        if (listed) error.value = undefined
        return conversation
      })
      .catch((cause: unknown) => {
        // 连接/能力已经跨代时，迟到响应只被丢弃，不覆盖新状态错误。
        if (myEpoch !== createEpoch || connectionSignature(useConnectionStore().state) !== capturedSignature || connectionGeneration !== capturedGeneration) return undefined
        error.value = parsePublicError(messageOf(cause))
        return undefined
      })
      .finally(() => {
        if (createInFlight === task) {
          createInFlight = undefined
        }
        // Connection changes release the old owner eagerly; this release is
        // intentionally idempotent so a late task cannot clear a new task.
        releaseOperation(owner)
      })
    createInFlight = task
    return task
  }

  /** §4.2.4 rename(单对象载荷 {conversationId,title},registry arity 约束,P2-4):try/catch + busy */
  async function rename(input: { conversationId: string; title: string }): Promise<void> {
    observeConnectionState()
    const capturedSignature = connectionSignature(useConnectionStore().state)
    const capturedGeneration = connectionGeneration
    const owner = acquireOperation()
    try {
      await api.renameConversation(input)
      if (!conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
      await safeList()
      if (!conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
      error.value = undefined   // F1:成功清旧错误
    } catch (e) {
      if (!conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
      error.value = parsePublicError(messageOf(e))
    } finally {
      releaseOperation(owner)
    }
  }

  /** §4.2.4 remove:try/catch + busy;删除当前激活会话 → currentId 清空 + messageStore 清空(空态,L1) */
  async function remove(id: string): Promise<void> {
    observeConnectionState()
    const capturedSignature = connectionSignature(useConnectionStore().state)
    const capturedGeneration = connectionGeneration
    const wasActive = currentId.value === id
    const owner = acquireOperation()
    try {
      await api.deleteConversation(id)
      if (!conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
      await safeList()
      if (!conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
      // 删除当前激活会话:currentId 清空 + messageStore 清空(聊天区显示空态,避免残留旧消息/发送打到已删会话,L1)
      if (wasActive && currentId.value === id) {
        currentId.value = undefined
        useMessageStore().resetConversation(id)
      }
      useDraftStore().purge(id)   // 删除联动:清内存草稿/锚点 + 取消待写（G2，spec §4.4.1）
      useCacheStore().purge(id)   // 删除联动:清消息快照（G2，spec §4.5.1）
      // R2（2026-09-15 评审）：附件队列已按会话分桶，删除会话要连带清掉那一桶并释放其 File/bytes 强引用
      // （`clearFor` 此前没有调用方——队列按会话归属落地后它才第一次有了真实意义）。
      useAttachmentStore().clearFor(id)
      error.value = undefined   // F1:成功清旧错误
    } catch (e) {
      if (!conversationStateIsCurrent(capturedSignature, capturedGeneration)) return
      error.value = parsePublicError(messageOf(e))
    } finally {
      releaseOperation(owner)
    }
  }

  /** 离线水合装载缓存会话列表（bootstrap disconnected 分支）；offlineView 置位 */
  function setOfflineCache(conversations: Conversation[]): void {
    items.value = cloneValue(conversations)
    conversationGenerations.clear()
    for (const item of items.value) conversationGenerations.set(item.id, connectionGeneration)
    const stateIdentity = backendIdentity(useConnectionStore().state)
    dataBackendIdentity = stateIdentity?.authoritative
      ? stateIdentity
      : knownBackendIdentity ?? stateIdentity
    offlineView.value = true
    error.value = undefined
  }

  /** 离线会话切换（P1-1）：绕过 api.activate/getMessages，从 cacheStore 换入 messageStore */
  async function activateLocal(id: string): Promise<void> {
    if (useConnectionStore().state.status !== 'disconnected') return
    const cache = useCacheStore()
    if (!cache.conversations.some((c) => c.id === id)) {
      error.value = { code: 'OFFLINE_NOT_CACHED', message: 'LOCAL:OFFLINE_NOT_CACHED' }
      return
    }
    currentId.value = id
    offlineView.value = true
    const messageStore = useMessageStore()
    messageStore.resetConversation(id)
    const snap = cache.snapshotMessages(id)
    if (snap && snap.length) messageStore.loadSnapshot(id, snap)
    // 无快照 → 空态 + 提示（CyChatView 空态文案按 offlineView 区分）
    error.value = undefined
  }

  return { items, currentId, currentCharacter, hasMore, nextCursor, initializedFor, ready, error, busy, offlineView, blockReason, list, safeList, onConnected, onActiveConversationAppeared, activate, jumpToMessage, getMore, create, rename, remove, setOfflineCache, activateLocal, setConnectionState }
})
