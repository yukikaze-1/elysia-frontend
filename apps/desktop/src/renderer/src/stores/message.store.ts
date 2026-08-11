// src/renderer/src/stores/message.store.ts
// 消息流式核心(docs/18 §4.3 / docs/06 §5):纯消费层,用 2A StreamAccumulator 应用领域事件。
// - generationId 守卫(跨代/迟到事件丢弃);accumulator.state.messageId 关联父消息(C-G5);
// - generation.completed 才结束父回复,status 用 acc.getState().status(completed/completing,不硬编码);
// - 乐观发送 clientMessageId key;无 serverMessageId 也 acknowledged,有则 migrateKey;
// - cancel 乐观置 interrupted;断线且 in-flight → handleConnectionStateChange 置 interrupted。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { BackendEvent, ConnectionState, Message, MessagePage } from '@shared/contracts'
import { StreamAccumulator } from '@shared/domain'
import { api } from './desktop-api'
import { useConversationStore } from './conversation.store'

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
  const lastError = ref<string>()

  /** 按 messageId 去重插入:新 key 追加 order;已存在则替换内容、保持位置 */
  function upsertMessage(msg: Message): void {
    if (byId.value[msg.messageId] === undefined) order.value.push(msg.messageId)
    byId.value[msg.messageId] = msg
  }

  /** 乐观发送 key 迁移到 serverMessageId(P2-1):同步 byId/order key 与 msg.messageId */
  function migrateKey(oldKey: string, newKey: string, msg: Message): void {
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
    lastError.value = `[${event.error.code}] ${event.error.message}`
  }

  function resetConversation(_conversationId: string): void {
    byId.value = {}
    order.value = []
    activeGenerationId.value = undefined
  }

  function applyEvent(event: BackendEvent): void {
    switch (event.event) {
      case 'generation.started': {
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
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break // 跨代/迟到事件丢弃(P2-2)
        acc.apply(event)
        patchAssistant(acc.getState().messageId, acc)
        break
      }
      case 'generation.completed': {
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break
        acc.apply(event)
        finalizeAssistant(acc.getState().messageId, acc)
        activeGenerationId.value = undefined
        break
      }
      case 'generation.failed': {
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break
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
      lastError.value = messageOf(e)
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

  /** 重连回放核心路径(P2-2):按 messageId 去重插入 */
  function loadReplay(conversationId: string, messages: Message[]): void {
    for (const m of messages) upsertMessage({ ...m, conversationId })
  }

  function loadPage(page: MessagePage): void {
    for (const m of page.items) upsertMessage(m)
  }

  /** 断线(reconnecting/error/disconnected)且 in-flight → assistant 置 interrupted + 清 activeGenerationId(P1-6) */
  function handleConnectionStateChange(s: ConnectionState): void {
    if (s.status !== 'reconnecting' && s.status !== 'error' && s.status !== 'disconnected') return
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
    resetConversation,
    applyEvent,
    send,
    cancel,
    loadReplay,
    loadPage,
    handleConnectionStateChange
  }
})
