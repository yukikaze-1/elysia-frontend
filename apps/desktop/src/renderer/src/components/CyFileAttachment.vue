<script setup lang="ts">
// CyFileAttachment:文件图标卡（名称/大小/类型；P0 不下载，D-08 P2）；unsupported 显示「暂不支持播放」。
import { formatFileSize } from '../utils/media'
defineProps<{ name?: string; size?: number; mediaType?: string; unsupported?: boolean }>()
</script>

<template>
  <div class="cy-file-card" :title="mediaType">
    <span class="cy-file-icon">📄</span>
    <span class="cy-file-meta">{{ name ?? '文件' }}<template v-if="size !== undefined"> · {{ formatFileSize(size) }}</template></span>
    <span v-if="unsupported" class="cy-file-note">此格式暂不支持播放</span>
  </div>
</template>

<style scoped>
.cy-file-card { display: flex; align-items: center; gap: var(--cy-space-5); padding: var(--cy-space-4-5) var(--cy-space-6); border-radius: var(--cy-radius-6); border: 1px solid var(--cy-border); background: var(--cy-surface-soft); max-width: 100%; }
.cy-file-meta { color: var(--cy-text); font-size: var(--cy-font-lg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-file-note { margin-left: auto; color: var(--cy-warning); font-size: var(--cy-font-md); }
</style>
