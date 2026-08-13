<script setup lang="ts">
import { ref } from 'vue'

type NavKey = 'chat' | 'tasks' | 'settings'

const active = ref<NavKey>('chat')

const items: Array<{ key: NavKey; label: string; icon: string }> = [
  {
    key: 'chat',
    label: '聊天',
    icon: '<path d="M4 5h16v10H8l-4 4z" /><path d="M8 9h8M8 12h5" />'
  },
  {
    key: 'tasks',
    label: '任务',
    icon: '<rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 12l2 2 4-4" />'
  },
  {
    key: 'settings',
    label: '设置',
    icon: '<circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5-2 2m-7 7-2 2m11 0-2-2m-7-7-2-2" />'
  }
]
</script>

<template>
  <nav class="cy-nav" aria-label="主导航">
    <div class="cy-brand" aria-hidden="true">Cy</div>
    <button
      v-for="item in items"
      :key="item.key"
      class="cy-nav-button"
      :aria-pressed="active === item.key"
      :aria-label="item.label"
      :title="item.label"
      @click="active = item.key"
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

.cy-brand {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-bottom: 6px;
  border-radius: 13px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  font-weight: 500;
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
