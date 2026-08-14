<script setup lang="ts">
// CyAudioAttachment:图标卡收起态 + 点击展开内联 <audio controls> 播放（D9，同 CyVideoAttachment 结构）。
import { ref } from 'vue'
import { formatFileSize } from '../utils/media'
import { mediaUrlFor } from '../utils/media-url'
const props = defineProps<{ attachmentId?: string; mediaType?: string; name?: string; size?: number }>()
const emit = defineEmits<{ error: [] }>()
const playing = ref(false)
function src(): string | undefined {
  return props.attachmentId ? mediaUrlFor('attachment', props.attachmentId) : undefined
}
</script>

<template>
  <div v-if="!playing" class="cy-media-card" role="button" tabindex="0" :aria-label="`播放音频 ${name ?? ''}`" @click="playing = true" @keydown.enter="playing = true">
    <span class="cy-media-icon">🔊</span>
    <span class="cy-media-meta">{{ name ?? '音频' }}<template v-if="size !== undefined"> · {{ formatFileSize(size) }}</template></span>
    <span class="cy-media-action">点击播放</span>
  </div>
  <audio v-else-if="src()" :src="src()" controls class="cy-media-audio" @error="emit('error')" />
</template>

<style scoped>
.cy-media-card { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); cursor: pointer; max-width: 100%; }
.cy-media-meta { color: var(--cy-text); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-media-action { margin-left: auto; color: var(--cy-muted); font-size: 12px; }
.cy-media-audio { display: block; max-width: 100%; border-radius: 10px; border: 1px solid var(--cy-border); }
</style>
