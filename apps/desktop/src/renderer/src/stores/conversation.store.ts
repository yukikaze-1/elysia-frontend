// src/renderer/src/stores/conversation.store.ts
// 会话列表/当前会话/激活/历史。activate 里 resetConversation(id) + 拉第一页历史(loadPage 去重按 messageId,P1-3)。
// 批次B T8:初始化编排(FE-P1-03 §4.1)+ epoch 守卫(FE-P1-04 §4.2.3/4)+ ready/busy/error + 补激活(§4.1.3)。
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { Conversation } from '@shared/contracts'
import { api } from './desktop-api'
import { useMessageStore } from './message.store'
import { useConnectionStore } from './connection.store'
import { useCacheStore } from './cache.store'
import { useDraftStore } from './draft.store'
import { useVoiceStore } from './voice.store'
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
  const offlineView = ref(false) // 离线视图：activateLocal/setOfflineCache 置位，恢复后 false
  const blockReason = ref<string>()      // D-P5：语音会话活跃时切换/新建被拒的 UI 提示（同附件 canSend.blockReason 短横幅语义）
  // Minor-3：语音 mode 回 idle 时归口清除切换守卫横幅——停止/删除录音、实时会话结束、转写取消后
  // 「请先结束当前语音会话」不得残留（activate/create 开头的 idle 清除只覆盖「放行路径」）。
  watch(
    () => useVoiceStore().mode,
    (m) => { if (m === 'idle') blockReason.value = undefined }
  )
  let epoch = 0                          // 激活竞态守卫(§4.2.3/D6):数字递增,最新请求才提交
  let initializingFor: string | undefined
  let initializationPromise: Promise<void> | undefined

  /** §4.2.4:list 包 try/catch 写 error 不抛 + busy */
  async function list(): Promise<boolean> {
    busy.value = true
    try {
      const p = await api.listConversations({})
      items.value = p.items
      hasMore.value = p.hasMore
      nextCursor.value = p.nextCursor
      useCacheStore().syncConversations(p.items) // 在线列表 → 内存缓存（供离线切换判定；持久化列表由 Main 派生）
      error.value = undefined   // F1:成功清旧错误(短横幅语义,防残留)
      return true
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
      return false
    } finally {
      busy.value = false
    }
  }

  /** §4.2.4:safeList —— busy 包裹 list;list 已吞错,safeList catch 为兜底 */
  async function safeList(): Promise<boolean> {
    busy.value = true
    try { return await list() } catch (e) { error.value = parsePublicError(messageOf(e)); return false } finally { busy.value = false }
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

  /** §4.2.3 activate:epoch 大者胜;currentId 立即切走;resetConversation + applyPendingReplay + 拉首屏。
   *  G4 扩展（D5）：anchor 存在时改拉 loadContextWindow 上下文窗口（替代首页）+ setHighlight；anchor 缺省行为完全不变。 */
  async function activate(id: string, anchor?: { messageId: string; segmentId?: string }): Promise<void> {
    // D-P5 会话切换守卫：语音会话活跃（mode≠idle）→ 禁止切换，UI 提示先结束（实时模式同理）
    if (useVoiceStore().mode !== 'idle') {
      blockReason.value = '请先结束当前语音会话'
      return
    }
    blockReason.value = undefined
    if (offlineView.value && useConnectionStore().state.status === 'disconnected') {
      error.value = { code: 'OFFLINE_VIEW', message: '离线视图下请使用本地缓存会话' }
      return
    }
    offlineView.value = false
    const myEpoch = ++epoch
    busy.value = true
    currentId.value = id               // 立即切走:保护 send/canSend 与事件守卫(即使后续失败也留在目标会话)
    const messageStore = useMessageStore()
    messageStore.resetConversation(id) // 选项 A:清空旧消息 + activeGenerationId + generationByConversation
    messageStore.applyPendingReplay(id)
    try {
      await api.activate(id)
      if (myEpoch !== epoch) return    // 已被更新的切换取代,不提交
      if (anchor) {
        const ok = await messageStore.loadContextWindow(anchor.messageId)
        if (myEpoch !== epoch) return
        if (ok) messageStore.setHighlight(anchor.messageId, anchor.segmentId)
        error.value = ok ? undefined : parsePublicError('无法定位消息')
      } else {
        const p = await api.getMessages({ conversationId: id })
        if (myEpoch !== epoch) return
        messageStore.loadPage(p)
        messageStore.setPageMeta(p) // 首页 nextCursor → 更早一页游标（G2）
        error.value = undefined   // F1:激活成功清旧错误
      }
    } catch (e) {
      if (myEpoch !== epoch) return    // 被取代的请求失败不打扰
      error.value = parsePublicError(messageOf(e))
    } finally {
      if (myEpoch === epoch) busy.value = false
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
    busy.value = true
    try {
      const p = await api.listConversations({ cursor: nextCursor.value })
      items.value.push(...p.items)
      hasMore.value = p.hasMore
      nextCursor.value = p.nextCursor
      error.value = undefined   // F1:成功清旧错误
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
    }
  }

  /** §4.2.4 create:try/catch 写 error + busy;内部 list 改 safeList */
  async function create(): Promise<void> {
    // D-P5 会话切换守卫：语音会话活跃（mode≠idle）→ 禁止新建会话，UI 提示先结束
    if (useVoiceStore().mode !== 'idle') {
      blockReason.value = '请先结束当前语音会话'
      return
    }
    blockReason.value = undefined
    busy.value = true
    try {
      const c = await api.createConversation({})
      await safeList()
      currentId.value = c.id
      error.value = undefined   // F1:成功清旧错误
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
      error.value = undefined   // F1:成功清旧错误
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
      useDraftStore().purge(id)   // 删除联动:清内存草稿/锚点 + 取消待写（G2，spec §4.4.1）
      useCacheStore().purge(id)   // 删除联动:清消息快照（G2，spec §4.5.1）
      error.value = undefined   // F1:成功清旧错误
    } catch (e) {
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
    }
  }

  /** 离线水合装载缓存会话列表（bootstrap disconnected 分支）；offlineView 置位 */
  function setOfflineCache(conversations: Conversation[]): void {
    items.value = [...conversations]
    offlineView.value = true
    error.value = undefined
  }

  /** 离线会话切换（P1-1）：绕过 api.activate/getMessages，从 cacheStore 换入 messageStore */
  async function activateLocal(id: string): Promise<void> {
    if (useConnectionStore().state.status !== 'disconnected') return
    const cache = useCacheStore()
    if (!cache.conversations.some((c) => c.id === id)) {
      error.value = { code: 'OFFLINE_NOT_CACHED', message: '该会话离线不可读' }
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

  return { items, currentId, hasMore, nextCursor, initializedFor, ready, error, busy, offlineView, blockReason, list, safeList, onConnected, onActiveConversationAppeared, activate, jumpToMessage, getMore, create, rename, remove, setOfflineCache, activateLocal }
})
