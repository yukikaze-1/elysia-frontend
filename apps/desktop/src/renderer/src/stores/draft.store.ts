// 草稿+滚动锚点内存态（spec §4.1/§4.4.1 D1/D4）：Renderer 只持内存态，防抖/切会话经 persistSession 持久化归 Main。
// 超限（D4）两层口径：①单草稿 100KB UTF-8 字节 → 拒绝+横幅；②50 会话上限 → Main 淘汰 + evictedConversationIds 通知。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PersistSessionResult, ScrollAnchor, SessionPersistenceState } from '@shared/contracts'
import { api } from './desktop-api'
import { applyPersistenceFailure, clearPersistenceFailure, type PersistenceFailure } from '../utils/persistence-failure'

export const DRAFT_MAX_BYTES = 100 * 1024
export const DRAFT_DEBOUNCE_MS = 800
export const DRAFT_MAX_ENTRIES = 50

function nowIso(): string { return new Date().toISOString() }
function byteLength(s: string): number { return new TextEncoder().encode(s).byteLength }

export const useDraftStore = defineStore('draft', () => {
  const drafts = ref<Record<string, string>>({})
  const scrollAnchors = ref<Record<string, ScrollAnchor>>({})
  const overLimit = ref<Record<string, boolean>>({})
  const hydrated = ref(false)
  const evictionNotice = ref<string[]>([])
  /**
   * 本地持久化故障（H-11b renderer 半边，2026-09-13）。
   *
   * 此前 `persistNow` 的 catch 是**无条件 fail-open**：保内存态、下次重试、不告诉任何人。
   * 对「单次抖动」这是对的；对「降级态」却是错的——降级在本进程内**不会自愈**，
   * 用户会一直以为草稿存着，直到重启后发现全丢。评审把这条记为 H-11b 的 renderer 半边
   * （此前只到「Main 拒绝写入 + 日志/诊断计数」，UI 侧一个字都看不到）。
   */
  const persistenceFailure = ref<PersistenceFailure | undefined>(undefined)
  /** convId → pending timer：防抖窗口内再次保存重置；flush/purge 取消 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function schedulePersist(conversationId: string): void {
    const prev = timers.get(conversationId)
    if (prev !== undefined) clearTimeout(prev)
    timers.set(conversationId, setTimeout(() => { timers.delete(conversationId); void persistNow(conversationId) }, DRAFT_DEBOUNCE_MS))
  }

  async function persistNow(conversationId: string): Promise<PersistSessionResult | undefined> {
    timers.delete(conversationId)
    try {
      const res = await api.persistSession({
        conversationId,
        draft: { text: drafts.value[conversationId] ?? '', updatedAt: nowIso() },
        scrollAnchor: scrollAnchors.value[conversationId] ?? null
      })
      if (res?.evictedConversationIds?.length) {
        removeConversations(res.evictedConversationIds) // 评审 P2-4：淘汰项内存清理（草稿/锚点/定时器）+ 一次性通知——否则被 Main 淘汰的草稿留在 Renderer 内存，保存即重新写回、50 会话配额反复震荡
      }
      // 写回成功即清「单次失败」；降级态是 Main 侧的持续条件（本进程内不可自愈），只能由 hydrate 改变
      // ——规则收口在 utils/persistence-failure.ts（cache.store 用的是同一份）。
      persistenceFailure.value = clearPersistenceFailure(persistenceFailure.value)
      return res
    } catch (e) {
      // fail-open（C1 同款）保留：持久化失败保内存态，下次触发重试。**但不再静默**——见 persistenceFailure。
      persistenceFailure.value = applyPersistenceFailure(persistenceFailure.value, e)
      return undefined
    }
  }

  function saveDraft(conversationId: string, text: string): boolean {
    if (byteLength(text) > DRAFT_MAX_BYTES) {
      overLimit.value[conversationId] = true
      return false // 拒绝写入、不静默截断；横幅「草稿已满」+ 清空按钮
    }
    drafts.value[conversationId] = text
    overLimit.value[conversationId] = false
    schedulePersist(conversationId)
    return true
  }

  function clear(conversationId: string): void {
    delete drafts.value[conversationId]
    overLimit.value[conversationId] = false
    schedulePersist(conversationId) // persistNow 读 drafts[id] ?? '' → 空串=清除（Main 保留条目但 text 为空）
  }

  function setScrollAnchor(conversationId: string, anchor: ScrollAnchor | null): void {
    if (anchor === null) delete scrollAnchors.value[conversationId]
    else scrollAnchors.value[conversationId] = anchor
  }

  function hydrate(state: SessionPersistenceState): void {
    const next: Record<string, string> = {}
    for (const d of state.drafts) next[d.conversationId] = d.text
    drafts.value = next
    scrollAnchors.value = { ...state.scrollAnchors }
    // 启动水合是用户**第一个**能知道「本地保存已停用」的时刻（Main 在 load() 阶段就已降级）：
    // 没有这一步，降级态只有等到用户下一次键入触发写入被拒、且 UI 会显示之后才可见。
    persistenceFailure.value = state.persistenceDegraded === undefined
      ? undefined
      : { code: 'PERSISTENCE_DEGRADED', file: state.persistenceDegraded.file, reason: state.persistenceDegraded.reason }
    hydrated.value = true
  }

  async function flush(conversationId: string): Promise<PersistSessionResult | undefined> {
    const prev = timers.get(conversationId)
    if (prev !== undefined) { clearTimeout(prev); timers.delete(conversationId) }
    return persistNow(conversationId)
  }

  /**
   * 退出前 flush（H-04，2026-09-11）：把所有**仍在防抖窗口内**的会话草稿立刻落盘。
   * 背景：`flush` 此前只有「切会话」与「断线」两个调用点，键入后立刻关窗时定时器未到期，
   * 内容无提示消失。逐会话并发、任一失败不阻断其余（persistNow 内部已 fail-open）。
   */
  async function flushAll(): Promise<void> {
    const pendingIds = [...timers.keys()]
    if (pendingIds.length === 0) return
    await Promise.allSettled(pendingIds.map((id) => flush(id)))
  }

  function purge(conversationId: string): void {
    const prev = timers.get(conversationId)
    if (prev !== undefined) { clearTimeout(prev); timers.delete(conversationId) }
    delete drafts.value[conversationId]
    delete scrollAnchors.value[conversationId]
    delete overLimit.value[conversationId]
  }

  /** 淘汰项清理（P2-1）：被 Main 淘汰的会话草稿/锚点一并从内存清，并置一次性通知 */
  function removeConversations(ids: string[]): void {
    for (const id of ids) {
      const prev = timers.get(id)
      if (prev !== undefined) { clearTimeout(prev); timers.delete(id) }
      delete drafts.value[id]
      delete scrollAnchors.value[id]
      delete overLimit.value[id]
    }
    if (ids.length) evictionNotice.value = [...evictionNotice.value, ...ids]
  }

  function dismissEviction(): void { evictionNotice.value = [] }

  return {
    drafts, scrollAnchors, overLimit, hydrated, evictionNotice, persistenceFailure,
    saveDraft, clear, setScrollAnchor, hydrate, flush, flushAll, purge, removeConversations, dismissEviction
  }
})
