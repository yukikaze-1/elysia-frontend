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
import type { BackendEvent, ConnectionState, Message, MessagePage } from '@shared/contracts'
import { StreamAccumulator } from '@shared/domain'
import { api } from './desktop-api'
import { useConversationStore } from './conversation.store'
import { parsePublicError, type PublicError } from '../utils/public-error'

function nowIso(): string {
  return new Date().toISOString()
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useMessageStore = defineStore('message', () => {
  const byId = ref<Record<string, Message>>({})
  const order = ref<string[]>([])
  const sending = ref(false)
  const activeGenerationId = ref<string>()
  const accumulator = ref<StreamAccumulator>()
  const lastError = ref<PublicError>()

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

  /** 按 messageId 去重插入:新 key 追加 order;已存在则替换内容、保持位置 */
  function upsertMessage(msg: Message): void {
    if (byId.value[msg.messageId] === undefined) order.value.push(msg.messageId)
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

  /** 回复失败:CANCELLED → interrupted(幂等不降级 failed,C-9),其余 → failed + 错误展示 */
  function failAssistant(messageId: string, event: Extract<BackendEvent, { event: 'generation.failed' }>): void {
    const m = byId.value[messageId]
    if (!m) return
    m.status = event.error.code === 'CANCELLED' ? 'interrupted' : 'failed'
    lastError.value = { code: event.error.code, message: event.error.message, backendCode: event.error.code, retryable: event.error.retryable }
  }

  function resetConversation(_conversationId: string): void {
    byId.value = {}
    order.value = []
    activeGenerationId.value = undefined
    generationByConversation.value = {}
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
    }
  }

  async function send(text: string): Promise<void> {
    const conversationId = useConversationStore().currentId
    if (!conversationId) return
    lastError.value = undefined   // 新发送清旧错误,避免失败横幅残留(最终 review 修复)
    const clientRequestId = crypto.randomUUID()
    const key = `local-${clientRequestId}`
    const optimistic: Message = {
      messageId: key,
      conversationId,
      role: 'user',
      content: text,
      status: 'pending',
      clientMessageId: clientRequestId,
      createdAt: nowIso()
    }
    upsertMessage(optimistic)
    sending.value = true
    try {
      const ref = await api.send({ conversationId, text, clientRequestId })
      if (ref?.serverMessageId) migrateKey(key, ref.serverMessageId, optimistic)
      optimistic.status = 'acknowledged' // 无 serverMessageId 也 acknowledged(P2-1)
    } catch (e) {
      optimistic.status = 'failed'
      lastError.value = parsePublicError(messageOf(e))
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
    for (const m of page.items) upsertMessage(m)
  }

  /** 断线(reconnecting/error/disconnected):先清 local-* pending 乐观消息(I5),再处理 in-flight → interrupted(P1-6) */
  function handleConnectionStateChange(s: ConnectionState): void {
    if (s.status !== 'reconnecting' && s.status !== 'error' && s.status !== 'disconnected') return
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
    resetConversation,
    applyEvent,
    send,
    cancel,
    loadReplay,
    applyPendingReplay,
    loadPage,
    handleConnectionStateChange
  }
})
