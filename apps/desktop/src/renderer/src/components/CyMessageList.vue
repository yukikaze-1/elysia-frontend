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
  // G4 P1-2：跨会话跳转后（loadContextWindow 置 nextCursor）走 loadEarlier 续接更早历史；常规激活走 loadOlder。
  if (el.scrollTop <= 40 && !messageStore.loadingOlder && !messageStore.loadingEarlier) {
    if (messageStore.nextCursor) {
      pendingLoadAnchor.value = captureAnchor(items.value, prefix.value, el.scrollTop, el.clientHeight)
      void messageStore.loadEarlier().then(() => restoreLoadAnchor())
    } else if (messageStore.hasMoreBefore) {
      pendingLoadAnchor.value = captureAnchor(items.value, prefix.value, el.scrollTop, el.clientHeight)
      void messageStore.loadOlder().then(() => restoreLoadAnchor())
    }
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

/** G4 D6：来源跳转高亮——滚动居中 + 6s 清除 + aria-live 播报（非纯颜色，配「已定位」chip）。
 *  P1-1：跨会话跳转后目标行可能不在虚拟列表渲染窗口（querySelector 为 null，restoreScrollFor 滚底部把目标推出窗口）——
 *  先按 order 前缀和估算滚动容器定位，下一帧窗口重算后再精确 scrollIntoView 居中；items.length 变化时重试。 */
let highlightTimer: ReturnType<typeof setTimeout> | undefined

/** 定位高亮行：行已渲染 → scrollIntoView 居中；未渲染 → 按前缀和估算 scrollTop 使目标进入视口（返回是否可继续重试） */
function scrollToHighlight(id: string): boolean {
  const el = container.value
  if (!el) return false
  const row = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
  if (row) {
    row.scrollIntoView({ block: 'center' })
    return true
  }
  const idx = items.value.findIndex((m) => m.messageId === id)
  if (idx < 0) return false
  const targetTop = prefix.value[idx] ?? 0
  el.scrollTop = Math.max(0, targetTop - el.clientHeight / 2) // 估高近似居中（实测高误差由后续 scrollIntoView 精确修正）
  scrollTop.value = el.scrollTop
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
  return true
}

watch(() => messageStore.highlightMessageId, async (id) => {
  if (highlightTimer) clearTimeout(highlightTimer)
  if (!id) return
  await nextTick()
  scrollToHighlight(id)
  // P1-1：估算滚动后窗口已重算，目标行应已渲染 → 再精确居中一次（若仍未渲染则按新窗口再估算一次）
  requestAnimationFrame(() => {
    if (messageStore.highlightMessageId !== id) return
    scrollToHighlight(id)
  })
  highlightTimer = setTimeout(() => messageStore.clearHighlight(), 6000)
})

/** P1-1：高亮期间列表增长/窗口变化 → 重试定位（目标行可能在补载后进入渲染窗口；跨会话跳转首页/上下文窗口合并加载） */
watch(() => items.value.length, () => {
  const id = messageStore.highlightMessageId
  if (id) void nextTick(() => scrollToHighlight(id))
})
const hasHighlight = computed(() => !!messageStore.highlightMessageId)
onBeforeUnmount(() => { if (highlightTimer) clearTimeout(highlightTimer) })

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
        :class="{ 'cy-highlighted': messageStore.highlightMessageId === id }"
      >
        <CyMessageBubble :message="messageStore.byId[id]" />
        <span v-if="messageStore.highlightMessageId === id" class="cy-located-chip">已定位</span>
      </div>
      <div :style="{ height: win.paddingBottom + 'px' }" class="cy-vlist-pad" />
      <div v-if="isStreaming" class="cy-streaming-placeholder">
        <span class="cy-typing-dot" />
        <span>生成中…</span>
      </div>
    </template>

    <button v-if="!atBottom && !isEmpty" class="cy-back-bottom" title="回到底部" @click="backToBottom">↓ 回到底部</button>
    <!-- P2-4：aria-live 区常驻（v-if 条件挂载部分读屏器不播报）——role=status 占位容器恒在，文本随高亮更新；
         清除策略：6s 定时（spec「滚动或 6s」取定时分支；程序性定位滚动与用户滚动难可靠区分，定时满足语义） -->
    <div class="cy-sr-live" role="status" aria-live="polite">{{ hasHighlight ? '已定位到消息' : '' }}</div>
  </div>
</template>

<style scoped>
.cy-messages { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; padding: 0 16px; overflow-y: auto; background: linear-gradient(180deg, var(--cy-surface) 0%, var(--cy-pane) 100%); }
.cy-vlist-row { display: flex; flex-direction: column; gap: 9px; padding: 6px 0; }
.cy-vlist-row.cy-highlighted { outline: 2px solid var(--cy-accent-strong); border-radius: 12px; }   /* G4 D6：高亮非纯颜色——outline + chip + aria-live */
.cy-located-chip { display: inline-block; align-self: flex-start; padding: 1px 8px; border-radius: 999px; color: var(--cy-accent-text); background: var(--cy-accent); font-size: 11px; }
.cy-sr-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.cy-empty { display: grid; flex: 1; place-items: center; color: var(--cy-muted); font-size: 13px; }
.cy-back-bottom { position: sticky; bottom: 12px; align-self: center; padding: 6px 12px; border: 1px solid var(--cy-border); border-radius: 999px; background: var(--cy-surface); color: var(--cy-muted); font-size: 12px; cursor: pointer; }
.cy-streaming-placeholder { display: inline-flex; align-items: center; align-self: flex-start; gap: 8px; padding: 9px 13px; margin: 6px 0; color: var(--cy-muted); background: var(--cy-surface); border: 1px solid var(--cy-border); border-radius: 13px; font-size: 12px; }
.cy-typing-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cy-accent-strong); animation: cy-pulse 1s ease-in-out infinite; }
@keyframes cy-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
</style>
