<script setup lang="ts">
// 阶段 3 G1（spec §4.6，决策 D10）：布局宿主——消费 layoutStore，绑定 grid-template-columns/areas，
// 挂 ResizeObserver 喂 viewportWidth（P2-2 首帧已由 store 播种）；隐藏区 v-show + 网格列不生成。
// 阶段 4 批次 A：视图切换——chat 四区（v-if）/ tasks 占位（v-else-if）/ settings 全窗 overlay（v-else）；
// NavRail 常驻（settings 关闭回焦目标）；CyLive2DPanel 移到 chat 分支外常驻挂载（7D 真机前置修复）——
// settings 打开时仅 v-show 隐藏 + 面板内 currentView gate 停 rAF，不 dispose，诊断页才能读到 ready 态帧读数。
// UII-QQ 设置页批次：应用内标题栏移除（原生系统标题栏承担窗口标题）——网格单行，折叠会话栏按钮移入 NavRail 顶部。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CyRendererCrashBanner from './components/CyRendererCrashBanner.vue'
import CyNavRail from './components/CyNavRail.vue'
import CyConversationList from './components/CyConversationList.vue'
import CyChatView from './components/CyChatView.vue'
import CyLive2DPanel from './components/CyLive2DPanel.vue'
import CyHistoryViewer from './components/CyHistoryViewer.vue'
import CySettingsView from './components/CySettingsView.vue'
import { useLayoutStore } from './stores/layout.store'
import { useAppStore } from './stores/app.store'
import { gridTemplateFor } from './layout/effective-layout'

const layout = useLayoutStore()
const app = useAppStore()
const rootRef = ref<HTMLElement>()
// 用对象字面量重建 style：gridTemplateFor 返回的 GridTemplate（具名接口）缺 CSSProperties 的 `--${string}`
// 索引签名，直接 `:style` 绑定过不了 vue-tsc；字面量对象字面量语义则可赋给 CSSProperties。
const gridStyle = computed(() => {
  const g = gridTemplateFor(layout.effective)
  return { gridTemplateColumns: g.gridTemplateColumns, gridTemplateAreas: g.gridTemplateAreas }
})

let ro: ResizeObserver | undefined
let rafPending = false
let latestWidth = 0
function onResize(width: number): void {
  latestWidth = width // P3-2：总是记录最新宽度——rAF 回调读最新值，同一帧内多个 RO 事件不丢最后宽度
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => { rafPending = false; layout.handleViewportChange(latestWidth) })
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
  <!-- 四区布局:导航 / 会话列表 / 聊天 / Live2D 右栏（角色栏是布局列，不覆盖聊天）。grid-template-* 由有效布局驱动（D10）。
       阶段 4 批次 A：Chat 视图整体 v-if；Tasks 占位；Settings 全窗 overlay（fixed，覆盖标题栏以下全部区域）。
       阶段 7 批次 B（Task 3）：CyRendererCrashBanner 全局挂载（不随 view 切换）——reload 后 getLastCrash 读 marker 提示。
       7D：CyLive2DPanel 常驻挂载（不随 chat v-if 卸载）——settings 打开时 v-show 隐藏但保留 ready 态，
       rAF 由面板内 currentView gate 停止；诊断页 Live2D 性能读数因此可读到真实帧耗时/帧率。 -->
  <CyRendererCrashBanner />
  <div
    ref="rootRef"
    class="cy-app"
    :class="{ 'is-conv-hidden': !layout.effective.conversationShown, 'is-live-hidden': !(layout.effective.live2dShown && app.currentView === 'chat') }"
    :style="gridStyle"
  >
    <CyNavRail />
    <template v-if="app.currentView === 'chat'">
      <CyConversationList v-show="layout.effective.conversationShown" />
      <main class="cy-main">
        <CyChatView />
      </main>
      <div v-if="layout.notice" class="cy-layout-toast" role="status">{{ layout.notice }}</div>
      <CyHistoryViewer />
    </template>
    <div v-else-if="app.currentView === 'tasks'" class="cy-tasks-placeholder" role="status">
      任务中心 · 阶段 6 落地
    </div>
    <CySettingsView v-else @close="app.setView('chat')" />
    <CyLive2DPanel v-show="layout.effective.live2dShown && app.currentView === 'chat'" />
  </div>
</template>

<style scoped>
.cy-app {
  display: grid;
  /* UII-QQ 设置页批次：应用内标题栏移除——网格单行（原生系统标题栏承担窗口标题） */
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--cy-window);
}

/* 隐藏区兜底（2026-09-10）：网格模板对隐藏区保留 0px 轨道（见 layout/effective-layout.ts
   gridTemplateFor），但含 padding/border 的元素在 border-box 下宽度下限是「padding+border」，
   仍会从 0px 轨道里溢出（实测会话栏漏出 21px、角色栏 25px）。

   所以这里再显式隐藏一次，与 v-show 同源布尔量绑定——两层保险，任一生效都不会有残留占位。
   角色栏必须常驻挂载（诊断页要读实时帧读数，见 electron-live2d.spec.ts:928），故不能改用 v-if。

   状态绑在 .cy-app 自己身上（而非给子组件传 :class）：.cy-app 是本组件自己的元素，:class 必然
   生效；再用 :deep() 穿透到子组件根（子组件根带的是它自己的 scope id，普通选择器命中不了）。 */
.cy-app.is-conv-hidden :deep(> .cy-conversations),
.cy-app.is-live-hidden :deep(> .cy-live) {
  display: none !important;
}

.cy-main {
  grid-area: chat;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--cy-surface);
}

/* tasks 占位视图：落在 chat 区（导航常驻其左侧，可随时切回） */
.cy-tasks-placeholder {
  grid-area: chat;
  display: grid;
  place-items: center;
  color: var(--cy-muted);
  font-size: var(--cy-font-base);
}

/* 轻量 toast：非 Live2D 覆盖物，仅瞬时提示，不遮挡交互区 */
.cy-layout-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 40;
  max-width: 70vw;
  padding: var(--cy-space-4-5) var(--cy-space-7);
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-6);
  font-size: var(--cy-font-md);
  box-shadow: var(--cy-shadow);
}
</style>
