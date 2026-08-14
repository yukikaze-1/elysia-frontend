<script setup lang="ts">
// 阶段 3 G1（spec §4.6，决策 D10）：布局宿主——消费 layoutStore，绑定 grid-template-columns/areas，
// 挂 ResizeObserver 喂 viewportWidth（P2-2 首帧已由 store 播种）；隐藏区 v-show + 网格列不生成。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CyTitleBar from './components/CyTitleBar.vue'
import CyNavRail from './components/CyNavRail.vue'
import CyConversationList from './components/CyConversationList.vue'
import CyChatView from './components/CyChatView.vue'
import CyLive2DPanel from './components/CyLive2DPanel.vue'
import CyHistoryViewer from './components/CyHistoryViewer.vue'
import { useLayoutStore } from './stores/layout.store'
import { gridTemplateFor } from './layout/effective-layout'

const layout = useLayoutStore()
const rootRef = ref<HTMLElement>()
// 用对象字面量重建 style：gridTemplateFor 返回的 GridTemplate（具名接口）缺 CSSProperties 的 `--${string}`
// 索引签名，直接 `:style` 绑定过不了 vue-tsc；字面量对象字面量语义则可赋给 CSSProperties。
const gridStyle = computed(() => {
  const g = gridTemplateFor(layout.effective)
  return { gridTemplateColumns: g.gridTemplateColumns, gridTemplateAreas: g.gridTemplateAreas }
})

let ro: ResizeObserver | undefined
let rafPending = false
function onResize(width: number): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => { rafPending = false; layout.handleViewportChange(width) })
}
function onWindowResize(): void { onResize(window.innerWidth) }

onMounted(() => {
  const el = rootRef.value
  if (!el) return
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((entries) => { for (const en of entries) onResize(en.contentRect.width) })
    ro.observe(el)
  } else {
    window.addEventListener('resize', onWindowResize)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('resize', onWindowResize)
})

// 轻量布局提示 toast（spec §4.5 窄窗弹回）：数秒后自动清除
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => layout.notice, (n) => {
  if (noticeTimer) clearTimeout(noticeTimer)
  if (n) noticeTimer = setTimeout(() => layout.clearNotice(), 3000)
})
</script>

<template>
  <!-- 四区布局:导航 / 会话列表 / 聊天 / Live2D 右栏（角色栏是布局列，不覆盖聊天）。grid-template-* 由有效布局驱动（D10） -->
  <div ref="rootRef" class="cy-app" :style="gridStyle">
    <CyTitleBar />
    <CyNavRail />
    <CyConversationList v-show="layout.effective.conversationShown" />
    <main class="cy-main">
      <CyChatView />
    </main>
    <CyLive2DPanel v-show="layout.effective.live2dShown" />
    <div v-if="layout.notice" class="cy-layout-toast" role="status">{{ layout.notice }}</div>
    <CyHistoryViewer />
  </div>
</template>

<style scoped>
.cy-app {
  display: grid;
  /* 行高 36px = layout/constants.ts TITLEBAR_HEIGHT（D1 单一事实来源） */
  grid-template-rows: 36px 1fr;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--cy-window);
}

.cy-main {
  grid-area: chat;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--cy-surface);
}

/* 轻量 toast：非 Live2D 覆盖物，仅瞬时提示，不遮挡交互区 */
.cy-layout-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 40;
  max-width: 70vw;
  padding: 9px 14px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
  font-size: 12px;
  box-shadow: var(--cy-shadow);
}
</style>
