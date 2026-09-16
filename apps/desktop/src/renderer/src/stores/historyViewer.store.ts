// src/renderer/src/stores/historyViewer.store.ts
// 阶段 3 G4（spec §4.1-4.5，D4/D5/D10/D11/D12/D15）：历史查看器独立 Pinia store。
// 查询/分页/跳转编排在此（可单测）；组件只消费状态与动作。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ChatHistoryItem, ChatHistoryQuery, HistoryCategory } from '@shared/contracts'
import { api } from './desktop-api'
import { useConversationStore } from './conversation.store'
import { parsePublicError, type PublicError } from '../utils/public-error'

export interface BuildQueryInput {
  keyword: string
  localDate: string
  scope: 'conversation' | 'all'
  category: HistoryCategory
  conversationId?: string
  cursor?: string
  limit?: number
}

/** D15 统一路径：关键词/日期/分类/scope/分页全部映射到 queryChatHistory 单一路径 */
export function buildQuery(input: BuildQueryInput): ChatHistoryQuery {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const keyword = input.keyword.trim()
  return {
    scope: input.scope === 'all'
      ? { type: 'all_conversations' }
      : { type: 'conversation', conversationId: input.conversationId ?? '' },
    ...(keyword ? { query: keyword } : {}),
    ...(input.localDate ? { localDate: input.localDate } : {}),
    timeZone,
    category: input.category,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: input.limit ?? 50
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useHistoryViewerStore = defineStore('historyViewer', () => {
  const open = ref(false)
  const keyword = ref('')
  const localDate = ref('')               // '' = 未筛选（<input type="date"> 空值）
  const scope = ref<'conversation' | 'all'>('all')
  const category = ref<HistoryCategory>('all')
  const items = ref<ChatHistoryItem[]>([])
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<PublicError>()
  const hasMore = ref(false)
  const nextCursor = ref<string>()
  const hasSearched = ref(false)          // 区分初始空态与「无结果」空态
  const busy = ref(false)

  /**
   * 查询世代（2026-09-16 审计 P2「读会话 id → await → 写 state 缺栅栏」）。
   *
   * 缺口：`submitQuery`/`loadMore` 都在 await **之前**读 `conversationStore.currentId`，await 之后
   * **无条件**把结果写进 state。若在途期间上下文变了（切换会话、关掉再重开查看器），回来的是
   * "旧上下文的查询结果"却被当成当前查询的结果写进去；`hasMore/nextCursor` 也一起被换掉，于是下一次
   * `loadMore` 会带着**上一个查询的游标**去续接。
   *
   * 栅栏用世代号（对齐 `conversation.store` 的 epoch 先例）：发起新查询 / 关闭 / 重开都 +1；
   * await 回来若世代已变即**丢弃**该次结果（不写数据、不写 error）。丢弃而不是"最后一次获胜"——
   * 被顶掉的那次请求属于一个已经不存在的上下文，它的结果没有可解释的归属。
   *
   * 注意 `busy`/`loading` 的复位**不**受世代守卫：`busy` 是互斥量（进入时 `if (busy) return`），
   * 任一时刻至多一次在途查询，所以 finally 一定属于持有者；若把复位也挂上世代守卫，被顶掉的那次
   * 就再也没人清 busy ⇒ 查看器永久卡死。这一条正是"按我这次的失败去清理共享态"的反面教材。
   */
  let queryEpoch = 0

  function openViewer(initialCategory?: HistoryCategory): void {
    queryEpoch++                          // 关掉再重开 = 旧的在途结果作废
    open.value = true
    keyword.value = ''
    localDate.value = ''
    scope.value = 'all'                   // D11：scope 默认全部会话
    category.value = initialCategory ?? 'all'
    items.value = []
    error.value = undefined
    hasMore.value = false
    nextCursor.value = undefined
    hasSearched.value = false
  }

  function closeViewer(): void {
    queryEpoch++                          // 关闭 = 在途结果作废（组件随后可能立刻 openViewer）
    open.value = false
    error.value = undefined
  }

  /** D11 显式提交（搜索按钮/Enter，IME 守卫在组件）；busy 防重入；失败保留旧结果（D10 不清空聊天） */
  async function submitQuery(): Promise<void> {
    if (busy.value) return
    busy.value = true
    loading.value = true
    error.value = undefined
    const epoch = ++queryEpoch            // 本次查询的世代（后续写入都要持有它）
    try {
      const query = buildQuery({
        keyword: keyword.value, localDate: localDate.value, scope: scope.value, category: category.value,
        conversationId: useConversationStore().currentId
      })
      const page = await api.queryChatHistory(query)
      if (epoch !== queryEpoch) return    // 已被切换会话/关闭重开顶掉 → 丢弃，不污染当前结果
      items.value = page.items
      hasMore.value = page.hasMore
      nextCursor.value = page.nextCursor
      hasSearched.value = true
    } catch (e) {
      if (epoch !== queryEpoch) return    // 同上：旧上下文的失败不该显示在当前上下文上
      error.value = parsePublicError(messageOf(e))     // 保留上次成功结果
    } finally {
      busy.value = false                  // 互斥量复位不受世代守卫（见 queryEpoch 注记）
      loading.value = false
    }
  }

  /** D12 不透明游标续接：去重合并 + 稳定排序 + busy 防重入；失败保留当前页 */
  async function loadMore(): Promise<void> {
    if (busy.value || !hasMore.value || !nextCursor.value) return
    busy.value = true
    loadingMore.value = true
    const epoch = queryEpoch              // 续接**当前**查询：读世代而不自增
    try {
      const query = buildQuery({
        keyword: keyword.value, localDate: localDate.value, scope: scope.value, category: category.value,
        conversationId: useConversationStore().currentId, cursor: nextCursor.value
      })
      const page = await api.queryChatHistory(query)
      if (epoch !== queryEpoch) return    // 期间换了上下文/重开查看器 → 这一页属于旧查询，丢弃
      const byHit = new Map(items.value.map((i) => [i.hitId, i]))
      for (const item of page.items) byHit.set(item.hitId, item)
      items.value = [...byHit.values()].sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)
      hasMore.value = page.hasMore
      nextCursor.value = page.nextCursor
      error.value = undefined
    } catch (e) {
      if (epoch !== queryEpoch) return
      error.value = parsePublicError(messageOf(e))
    } finally {
      busy.value = false
      loadingMore.value = false
    }
  }

  /** D5 来源跳转编排：关闭查看器，返回跳转目标（组件随后调 conversationStore.jumpToMessage） */
  function jumpTo(hit: ChatHistoryItem): { conversationId: string; messageId: string; segmentId?: string } {
    closeViewer()
    return { conversationId: hit.conversationId, messageId: hit.messageId, segmentId: hit.segmentId }
  }

  return {
    open, keyword, localDate, scope, category, items, loading, loadingMore, error, hasMore, nextCursor, hasSearched, busy,
    openViewer, closeViewer, submitQuery, loadMore, jumpTo
  }
})
