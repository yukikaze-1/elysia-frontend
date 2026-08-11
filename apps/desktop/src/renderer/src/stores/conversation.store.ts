// src/renderer/src/stores/conversation.store.ts
// 会话列表/当前会话/激活/历史。activate 里 resetConversation(id) + 拉第一页历史(loadPage 去重按 messageId,P1-3)。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Conversation } from '@shared/contracts'
import { api } from './desktop-api'
import { useMessageStore } from './message.store'

export const useConversationStore = defineStore('conversation', () => {
  const items = ref<Conversation[]>([])
  const currentId = ref<string>()
  const hasMore = ref(false)
  const nextCursor = ref<string>()

  async function list(): Promise<void> {
    const p = await api.listConversations({})
    items.value = p.items
    hasMore.value = p.hasMore
    nextCursor.value = p.nextCursor
  }

  async function activate(id: string): Promise<void> {
    await api.activate(id)
    currentId.value = id
    // 切会话清空旧消息 + 拉第一页历史(去重按 messageId,P1-3)
    const messageStore = useMessageStore()
    messageStore.resetConversation(id)
    const p = await api.getMessages({ conversationId: id })
    messageStore.loadPage(p)
  }

  async function getMore(): Promise<void> {
    if (!nextCursor.value) return
    const p = await api.listConversations({ cursor: nextCursor.value })
    items.value.push(...p.items)
    hasMore.value = p.hasMore
    nextCursor.value = p.nextCursor
  }

  async function create(): Promise<void> {
    const c = await api.createConversation({})
    await list()
    currentId.value = c.id
  }

  /** 单对象载荷 {conversationId,title}(registry arity 约束,P2-4) */
  async function rename(input: { conversationId: string; title: string }): Promise<void> {
    await api.renameConversation(input)
    await list()
  }

  async function remove(id: string): Promise<void> {
    const wasActive = currentId.value === id
    await api.deleteConversation(id)
    await list()
    // 删除当前激活会话:currentId 清空 + messageStore 清空(聊天区显示空态,避免残留旧消息/发送打到已删会话,L1)
    if (wasActive) {
      currentId.value = undefined
      useMessageStore().resetConversation(id)
    }
  }

  return { items, currentId, hasMore, nextCursor, list, activate, getMore, create, rename, remove }
})
