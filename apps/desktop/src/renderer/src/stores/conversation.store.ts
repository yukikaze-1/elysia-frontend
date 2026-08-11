// src/renderer/src/stores/conversation.store.ts
// 会话列表/当前会话/激活/历史。activate 里 resetConversation(id) + 拉第一页历史(loadPage 去重按 messageId,P1-3)。
// 批次B T8:初始化编排(FE-P1-03 §4.1)+ epoch 守卫(FE-P1-04 §4.2.3/4)+ ready/busy/error + 补激活(§4.1.3)。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Conversation } from '@shared/contracts'
import { api } from './desktop-api'
import { useMessageStore } from './message.store'
import { useConnectionStore } from './connection.store'
import { parsePublicError, type PublicError } from '../utils/public-error'

/** F8:messageOf 仅在 message.store 内定义(非导出),conversation.store 自定模块内 helper */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
  let epoch = 0                          // 激活竞态守卫(§4.2.3/D6):数字递增,最新请求才提交

  /** §4.2.4:list 包 try/catch 写 error 不抛 + busy */
  async function list(): Promise<void> {
    busy.value = true
    try {
      const p = await api.listConversations({})
      items.value = p.items
      hasMore.value = p.hasMore
      nextCursor.value = p.nextCursor
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
    }
  }

  /** §4.2.4:safeList —— busy 包裹 list;list 已吞错,safeList catch 为兜底 */
  async function safeList(): Promise<void> {
    busy.value = true
    try { await list() } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { busy.value = false }
  }

  /** §4.1.1 onConnected:幂等 + 首次/重连分支 + 就绪门控 */
  async function onConnected(connectionId?: string): Promise<void> {
    if (connectionId && initializedFor.value === connectionId) return   // 同一连接幂等
    if (connectionId === undefined && initializedFor.value !== undefined) return  // Mock 无 connectionId:只初始化一次(m3)
    initializedFor.value = connectionId ?? ''
    try {
      if (currentId.value) {
        // 重连/已有活动会话:只刷新列表 + reconcile 活动会话,不动已有历史(replay 按 messageId 去重合并)
        await safeList()
        const activeId = useConnectionStore().state.activeConversationId
        if (activeId && activeId !== currentId.value) await activate(activeId)   // I4:后端活动会话变了 → 切过去
        ready.value = true
        return
      }
      // 首次:完整初始化
      await safeList()
      ready.value = true            // 就绪门控(D13):safeList 完成后即就绪(N1:不依赖 activate)
      if (currentId.value) return   // m6:safeList 期间用户已手动切会话,不再覆盖
      const activeId = useConnectionStore().state.activeConversationId
      if (activeId) await activate(activeId)   // 同步出现的 active:activate(applyPendingReplay + getMessages 首屏)
      // active 晚到(session 帧晚于 safeList):由 onActiveConversationAppeared 补激活(§4.1.3),此处不设 currentId
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    }
  }

  /** §4.1.3 补激活:currentId 已设/busy → 不动;否则 activate(applyPendingReplay + 首屏) */
  async function onActiveConversationAppeared(activeId: string): Promise<void> {
    if (currentId.value) return   // 已激活/用户已手动切,不动
    if (busy.value) return        // 初始化/操作进行中,由激活流程覆盖
    await activate(activeId)
  }

  /** §4.2.3 activate:epoch 大者胜;currentId 立即切走;resetConversation + applyPendingReplay + 拉首屏 */
  async function activate(id: string): Promise<void> {
    const myEpoch = ++epoch
    busy.value = true
    currentId.value = id               // 立即切走:保护 send/canSend 与事件守卫(即使后续失败也留在目标会话)
    const messageStore = useMessageStore()
    messageStore.resetConversation(id) // 选项 A:清空旧消息 + activeGenerationId + generationByConversation
    messageStore.applyPendingReplay(id)
    try {
      await api.activate(id)
      if (myEpoch !== epoch) return    // 已被更新的切换取代,不提交
      const p = await api.getMessages({ conversationId: id })
      if (myEpoch !== epoch) return
      messageStore.loadPage(p)
    } catch (e) {
      if (myEpoch !== epoch) return    // 被取代的请求失败不打扰
      error.value = parsePublicError(messageOf(e))
    } finally {
      if (myEpoch === epoch) busy.value = false
    }
  }

  /** §4.2.4 getMore:try/catch 写 error + busy */
  async function getMore(): Promise<void> {
    if (!nextCursor.value) return
    busy.value = true
    try {
      const p = await api.listConversations({ cursor: nextCursor.value })
      items.value.push(...p.items)
      hasMore.value = p.hasMore
      nextCursor.value = p.nextCursor
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
    }
  }

  /** §4.2.4 create:try/catch 写 error + busy;内部 list 改 safeList */
  async function create(): Promise<void> {
    busy.value = true
    try {
      const c = await api.createConversation({})
      await safeList()
      currentId.value = c.id
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
    }
  }

  /** §4.2.4 rename(单对象载荷 {conversationId,title},registry arity 约束,P2-4):try/catch + busy */
  async function rename(input: { conversationId: string; title: string }): Promise<void> {
    busy.value = true
    try {
      await api.renameConversation(input)
      await safeList()
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
    }
  }

  /** §4.2.4 remove:try/catch + busy;删除当前激活会话 → currentId 清空 + messageStore 清空(空态,L1) */
  async function remove(id: string): Promise<void> {
    const wasActive = currentId.value === id
    busy.value = true
    try {
      await api.deleteConversation(id)
      await safeList()
      // 删除当前激活会话:currentId 清空 + messageStore 清空(聊天区显示空态,避免残留旧消息/发送打到已删会话,L1)
      if (wasActive) {
        currentId.value = undefined
        useMessageStore().resetConversation(id)
      }
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
    }
  }

  return { items, currentId, hasMore, nextCursor, initializedFor, ready, error, busy, list, safeList, onConnected, onActiveConversationAppeared, activate, getMore, create, rename, remove }
})
