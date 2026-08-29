<script setup lang="ts">
// 阶段 4 批次 A：NavRail active 上提——局部 ref 删除，改由 appStore.currentView 驱动（doc 06 §3.1）。
// 布局折叠按钮保留（layoutStore 原有语义不变）。
// UI 问题 10/11：折叠开关上移到标题栏左上（替代装饰三点），设置按钮沉底（VS Code/Discord 惯例）；
// 删除纯装饰 Cy 徽标（形似按钮但不可点，制造误导）。
// UII-QQ IA：连接状态入口移入 NavRail 底部（设置上方）——连接是全局运行状态，不属于单个会话。
import { useAppStore, type AppView } from '../stores/app.store'
import CyConnectionPanel from './CyConnectionPanel.vue'

const app = useAppStore()

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
  gap: 10px;
  padding: 14px 7px;
  background: var(--cy-nav);
  border-right: 1px solid var(--cy-border);
}

.cy-nav-button {
  display: grid;
  place-items: center;
  width: 40px;
  min-height: 40px;
  border-radius: 12px;
  color: var(--cy-muted);
}

.cy-nav-button:hover {
  background: var(--cy-surface-hover);
}

.cy-nav-button[aria-pressed='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-nav-spacer {
  flex: 1;
}
</style>
