// src/renderer/src/stores/message.store.ts
// 消息流式核心(docs/18 §4.3 / docs/06 §5):纯消费层,用 2A StreamAccumulator 应用领域事件。
// - generationId 守卫(跨代/迟到事件丢弃);accumulator.state.messageId 关联父消息(C-G5);
// - generation.completed 才结束父回复,status 用 acc.getState().status(completed/completing,不硬编码);
// - 乐观发送 clientMessageId key;无 serverMessageId 也 acknowledged,有则 migrateKey;
// - cancel 乐观置 interrupted;断线且 in-flight → handleConnectionStateChange 置 interrupted;
// - 事件归属守卫(批次B T7):started 校验 conversationId;中间事件(无 conversationId)经 generationByConversation 表判归属;
// - loadReplay 纯缓冲(currentId 未设→pendingReplay,由 applyPendingReplay 补应用,design §4.1.3);migrateKey 竞态守卫(I1);
// - handleConnectionStateChange 断线先清 local-* pending 乐观消息(I5),再处理 in-flight → interrupted(F11:清理在早退之前)。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  BackendEvent,
  CharacterBindingSnapshot,
  CharacterGenerationRef,
  ConnectionState,
  Message,
  MessageAttachment,
  MessagePage
} from '@shared/contracts'
import { StreamAccumulator } from '@shared/domain'
import { api } from './desktop-api'
import { useConversationStore } from './conversation.store'
import { useConnectionStore } from './connection.store'
import { useDraftStore } from './draft.store'
import { useCacheStore } from './cache.store'
import { cmpMsg } from '../utils/message-order'
import { parsePublicError, type PublicError } from '../utils/public-error'
import { clearMarkdownCache } from '../utils/markdown'   // 阶段 7 批次 C（Task 3）：会话切换清空 markdown 渲染缓存（M-2 单一挂载点）
import { cloneValue } from '@shared/domain'

function nowIso(): string {
  return new Date().toISOString()
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

type GenerationIdentity = {
  conversationId: string
  characterId: string
  characterInstanceId: string
  characterRevision: number
  /** Transport generation captured with the immutable generation tuple. */
  connectionEpoch: number
  connectionSignature: string
  /** Snapshot captured at generation start; never re-read from catalog. */
  snapshot: CharacterGenerationRef
}

type GenerationSessionIdentity = {
  conversationId: string
  connectionEpoch: number
  connectionSignature: string
}

function connectionSignatureFor(state: ConnectionState): string {
  // activeConversationId is deliberately excluded: it is a chat selection,
  // not a transport incarnation.  A new connectionId, endpoint, status or
  // capability set is a new message event session.
  return JSON.stringify([
    state.status,
    state.serverUrl ?? null,
    state.connectionId ?? null,
    state.protocolVersion ?? null,
    state.features?.characterProfiles === true,
    state.features?.characterStateStream === true
  ])
}

function characterIdentityTuple(value: {
  characterId?: string
  characterInstanceId?: string
  characterRevision?: number
}): [string, string, number] | undefined {
  if (
    typeof value.characterId !== 'string' || value.characterId.length === 0
    || typeof value.characterInstanceId !== 'string' || value.characterInstanceId.length === 0
    || typeof value.characterRevision !== 'number' || !Number.isInteger(value.characterRevision) || value.characterRevision < 1
  ) return undefined
  return [value.characterId, value.characterInstanceId, value.characterRevision]
}

function sameCharacterInstance(
  left: Pick<CharacterGenerationRef, 'characterId' | 'characterInstanceId'>,
  right: Pick<CharacterBindingSnapshot, 'characterId' | 'characterInstanceId'>
): boolean {
  return left.characterId === right.characterId && left.characterInstanceId === right.characterInstanceId
}

/** 正式取消码 GENERATION_CANCELLED + legacy CANCELLED 兼容（D3，二次联调 §6.3） */
export function isCancellationCode(code: string | undefined): boolean {
  return code === 'GENERATION_CANCELLED' || code === 'CANCELLED'
}

export const useMessageStore = defineStore('message', () => {
  const byId = ref<Record<string, Message>>({})
  const order = ref<string[]>([])
  const sending = ref(false)
  const activeGenerationId = ref<string>()
  const accumulator = ref<StreamAccumulator>()
  const lastError = ref<PublicError>()

  /** G2：向上加载更早历史（before 游标，docs/02 §19 倒序 keyset） */
  const hasMoreBefore = ref(false)
  const beforeCursor = ref<string>()
  const loadingOlder = ref(false)

  /** G4：来源跳转高亮（D6）——setHighlight 置位，查看器/组件 watch 滚动定位 + 6s 清除 */
  const highlightMessageId = ref<string>()
  const highlightSegmentId = ref<string>()
  /** G4：跳转后分页续接（P2-3）——getMessageContext 窗口落地后首页 getMessages 初始化游标 */
  const nextCursor = ref<string>()
  const loadingEarlier = ref(false)

  /** generationId → conversationId 归属表:只在 generation.started(唯一带 conversationId 的事件)记录(design §4.2.1) */
  const generationByConversation = ref<Record<string, string>>({})
  /**
   * FE-E2：generationId → immutable character identity.  The conversation-only
   * map above remains public for the legacy tests/consumers, while this map is
   * the identity authority for every generation when character profiles are
   * enabled.  The snapshot is copied once from the immutable session binding;
   * catalog edits must never rewrite an in-flight or historical message.
   */
  const generationIdentityById = ref<Record<string, GenerationIdentity>>({})
  /** Connection/session fence for legacy and profile-enabled generations. */
  const generationSessionById = ref<Record<string, GenerationSessionIdentity>>({})
  const connectionEpoch = ref(0)
  let connectionSignature = connectionSignatureFor(useConnectionStore().state)
  /**
   * Keep the last connected capability decision across reconnecting/error
   * transport states.  Those states intentionally clear ConnectionState's
   * feature payload, but a late replay/generation from the previous profile-
   * enabled connection must not silently downgrade to legacy attribution.
   * A subsequent connected snapshot replaces the decision (including false).
   */
  let characterProfilesRequired = false
  /** loadReplay 纯缓冲:currentId 未设时暂存,由 applyPendingReplay(id) 应用(design §4.1.3) */
  const pendingReplay = ref<{ conversationId: string; messages: Message[] }>()
  /** 领域守卫丢弃计数(测试断言/调试;只记类型与 ID,不记正文,design §4.2.1) */
  const droppedEvents = ref(0)
  /** Pagination request owners: reset/switch can revoke an old token without
   * allowing its finally block to unlock a newer conversation's request. */
  let olderOwner: symbol | undefined
  let earlierOwner: symbol | undefined
  /** Latest send/voice-commit owner. Both APIs share the public `sending`
   * busy flag, so an older completion must never unlock a newer request. */
  let sendingOwner: symbol | undefined
  /** Context-window owner: latest request wins even for the same conversation
   * and transport session. */
  let contextOwner: symbol | undefined

  /** 领域守卫:丢弃事件只记类型与 ID,不记正文;计数供测试/调试 */
  function guardDropEvent(type: string, conversationId?: string, generationId?: string): void {
    console.warn('cyrene:guard:drop', { type, conversationId, generationId })
    droppedEvents.value++
  }

  function guardDropReplay(conversationId: string): void {
    console.warn('cyrene:guard:drop', { type: 'replay', conversationId })
    droppedEvents.value++
  }

  function profilesEnabled(): boolean {
    const state = useConnectionStore().state
    if (state.status === 'connected') {
      characterProfilesRequired = state.features?.characterProfiles === true
    }
    return characterProfilesRequired
  }

  function currentConnectionSession(): GenerationSessionIdentity {
    return {
      conversationId: useConversationStore().currentId ?? '',
      connectionEpoch: connectionEpoch.value,
      connectionSignature
    }
  }

  function generationSessionMatches(session: GenerationSessionIdentity): boolean {
    return session.connectionEpoch === connectionEpoch.value
      && session.connectionSignature === connectionSignature
      && session.conversationId === (useConversationStore().currentId ?? '')
  }

  function sendRequestIsCurrent(owner: symbol, session: GenerationSessionIdentity): boolean {
    // A state push normally reaches this store before the ACK, but checking
    // here also closes embedders that update connectionStore directly.
    syncConnectionSessionFromStore()
    return sendingOwner === owner && generationSessionMatches(session)
  }

  function clearPendingOptimisticMessages(): void {
    for (const id of [...order.value]) {
      const message = byId.value[id]
      if (!message || message.role !== 'user' || message.status !== 'pending' || !id.startsWith('local-')) continue
      delete byId.value[id]
      const index = order.value.indexOf(id)
      if (index >= 0) order.value.splice(index, 1)
    }
  }

  /**
   * A chat state push is also a message transport fence.  In particular,
   * connected(A) → connected(B) must invalidate A even though no disconnected
   * state was observed by the renderer.  Existing assistant content remains
   * visible, but an old stream can no longer append/finalize it.
   */
  function advanceConnectionSession(state: ConnectionState): void {
    const nextSignature = connectionSignatureFor(state)
    if (nextSignature === connectionSignature) return
    const gid = activeGenerationId.value
    const acc = accumulator.value
    if (gid && acc) {
      const message = byId.value[acc.getState().messageId]
      if (message) message.status = 'interrupted'
    }
    activeGenerationId.value = undefined
    accumulator.value = undefined
    generationByConversation.value = {}
    generationSessionById.value = {}
    generationIdentityById.value = {}
    // Replay delivered by the previous transport incarnation is no longer
    // safe to hydrate after a reconnect.  A fresh replay may be queued by the
    // new connection, but an old pending batch must never cross this fence.
    pendingReplay.value = undefined
    // Revoke pagination owners as part of the same message session fence.
    // This lets the new connection start a request immediately; an old
    // request's finally sees a different owner and cannot unlock it.
    olderOwner = undefined
    earlierOwner = undefined
    contextOwner = undefined
    loadingOlder.value = false
    loadingEarlier.value = false
    // A pending local message has no safe ACK owner after a transport fence.
    // Remove it just like the explicit reconnect/error path below; a fresh
    // replay may reintroduce the authoritative server message.
    clearPendingOptimisticMessages()
    sendingOwner = undefined
    sending.value = false
    connectionSignature = nextSignature
    connectionEpoch.value++
  }

  function syncConnectionSessionFromStore(): void {
    const state = useConnectionStore().state
    if (connectionSignatureFor(state) !== connectionSignature) advanceConnectionSession(state)
  }

  function bindingFor(conversationId: string): CharacterBindingSnapshot | undefined {
    const conversation = useConversationStore().items.find((item) => item.id === conversationId)
    return conversation?.character
  }

  function snapshotFromBinding(binding: CharacterBindingSnapshot): CharacterGenerationRef {
    return cloneValue({
      characterId: binding.characterId,
      characterInstanceId: binding.characterInstanceId,
      characterRevision: binding.characterRevision,
      displayName: binding.displayName,
      presentation: binding.presentation
    })
  }

  function eventIdentityFor(event: {
    characterId?: string
    characterInstanceId?: string
    characterRevision?: number
  }): [string, string, number] | undefined {
    return characterIdentityTuple(event)
  }

  /**
   * Build the message-level snapshot from the session binding only after all
   * three event identity fields have matched.  There is deliberately no
   * catalog/name lookup here: a catalog lookup could silently replace a
   * historical revision with a newer display name.
   */
  function generationIdentityForStarted(event: Extract<BackendEvent, { event: 'generation.started' }>): GenerationIdentity | undefined {
    const tuple = eventIdentityFor(event)
    if (!tuple) return undefined
    const binding = bindingFor(event.conversationId)
    if (!binding || binding.characterId !== tuple[0] || binding.characterInstanceId !== tuple[1]) return undefined
    const session = currentConnectionSession()
    // The session binding identifies the character/instance.  A generation
    // may legitimately start on a newer revision while a follow_latest
    // session summary is catching up.  Only the matching revision can borrow
    // the binding's display snapshot; another revision remains tuple-only so
    // the UI can use an exact revision cache or the neutral fallback.
    const snapshot = tuple[2] === binding.characterRevision
      ? snapshotFromBinding(binding)
      : {
          characterId: tuple[0],
          characterInstanceId: tuple[1],
          characterRevision: tuple[2]
        }
    return {
      conversationId: event.conversationId,
      characterId: tuple[0],
      characterInstanceId: tuple[1],
      characterRevision: tuple[2],
      connectionEpoch: session.connectionEpoch,
      connectionSignature: session.connectionSignature,
      snapshot
    }
  }

  function terminalIdentityMatches(
    event: Extract<BackendEvent, { event: 'generation.completed' | 'generation.failed' }>,
    identity: GenerationIdentity
  ): boolean {
    const tuple = eventIdentityFor(event)
    // Once started established a character generation, terminal events must
    // carry the same tuple even if the connection changes state while the
    // response is in flight.  Never loosen this check by consulting the
    // current catalog or a transient feature flag.
    if (!tuple) return false
    return tuple[0] === identity.characterId
      && tuple[1] === identity.characterInstanceId
      && tuple[2] === identity.characterRevision
  }

  /** Validate an archived assistant message before it can enter memory/cache. */
  function acceptArchivedMessage(message: Message, source: 'replay' | 'rest' | 'snapshot'): Message | undefined {
    if (!profilesEnabled() || message.role !== 'assistant') return cloneValue(message)
    const binding = bindingFor(message.conversationId)
    const ref = message.character
    const tuple = ref ? characterIdentityTuple(ref) : undefined
    // A locally persisted snapshot may predate FE-E2 and legitimately lack
    // the optional message character ref.  Keep that old cache readable with
    // neutral identity; remote replay/REST pages remain strict and cannot
    // invent an attribution.  Any present-but-malformed/cross-instance ref
    // is still rejected, including in snapshots.
    if (source === 'snapshot' && message.role === 'assistant' && ref === undefined) return cloneValue(message)
    // A conversation binds a stable character instance, while its archived
    // messages may refer to any immutable content revision used by that
    // generation.  Reject cross-character/instance data, but preserve a
    // legitimate historical revision snapshot verbatim.
    if (!binding || !tuple || !sameCharacterInstance({ characterId: tuple[0], characterInstanceId: tuple[1] }, binding)) {
      guardDropEvent(`message.${source}`, message.conversationId, message.messageId)
      return undefined
    }
    // A server-provided ref is authoritative.  Copy it so a REST/replay
    // object or a reactive caller cannot mutate the stored historical snapshot.
    return cloneValue(message)
  }

  function acceptArchivedMessages(messages: Message[], source: 'replay' | 'rest' | 'snapshot'): Message[] | undefined {
    const accepted: Message[] = []
    for (const message of messages) {
      const next = acceptArchivedMessage(message, source)
      if (!next) {
        // In profile mode an assistant message without a valid character
        // snapshot invalidates the complete page/batch.  Partially accepting
        // it would advance a cursor while silently losing one history item.
        if (profilesEnabled()) return undefined
        continue
      }
      accepted.push(next)
    }
    return accepted
  }

  function reportMessageProtocolError(source: string, conversationId?: string, messageId?: string): void {
    guardDropEvent(`message.${source}`, conversationId, messageId)
    lastError.value = {
      code: 'MESSAGE_PROTOCOL_MISMATCH',
      backendCode: 'MESSAGE_PROTOCOL_MISMATCH',
      message: '消息所属会话或角色身份校验失败，请重试',
      retryable: true
    }
  }

  /** Never rewrite a message's own conversationId with an envelope/request id. */
  function validateMessageConversationIds(messages: Message[], envelopeConversationId: string, source: string): Message[] | undefined {
    for (const message of messages) {
      if (typeof message.conversationId !== 'string' || message.conversationId.length === 0 || message.conversationId !== envelopeConversationId) {
        reportMessageProtocolError(`${source}.conversation`, envelopeConversationId, message.messageId)
        return undefined
      }
    }
    return cloneValue(messages)
  }

  /** 按 messageId 去重 + (createdAt, messageId) 升序二分有序插入（P0-1）：新 key 插到第一个「不早于自己」的 key 之前（同序插其后，稳定）；已存在原位替换 */
  function upsertMessage(msg: Message): void {
    if (byId.value[msg.messageId] !== undefined) {
      byId.value[msg.messageId] = msg
      // The authoritative replay/REST copy may correct createdAt for a
      // temporary message.  Re-sort on replacement while JS's stable sort
      // keeps the `(createdAt, messageId)` tie-break deterministic.
      order.value.sort((left, right) => cmpMsg(byId.value[left], byId.value[right]))
      return
    }
    let lo = 0
    let hi = order.value.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cmpMsg(byId.value[order.value[mid]], msg) <= 0) lo = mid + 1
      else hi = mid
    }
    order.value.splice(lo, 0, msg.messageId)
    byId.value[msg.messageId] = msg
  }

  /** 乐观发送 key 迁移到 serverMessageId(P2-1):同步 byId/order key 与 msg.messageId */
  function migrateKey(oldKey: string, newKey: string, msg: Message): void {
    if (byId.value[oldKey] === undefined) return   // I1:乐观消息已被 resetConversation 清掉(切会话)则不重插
    if (oldKey === newKey) return
    const idx = order.value.indexOf(oldKey)
    if (idx >= 0) order.value[idx] = newKey
    delete byId.value[oldKey]
    msg.messageId = newKey
    byId.value[newKey] = msg
  }

  /** 流式中间态:只刷新有序分段,status 由创建时的 streaming 保持 */
  function patchAssistant(messageId: string, acc: StreamAccumulator): void {
    const m = byId.value[messageId]
    if (!m) return
    m.assistantSegments = acc.toAssistantSegments()
  }

  /** 父回复完成:status 用 acc 状态(completed/completing,P3-5)+ Token/模型/心情落位 */
  function finalizeAssistant(messageId: string, acc: StreamAccumulator): void {
    const m = byId.value[messageId]
    if (!m) return
    const s = acc.getState()
    m.assistantSegments = acc.toAssistantSegments()
    m.status = s.status
    if (s.usage) m.usage = s.usage
    if (s.model) m.model = s.model
    if (s.emotion) m.emotion = s.emotion
  }

  /** 回复失败:取消码(GENERATION_CANCELLED/legacy CANCELLED,D3)→ interrupted + 不设 lastError,其余 → failed + 错误展示 */
  function failAssistant(messageId: string, event: Extract<BackendEvent, { event: 'generation.failed' }>): void {
    const m = byId.value[messageId]
    if (!m || m.role !== 'assistant') return
    if (isCancellationCode(event.error.code)) {
      m.status = 'interrupted' // 取消终态：interrupted（不降级 failed）
      // 不设 lastError：用户主动取消不展示「发送失败」（§6.2 UX 不一致，D3）
    } else {
      m.status = 'failed'
      lastError.value = { code: event.error.code, message: event.error.message, backendCode: event.error.code, retryable: event.error.retryable }
    }
    activeGenerationId.value = undefined
  }

  function clearGeneration(generationId: string): void {
    delete generationByConversation.value[generationId]
    delete generationSessionById.value[generationId]
    delete generationIdentityById.value[generationId]
    // The active id is cleared eagerly on failure/cancellation.  Do not let
    // that make the accumulator immortal: terminal cleanup owns the
    // accumulator by its generation id, not by the current active pointer.
    if (accumulator.value?.getState().generationId === generationId) {
      accumulator.value = undefined
    }
    if (activeGenerationId.value === generationId) {
      activeGenerationId.value = undefined
    }
  }

  /** A terminal identity mismatch is a protocol failure, not a retryable
   * stream.  Preserve the partial content for diagnosis, but release the
   * active generation and all maps so the composer cannot remain locked. */
  function failGenerationProtocol(generationId: string, messageId?: string): void {
    const accumulatorMessageId = accumulator.value?.getState().generationId === generationId
      ? accumulator.value.getState().messageId
      : undefined
    const resolvedMessageId = accumulatorMessageId ?? messageId
    if (resolvedMessageId) {
      const message = byId.value[resolvedMessageId]
      if (message) message.status = 'failed'
    }
    lastError.value = {
      code: 'CHARACTER_GENERATION_PROTOCOL_MISMATCH',
      backendCode: 'CHARACTER_GENERATION_PROTOCOL_MISMATCH',
      message: '回复身份校验失败，已停止本次生成',
      retryable: false
    }
    clearGeneration(generationId)
  }

  function resetConversation(_conversationId: string): void {
    byId.value = {}
    order.value = []
    activeGenerationId.value = undefined
    accumulator.value = undefined
    generationByConversation.value = {}
    generationSessionById.value = {}
    generationIdentityById.value = {}
    olderOwner = undefined
    earlierOwner = undefined
    contextOwner = undefined
    sendingOwner = undefined
    sending.value = false
    hasMoreBefore.value = false
    beforeCursor.value = undefined
    loadingOlder.value = false
    highlightMessageId.value = undefined
    highlightSegmentId.value = undefined
    nextCursor.value = undefined
    loadingEarlier.value = false
    clearMarkdownCache()   // 阶段 7 批次 C（Task 3）：会话切换清空 markdown 缓存（M-2 单一挂载点，防敏感内容跨会话驻留）
  }

  function applyEvent(event: BackendEvent): void {
    // Normally bootstrap calls handleConnectionStateChange for every push.
    // This defensive observation closes the small window where a transport
    // state changed before its event subscription was scheduled.
    syncConnectionSessionFromStore()
    switch (event.event) {
      case 'generation.started': {
        // 归属守卫(design §4.2.1):started 校验 conversationId,防 A 的 started 迟到到 B 时覆盖 B 的 accumulator
        if (event.conversationId !== useConversationStore().currentId) { guardDropEvent('generation.started', event.conversationId, event.generationId); break }
        const characterIdentity = profilesEnabled() ? generationIdentityForStarted(event) : undefined
        if (profilesEnabled() && !characterIdentity) {
          // Feature-enabled mode is fail-closed: an assistant generation with
          // no complete identity or with a binding mismatch must not create a
          // message that could later be attributed to another character.
          guardDropEvent('generation.started.character', event.conversationId, event.generationId)
          break
        }
        // The renderer has one active accumulator.  If a backend starts a
        // newer generation before the prior one terminates, close the prior
        // local stream and remove its identity maps so a late terminal cannot
        // retain state or touch the newer message.
        const previousGenerationId = activeGenerationId.value
        if (previousGenerationId && previousGenerationId !== event.generationId) {
          const previousAccumulator = accumulator.value
          const previousMessageId = previousAccumulator?.getState().messageId
          if (previousMessageId && byId.value[previousMessageId]) byId.value[previousMessageId].status = 'interrupted'
          clearGeneration(previousGenerationId)
        }
        generationByConversation.value[event.generationId] = event.conversationId
        generationSessionById.value[event.generationId] = {
          conversationId: event.conversationId,
          connectionEpoch: connectionEpoch.value,
          connectionSignature
        }
        if (characterIdentity) generationIdentityById.value[event.generationId] = characterIdentity
        accumulator.value = new StreamAccumulator({
          generationId: event.generationId,
          messageId: event.messageId,
          responseId: event.responseId,
          conversationId: event.conversationId
        })
        activeGenerationId.value = event.generationId
        upsertMessage({
          messageId: event.messageId,
          conversationId: event.conversationId,
          role: 'assistant',
          status: 'streaming',
          assistantSegments: [],
          createdAt: nowIso(),
          ...(event.model ? { model: event.model } : {}),
          ...(characterIdentity ? { character: cloneValue(characterIdentity.snapshot) } : {})
        })
        break
      }
      case 'generation.delta':
      case 'generation.segment.started':
      case 'generation.segment.completed': {
        // 归属守卫(design §4.2.1):中间事件无 conversationId,经 generationByConversation 表判归属
        const conv = generationByConversation.value[event.generationId]
        if (conv === undefined || conv !== useConversationStore().currentId) { guardDropEvent(event.event, conv, event.generationId); break }
        const session = generationSessionById.value[event.generationId]
        if (!session || !generationSessionMatches(session)) { guardDropEvent(`${event.event}.session`, conv, event.generationId); break }
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break // 跨代/迟到事件丢弃(P2-2)
        // P2-5:cancel/断线已清 activeGenerationId,同代迟到事件丢弃(accumulator 仍在,防覆盖 interrupted)
        if (event.generationId !== activeGenerationId.value) break
        acc.apply(event)
        patchAssistant(acc.getState().messageId, acc)
        break
      }
      case 'generation.completed': {
        const conv = generationByConversation.value[event.generationId]
        if (conv === undefined || conv !== useConversationStore().currentId) { guardDropEvent(event.event, conv, event.generationId); break }
        const session = generationSessionById.value[event.generationId]
        if (!session || !generationSessionMatches(session)) { guardDropEvent('generation.completed.session', conv, event.generationId); break }
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break
        const identity = generationIdentityById.value[event.generationId]
        if (identity && !terminalIdentityMatches(event, identity)) {
          guardDropEvent('generation.completed.character', conv, event.generationId)
          failGenerationProtocol(event.generationId, event.messageId)
          break
        }
        // P2-5:同上——activeGenerationId 清空后迟到 completed 不得把 interrupted 复活为 completed
        if (event.generationId !== activeGenerationId.value) break
        acc.apply(event)
        finalizeAssistant(acc.getState().messageId, acc)
        const finalMsg = byId.value[acc.getState().messageId]
        if (finalMsg) {
          // Cache persistence is asynchronous too.  Keep the same transport
          // fence as the terminal event so a reconnect/backend switch cannot
          // rehydrate this generation into the new fact domain after purge.
          void useCacheStore().pushMessages(
            useConversationStore().currentId ?? finalMsg.conversationId,
            [finalMsg],
            nowIso(),
            { guard: () => generationSessionMatches(session) }
          )
        }
        clearGeneration(event.generationId)
        break
      }
      case 'generation.failed': {
        const conv = generationByConversation.value[event.generationId]
        if (conv === undefined || conv !== useConversationStore().currentId) { guardDropEvent(event.event, conv, event.generationId); break }
        const session = generationSessionById.value[event.generationId]
        if (!session || !generationSessionMatches(session)) { guardDropEvent('generation.failed.session', conv, event.generationId); break }
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break
        const identity = generationIdentityById.value[event.generationId]
        if (identity && !terminalIdentityMatches(event, identity)) {
          guardDropEvent('generation.failed.character', conv, event.generationId)
          failGenerationProtocol(event.generationId, event.messageId)
          break
        }
        // P2-5:同上——同代迟到 failed 丢弃(已断线/cancel 不应降级状态)
        if (event.generationId !== activeGenerationId.value) break
        acc.apply(event)
        failAssistant(acc.getState().messageId, event)
        clearGeneration(event.generationId)
        break
      }
      case 'voice_session.turn': {
        // P4-B（spec §5.11）：实时语音轮次自动提交——后端预分配 messageId（非乐观）；
        // 归属取 event.conversationId ?? currentId；匹配当前会话插入 user 消息（后续 generation.* 正常装配），不匹配丢弃
        const currentId = useConversationStore().currentId
        const conv = event.conversationId ?? currentId
        if (!conv || conv !== currentId) { guardDropEvent('voice_session.turn', conv); break }
        upsertMessage({
          messageId: event.messageId,
          conversationId: conv,
          role: 'user',
          status: 'acknowledged',
          content: event.text,
          createdAt: nowIso()
        })
        break
      }
    }
  }

  /** 发送文本（可选贴图 stickerId 或附件 opts）；既有 G3 附件调用兼容 */
  async function send(text: string, stickerId?: string): Promise<boolean>
  async function send(text: string, opts?: { attachments?: MessageAttachment[]; stickerId?: string }): Promise<boolean>
  async function send(text: string, arg?: string | { attachments?: MessageAttachment[]; stickerId?: string }): Promise<boolean> {
    const conversationId = useConversationStore().currentId
    if (!conversationId) return false
    syncConnectionSessionFromStore()
    const capturedSession: GenerationSessionIdentity = {
      conversationId,
      connectionEpoch: connectionEpoch.value,
      connectionSignature
    }
    const owner = Symbol('send')
    sendingOwner = owner
    const stickerId = typeof arg === 'string' ? arg : arg?.stickerId
    const attachments = typeof arg === 'string' ? undefined : arg?.attachments
    lastError.value = undefined   // 新发送清旧错误,避免失败横幅残留(最终 review 修复)
    const clientRequestId = crypto.randomUUID()
    const key = `local-${clientRequestId}`
    const optimistic: Message = {
      messageId: key,
      conversationId,
      role: 'user',
      status: 'pending',
      clientMessageId: clientRequestId,
      createdAt: nowIso(),
      ...(text ? { content: text } : {}),
      ...(stickerId ? { stickerId } : {}),
      ...(attachments?.length ? { attachments } : {})
    }
    upsertMessage(optimistic)
    sending.value = true
    try {
      const ref = await api.send({
        conversationId,
        text,
        clientRequestId,
        ...(stickerId ? { stickerId } : {}),
        ...(attachments?.length
          ? { attachments: attachments.map((a) => ({ attachmentId: a.attachmentId, kind: a.kind, mime: a.mediaType })) }
          : {})
      })
      if (!sendRequestIsCurrent(owner, capturedSession)) return false
      if (ref?.serverMessageId) migrateKey(key, ref.serverMessageId, optimistic)
      optimistic.status = 'acknowledged' // 无 serverMessageId 也 acknowledged(P2-1)
      void useCacheStore().pushMessages(conversationId, [optimistic], nowIso(), {
        // Once the ACK has been accepted the busy owner may be released by
        // finally; the transport/session fence remains the cache authority.
        guard: () => {
          syncConnectionSessionFromStore()
          return generationSessionMatches(capturedSession)
        }
      }) // send ack 已确认消息快照
      return true // P2-2：成功返回 true，调用方据此清草稿
    } catch (e) {
      if (!sendRequestIsCurrent(owner, capturedSession)) return false
      optimistic.status = 'failed'
      lastError.value = parsePublicError(messageOf(e))
      return false // P2-2：失败返回 false，调用方保留草稿
    } finally {
      if (sendingOwner === owner) {
        sendingOwner = undefined
        sending.value = false
      }
    }
  }

  /** P4-B（spec §5.11）：录音确认发送——镜像 send()：乐观 user 消息 + api.voiceCommit + migrateKey + acknowledged + push cache；
   *  失败 → failed + lastError → false（调用方据此保留待发送条/草稿语义）。 */
  async function sendVoiceCommit(recordingId: string, text: string): Promise<boolean> {
    const conversationId = useConversationStore().currentId
    if (!conversationId) return false
    syncConnectionSessionFromStore()
    const capturedSession: GenerationSessionIdentity = {
      conversationId,
      connectionEpoch: connectionEpoch.value,
      connectionSignature
    }
    const owner = Symbol('voice-commit')
    sendingOwner = owner
    lastError.value = undefined   // 新发送清旧错误,避免失败横幅残留
    const clientRequestId = crypto.randomUUID()
    const key = `local-${clientRequestId}`
    const optimistic: Message = {
      messageId: key,
      conversationId,
      role: 'user',
      status: 'pending',
      clientMessageId: clientRequestId,
      content: text,
      createdAt: nowIso()
    }
    upsertMessage(optimistic)
    sending.value = true
    try {
      const ref = await api.voiceCommit({
        recordingId,
        text,
        conversationId,
          clientRequestId,
          clientMessageId: clientRequestId
      })
      if (!sendRequestIsCurrent(owner, capturedSession)) return false
      if (ref?.serverMessageId) migrateKey(key, ref.serverMessageId, optimistic)
      optimistic.status = 'acknowledged' // 无 serverMessageId 也 acknowledged(与 send 同口径)
      void useCacheStore().pushMessages(conversationId, [optimistic], nowIso(), {
        guard: () => {
          syncConnectionSessionFromStore()
          return generationSessionMatches(capturedSession)
        }
      })
      return true
    } catch (e) {
      if (!sendRequestIsCurrent(owner, capturedSession)) return false
      optimistic.status = 'failed'
      lastError.value = parsePublicError(messageOf(e))
      return false
    } finally {
      if (sendingOwner === owner) {
        sendingOwner = undefined
        sending.value = false
      }
    }
  }

  async function cancel(): Promise<void> {
    const gid = activeGenerationId.value
    if (!gid) return
    const capturedSession = generationSessionById.value[gid]
    try {
      await api.cancel({ generationId: gid })
    } catch {
      // 乐观置位:后端结果不阻塞(P1-4)
    }
    // The cancel IPC can race a new generation or a connection fence.  Only
    // the generation that owned this request may be interrupted/cleared; an
    // old cancel response must never mark a newer accumulator as interrupted.
    if (generationByConversation.value[gid] !== useConversationStore().currentId
      || !capturedSession
      || !generationSessionMatches(capturedSession)
      || activeGenerationId.value !== gid) return
    const acc = accumulator.value
    if (acc && acc.getState().generationId === gid) {
      const m = byId.value[acc.getState().messageId]
      if (m) m.status = 'interrupted'
    }
    clearGeneration(gid)
  }

  /** 重连回放核心路径(P2-2):匹配当前会话 → 按 messageId 去重插入;未设 currentId → 纯缓冲;不匹配 → 丢弃(design §4.1.3/4.2.2) */
  function loadReplay(conversationId: string, messages: Message[]): void {
    const validated = validateMessageConversationIds(messages, conversationId, 'replay')
    if (!validated) return
    const cur = useConversationStore().currentId
    if (cur === conversationId) {
      const accepted = acceptArchivedMessages(validated, 'replay')
      if (!accepted) {
        reportMessageProtocolError('replay.character', conversationId)
        return
      }
      for (const m of accepted) upsertMessage(m)
      return
    }
    if (cur === undefined) {
      // Do not validate against a missing binding yet.  The active session is
      // established by activate(), which calls applyPendingReplay and applies
      // the same strict guard before inserting anything.
      pendingReplay.value = { conversationId, messages: validated }
      return
    }   // 未激活前一律缓冲(活动会话晚到由 onActiveConversationAppeared 补激活)
    guardDropReplay(conversationId)
  }

  /** Task 8 activate 调用:匹配会话应用缓冲 replay;无论是否匹配都清空,防残留(m5) */
  function applyPendingReplay(id: string): void {
    if (pendingReplay.value?.conversationId === id) {
      const validated = validateMessageConversationIds(pendingReplay.value.messages, id, 'replay.pending')
      const accepted = validated ? acceptArchivedMessages(validated, 'replay') : undefined
      if (!accepted) {
        reportMessageProtocolError('replay.pending.character', id)
      } else {
        for (const m of accepted) upsertMessage(m)
      }
    }
    pendingReplay.value = undefined
  }

  function loadPage(page: MessagePage, guard?: () => boolean): boolean {
    // Capture a local session even for callers that only perform a synchronous
    // page commit (for example conversation.activate).  The cache write below
    // can outlive that commit, so it must not be allowed to cross a later
    // connected→connected transport fence.
    syncConnectionSessionFromStore()
    const pageSession = currentConnectionSession()
    const pageGuard = () => generationSessionMatches(pageSession) && (!guard || guard())
    if (!pageGuard()) return false
    const conversationId = useConversationStore().currentId
    // P1-4：非当前会话消息跳过（调用方 await 后 currentId 守卫双保险）——迟到 REST 页/异流响应不得污染其他会话列表。
    // 仅在 currentId 已设时过滤（未激活前 currentId 为空，历史页属 pending 语义，不在此路径出现）
    const rawItems = [...page.items].sort(cmpMsg) // 后端 before 页已归一化升序，再排一次免疫非时间序页（P0-1）
    // The REST request is scoped to currentId.  In legacy mode retain the
    // established defensive filtering for a mixed page, but never mutate a
    // foreign item into the current conversation.  Profile mode is strict:
    // one malformed/foreign assistant page must not advance or cache partly.
    const validItems = conversationId
      ? rawItems.filter((message) => message.conversationId === conversationId)
      : rawItems
    if (conversationId && validItems.length !== rawItems.length) {
      for (const message of rawItems) {
        if (message.conversationId !== conversationId) {
          reportMessageProtocolError('rest.conversation', conversationId, message.messageId)
        }
      }
      if (profilesEnabled()) return false
    }
    if (!conversationId && rawItems.some((message) => typeof message.conversationId !== 'string' || message.conversationId.length === 0)) {
      reportMessageProtocolError('rest.conversation', undefined)
      return false
    }
    const items = acceptArchivedMessages(validItems, 'rest')
    if (!items) {
      reportMessageProtocolError('rest.character', conversationId)
      return false
    }
    for (const m of items) upsertMessage(m)
    if (conversationId && items.length) {
      // 缓存 updatedAt 用会话真实最新消息时间而非 nowIso()（评审 P2-3）：否则向上翻旧历史会把会话顶成「现在」，
      // 扰乱 Main 侧 top-20 淘汰（updatedAt 最旧移除）——order 已含本会话已加载消息，取最大 createdAt
      const latest = order.value.reduce((max, id) => {
        const c = byId.value[id]?.createdAt ?? ''
        return c > max ? c : max
      }, '')
      void useCacheStore().pushMessages(conversationId, items, latest || nowIso(), { guard: pageGuard }) // best-effort，非离线快照路径
    }
    return true
  }

  /** 激活首屏后初始化向上分页：首页 nextCursor 即「更早一页」的 before 游标（toMessagePage has_more 语义） */
  function setPageMeta(page: MessagePage): void {
    hasMoreBefore.value = page.hasMore && !!page.nextCursor
    beforeCursor.value = page.nextCursor
  }

  /** 向上加载更早消息（CyMessageList 顶部哨兵触发）：防重入、失败保留游标可重试 */
  async function loadOlder(): Promise<void> {
    const conversationId = useConversationStore().currentId
    if (!conversationId || loadingOlder.value || !hasMoreBefore.value || !beforeCursor.value) return
    syncConnectionSessionFromStore()
    const capturedSession: GenerationSessionIdentity = {
      conversationId,
      connectionEpoch: connectionEpoch.value,
      connectionSignature
    }
    const capturedCursor = beforeCursor.value
    const owner = Symbol('load-older')
    olderOwner = owner
    loadingOlder.value = true
    try {
      const page = await api.getMessages({ conversationId, before: capturedCursor })
      if (olderOwner !== owner || !generationSessionMatches(capturedSession)) return
      if (!loadPage(page, () => olderOwner === owner && generationSessionMatches(capturedSession))) return
      if (olderOwner !== owner || !generationSessionMatches(capturedSession)) return
      hasMoreBefore.value = page.hasMore && !!page.nextCursor
      beforeCursor.value = page.nextCursor ?? undefined
    } catch (e) {
      if (olderOwner === owner && generationSessionMatches(capturedSession)) {
        lastError.value = parsePublicError(messageOf(e)) // 保留游标，可重试
      }
    } finally {
      if (olderOwner === owner) {
        olderOwner = undefined
        loadingOlder.value = false
      }
    }
  }

  /** 离线水合/离线切换载入快照（P0-1/P1-1）：排序载入 + 离线不可加载更早 */
  function loadSnapshot(conversationId: string, messages: Message[]): void {
    const validated = validateMessageConversationIds(messages, conversationId, 'snapshot')
    if (!validated) return
    const accepted = acceptArchivedMessages([...validated].sort(cmpMsg), 'snapshot')
    if (!accepted) {
      reportMessageProtocolError('snapshot.character', conversationId)
      return
    }
    resetConversation(conversationId)
    for (const m of accepted) upsertMessage(m)
    hasMoreBefore.value = false
    beforeCursor.value = undefined
    loadingOlder.value = false
  }

  // —— 阶段 3 G4：来源跳转高亮（D6）+ 上下文窗口（D5/P2-3）——

  function setHighlight(messageId: string, segmentId?: string): void {
    highlightMessageId.value = messageId
    highlightSegmentId.value = segmentId
  }
  function clearHighlight(): void {
    highlightMessageId.value = undefined
    highlightSegmentId.value = undefined
  }

  /** 按 (createdAt, messageId) 稳定重排 order（批量加载后保序；流式单条 upsert 不受影响） */
  function reorder(): void {
    order.value.sort((x, y) => cmpMsg(byId.value[x], byId.value[y]))
  }

  /** 跳转后分页续接（P2-3）：getMessageContext 窗口落地后，再补一次首页 getMessages 做游标初始化；
   *  首页 items 与窗口经 loadPage 去重合并（upsert 按 messageId，按 createdAt 稳定排序）。
   *  P1-2：首页游标经 setPageMeta 初始化 hasMoreBefore/beforeCursor——跳转后顶部哨兵在 nextCursor 存在时走 loadEarlier 补载更早历史。
   *  P1-4：两个 await 与 loadPage 之间加 currentId 守卫（对齐 activate 非 anchor 路径的 epoch 语义）——中途切会话不得污染新列表。 */
  async function loadContextWindow(messageId: string, before = 5, after = 5): Promise<boolean> {
    const conversationId = useConversationStore().currentId
    if (!conversationId) return false
    // Context jumps have two independent awaits just like the paginated
    // loaders below.  Capture the message transport session before the first
    // request so a reconnect to another backend (or a connected→connected
    // transport incarnation) cannot let an old window commit into the new
    // conversation view.  The conversation-id check alone is insufficient
    // when the same conversation id exists on both backends.
    syncConnectionSessionFromStore()
    const capturedSession: GenerationSessionIdentity = {
      conversationId,
      connectionEpoch: connectionEpoch.value,
      connectionSignature
    }
    const owner = Symbol('load-context')
    contextOwner = owner
    const isCurrent = (): boolean => {
      syncConnectionSessionFromStore()
      return contextOwner === owner && generationSessionMatches(capturedSession)
    }
    try {
      const page = await api.getMessageContext({ conversationId, messageId, before, after })
      if (!isCurrent()) return false   // P1-4：切会话/连接世代或请求 owner 变化时丢弃
      if (!loadPage(page, isCurrent) || !isCurrent()) return false
      if (!isCurrent()) return false
      reorder()
      if (!isCurrent()) return false
      const first = await api.getMessages({ conversationId, limit: 20 })
      if (!isCurrent()) return false   // P1-4：切会话/连接世代或请求 owner 变化时丢弃
      if (!loadPage(first, isCurrent) || !isCurrent()) return false
      if (!isCurrent()) return false
      nextCursor.value = first.nextCursor
      setPageMeta(first)   // P1-2：跳转后初始化「更早一页」游标（hasMoreBefore/beforeCursor），哨兵据此续接
      if (!isCurrent()) return false
      reorder()
      if (!isCurrent()) return false
      return true
    } catch {
      if (!isCurrent()) return false
      return false
    } finally {
      // Do not let an older context request revoke a newer request's owner.
      if (contextOwner === owner) contextOwner = undefined
    }
  }

  /** 加载更早消息：!nextCursor 早退（镜像 conversationStore.getMore）；成功更新游标；失败保留旧结果可重试。
   *  P1-2：跳转后（loadContextWindow 置 nextCursor）顶部哨兵走本路径；同时同步 hasMoreBefore/beforeCursor，
   *  保证哨兵两路径状态一致——nextCursor 耗尽后不落到用陈旧 beforeCursor 重复拉页的 loadOlder。 */
  async function loadEarlier(): Promise<void> {
    const conversationId = useConversationStore().currentId
    if (!conversationId || !nextCursor.value || loadingEarlier.value) return
    syncConnectionSessionFromStore()
    const capturedSession: GenerationSessionIdentity = {
      conversationId,
      connectionEpoch: connectionEpoch.value,
      connectionSignature
    }
    const capturedCursor = nextCursor.value
    const owner = Symbol('load-earlier')
    earlierOwner = owner
    loadingEarlier.value = true
    try {
      const page = await api.getMessages({ conversationId, before: capturedCursor })
      if (earlierOwner !== owner || !generationSessionMatches(capturedSession)) return
      if (!loadPage(page, () => earlierOwner === owner && generationSessionMatches(capturedSession))) return
      if (earlierOwner !== owner || !generationSessionMatches(capturedSession)) return
      reorder()
      nextCursor.value = page.nextCursor
      hasMoreBefore.value = page.hasMore && !!page.nextCursor
      beforeCursor.value = page.nextCursor
    } catch {
      // 保留旧结果，可重试；跨会话/连接世代的失败不能覆盖新状态。
    } finally {
      if (earlierOwner === owner) {
        earlierOwner = undefined
        loadingEarlier.value = false
      }
    }
  }

  /** 断线(reconnecting/error/disconnected):先清 local-* pending 乐观消息(I5),再处理 in-flight → interrupted(P1-6) */
  function handleConnectionStateChange(s: ConnectionState): void {
    // Every chat-state push participates in the message session fence,
    // including connected→connected reconnects.  This call is intentionally
    // before the status-specific cleanup below so a new connected endpoint
    // cannot inherit the previous generation map.
    advanceConnectionSession(s)
    if (s.status !== 'reconnecting' && s.status !== 'error' && s.status !== 'disconnected') return
    // Task 4（H-3）：断线自动持久化当前会话草稿——flush(cid) 立即落盘草稿/滚动锚点，防断线丢草稿。
    // currentId 保留（断线不切会话），flush 必传 conversationId；无活动会话则跳过。
    const cid = useConversationStore().currentId
    if (cid) void useDraftStore().flush(cid)
    // I5:清理 byId 中 status='pending' 且 key 以 local- 开头的用户消息(未确认;后端若已处理会经 replay 带回正式版本)
    // F11:插在 activeGenerationId 早退之前,无 active generation 时清理也执行
    for (const id of [...order.value]) {
      const m = byId.value[id]
      if (m && m.role === 'user' && m.status === 'pending' && id.startsWith('local-')) {
        delete byId.value[id]
        const i = order.value.indexOf(id); if (i >= 0) order.value.splice(i, 1)
      }
    }
    const gid = activeGenerationId.value
    if (!gid) return
    const acc = accumulator.value
    if (acc) {
      const m = byId.value[acc.getState().messageId]
      if (m) m.status = 'interrupted'
    }
    activeGenerationId.value = undefined
  }

  return {
    byId,
    order,
    sending,
    activeGenerationId,
    lastError,
    generationByConversation,
    generationSessionById,
    generationIdentityById,
    connectionEpoch,
    pendingReplay,
    droppedEvents,
    hasMoreBefore,
    beforeCursor,
    loadingOlder,
    highlightMessageId,
    highlightSegmentId,
    nextCursor,
    loadingEarlier,
    resetConversation,
    applyEvent,
    send,
    sendVoiceCommit,
    cancel,
    setHighlight,
    clearHighlight,
    loadContextWindow,
    loadEarlier,
    loadReplay,
    applyPendingReplay,
    loadPage,
    setPageMeta,
    loadOlder,
    loadSnapshot,
    handleConnectionStateChange
  }
})
