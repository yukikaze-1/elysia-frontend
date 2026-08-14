<script setup lang="ts">
// CyHistoryViewer:全窗覆盖式历史查看器（spec §4.1/§4.7，D1/D14）。
// 模态无障碍:role=dialog + aria-modal、初始焦点搜索框、Tab 焦点陷阱、Esc 关闭并回焦点、aria-live 播报。
// 查询:显式提交(D11) + IME 守卫(isCompositionEnter,D14);分页:不透明游标 loadMore(D12)。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isCompositionEnter, isoToLocalDate } from '@shared/domain'
import type { ChatHistoryItem, HistoryCategory } from '@shared/contracts'
import { useConversationStore } from '../stores/conversation.store'
import { useHistoryViewerStore } from '../stores/historyViewer.store'
import CyHistoryResultItem from './CyHistoryResultItem.vue'

const store = useHistoryViewerStore()
const conversationStore = useConversationStore()

const keywordInput = ref<HTMLInputElement>()
const overlay = ref<HTMLElement>()
let triggerElement: Element | null = null   // 打开前的活动元素(关闭后回焦点)
const CATEGORIES: Array<{ value: HistoryCategory; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image_video', label: '图片/视频' },
  { value: 'sticker', label: '表情' },
  { value: 'file', label: '文件' },
  { value: 'audio', label: '音频' },
  { value: 'link', label: '链接' }
]

/** P2-2：按用户本地自然日分组（spec §2/§4.1/§4.2）——isoToLocalDate 处理跨 UTC 日；组内保序、组间按日期降序 */
const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
interface DayGroup { date: string; label: string; items: ChatHistoryItem[] }
const groupedItems = computed<DayGroup[]>(() => {
  const groups: DayGroup[] = []
  const byDate = new Map<string, DayGroup>()
  for (const hit of store.items) {
    let date = ''
    try { date = isoToLocalDate(hit.createdAt, localTimeZone) } catch { /* 非法时间戳归入「其他」 */ }
    if (!date || date.includes('NaN')) date = '其他'
    let g = byDate.get(date)
    if (!g) {
      g = { date, label: dayLabel(date), items: [] }
      byDate.set(date, g)
      groups.push(g)
    }
    g.items.push(hit)
  }
  // 组间按日期降序（最新在前）；「其他」组置底
  return groups.sort((a, b) => {
    if (a.date === '其他') return 1
    if (b.date === '其他') return -1
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  })
})

function dayLabel(date: string): string {
  if (date === '其他') return '其他'
  const [y, m, d] = date.split('-').map(Number)
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()]
  return `${y}年${m}月${d}日 · 周${week}`
}

/** 打开时记录触发元素并聚焦搜索框 */
function onOpen(): void {
  triggerElement = document.activeElement
  void nextTick(() => keywordInput.value?.focus())
}
watch(() => store.open, (v) => { if (v) onOpen() })
onMounted(() => { if (store.open) onOpen() })

function close(): void {
  store.closeViewer()
  if (triggerElement instanceof HTMLElement) triggerElement.focus()
}

function onEnter(e: KeyboardEvent): void {
  if (isCompositionEnter(e)) return   // IME 组词确认 Enter 不提交(D14)
  e.preventDefault()
  void store.submitQuery()
}

/** Tab 焦点陷阱:循环回拦在可聚焦元素内 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (document.activeElement === keywordInput.value && keywordInput.value?.value) {
      keywordInput.value.value = ''; store.keyword = ''   // Esc 先清空输入(可选)
    } else {
      close()
    }
    return
  }
  if (e.key !== 'Tab' || !overlay.value) return
  const focusables = overlay.value.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

function setCategory(c: HistoryCategory): void { store.category = c }
function onScopeChange(e: Event): void { store.scope = (e.target as HTMLSelectElement).value as 'conversation' | 'all' }

/** 跳转:store.jumpTo 关闭查看器 → conversationStore.jumpToMessage(失败两分支统一:已关→横幅;未关→查看器提示) */
async function onJump(hit: ChatHistoryItem): Promise<void> {
  const target = store.jumpTo(hit)
  const ok = await conversationStore.jumpToMessage(target.conversationId, target.messageId, target.segmentId)
  if (!ok && store.open) store.error = { code: 'JUMP_FAILED', message: '无法定位消息' }
}

const announceText = computed(() => {
  if (store.loading) return '正在搜索聊天记录'
  if (store.error) return `搜索失败:${store.error.message}`
  if (store.hasSearched && store.items.length === 0) return '没有找到相关聊天记录'
  if (store.hasSearched) return `找到 ${store.items.length} 条相关聊天记录`
  return ''
})

onBeforeUnmount(() => { triggerElement = null })
</script>

<template>
  <Teleport to="body">
    <div v-if="store.open" ref="overlay" class="cy-history-overlay" role="dialog" aria-modal="true" aria-label="聊天历史" @keydown="onKeydown">
      <div class="cy-history">
        <header class="cy-history-header">
          <div class="cy-history-title">
            <strong>聊天历史</strong>
            <span class="cy-muted">搜索不影响当前聊天</span>
          </div>
          <button class="cy-close-btn" aria-label="关闭历史查看器" @click="close">✕</button>
        </header>

        <div class="cy-history-filters">
          <select class="cy-filter-select" :value="store.scope" aria-label="搜索范围" @change="onScopeChange">
            <option value="all">全部会话</option>
            <option value="conversation">当前会话</option>
          </select>
          <input ref="keywordInput" v-model="store.keyword" class="cy-filter-input" type="text" placeholder="关键词搜索" aria-label="关键词搜索" @keydown.enter="onEnter" />
          <input v-model="store.localDate" class="cy-filter-date" type="date" aria-label="按日期筛选" />
          <button class="cy-search-btn" :disabled="store.busy" aria-label="搜索" @click="store.submitQuery()">搜索</button>
        </div>

        <nav class="cy-history-tabs" aria-label="分类筛选">
          <button v-for="c in CATEGORIES" :key="c.value" class="cy-cat-tab" :class="{ active: store.category === c.value }" :aria-pressed="store.category === c.value" @click="setCategory(c.value)">
            {{ c.label }}
          </button>
        </nav>

        <div class="cy-live" role="status" aria-live="polite">{{ announceText }}</div>

        <div v-if="store.error" class="cy-history-error" role="alert">
          <span>搜索失败:{{ store.error.message }}</span>
          <button class="cy-retry-btn" @click="store.submitQuery()">重试</button>
        </div>

        <div v-if="store.loading" class="cy-history-state">正在搜索…</div>
        <div v-else-if="store.hasSearched && store.items.length === 0" class="cy-history-state">没有找到相关聊天记录</div>
        <ul v-else class="cy-history-results">
          <template v-for="group in groupedItems" :key="group.date">
            <li class="cy-history-day">{{ group.label }}</li>
            <CyHistoryResultItem v-for="hit in group.items" :key="hit.hitId" :hit="hit" @jump="onJump" />
          </template>
        </ul>

        <footer class="cy-history-footer">
          <button v-if="store.hasMore && !store.loadingMore" class="cy-more-btn" @click="store.loadMore()">加载更多</button>
          <span v-if="store.loadingMore" class="cy-muted">加载中…</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cy-history-overlay {
  position: fixed;
  inset: 36px 0 0 60px;   /* 保留标题栏(36px)与导航栏(60px,NAV_WIDTH),覆盖聊天主区与会话栏(D1) */
  z-index: 50;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--cy-window) 70%, transparent);
  backdrop-filter: blur(2px);
}
.cy-history {
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100% - 48px));
  max-height: calc(100% - 48px);
  padding: 14px;
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);
}
.cy-history-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.cy-history-title { display: flex; align-items: baseline; gap: 8px; }
.cy-close-btn { padding: 4px 10px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-muted); }
.cy-history-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.cy-filter-select, .cy-filter-input, .cy-filter-date { padding: 7px 9px; border: 1px solid var(--cy-border); border-radius: 10px; background: var(--cy-surface); color: var(--cy-text); font-size: 13px; }
.cy-filter-input { flex: 1; min-width: 160px; }
.cy-search-btn { padding: 7px 14px; border: 0; border-radius: 10px; background: var(--cy-accent); color: var(--cy-accent-text); }
.cy-search-btn:disabled { opacity: 0.5; }
.cy-history-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.cy-cat-tab { padding: 5px 10px; border: 1px solid var(--cy-border); border-radius: 999px; background: var(--cy-surface); color: var(--cy-muted); font-size: 12px; }
.cy-cat-tab.active { background: var(--cy-accent); color: var(--cy-accent-text); border-color: var(--cy-accent); }
.cy-live { min-height: 18px; color: var(--cy-muted); font-size: 12px; }
.cy-history-error { display: flex; align-items: center; gap: 8px; padding: 8px 11px; margin-bottom: 8px; color: var(--cy-danger); background: var(--cy-surface-soft); border: 1px dashed var(--cy-danger); border-radius: 10px; font-size: 12px; }
.cy-retry-btn { margin-left: auto; padding: 3px 9px; border: 1px solid var(--cy-border); border-radius: 7px; background: var(--cy-surface); }
.cy-history-state { padding: 28px 0; color: var(--cy-muted); text-align: center; font-size: 13px; }
.cy-history-results { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; overflow-y: auto; min-height: 120px; }
.cy-history-day { display: block; margin: 8px 0 2px; color: var(--cy-muted); font-size: 12px; font-weight: 500; }
.cy-history-footer { margin-top: 10px; text-align: center; }
.cy-more-btn { padding: 6px 16px; border: 1px solid var(--cy-border); border-radius: 999px; background: var(--cy-surface); color: var(--cy-muted); font-size: 12px; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
