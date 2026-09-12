<script setup lang="ts">
// CyMessageList：自研轻量虚拟列表（spec §4.3.2/§4.3.4 D3/D5/D6）。
// 估高 + ResizeObserver 实测 + 前缀和二分窗口；向上加载锚点不跳动；切会话草稿+锚点 flush。
// UII-QQ 时间戳批次：全量 items 预计算「本地日首条非 tool 消息」（dayFirst）→ 对应行内渲染居中日期分隔；
// 估高经 estimateMessageRowHeight 补分隔额度（实测由 ResizeObserver border-box 天然含分隔）；
// 相对标签（今天/昨天）经 now ref + 跨本地午夜定时刷新（卸载清理）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'
import { useDraftStore } from '../stores/draft.store'
import { useIdentityStore } from '../stores/identity.store'
import { useCharacterCatalogStore } from '../stores/character-catalog.store'
import type { Message } from '@shared/contracts'
import CyMessageBubble from './CyMessageBubble.vue'
import { buildPrefix, captureAnchor, computeWindow, restoreScrollTop, OVERSCAN_PX } from '../utils/virtual-window'
import { dayFirstDayKeys, daySeparatorLabel, estimateMessageRowHeight } from '../utils/message-time'

const messageStore = useMessageStore()
const conversationStore = useConversationStore()
const draftStore = useDraftStore()
const identityStore = useIdentityStore()
const characterCatalogStore = useCharacterCatalogStore()

const userDisplayName = computed(() => identityStore.profile?.displayName?.trim() || '我')

/**
 * The bubble may use a revision cache only when the message itself carries
 * the exact character id + content revision.  It must never receive the
 * current catalog summary as a historical-message fallback.
 */
function revisionIdentityFor(message: Message) {
  const ref = message.character
  return ref
    ? characterCatalogStore.revisionIdentity(ref.characterId, ref.characterRevision)
    : undefined
}

const container = ref<HTMLElement>()
const heights = ref<Record<string, number>>({})          // 实测高（ResizeObserver，滚动提交后合并）
const rowEls = new Map<string, HTMLElement>()            // messageId → 行元素
const resizeObs = ref<ResizeObserver>()
let viewportObs: ResizeObserver | undefined               // UII-QQ：viewport 高度跟随（只喂窗口切分）

/** UI 问题 1：滚动中实测高先写 pendingHeights，滚动停（scrollend/150ms 空闲）才合并进 heights——
 *  避免滚动中每次估高→实测修正都改 paddingTop/Bottom → scrollHeight → thumb 跳。
 *  prefix 只用已提交 heights（未提交 pending 不参与窗口二分）→ 滚动中布局稳定；停稳后一次合并修正。 */
const pendingHeights = ref<Record<string, number>>({})
const isScrolling = ref(false)
let scrollSettleTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_SETTLE_MS = 150

/** 窗口化后的可见顺序（order 恒 (createdAt, messageId) 升序，P0-1 不变量） */
const items = computed(() => messageStore.order.map((id) => messageStore.byId[id]).filter(Boolean))

/** UII-QQ 时间戳批次：全量 items 预计算「本地日首条非 tool 消息」——全局 index → 本地日键 + 对应消息 id 集。
 *  判定恒基于全量 items（与虚拟窗口 startIndex 无关）；tool 空占位跳过；首条非 tool 恒有分隔 */
const dayFirst = computed(() => {
  const byIndex = dayFirstDayKeys(items.value)
  const ids = new Set<string>()
  for (const idx of byIndex.keys()) {
    const m = items.value[idx]
    if (m) ids.add(m.messageId)
  }
  return { byIndex, ids }
})

function isDayFirstRow(globalIdx: number): boolean {
  return dayFirst.value.byIndex.has(globalIdx)
}

/** 分隔标签（今天/昨天/M月D日/YYYY年M月D日）：键来自 dayFirst（消息自身日），相对判断用 now */
function daySeparatorText(globalIdx: number): string {
  const key = dayFirst.value.byIndex.get(globalIdx)
  return key ? daySeparatorLabel(key, { now: now.value }) : ''
}

/** 相对日期标签基准：跨本地午夜后刷新（setTimeout 至下一午夜 +5s，触发后重排；卸载清理）。
 *  分隔键（dayFirst）与 now 无关，仅标签文案随 now 更新 */
const now = ref(new Date())
let midnightTimer: ReturnType<typeof setTimeout> | undefined
function scheduleMidnightRefresh(): void {
  if (midnightTimer) clearTimeout(midnightTimer)
  const n = now.value
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 5)
  midnightTimer = setTimeout(() => {
    now.value = new Date()
    scheduleMidnightRefresh()
  }, Math.max(1000, next.getTime() - n.getTime()))
}

const prefix = computed(() => {
  // UII-QQ 时间戳批次：估高注入日首补额（未实测行含日期分隔高度，防跨多天长会话前缀和持续低估）；
  // 实测路径天然覆盖——分隔渲染在 .cy-vlist-row 内，ResizeObserver border-box 实测含分隔高度
  const ids = dayFirst.value.ids
  return buildPrefix(items.value, heights.value, {
    keyFor: (m) => m.messageId,
    estimate: (m) => estimateMessageRowHeight(m, ids.has(m.messageId)),
  })
})
const scrollTop = ref(0)
const viewportHeight = ref(600)
const atBottom = ref(true)

/**
 * 跟随意图（H-02 续修，2026-09-11；CI 复盘后重做并**去掉了一版错误的加固**）。
 *
 * 承重的是**意图与瞬时位置分离**：原实现用 `atBottom`（瞬时位置）决定是否跟随，而流式期间它会
 * 瞬时为 false（探针实测多处 `atb=false`：增长后 scrollHeight 变大、scrollTop 未变、重锚尚未跑完），
 * `followBottomIfSticky` 据此早退——而一旦早退，缺口更大、atBottom 更不可能为真，**再无恢复路径**：
 * 此后 scrollTop 冻结、不再产生 scroll 事件 → 不再有 settle → 不再合并/重锚，缺口永久累积。
 * 探针实测：scrollTop 冻在 6146 而 scrollHeight 从 7176 涨到 12093。
 *
 * 为什么本地一直绿、CI 才红：这个窗口极短，本地负载低时重锚总赶在它之前完成；CI 上时序一变就落进窗口。
 *
 * 意图的清除判据就是朴素的「scrollTop 变小」＝用户上翻。**刻意不加几何条件**：我曾加过一条
 * 「且最大可滚动量未增长才算用户上翻」的判别（想防"浏览器夹小 scrollTop 被误判"），**被既有
 * `perf-gate` ②b 当场抓住**——流式期间用户上翻时 maxScroll 恰在增长，该条件使意图**永远清不掉**，
 * 于是每次内容增长都把用户从正在阅读的位置**拽回底部**（断言 `top >= clientH` 红于 245 < 534）。
 * 那个"夹小"担忧在两处实测里都没有出现：为一个未证实的假设牺牲真实可用性是错的。
 */
const stickToBottom = ref(true)
const BOTTOM_EPS = 40

function computeAtBottom(el: HTMLElement): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_EPS
}

async function followBottomIfSticky(): Promise<void> {
  if (!stickToBottom.value) return
  await nextTick()
  const el = container.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  scrollTop.value = el.scrollTop
  atBottom.value = computeAtBottom(el)
}

/** 连续维护的锚点（scroll/窗口变化时更新；切会话时「先捕获后 flush」用它） */
const lastAnchor = ref<{ conversationId: string; anchor: ReturnType<typeof captureAnchor> }>()
/** 评审 P1-2：loadOlder 前捕获的锚点（前插后 restoreScrollTop 恢复可视位置，向上翻不跳动） */
const pendingLoadAnchor = ref<ReturnType<typeof captureAnchor>>()

const isStreaming = computed(() => !!messageStore.activeGenerationId)
const isEmpty = computed(() => items.value.length === 0)

/** UII-QQ 轮次分组（纯展示）：与前一条「非 tool」消息角色不同的行为「轮首」。
 *  tool 行是空占位（assistant→tool→assistant 是同一工具调用轮次），跳过不计轮；
 *  预计算 Set（每 items 变化一次），模板按全局 index 查询——不加 class 不改虚拟列表数学
 *  （padding 在 border-box 内，ResizeObserver 可测；estimate 误差由既有实测修正路径吸收） */
const turnStartSet = computed(() => {
  const s = new Set<number>()
  let prevRole: string | undefined
  for (let i = 0; i < items.value.length; i++) {
    const role = items.value[i]?.role
    if (role === 'tool') continue
    if (prevRole !== undefined && role !== prevRole) s.add(i)
    prevRole = role
  }
  return s
})

const win = computed(() => {
  const w = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
  return {
    startIndex: w.startIndex,
    endIndex: w.endIndex,
    paddingTop: w.paddingTop,
    paddingBottom: w.paddingBottom,
    visibleIds: items.value.slice(w.startIndex, w.endIndex + 1).map((m) => m.messageId),
  }
})

/** D6 恢复守卫：每会话激活只恢复一次（由 pendingRestoreId + items.length watch 承担） */

function onScroll(): void {
  const el = container.value
  if (!el) return
  const prevTop = scrollTop.value
  scrollTop.value = el.scrollTop
  const atBottomNow = computeAtBottom(el)
  atBottom.value = atBottomNow
  // H-02（意图/位置分离）：滚到（近）底部 → 恢复跟随意图；scrollTop 变小（用户上翻，含拖滚动条）→ 放弃跟随。
  // 内容增长只改 scrollHeight、不改 scrollTop，故不会误清意图——这正是"瞬时位置吞掉意图"的根因。
  if (atBottomNow) stickToBottom.value = true
  else if (el.scrollTop < prevTop) stickToBottom.value = false
  // UI 问题 1：滚动期间进入「滚动中」态，实测高写 pendingHeights（不立即合并）
  // → 滚动中 padding/scrollHeight 稳定，thumb 不跳；滚动停 150ms 后合并一次修正。
  isScrolling.value = true
  if (scrollSettleTimer) clearTimeout(scrollSettleTimer)
  scrollSettleTimer = setTimeout(commitScrollHeights, SCROLL_SETTLE_MS)
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

/** UI 问题 1 修复（②）：滚动停止——先捕获顶部锚点 → 合并 pendingHeights 进 heights → DOM 更新后
 *  精确恢复锚点scroll位置（无累计 delta 补偿）。滚动中不 jump，停稳后一次对齐，且不放大。 */
function commitScrollHeights(): void {
  if (scrollSettleTimer) { clearTimeout(scrollSettleTimer); scrollSettleTimer = undefined }
  isScrolling.value = false
  const hasPending = Object.keys(pendingHeights.value).length > 0
  if (!hasPending) return
  const el = container.value
  if (!el) { pendingHeights.value = {}; return }
  // H-02：合并前记录「用户是否要继续跟随底部」。估高→实测高修正会改变 scrollHeight，
  // 若本就在底部，修正后必须重新贴底；否则会停在离底部数百像素处（实测 551px）。
  // 用**意图**而非瞬时位置：修正本身就会让瞬时位置短暂地不贴底。
  const wasAtBottom = stickToBottom.value
  // ② 捕获当前可视顶部锚点（用旧 prefix——合并前的布局）；offset = scrollTop - prefix[锚点]
  const anchor = captureAnchor(items.value, prefix.value, el.scrollTop, el.clientHeight)
  // 合并 pending 高进 heights → prefix 重算
  heights.value = { ...heights.value, ...pendingHeights.value }
  pendingHeights.value = {}
  // ③ 恢复锚点：DOM 更新后按新 prefix 定位 anchor，使可视位置不变（无累计 delta，不放大）
  void nextTick(() => {
    if (!container.value) return
    if (wasAtBottom) {
      // 贴底态：高度修正不应把用户从底部推开（上翻态才走锚点恢复）
      container.value.scrollTop = container.value.scrollHeight
    } else {
      const target = restoreScrollTop(items.value, prefix.value, anchor)
      container.value.scrollTop = target
    }
    scrollTop.value = container.value.scrollTop
    atBottom.value = container.value.scrollTop + container.value.clientHeight >= container.value.scrollHeight - 40
  })
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
      atBottom.value = computeAtBottom(container.value)
      // loadOlder 锚点恢复同样是**有意的**非贴底定位（用户正在向上翻），放弃跟随
      stickToBottom.value = false
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

/** 行实测：记录实测高（锚点行也记——③）。滚动中写 pendingHeights，滚动停 commit 时锚点恢复。
 *  比较基线用 pendingHeights[id] ?? heights[id]（③：pending 最新值作下次基线，避免重复测量按旧高度累计放大）。
 *  不再做累计 delta 补偿（② 改用锚点捕获→恢复）。非滚动态（流式/初始加载）直接写 heights。 */
function onRowResized(id: string, entry: ResizeObserverEntry): void {
  // 7D 真机修复：用 border-box 实际高度（同 CyHistoryViewer）。contentRect 不含 .cy-vlist-row 的
  // 上下 padding（6+6=12px/行），长列表前缀和会逐行欠估。
  const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
  const prev = pendingHeights.value[id] ?? heights.value[id]
  if (prev === h) return
  // ③：始终记录锚点行实测高（不再 if (anchorId===id) return 跳过）——锚点行高也写入，供 prefix/恢复用
  if (isScrolling.value) {
    pendingHeights.value[id] = h
    return
  }
  heights.value[id] = h
  // H-02：行高增长（流式文本变长 / markdown 突发）也是内容增长——贴底时同步跟随
  void followBottomIfSticky()
}

/** 切会话：先捕获（持续维护的 lastAnchor）再 flush 旧会话草稿+锚点（D6 时序定死）；
 *  恢复不在 currentId watch 里做（activate 首屏异步，nextTick 时 order 仍空），改由 items.length watch 在页面加载后触发 */
let pendingRestoreId: string | undefined
watch(() => conversationStore.currentId, (id, oldId) => {
  if (oldId && lastAnchor.value && lastAnchor.value.conversationId === oldId) {
    draftStore.setScrollAnchor(oldId, lastAnchor.value.anchor)
    void draftStore.flush(oldId)
  }
  // UI 问题 1：切会话清滚动批次态（pendingHeights + settle 定时器 + 滚动标志）
  if (scrollSettleTimer) { clearTimeout(scrollSettleTimer); scrollSettleTimer = undefined }
  isScrolling.value = false
  pendingHeights.value = {}
  heights.value = {}
  scrollTop.value = 0
  atBottom.value = true
  // 新会话默认「跟随底部」；若随后 restoreScrollFor 恢复到锚点位置，那里会按实际位置显式改写意图
  stickToBottom.value = true
  pendingRestoreId = id ?? undefined
})

/** 回会话恢复策略（D6）：锚点在已加载页→精确恢复；不在且有更早→首屏顶部；否则→底部（离线 loadSnapshot 同步载入也走此路径） */
watch(() => items.value.length, (len) => {
  if (len > 0 && pendingRestoreId === conversationStore.currentId) {
    pendingRestoreId = undefined
    void nextTick(() => restoreScrollFor(conversationStore.currentId!))
    return
  }
  // H-02：追加新行（发送自己的消息 / 流式新分段）时贴底跟随。切会话恢复路径已 return，互不干扰。
  void followBottomIfSticky()
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
  atBottom.value = computeAtBottom(el)
  // 恢复锚点是**有意的**非贴底定位：显式放弃跟随意图（否则随后一次内容增长会把用户拽回底部）
  stickToBottom.value = atBottom.value
}

function backToBottom(): void {
  const el = container.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  atBottom.value = true
  stickToBottom.value = true   // 用户主动回到底部＝重新表达跟随意图
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
  atBottom.value = computeAtBottom(el)
  // 来源跳转是**有意的**非贴底定位：放弃跟随，避免随后增长把用户从定位处拽走
  stickToBottom.value = false
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

onBeforeUnmount(() => {
  if (scrollSettleTimer) { clearTimeout(scrollSettleTimer); scrollSettleTimer = undefined }
  if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = undefined }
  resizeObs.value?.disconnect()
  viewportObs?.disconnect()
})

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
  // UII-QQ：viewport 高度跟随（Composer 自适应增高/窗口变化）——只影响窗口切分（padding 总量恒定，scrollHeight 不变），
  // 不触碰行高提交/锚点恢复机制。Composer 多行增高时窗口仍准确，避免底部空行。
  viewportObs = new ResizeObserver(() => {
    const c = container.value
    if (!c) return
    const wasAtBottom = stickToBottom.value   // H-02：窗口变矮的贴底判定同样看**意图**而非瞬时位置
    const prevH = viewportHeight.value
    viewportHeight.value = c.clientHeight
    // P1 修复：仅「增高前位于底部」且视口变矮（Composer 增高/窗口变小）时继续贴底——
    // 否则最新消息会被挤出视口；用户已上翻则保持原 scrollTop（锚点不动）。
    // 视口变高（发送清稿 Composer 收缩）时浏览器自动钳制 scrollTop 到新最大值，天然贴底，无需处理。
    if (wasAtBottom && c.clientHeight < prevH) {
      c.scrollTop = c.scrollHeight
      scrollTop.value = c.scrollTop
      atBottom.value = true
    }
  })
  if (el) viewportObs.observe(el)
  scheduleMidnightRefresh()
})
</script>

<template>
  <div ref="container" class="cy-messages" aria-live="polite" @scroll.passive="onScroll">
    <div v-if="isEmpty" class="cy-empty" role="status">
      <strong>{{ conversationStore.offlineView ? '这个会话暂时无法读取' : '想聊点什么？' }}</strong>
      <span>{{ conversationStore.offlineView ? '连接恢复后可以重新读取会话内容。' : '从一句话开始，角色会在这里听你说。' }}</span>
    </div>
    <template v-else>
      <div :style="{ height: win.paddingTop + 'px' }" class="cy-vlist-pad" />
      <div
        v-for="(id, i) in win.visibleIds"
        :key="id"
        :data-message-id="id"
        :ref="(el) => setRowEl(id, el as Element | null)"
        class="cy-vlist-row"
        :class="{ 'cy-highlighted': messageStore.highlightMessageId === id, 'cy-turn-start': turnStartSet.has(win.startIndex + i) && !isDayFirstRow(win.startIndex + i), 'cy-first-row': win.startIndex + i === 0 }"
      >
        <!-- UII-QQ 时间戳批次：本地日首条非 tool 消息行内渲染居中日期分隔（判定基于全量 items，见 dayFirst）；
             该行禁用 cy-turn-start 大段顶距，由分隔自身留白负责轮次间距，避免双重间距 -->
        <div v-if="isDayFirstRow(win.startIndex + i)" class="cy-day-separator">
          <span class="cy-day-separator-text">{{ daySeparatorText(win.startIndex + i) }}</span>
        </div>
        <CyMessageBubble
          :message="messageStore.byId[id]"
          :character-binding="conversationStore.currentCharacter"
          :revision-identity="revisionIdentityFor(messageStore.byId[id])"
          :user-display-name="userDisplayName"
        />
        <span v-if="messageStore.highlightMessageId === id" class="cy-located-chip">已定位</span>
      </div>
      <div :style="{ height: win.paddingBottom + 'px' }" class="cy-vlist-pad" />
      <div v-if="isStreaming" class="cy-streaming-placeholder" role="status">
        <span class="cy-typing-dot" />
        <span>{{ conversationStore.currentCharacter?.displayName ?? '角色' }}正在输入…</span>
      </div>
    </template>

    <button v-if="!atBottom && !isEmpty" class="cy-back-bottom" title="回到底部" @click="backToBottom">↓ 回到底部</button>
    <!-- P2-4：aria-live 区常驻（v-if 条件挂载部分读屏器不播报）——role=status 占位容器恒在，文本随高亮更新；
         清除策略：6s 定时（spec「滚动或 6s」取定时分支；程序性定位滚动与用户滚动难可靠区分，定时满足语义） -->
    <div class="cy-sr-live" role="status" aria-live="polite">{{ hasHighlight ? '已定位到消息' : '' }}</div>
  </div>
</template>

<style scoped>
/* UII-QQ：扁平中性底（去渐变）+ scrollbar-gutter stable（滚动条出现/消失不横跳）；
   行居中为 940px 阅读轨道——行仍是 :scope 直接子元素（perf-gate/虚拟列表契约不变） */
/* 与 .cy-main 的 24% 叠加后，消息区仍保留约 62% 底图；消息气泡自身提供阅读对比度。 */
.cy-messages { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; padding: 0 var(--cy-space-8); overflow-y: auto; overflow-x: hidden; overflow-anchor: none; scrollbar-gutter: stable; background: color-mix(in srgb, var(--cy-pane) 18%, transparent); }
.cy-vlist-row { display: flex; flex-direction: column; gap: var(--cy-space-4-5); width: min(100%, 940px); margin-inline: auto; padding: var(--cy-space-1) 0; }
.cy-vlist-row.cy-turn-start { padding-top: var(--cy-space-9); }
/* P3：全局首条消息 6px 顶距——不能用 :first-child（列表首位恒为 .cy-vlist-pad，永不匹配），用显式类 */
.cy-vlist-row.cy-first-row { padding-top: var(--cy-space-3); }
/* UII-QQ 时间戳批次：居中日期分隔——低权重浅胶囊小字，不与正文争焦点；
   日首行顶部留白由分隔负责（该行 cy-turn-start 已禁用），不影响消息左右对齐结构 */
.cy-day-separator { display: flex; justify-content: center; padding: var(--cy-space-7) 0 var(--cy-space-1); }
.cy-day-separator-text { padding: var(--cy-space-1) var(--cy-space-5); color: var(--cy-muted); background: var(--cy-surface-soft); border-radius: var(--cy-radius-pill); font-size: var(--cy-font-sm); opacity: 0.85; font-variant-numeric: tabular-nums; user-select: none; }
.cy-vlist-pad { flex-shrink: 0; }   /* 7C 真机修复：flex 列内垫片必须禁收缩，否则 paddingTop/Bottom 被压成 0，长会话滚不到底部新消息 */
.cy-vlist-row.cy-highlighted { outline: 2px solid var(--cy-accent-strong); border-radius: var(--cy-radius-6); }   /* G4 D6：高亮非纯颜色——outline + chip + aria-live */
.cy-located-chip { display: inline-block; align-self: flex-start; padding: var(--cy-space-0-5) var(--cy-space-4); border-radius: var(--cy-radius-pill); color: var(--cy-accent-text); background: var(--cy-accent); font-size: var(--cy-font-sm); }
.cy-sr-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.cy-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: var(--cy-space-3); padding: var(--cy-space-8); color: var(--cy-muted); font-size: var(--cy-font-lg); text-align: center; }
.cy-empty strong { color: var(--cy-text); font-size: var(--cy-font-xl); font-weight: 600; }
.cy-empty span { max-width: 34em; font-size: var(--cy-font-md); line-height: 1.65; }
.cy-back-bottom { position: sticky; bottom: 12px; align-self: center; z-index: 2; padding: var(--cy-space-3) var(--cy-space-6-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-pill); background: var(--cy-surface); color: var(--cy-muted); font-size: var(--cy-font-md); cursor: pointer; box-shadow: 0 4px 12px rgb(0 0 0 / 0.12); }
.cy-back-bottom:hover { color: var(--cy-accent-text); background: var(--cy-surface-hover); }
.cy-streaming-placeholder { display: inline-flex; align-items: center; align-self: stretch; width: min(100%, 940px); margin-inline: auto; padding: var(--cy-space-4-5) var(--cy-space-6-5) var(--cy-space-4-5) 41px; margin-top: var(--cy-space-3); color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-typing-dot { width: 7px; height: 7px; border-radius: var(--cy-radius-circle); background: var(--cy-accent-strong); animation: cy-pulse 1s ease-in-out infinite; }
@keyframes cy-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
</style>
