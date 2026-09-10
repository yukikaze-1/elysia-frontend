<script setup lang="ts">
// CyVideoAttachment:图标卡收起态 + 点击展开内联 <video controls> 播放（D9，不引缩略图库）。
import { ref } from 'vue'
import { formatFileSize } from '../utils/media'
import { mediaUrlFor } from '../utils/media-url'
const props = defineProps<{ attachmentId?: string; mediaType?: string; name?: string; size?: number; nonce?: number }>()
const emit = defineEmits<{ error: [] }>()
const playing = ref(false)
function src(): string | undefined {
  return props.attachmentId ? mediaUrlFor('attachment', props.attachmentId, props.nonce) : undefined
}
</script>

<template>
  <div v-if="!playing" class="cy-media-card" role="button" tabindex="0" :aria-label="`播放视频 ${name ?? ''}`" @click="playing = true" @keydown.enter="playing = true">
    <span class="cy-media-icon">🎬</span>
    <span class="cy-media-meta">{{ name ?? '视频' }}<template v-if="size !== undefined"> · {{ formatFileSize(size) }}</template></span>
    <span class="cy-media-action">点击播放</span>
  </div>
  <video v-else-if="src()" :src="src()" controls class="cy-media-video" @error="emit('error')" />
</template>

<style scoped>
.cy-media-card { display: flex; align-items: center; gap: var(--cy-space-5); padding: var(--cy-space-4-5) var(--cy-space-6); border-radius: var(--cy-radius-6); border: 1px solid var(--cy-border); background: var(--cy-surface-soft); cursor: pointer; max-width: 100%; }
.cy-media-meta { color: var(--cy-text); font-size: var(--cy-font-lg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-media-action { margin-left: auto; color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-media-video { display: block; max-width: 100%; max-height: 320px; border-radius: var(--cy-radius-5); border: 1px solid var(--cy-border); }
</style>
