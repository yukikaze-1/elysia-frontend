<script setup lang="ts">
// UI 问题 10：标题栏左上原为装饰三点（无功能，形似 macOS 红绿灯）。删三点，
// 原位放「折叠会话列表」开关——紧邻其控制对象的视觉原点，且与导航栏的设置沉底对称。
// 折叠开关保留 layout.toggleConversation() 语义 + aria-pressed 状态 + 图标折叠态翻转。
// 上下文可见性：会话列表仅聊天视图存在，settings/tasks 时禁用（避免误导）。
import { computed } from 'vue'
import { useLayoutStore } from '../stores/layout.store'
import { useAppStore } from '../stores/app.store'

const layout = useLayoutStore()
const app = useAppStore()

// 折叠开关仅在聊天视图可用（会话列表仅 chat 存在；settings/tasks 下禁用不误导）
const collapseDisabled = computed(() => app.currentView !== 'chat')
const collapseLabel = computed(() => layout.effective.conversationShown ? '折叠会话列表' : '展开会话列表')
</script>

<template>
  <header class="cy-titlebar">
    <button
      class="cy-title-collapse"
      :disabled="collapseDisabled"
      :aria-pressed="layout.effective.conversationShown"
      :aria-label="collapseLabel"
      :title="collapseLabel"
      @click="layout.toggleConversation()"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 5h7v14H4zM15 9l3 3-3 3" />
      </svg>
    </button>
    <span class="cy-title-name">Cyrene</span>
    <span class="cy-title-spacer" aria-hidden="true" />
  </header>
</template>

<style scoped>
.cy-titlebar {
  grid-area: title;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  background: var(--cy-titlebar);
  border-bottom: 1px solid var(--cy-border);
  user-select: none;
}

/* 折叠开关：替代原装饰三点，等同原导航栏折叠键的触达面 */
.cy-title-collapse {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: 8px;
  color: var(--cy-muted);
  background: transparent;
  border: 0;
}
.cy-title-collapse:hover:not(:disabled) {
  color: var(--cy-accent);
  background: var(--cy-surface-hover);
}
.cy-title-collapse:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.cy-title-collapse[aria-pressed='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-title-name {
  flex: 1;
  color: var(--cy-muted);
  text-align: center;
  /* UII-QQ：弱化应用内标题——系统标题栏已有「Cyrene」，避免双标题观感 */
  font-size: 11px;
  opacity: 0.65;
}

/* 右侧配平：原为三点配平，现为左侧折叠开关配平，标题保持居中 */
.cy-title-spacer {
  width: 30px;
}
</style>
