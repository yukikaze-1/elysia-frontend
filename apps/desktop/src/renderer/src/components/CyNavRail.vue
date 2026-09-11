<script setup lang="ts">
// 阶段 4 批次 A：NavRail active 上提——局部 ref 删除，改由 appStore.currentView 驱动（doc 06 §3.1）。
// UI 问题 10/11：设置按钮沉底（VS Code/Discord 惯例）；删除纯装饰 Cy 徽标。
// UII-QQ 设置页批次：应用内标题栏移除——「折叠/展开会话栏」按钮从标题栏移到导航栏顶部；
// 仅聊天视图显示（任务页无会话栏）；折叠后按钮仍可见可展开；
// hover 修复：pressed 态 hover 不再被浅色前景覆盖（图标恒保持对比度），补齐 active/focus-visible/disabled。
import { computed } from 'vue'
import { useAppStore, type AppView } from '../stores/app.store'
import { useLayoutStore } from '../stores/layout.store'
import CyConnectionPanel from './CyConnectionPanel.vue'

const app = useAppStore()
const layout = useLayoutStore()

const collapseLabel = computed(() => (layout.effective.conversationShown ? '折叠会话列表' : '展开会话列表'))

const items: Array<{ key: AppView; label: string; icon: string }> = [
  {
    key: 'chat',
    label: '聊天',
    icon: '<path d="M4 5h16v10H8l-4 4z" /><path d="M8 9h8M8 12h5" />'
  },
  {
    key: 'tasks',
    label: '任务',
    icon: '<rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 12l2 2 4-4" />'
  }
]

/** 设置按钮沉底（问题 10）：与聊天/任务分开，置于 spacer 之下。连接入口在其上方（IA 调整）。 */
const bottomItems: Array<{ key: AppView; label: string; icon: string }> = [
  {
    key: 'settings',
    label: '设置',
    icon: '<circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5-2 2m-7 7-2 2m11 0-2-2m-7-7-2-2" />'
  }
]
</script>

<template>
  <nav class="cy-nav" aria-label="主导航">
    <!-- 折叠/展开会话栏：仅聊天视图显示（会话栏仅 chat 存在）；折叠后按钮仍在导航栏内可展开 -->
    <button
      v-if="app.currentView === 'chat'"
      class="cy-nav-collapse"
      :aria-pressed="layout.effective.conversationShown"
      :aria-label="collapseLabel"
      :title="collapseLabel"
      @click="layout.toggleConversation()"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 5h7v14H4zM15 9l3 3-3 3" />
      </svg>
    </button>
    <button
      v-for="item in items"
      :key="item.key"
      class="cy-nav-button"
      :aria-pressed="app.currentView === item.key"
      :aria-label="item.label"
      :title="item.label"
      @click="app.setView(item.key)"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        v-html="item.icon"
      />
    </button>
    <span class="cy-nav-spacer" />
    <CyConnectionPanel />
    <button
      v-for="item in bottomItems"
      :key="item.key"
      class="cy-nav-button"
      :aria-pressed="app.currentView === item.key"
      :aria-label="item.label"
      :title="item.label"
      @click="app.setView(item.key)"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        v-html="item.icon"
      />
    </button>
  </nav>
</template>

<style scoped>
.cy-nav {
  grid-area: nav;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--cy-space-5);
  padding: var(--cy-space-7) var(--cy-space-3-5);
  background: color-mix(in srgb, var(--cy-nav) 62%, transparent);
  border-right: 1px solid var(--cy-border);
  backdrop-filter: blur(18px) saturate(110%);
}

.cy-nav-button,
.cy-nav-collapse {
  display: grid;
  place-items: center;
  width: 40px;
  min-height: 40px;
  border-radius: var(--cy-radius-6);
  color: var(--cy-muted);
  background: transparent;
  border: 1px solid transparent;
  transition: background var(--cy-motion-fast) ease, color var(--cy-motion-fast) ease;
}

.cy-nav-button:hover,
.cy-nav-collapse:hover {
  color: var(--cy-accent-strong);
  background: var(--cy-surface-hover);
}

.cy-nav-button:active,
.cy-nav-collapse:active {
  transform: translateY(1px);
}

.cy-nav-button:focus-visible,
.cy-nav-collapse:focus-visible {
  outline: 2px solid var(--cy-accent-strong);
  outline-offset: 2px;
}

/* pressed 态：hover/active 均保持 accent-text 前景在 accent 底上——图标对比度恒定（修复原 hover 图标消失） */
.cy-nav-button[aria-pressed='true'],
.cy-nav-collapse[aria-pressed='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent-tint);
  border-color: color-mix(in srgb, var(--cy-accent-strong) 24%, transparent);
}

.cy-nav-button[aria-pressed='true']:hover,
.cy-nav-collapse[aria-pressed='true']:hover {
  color: var(--cy-accent-text);
  background: var(--cy-accent-strong);
  border-color: var(--cy-accent-strong);
}

.cy-nav-collapse:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cy-nav-spacer {
  flex: 1;
}
</style>
