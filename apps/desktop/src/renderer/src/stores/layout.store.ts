// src/renderer/src/stores/layout.store.ts
// 阶段 3 G1（spec §4.5，决策 D6）：布局——Renderer 本地 UI 状态，localStorage key cyrene.layout.v1，不入 Main 配置。
// effective 由 computeEffectiveLayout 纯函数推导（D2，保护不写回持久偏好）；会话期 override（D3，不持久化）。
// toggle = 「目标态」动作（P1-2）：折叠=写 prefs+清 override；展开=写 prefs+按 wouldBe 判据置 override，
// 置位后复核 effective 的 dropped*（双 override 兜底 P1-1）→ 清位 + notice（窄窗弹回 toast），不静默。
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { LAYOUT_CONSTANTS, LIVE2D_DEFAULT_WIDTH } from '../layout/constants'
import {
  clampLive2dWidth, computeEffectiveLayout, type LayoutOverrides, type LayoutPrefs
} from '../layout/effective-layout'
import { readLayout, writeLayout } from '../layout/layout-storage'

const PERSIST_DEBOUNCE_MS = 200

export const useLayoutStore = defineStore('layout', () => {
  // P2-2：首帧用 window.innerWidth 播种，避免首个 ResizeObserver 回调前只渲染 nav+chat 的瞬时布局
  const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 0)
  const prefs = ref<LayoutPrefs>({ conversationCollapsed: false, live2dVisible: true, live2dWidth: LIVE2D_DEFAULT_WIDTH })
  const overrides = ref<LayoutOverrides>({ explicitOpenConversation: false, explicitOpenLive2d: false })
  const notice = ref<string | null>(null)
  const effective = computed(() => computeEffectiveLayout(viewportWidth.value, prefs.value, overrides.value, LAYOUT_CONSTANTS))

  // 持久化：prefs 防抖落盘（override 与 notice 不持久化）。flush:'sync' 保证写时序可测。
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  watch(prefs, () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => writeLayout(prefs.value, LAYOUT_CONSTANTS), PERSIST_DEBOUNCE_MS)
  }, { deep: true, flush: 'sync' })

  function clearNotice(): void { notice.value = null }

  function toggleConversation(): void {
    if (effective.value.conversationShown) {
      // 目标：折叠 —— 写回持久偏好 + 清会话期 override
      prefs.value.conversationCollapsed = true
      overrides.value.explicitOpenConversation = false
      return
    }
    // 目标：展开 —— 写回持久偏好；若「偏好展开 + 无 override」会被保护抢回则置 override
    prefs.value.conversationCollapsed = false
    const wouldBe = computeEffectiveLayout(viewportWidth.value,
      { ...prefs.value, conversationCollapsed: false },
      { ...overrides.value, explicitOpenConversation: false },
      LAYOUT_CONSTANTS)
    if (wouldBe.autoCollapsedConversation) overrides.value.explicitOpenConversation = true
    // 置位后复核 effective（P1-2）：若该 override 立即被双 override 兜底回退 → 清位 + toast
    if (effective.value.droppedConversationOverride) {
      overrides.value.explicitOpenConversation = false
      notice.value = '当前窗口过窄，无法同时显示会话列表与角色栏'
    }
  }

  function toggleLive2d(): void {
    if (effective.value.live2dShown) {
      prefs.value.live2dVisible = false
      overrides.value.explicitOpenLive2d = false
      return
    }
    prefs.value.live2dVisible = true
    const wouldBe = computeEffectiveLayout(viewportWidth.value,
      { ...prefs.value, live2dVisible: true },
      { ...overrides.value, explicitOpenLive2d: false },
      LAYOUT_CONSTANTS)
    if (wouldBe.autoClosedLive2d) overrides.value.explicitOpenLive2d = true
    if (effective.value.droppedLive2dOverride) {
      overrides.value.explicitOpenLive2d = false
      notice.value = '当前窗口过窄，角色栏无法显示'
    }
    // 评审第二轮重验修复：先置的会话栏 override 可能被双 override 兜底回退（droppedConversationOverride），
    // 必须同步清位——否则残留 override 在宽度回升 [660,1160) 时「复活」，会话栏意外展开、聊天被压到 40px。
    if (effective.value.droppedConversationOverride) {
      overrides.value.explicitOpenConversation = false
      notice.value = '窗口过窄，会话栏暂不可同时显示'
    }
  }

  function setLive2dWidth(w: number): void {
    prefs.value.live2dWidth = clampLive2dWidth(w, LAYOUT_CONSTANTS)
  }

  function handleViewportChange(w: number): void {
    viewportWidth.value = w
    // 宽度恢复足够 → 清 override（D3 判据）；dropped* 同步清位也在此覆盖
    if (w >= LAYOUT_CONSTANTS.NAV + LAYOUT_CONSTANTS.CONV + prefs.value.live2dWidth + LAYOUT_CONSTANTS.CHAT_MIN) {
      overrides.value.explicitOpenConversation = false
      overrides.value.explicitOpenLive2d = false
    }
    if (effective.value.droppedConversationOverride) overrides.value.explicitOpenConversation = false
    if (effective.value.droppedLive2dOverride) overrides.value.explicitOpenLive2d = false
  }

  function hydrate(): void {
    prefs.value = readLayout(LAYOUT_CONSTANTS)
  }

  /**
   * 退出前 flush（H-04，2026-09-11）：把仍在 200ms 防抖窗口内的布局偏好立刻写入 localStorage。
   * 仅在确有在途定时器时写（无改动即 no-op，避免无谓写入）；writeLayout 为同步实现。
   */
  function flush(): void {
    if (persistTimer === undefined) return
    clearTimeout(persistTimer)
    persistTimer = undefined
    writeLayout(prefs.value, LAYOUT_CONSTANTS)
  }

  return {
    viewportWidth, prefs, overrides, notice, effective,
    toggleConversation, toggleLive2d, setLive2dWidth, handleViewportChange, hydrate, clearNotice, flush
  }
})
