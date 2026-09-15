<script setup lang="ts">
// CyHistoryViewer:全窗覆盖式历史查看器（spec §4.1/§4.7，D1/D14）。
// 模态无障碍:role=dialog + aria-modal、初始焦点搜索框、Tab 焦点陷阱、Esc 关闭并回焦点、aria-live 播报。
// 查询:显式提交(D11) + IME 守卫(isCompositionEnter,D14);分页:不透明游标 loadMore(D12)。
// 阶段 7 批次 C Task 2（虚拟化）：groupedItems → 扁平 HistoryRow[]（DayHeaderRow | item row），
//   computeWindow 只渲染可视窗口（估高+实测混合前缀和），loadMore 锚点补偿改 data 层（captureAnchor/restoreScrollTop）。
//   注意：估高不精确时用 ResizeObserver 实测行高写 heights，锚点上方变化经 pendingCompensation 补偿（防跳）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isCompositionEnter, isoToLocalDate } from '@shared/domain'
import type { ChatHistoryItem, HistoryCategory } from '@shared/contracts'
import { useConversationStore } from '../stores/conversation.store'
import { useHistoryViewerStore } from '../stores/historyViewer.store'
import { buildPrefix, captureAnchor, computeWindow, restoreScrollTop, OVERSCAN_PX } from '../utils/virtual-window'
import CyHistoryResultItem from './CyHistoryResultItem.vue'
import { errorMessage } from '../utils/error-message'

const store = useHistoryViewerStore()
const conversationStore = useConversationStore()

// 多套 UI 基础：错误文案统一走映射器（store 只产 code）
const errorText = computed(() => errorMessage(store.error, '搜索失败，请稍后重试。'))

const resultsEl = ref<HTMLElement>()
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

// —— 阶段 7 批次 C Task 2：扁平虚拟行（groupedItems → rows，配合 computeWindow 只渲染可视窗口） ——
type HistoryRow =
  | { kind: 'header'; key: string; date: string; label: string }
  | { kind: 'item'; key: string; hit: ChatHistoryItem }

/** 历史行估算（完整 H-2/准确 M-4 修复）：header 固定 ~34px；item 单行 snippet ~72px + 6px padding-bottom（F-1 修复），sticker 缩略图 +64px。
 *  padding-bottom 计入 ResizeObserver border-box 高度，使 estimate 与实测一致（prefix math 不脱钩）。
 *  estimate 只作未实测行的近似，实测行高经 ResizeObserver 覆盖（估高误差由 pendingCompensation 补偿）。 */
function estimateItemHeight(hit: ChatHistoryItem): number {
  const BASE_ITEM = 78   // 72 内容 + 6 padding-bottom（F-1：grid gap:6px 改为 padding，恢复同组 item 间距）
  if (hit.resource?.kind === 'sticker') return BASE_ITEM + 64
  return BASE_ITEM
}

const rowKeyFor = (r: HistoryRow): string => r.key
const rowIsAnchorable = (r: HistoryRow): boolean => r.kind === 'item'
const rowEstimate = (r: HistoryRow): number => (r.kind === 'header' ? 34 : estimateItemHeight(r.hit))

const rows = computed<HistoryRow[]>(() => {
  const out: HistoryRow[] = []
  for (const g of groupedItems.value) {
    out.push({ kind: 'header', key: `header:${g.date}`, date: g.date, label: g.label })
    for (const hit of g.items) out.push({ kind: 'item', key: hit.hitId, hit })
  }
  return out
})

const heights = ref<Record<string, number>>({})          // 实测行高（ResizeObserver，border-box）
const prefix = computed(() => buildPrefix(rows.value, heights.value, { estimate: rowEstimate, keyFor: rowKeyFor }))
const scrollTop = ref(0)
const viewportHeight = ref(600)

const win = computed(() => {
  const w = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
  return { ...w, visibleRows: rows.value.slice(w.startIndex, w.endIndex + 1) }
})

// —— 锚点 data 层补偿（Task 1 泛型 captureAnchor/restoreScrollTop 组合）——
const rowAnchorOpts = { isAnchorable: rowIsAnchorable, keyFor: rowKeyFor }
let lastAnchorRowKey = ''  // 持续锚点（scroll 时更新；onRowResized 用它定位需补偿的锚点上方行）
let pendingCompensation = 0

function onScroll(): void {
  const el = resultsEl.value
  if (!el) return
  scrollTop.value = el.scrollTop
  captureCurrent()
}

/** 持续捕获锚点（首个 item 行 + 视口内偏移——data 层，不依赖全 DOM） */
function captureCurrent(): void {
  if (rows.value.length === 0) { lastAnchorRowKey = ''; return }
  const a = captureAnchor(rows.value, prefix.value, scrollTop.value, viewportHeight.value, rowAnchorOpts)
  if (a.messageId) lastAnchorRowKey = a.messageId
}

/** 行实测：写 heights 并补偿锚点上方变化（复用消息列表 onRowResized 模式——估→实测把锚点推走则补差）。
 *  border-box 高度含 padding/border，与 prefix 数学一致；contentRect 只含 content-box，会少算行内边距。 */
function onRowResized(key: string, entry: ResizeObserverEntry): void {
  const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
  const prev = heights.value[key]
  if (prev === h) return
  heights.value[key] = h
  if (!lastAnchorRowKey) return
  const anchorIdx = rows.value.findIndex((r) => rowKeyFor(r) === lastAnchorRowKey)
  const idx = rows.value.findIndex((r) => rowKeyFor(r) === key)
  if (anchorIdx > 0 && idx >= 0 && idx < anchorIdx) {
    // 首测行（prev undefined，此前用估高渲染）按「实测-估高」补差；已测行按实测增量（同消息列表 D5 语义）
    const delta = prev !== undefined ? h - prev : h - rowEstimate(rows.value[idx])
    pendingCompensation += delta
    if (resultsEl.value && pendingCompensation !== 0) {
      resultsEl.value.scrollTop += pendingCompensation
      scrollTop.value = resultsEl.value.scrollTop
      pendingCompensation = 0
    }
  }
}

// —— 行引用注册（ResizeObserver 观察）——
const rowEls = new Map<string, HTMLElement>()
const resizeObs = ref<ResizeObserver>()
function setRowEl(key: string, el: Element | null): void {
  if (el) { rowEls.set(key, el as HTMLElement); resizeObs.value?.observe(el) }
  else { const prev = rowEls.get(key); if (prev) { resizeObs.value?.unobserve(prev); rowEls.delete(key) } }
}

onMounted(() => {
  resizeObs.value = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const key = (entry.target as HTMLElement).dataset?.rowKey ?? ''
      if (key) onRowResized(key, entry)
    }
  })
  const el = resultsEl.value
  if (el) viewportHeight.value = el.clientHeight
})
onBeforeUnmount(() => { resizeObs.value?.disconnect(); triggerElement = null })

// resultsEl 懒挂载（v-if store.open 才渲染 ul）——ref 赋上时同步 viewportHeight（onMounted 时为空）
watch(() => resultsEl.value, (el) => { if (el) viewportHeight.value = el.clientHeight })

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

/** FE-S3-RUN2-P1-01 + 虚拟化：加载第二页前捕获首个可见 item 行（data 层 captureAnchor）→ loadMore 后
 *  用 restoreScrollTop 按 prefix[idx]+offset 恢复 scrollTop（前缀和含前插/prepend 高度；估高误差由 onRowResized 补偿）。
 *  M-8/M-9：视口顶落在 header 行内时 offset 可为负（M-8）且符号与旧 DOM 测得相反（M-9）——但前缀和与恢复公式自洽，
 *  非 bug；锚点取 computeWindow 上探的 startIndex 附近首个 item 行（M-9 上探 400px，影响极小）。 */
async function onLoadMorePreservingAnchor(): Promise<void> {
  let anchor: ReturnType<typeof captureAnchor> | undefined
  if (rows.value.length && resultsEl.value) {
    anchor = captureAnchor(rows.value, prefix.value, scrollTop.value, viewportHeight.value, rowAnchorOpts)
  }
  await store.loadMore()
  if (anchor?.messageId && resultsEl.value) {
    await nextTick()
    const target = restoreScrollTop(rows.value, prefix.value, anchor, rowKeyFor)
    resultsEl.value.scrollTop = target
    scrollTop.value = target
    lastAnchorRowKey = anchor.messageId
    captureCurrent()
  }
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

// UII-QQ 设置页批次：弹窗标题/aria 按 category 区分两入口（聊天历史 vs 图片/视频）
const viewerTitle = computed(() => (store.category === 'image_video' ? '图片/视频' : '聊天历史'))

const announceText = computed(() => {
  // UII-QQ 设置页批次：区分「聊天记录」与「图片/视频」两种视图的空态/播报文案
  const noun = store.category === 'image_video' ? '相关图片/视频资源' : '相关聊天记录'
  if (store.loading) return '正在搜索聊天记录'
  if (store.error) return `搜索失败:${errorText.value}`
  if (store.hasSearched && store.items.length === 0) return `没有找到${noun}`
  if (store.hasSearched) return `找到 ${store.items.length} 条${noun}`
  return ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="store.open" ref="overlay" class="cy-history-overlay" role="dialog" aria-modal="true" :aria-label="viewerTitle" @keydown="onKeydown">
      <div class="cy-history">
        <header class="cy-history-header">
          <div class="cy-history-title">
            <strong>{{ viewerTitle }}</strong>
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
          <span>搜索失败:{{ errorText }}</span>
          <button class="cy-retry-btn" @click="store.submitQuery()">重试</button>
        </div>

        <div v-if="store.loading" class="cy-history-state">正在搜索…</div>
        <div v-else-if="store.hasSearched && store.items.length === 0" class="cy-history-state">{{ store.category === 'image_video' ? '没有找到相关图片/视频资源' : '没有找到相关聊天记录' }}</div>
        <ul v-else ref="resultsEl" class="cy-history-results" @scroll.passive="onScroll">
          <div :style="{ height: win.paddingTop + 'px' }" class="cy-vlist-pad" />
          <template v-for="row in win.visibleRows" :key="row.key">
            <!-- 准确 M-5：每行挂 :ref + data-row-key 供 ResizeObserver 观察（否则 heights 恒空、实测高度永不收敛） -->
            <li v-if="row.kind === 'header'" :ref="(el) => setRowEl(row.key, el as Element | null)" :data-row-key="row.key" class="cy-history-day">{{ row.label }}</li>
            <div v-else :ref="(el) => setRowEl(row.key, el as Element | null)" :data-row-key="row.key" class="cy-vlist-row">
              <CyHistoryResultItem :hit="row.hit" @jump="onJump" />
            </div>
          </template>
          <div :style="{ height: win.paddingBottom + 'px' }" class="cy-vlist-pad" />
        </ul>

        <footer class="cy-history-footer">
          <button v-if="store.hasMore && !store.loadingMore" class="cy-more-btn" @click="onLoadMorePreservingAnchor()">加载更多</button>
          <span v-if="store.loadingMore" class="cy-muted">加载中…</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cy-history-overlay {
  position: fixed;
  inset: 0 0 0 60px;   /* UII-QQ：应用内标题栏移除；保留导航栏(60px,NAV_WIDTH)——历史查看器不全宽盖导航 */
  z-index: 50;
  display: flex;           /* grid → flex：max-height 百分比恢复确定性（spec §4.1 方案 A） */
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--cy-window) 70%, transparent);
  backdrop-filter: blur(2px);
}
.cy-history {
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100% - 48px));
  max-height: calc(100% - 48px);
  min-height: 0;           /* 允许收缩：面板不再被内容撑破 max-height（spec §4.1） */
  padding: var(--cy-space-7);
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);
}
.cy-history-header { display: flex; align-items: center; justify-content: space-between; gap: var(--cy-space-6); margin-bottom: var(--cy-space-5); }
.cy-history-title { display: flex; align-items: baseline; gap: var(--cy-space-4); }
.cy-close-btn { padding: var(--cy-space-2) var(--cy-space-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-surface); color: var(--cy-muted); }
.cy-history-filters { display: flex; flex-wrap: wrap; gap: var(--cy-space-4); }
.cy-filter-select, .cy-filter-input, .cy-filter-date { padding: var(--cy-space-3-5) var(--cy-space-4-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-5); background: var(--cy-surface); color: var(--cy-text); font-size: var(--cy-font-lg); }
.cy-filter-input { flex: 1; min-width: 160px; }
.cy-search-btn { padding: var(--cy-space-3-5) var(--cy-space-7); border: 0; border-radius: var(--cy-radius-5); background: var(--cy-accent); color: var(--cy-accent-text); }
.cy-search-btn:disabled { opacity: 0.5; }
.cy-history-tabs { display: flex; flex-wrap: wrap; gap: var(--cy-space-3); margin: var(--cy-space-5) 0; }
.cy-cat-tab { padding: var(--cy-space-2-5) var(--cy-space-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-pill); background: var(--cy-surface); color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-cat-tab.active { background: var(--cy-accent); color: var(--cy-accent-text); border-color: var(--cy-accent); }
.cy-live { min-height: 18px; color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-history-error { display: flex; align-items: center; gap: var(--cy-space-4); padding: var(--cy-space-4) var(--cy-space-5-5); margin-bottom: var(--cy-space-4); color: var(--cy-danger); background: var(--cy-surface-soft); border: 1px dashed var(--cy-danger); border-radius: var(--cy-radius-5); font-size: var(--cy-font-md); }
.cy-retry-btn { margin-left: auto; padding: var(--cy-space-1-5) var(--cy-space-4-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-3-5); background: var(--cy-surface); }
.cy-history-state { padding: 28px 0; color: var(--cy-muted); text-align: center; font-size: var(--cy-font-lg); }
/* 虚拟化：grid → flex column，去 gap（gap 不入实测行高）/ header margin → padding（margin 不入 ResizeObserver border-box 高度），
   否则 prefix 前缀和与真实布局不符、锚点恢复失效（<=1px 断言失败）。 */
.cy-history-results { flex: 1 1 0; display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; overflow-y: auto; overflow-anchor: none; min-height: 120px; scrollbar-gutter: stable; }   /* D4-UI（2026-09-15，整改清单 §3）：滚动条出现/消失不改变内容宽度 */
.cy-history-day { display: block; padding: var(--cy-space-2) 0 var(--cy-space-1-5); margin: 0; color: var(--cy-muted); font-size: var(--cy-font-md); font-weight: 500; }
.cy-vlist-row { display: block; padding: 0 0 var(--cy-space-3); }   /* F-1：grid gap:6px 改为 padding-bottom（计入 ResizeObserver border-box，恢复同组 item 间距） */
.cy-vlist-pad { flex-shrink: 0; }
.cy-history-footer { margin-top: var(--cy-space-5); text-align: center; }
.cy-history-header, .cy-history-filters, .cy-history-tabs, .cy-live, .cy-history-error, .cy-history-state, .cy-history-footer { flex-shrink: 0; }
.cy-more-btn { padding: var(--cy-space-3) var(--cy-space-8); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-pill); background: var(--cy-surface); color: var(--cy-muted); font-size: var(--cy-font-md); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
