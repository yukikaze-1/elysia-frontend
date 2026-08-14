<script setup lang="ts">
// CyLinkAttachment:链接卡片（label + URL，仅展示 http/https；打开外部经既有 will-navigate/setWindowOpenHandler → shell.openExternal，D8 无新 IPC）。
const props = defineProps<{ url?: string; name?: string }>()
function isWeb(u?: string): boolean { return !!u && (u.startsWith('http:') || u.startsWith('https:')) }
</script>

<template>
  <a v-if="isWeb(url)" class="cy-link-card" :href="url" target="_blank" rel="noopener noreferrer">
    <span class="cy-link-label">{{ name ?? url }}</span>
    <span class="cy-link-url">{{ url }}</span>
  </a>
  <div v-else class="cy-link-card"><span class="cy-link-label">{{ name ?? '链接' }}</span></div>
</template>

<style scoped>
.cy-link-card { display: grid; gap: 3px; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); max-width: 100%; }
.cy-link-label { color: var(--cy-accent); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-link-url { color: var(--cy-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
