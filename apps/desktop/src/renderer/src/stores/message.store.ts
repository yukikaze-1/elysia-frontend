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
import type { BackendEvent, ConnectionState, Message, MessageAttachment, MessagePage } from '@shared/contracts'
import { StreamAccumulator } from '@shared/domain'
import { api } from './desktop-api'
import { useConversationStore } from './conversation.store'
import { useDraftStore } from './draft.store'
import { useCacheStore } from './cache.store'
import { cmpMsg } from '../utils/message-order'
import { parsePublicError, type PublicError } from '../utils/public-error'
import { clearMarkdownCache } from '../utils/markdown'   // 阶段 7 批次 C（Task 3）：会话切换清空 markdown 渲染缓存（M-2 单一挂载点）

function nowIso(): string {
  return new Date().toISOString()
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
  /** loadReplay 纯缓冲:currentId 未设时暂存,由 applyPendingReplay(id) 应用(design §4.1.3) */
  const pendingReplay = ref<{ conversationId: string; messages: Message[] }>()
  /** 领域守卫丢弃计数(测试断言/调试;只记类型与 ID,不记正文,design §4.2.1) */
  const droppedEvents = ref(0)

  /** 领域守卫:丢弃事件只记类型与 ID,不记正文;计数供测试/调试 */
  function guardDropEvent(type: string, conversationId?: string, generationId?: string): void {
    console.warn('cyrene:guard:drop', { type, conversationId, generationId })
    droppedEvents.value++
  }

  function guardDropReplay(conversationId: string): void {
    console.warn('cyrene:guard:drop', { type: 'replay', conversationId })
    droppedEvents.value++
  }

  /** 按 messageId 去重 + (createdAt, messageId) 升序二分有序插入（P0-1）：新 key 插到第一个「不早于自己」的 key 之前（同序插其后，稳定）；已存在原位替换 */
  function upsertMessage(msg: Message): void {
    if (byId.value[msg.messageId] !== undefined) { byId.value[msg.messageId] = msg; return }
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

  function resetConversation(_conversationId: string): void {
    byId.value = {}
    order.value = []
    activeGenerationId.value = undefined
    generationByConversation.value = {}
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
    switch (event.event) {
      case 'generation.started': {
        // 归属守卫(design §4.2.1):started 校验 conversationId,防 A 的 started 迟到到 B 时覆盖 B 的 accumulator
        if (event.conversationId !== useConversationStore().currentId) { guardDropEvent('generation.started', event.conversationId, event.generationId); break }
        generationByConversation.value[event.generationId] = event.conversationId
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
          ...(event.model ? { model: event.model } : {})
        })
        break
      }
      case 'generation.delta':
      case 'generation.segment.started':
      case 'generation.segment.completed': {
        // 归属守卫(design §4.2.1):中间事件无 conversationId,经 generationByConversation 表判归属
        const conv = generationByConversation.value[event.generationId]
        if (conv === undefined || conv !== useConversationStore().currentId) { guardDropEvent(event.event, conv, event.generationId); break }
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
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break
        // P2-5:同上——activeGenerationId 清空后迟到 completed 不得把 interrupted 复活为 completed
        if (event.generationId !== activeGenerationId.value) break
        acc.apply(event)
        finalizeAssistant(acc.getState().messageId, acc)
        const finalMsg = byId.value[acc.getState().messageId]
        if (finalMsg) void useCacheStore().pushMessages(useConversationStore().currentId ?? finalMsg.conversationId, [finalMsg], nowIso())
        activeGenerationId.value = undefined
        break
      }
      case 'generation.failed': {
        const conv = generationByConversation.value[event.generationId]
        if (conv === undefined || conv !== useConversationStore().currentId) { guardDropEvent(event.event, conv, event.generationId); break }
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break
        // P2-5:同上——同代迟到 failed 丢弃(已断线/cancel 不应降级状态)
        if (event.generationId !== activeGenerationId.value) break
        acc.apply(event)
        failAssistant(acc.getState().messageId, event)
        activeGenerationId.value = undefined
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
      if (ref?.serverMessageId) migrateKey(key, ref.serverMessageId, optimistic)
      optimistic.status = 'acknowledged' // 无 serverMessageId 也 acknowledged(P2-1)
      void useCacheStore().pushMessages(conversationId, [optimistic], nowIso()) // send ack 已确认消息快照
      return true // P2-2：成功返回 true，调用方据此清草稿
    } catch (e) {
      optimistic.status = 'failed'
      lastError.value = parsePublicError(messageOf(e))
      return false // P2-2：失败返回 false，调用方保留草稿
    } finally {
      sending.value = false
    }
  }

  /** P4-B（spec §5.11）：录音确认发送——镜像 send()：乐观 user 消息 + api.voiceCommit + migrateKey + acknowledged + push cache；
   *  失败 → failed + lastError → false（调用方据此保留待发送条/草稿语义）。 */
  async function sendVoiceCommit(recordingId: string, text: string): Promise<boolean> {
    const conversationId = useConversationStore().currentId
    if (!conversationId) return false
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
      if (ref?.serverMessageId) migrateKey(key, ref.serverMessageId, optimistic)
      optimistic.status = 'acknowledged' // 无 serverMessageId 也 acknowledged(与 send 同口径)
      void useCacheStore().pushMessages(conversationId, [optimistic], nowIso())
      return true
    } catch (e) {
      optimistic.status = 'failed'
      lastError.value = parsePublicError(messageOf(e))
      return false
    } finally {
      sending.value = false
    }
  }

  async function cancel(): Promise<void> {
    const gid = activeGenerationId.value
    if (!gid) return
    try {
      await api.cancel({ generationId: gid })
    } catch {
      // 乐观置位:后端结果不阻塞(P1-4)
    }
    const acc = accumulator.value
    if (acc) {
      const m = byId.value[acc.getState().messageId]
      if (m) m.status = 'interrupted'
    }
    activeGenerationId.value = undefined
  }

  /** 重连回放核心路径(P2-2):匹配当前会话 → 按 messageId 去重插入;未设 currentId → 纯缓冲;不匹配 → 丢弃(design §4.1.3/4.2.2) */
  function loadReplay(conversationId: string, messages: Message[]): void {
    const cur = useConversationStore().currentId
    if (cur === conversationId) { for (const m of messages) upsertMessage({ ...m, conversationId }); return }
    if (cur === undefined) { pendingReplay.value = { conversationId, messages }; return }   // 未激活前一律缓冲(活动会话晚到由 onActiveConversationAppeared 补激活)
    guardDropReplay(conversationId)
  }

  /** Task 8 activate 调用:匹配会话应用缓冲 replay;无论是否匹配都清空,防残留(m5) */
  function applyPendingReplay(id: string): void {
    if (pendingReplay.value?.conversationId === id) {
      for (const m of pendingReplay.value.messages) upsertMessage({ ...m, conversationId: id })
    }
    pendingReplay.value = undefined
  }

  function loadPage(page: MessagePage): void {
    const conversationId = useConversationStore().currentId
    // P1-4：非当前会话消息跳过（调用方 await 后 currentId 守卫双保险）——迟到 REST 页/异流响应不得污染其他会话列表。
    // 仅在 currentId 已设时过滤（未激活前 currentId 为空，历史页属 pending 语义，不在此路径出现）
    const items = [...page.items].sort(cmpMsg).filter((m) => !conversationId || !m.conversationId || m.conversationId === conversationId) // 后端 before 页已归一化升序，再排一次免疫非时间序页（P0-1）
    for (const m of items) upsertMessage(m)
    if (conversationId && items.length) {
      // 缓存 updatedAt 用会话真实最新消息时间而非 nowIso()（评审 P2-3）：否则向上翻旧历史会把会话顶成「现在」，
      // 扰乱 Main 侧 top-20 淘汰（updatedAt 最旧移除）——order 已含本会话已加载消息，取最大 createdAt
      const latest = order.value.reduce((max, id) => {
        const c = byId.value[id]?.createdAt ?? ''
        return c > max ? c : max
      }, '')
      void useCacheStore().pushMessages(conversationId, items, latest || nowIso()) // best-effort，非离线快照路径
    }
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
    loadingOlder.value = true
    try {
      const page = await api.getMessages({ conversationId, before: beforeCursor.value })
      loadPage(page)
      hasMoreBefore.value = page.hasMore
      beforeCursor.value = page.nextCursor ?? undefined
    } catch (e) {
      lastError.value = parsePublicError(messageOf(e)) // 保留游标，可重试
    } finally {
      loadingOlder.value = false
    }
  }

  /** 离线水合/离线切换载入快照（P0-1/P1-1）：排序载入 + 离线不可加载更早 */
  function loadSnapshot(conversationId: string, messages: Message[]): void {
    resetConversation(conversationId)
    for (const m of [...messages].sort(cmpMsg)) upsertMessage({ ...m, conversationId })
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
    try {
      const page = await api.getMessageContext({ conversationId, messageId, before, after })
      if (useConversationStore().currentId !== conversationId) return false   // P1-4：切会话丢弃
      loadPage(page)
      reorder()
      const first = await api.getMessages({ conversationId, limit: 20 })
      if (useConversationStore().currentId !== conversationId) return false   // P1-4：切会话丢弃
      nextCursor.value = first.nextCursor
      setPageMeta(first)   // P1-2：跳转后初始化「更早一页」游标（hasMoreBefore/beforeCursor），哨兵据此续接
      loadPage(first)
      reorder()
      return true
    } catch {
      return false
    }
  }

  /** 加载更早消息：!nextCursor 早退（镜像 conversationStore.getMore）；成功更新游标；失败保留旧结果可重试。
   *  P1-2：跳转后（loadContextWindow 置 nextCursor）顶部哨兵走本路径；同时同步 hasMoreBefore/beforeCursor，
   *  保证哨兵两路径状态一致——nextCursor 耗尽后不落到用陈旧 beforeCursor 重复拉页的 loadOlder。 */
  async function loadEarlier(): Promise<void> {
    const conversationId = useConversationStore().currentId
    if (!conversationId || !nextCursor.value || loadingEarlier.value) return
    loadingEarlier.value = true
    try {
      const page = await api.getMessages({ conversationId, before: nextCursor.value })
      loadPage(page)
      reorder()
      nextCursor.value = page.nextCursor
      hasMoreBefore.value = page.hasMore && !!page.nextCursor
      beforeCursor.value = page.nextCursor
    } catch {
      // 保留旧结果，可重试
    } finally {
      loadingEarlier.value = false
    }
  }

  /** 断线(reconnecting/error/disconnected):先清 local-* pending 乐观消息(I5),再处理 in-flight → interrupted(P1-6) */
  function handleConnectionStateChange(s: ConnectionState): void {
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
