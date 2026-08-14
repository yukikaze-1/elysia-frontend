<script setup lang="ts">
// CyImageAttachment:图片内联预览（原生缩放）；svg 经 <img> 不执行脚本（spec §4.6 安全注记）。
import { mediaUrlFor } from '../utils/media-url'
// P2-6：name prop 已声明（模板 :alt="name ?? '附件图片'" 引用它，缺省会 typecheck 报未声明）
const props = defineProps<{ attachmentId?: string; mediaType?: string; name?: string; nonce?: number }>()
const emit = defineEmits<{ error: []; loaded: [] }>()
function src(): string | undefined {
  return props.attachmentId ? mediaUrlFor('attachment', props.attachmentId, props.nonce) : undefined
}
</script>

<template>
  <img v-if="src()" :src="src()" class="cy-attachment-image" :alt="name ?? '附件图片'" @error="emit('error')" @load="emit('loaded')" />
</template>

<style scoped>
.cy-attachment-image { display: block; max-width: 100%; max-height: 320px; border-radius: 10px; object-fit: contain; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); }
</style>
