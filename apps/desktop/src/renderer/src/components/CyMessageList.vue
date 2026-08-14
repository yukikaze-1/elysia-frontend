<script setup lang="ts">
// CyMessageList：自研轻量虚拟列表（spec §4.3.2/§4.3.4 D3/D5/D6）。
// 估高 + ResizeObserver 实测 + 前缀和二分窗口；向上加载锚点不跳动；切会话草稿+锚点 flush。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'
import { useDraftStore } from '../stores/draft.store'
import CyMessageBubble from './CyMessageBubble.vue'
import { buildPrefix, captureAnchor, computeWindow, estimateHeight, restoreScrollTop, OVERSCAN_PX } from '../utils/virtual-window'

const messageStore = useMessageStore()
const conversationStore = useConversationStore()
const draftStore = useDraftStore()

const container = ref<HTMLElement>()
const heights = ref<Record<string, number>>({})          // 实测高（ResizeObserver）
const rowEls = new Map<string, HTMLElement>()            // messageId → 行元素
const resizeObs = ref<ResizeObserver>()

/** 窗口化后的可见顺序（order 恒 (createdAt, messageId) 升序，P0-1 不变量） */
const items = computed(() => messageStore.order.map((id) => messageStore.byId[id]).filter(Boolean))
const prefix = computed(() => buildPrefix(items.value, heights.value))
const scrollTop = ref(0)
const viewportHeight = ref(600)
const atBottom = ref(true)
const pendingCompensation = ref(0)

/** 连续维护的锚点（scroll/窗口变化时更新；切会话时「先捕获后 flush」用它） */
const lastAnchor = ref<{ conversationId: string; anchor: ReturnType<typeof captureAnchor> }>()
/** 评审 P1-2：loadOlder 前捕获的锚点（前插后 restoreScrollTop 恢复可视位置，向上翻不跳动） */
const pendingLoadAnchor = ref<ReturnType<typeof captureAnchor>>()

const isStreaming = computed(() => !!messageStore.activeGenerationId)
const isEmpty = computed(() => items.value.length === 0)

const win = computed(() => {
  const w = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
  return {
    startIndex: w.startIndex,
    endIndex: w.endIndex,
    paddingTop: w.paddingTop,
    paddingBottom: w.paddingBottom,
    visibleIds: items.value.slice(w.startIndex, w.endIndex + 1).map((m) => m.messageId)
  }
})

/** D6 恢复守卫：每会话激活只恢复一次（由 pendingRestoreId + items.length watch 承担） */

function onScroll(): void {
  const el = container.value
  if (!el) return
  scrollTop.value = el.scrollTop
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
  captureCurrent()
  // 顶部哨兵：更早历史 + 非加载中 → loadOlder（D5）。
  // 评审 P1-2：前插前 captureAnchor、前插完成后 restoreScrollTop——否则新页整块前插会把锚点/可视消息往下推
  //（scrollTop 数值不变但内容上移，用户视角跳动）。
  if (el.scrollTop <= 40 && messageStore.hasMoreBefore && !messageStore.loadingOlder) {
    pendingLoadAnchor.value = captureAnchor(items.value, prefix.value, el.scrollTop, el.clientHeight)
    void messageStore.loadOlder().then(() => restoreLoadAnchor())
  }
}

/** 评审 P1-2：loadOlder 有序插入后恢复锚点可视位置（restoreScrollTop 让前缀和含前插高度；估高误差由 onRowResized 补偿） */
function restoreLoadAnchor(): void {
  const el = container.value
  const anchor = pendingLoadAnchor.value
  if (!el || !anchor?.messageId) return
  pendingLoadAnchor.value = undefined
  void nextTick(() => {
    const target = restoreScrollTop(items.value, prefix.value, anchor)
    if (target > 0 && container.value) {
      container.value.scrollTop = target
      scrollTop.value = container.value.scrollTop
      atBottom.value = container.value.scrollTop + container.value.clientHeight >= container.value.scrollHeight - 40
    }
  })
}

/** 持续捕获锚点（切会话时用它做「先捕获再 flush」） */
function captureCurrent(): void {
  const el = container.value
  if (!el || items.value.length === 0) return
  const a = captureAnchor(items.value, prefix.value, el.scrollTop, el.clientHeight)
  if (a.messageId) lastAnchor.value = { conversationId: conversationStore.currentId ?? '', anchor: a }
}

/** 行实测：写 heights 并补偿锚点上方变化（D5，防估→实测推走锚点；评审 P1-2 前插行首测按实测-估高补差） */
function onRowResized(id: string, entry: ResizeObserverEntry): void {
  const h = entry.contentRect.height
  const prev = heights.value[id]
  if (prev === h) return
  heights.value[id] = h
  const anchorId = lastAnchor.value?.anchor.messageId ?? pendingLoadAnchor.value?.messageId
  if (anchorId === id) return
  const anchorIdx = anchorId ? items.value.findIndex((m) => m.messageId === anchorId) : -1
  const idx = items.value.findIndex((m) => m.messageId === id)
  if (anchorIdx > 0 && idx >= 0 && idx < anchorIdx) {
    // P1-2：前插行首测（prev undefined，此前用估高渲染）按「实测-估高」补差，防估高误差把锚点推走；
    // 已测行按实测增量（既有 D5 语义）
    const delta = prev !== undefined ? h - prev : h - estimateHeight(items.value[idx])
    pendingCompensation.value += delta
    if (container.value && pendingCompensation.value !== 0) {
      container.value.scrollTop += pendingCompensation.value
      scrollTop.value = container.value.scrollTop
      pendingCompensation.value = 0
    }
  }
}

/** 切会话：先捕获（持续维护的 lastAnchor）再 flush 旧会话草稿+锚点（D6 时序定死）；
 *  恢复不在 currentId watch 里做（activate 首屏异步，nextTick 时 order 仍空），改由 items.length watch 在页面加载后触发 */
let pendingRestoreId: string | undefined
watch(() => conversationStore.currentId, (id, oldId) => {
  if (oldId && lastAnchor.value && lastAnchor.value.conversationId === oldId) {
    draftStore.setScrollAnchor(oldId, lastAnchor.value.anchor)
    void draftStore.flush(oldId)
  }
  heights.value = {}
  scrollTop.value = 0
  atBottom.value = true
  pendingRestoreId = id ?? undefined
})

/** 回会话恢复策略（D6）：锚点在已加载页→精确恢复；不在且有更早→首屏顶部；否则→底部（离线 loadSnapshot 同步载入也走此路径） */
watch(() => items.value.length, (len) => {
  if (len > 0 && pendingRestoreId === conversationStore.currentId) {
    pendingRestoreId = undefined
    void nextTick(() => restoreScrollFor(conversationStore.currentId!))
  }
})

function restoreScrollFor(id: string): void {
  const el = container.value
  if (!el) return
  const anchor = draftStore.scrollAnchors[id]
  const idx = anchor ? items.value.findIndex((m) => m.messageId === anchor.messageId) : -1
  if (anchor && idx >= 0) {
    el.scrollTop = restoreScrollTop(items.value, prefix.value, anchor)
  } else if (anchor && messageStore.hasMoreBefore) {
    el.scrollTop = 0 // 首屏顶部边界：可继续上翻，不突兀跳底
  } else {
    el.scrollTop = el.scrollHeight
  }
  scrollTop.value = el.scrollTop
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
}

function backToBottom(): void {
  const el = container.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  atBottom.value = true
}

/** 行引用注册（ResizeObserver 观察） */
function setRowEl(id: string, el: Element | null): void {
  if (el) { rowEls.set(id, el as HTMLElement); resizeObs.value?.observe(el) }
  else { const prev = rowEls.get(id); if (prev) { resizeObs.value?.unobserve(prev); rowEls.delete(id) } }
}

onBeforeUnmount(() => { resizeObs.value?.disconnect() })

onMounted(() => {
  resizeObs.value = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target.getAttribute('data-message-id')
      if (id) onRowResized(id, entry)
    }
  })
  const el = container.value
  if (el) viewportHeight.value = el.clientHeight
  if (el && !conversationStore.offlineView) el.scrollTop = el.scrollHeight
})
</script>

<template>
  <div ref="container" class="cy-messages" aria-live="polite" @scroll.passive="onScroll">
    <div v-if="isEmpty" class="cy-empty">
      <p>{{ conversationStore.offlineView ? '该会话离线不可读或为空' : '新会话,开始对话' }}</p>
    </div>
    <template v-else>
      <div :style="{ height: win.paddingTop + 'px' }" class="cy-vlist-pad" />
      <div
        v-for="id in win.visibleIds"
        :key="id"
        :data-message-id="id"
        :ref="(el) => setRowEl(id, el as Element | null)"
        class="cy-vlist-row"
      >
        <CyMessageBubble :message="messageStore.byId[id]" />
      </div>
      <div :style="{ height: win.paddingBottom + 'px' }" class="cy-vlist-pad" />
      <div v-if="isStreaming" class="cy-streaming-placeholder">
        <span class="cy-typing-dot" />
        <span>生成中…</span>
      </div>
    </template>

    <button v-if="!atBottom && !isEmpty" class="cy-back-bottom" title="回到底部" @click="backToBottom">↓ 回到底部</button>
  </div>
</template>

<style scoped>
.cy-messages { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; padding: 0 16px; overflow-y: auto; background: linear-gradient(180deg, var(--cy-surface) 0%, var(--cy-pane) 100%); }
.cy-vlist-row { display: flex; flex-direction: column; gap: 9px; padding: 6px 0; }
.cy-empty { display: grid; flex: 1; place-items: center; color: var(--cy-muted); font-size: 13px; }
.cy-back-bottom { position: sticky; bottom: 12px; align-self: center; padding: 6px 12px; border: 1px solid var(--cy-border); border-radius: 999px; background: var(--cy-surface); color: var(--cy-muted); font-size: 12px; cursor: pointer; }
.cy-streaming-placeholder { display: inline-flex; align-items: center; align-self: flex-start; gap: 8px; padding: 9px 13px; margin: 6px 0; color: var(--cy-muted); background: var(--cy-surface); border: 1px solid var(--cy-border); border-radius: 13px; font-size: 12px; }
.cy-typing-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cy-accent-strong); animation: cy-pulse 1s ease-in-out infinite; }
@keyframes cy-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
</style>
