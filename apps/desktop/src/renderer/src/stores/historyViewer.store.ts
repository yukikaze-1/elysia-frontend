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

  function openViewer(initialCategory?: HistoryCategory): void {
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
    open.value = false
    error.value = undefined
  }

  /** D11 显式提交（搜索按钮/Enter，IME 守卫在组件）；busy 防重入；失败保留旧结果（D10 不清空聊天） */
  async function submitQuery(): Promise<void> {
    if (busy.value) return
    busy.value = true
    loading.value = true
    error.value = undefined
    try {
      const query = buildQuery({
        keyword: keyword.value, localDate: localDate.value, scope: scope.value, category: category.value,
        conversationId: useConversationStore().currentId
      })
      const page = await api.queryChatHistory(query)
      items.value = page.items
      hasMore.value = page.hasMore
      nextCursor.value = page.nextCursor
      hasSearched.value = true
    } catch (e) {
      error.value = parsePublicError(messageOf(e))     // 保留上次成功结果
    } finally {
      busy.value = false
      loading.value = false
    }
  }

  /** D12 不透明游标续接：去重合并 + 稳定排序 + busy 防重入；失败保留当前页 */
  async function loadMore(): Promise<void> {
    if (busy.value || !hasMore.value || !nextCursor.value) return
    busy.value = true
    loadingMore.value = true
    try {
      const query = buildQuery({
        keyword: keyword.value, localDate: localDate.value, scope: scope.value, category: category.value,
        conversationId: useConversationStore().currentId, cursor: nextCursor.value
      })
      const page = await api.queryChatHistory(query)
      const byHit = new Map(items.value.map((i) => [i.hitId, i]))
      for (const item of page.items) byHit.set(item.hitId, item)
      items.value = [...byHit.values()].sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)
      hasMore.value = page.hasMore
      nextCursor.value = page.nextCursor
      error.value = undefined
    } catch (e) {
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
