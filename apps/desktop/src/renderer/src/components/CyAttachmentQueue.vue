<script setup lang="ts">
// CyAttachmentQueue:输入区上方待发送队列（spec §4.3/§4.6）。附件条目显示图标/名称/大小/类型/状态/错误原因/移除；
// validating/uploading 显示不确定 spinner；G4 PendingSticker 经 __cyrene-media/sticker/{stickerId} 显示图片（§2 边界）。
import { computed } from 'vue'
import { useAttachmentStore } from '../stores/attachment.store'
import { formatFileSize } from '../utils/media'
import { mediaUrlFor } from '../utils/media-url'

const store = useAttachmentStore()
const STATUS_TEXT: Record<string, string> = {
  selected: '待校验', validating: '校验中', ready: '就绪', uploading: '上传中', failed: '校验失败', cancelled: '已取消'
}
const atts = computed(() => store.items.filter((i) => i.kind === 'attachment'))
const stickers = computed(() => store.items.filter((i) => i.kind === 'sticker'))
</script>

<template>
  <div v-if="store.order.length" class="cy-attachment-queue" aria-label="待发送附件">
    <div v-for="a in atts" :key="a.localId" class="cy-queue-item" :class="a.status">
      <span class="cy-queue-status" v-if="a.status === 'validating' || a.status === 'uploading'" aria-hidden="true" />
      <span class="cy-queue-name">{{ a.name }}</span>
      <span class="cy-queue-meta">{{ formatFileSize(a.size) }} · {{ STATUS_TEXT[a.status] ?? a.status }}</span>
      <span v-if="a.status === 'failed' && a.reason" class="cy-queue-error">{{ a.reason }}</span>
      <button v-if="a.status !== 'uploading'" class="cy-queue-remove" :aria-label="`移除 ${a.name}`" @click="store.remove(a.localId)">✕</button>
    </div>
    <div v-for="s in stickers" :key="s.stickerId" class="cy-queue-item">
      <img class="cy-queue-sticker" :src="mediaUrlFor('sticker', s.stickerId)" :alt="s.name ?? '贴图'" />
      <span class="cy-queue-name">{{ s.name ?? '贴图' }}</span>
    </div>
  </div>
</template>

<style scoped>
.cy-attachment-queue { display: grid; gap: var(--cy-space-3); padding: var(--cy-space-3) var(--cy-space-7) 0; max-height: 140px; overflow-y: auto; }
.cy-queue-item { display: flex; align-items: center; gap: var(--cy-space-4); padding: var(--cy-space-3) var(--cy-space-5); border-radius: var(--cy-radius-5); border: 1px solid var(--cy-border); background: var(--cy-surface-soft); font-size: var(--cy-font-md); }
.cy-queue-item.failed { border-style: dashed; border-color: var(--cy-danger); }
.cy-queue-status { width: 12px; height: 12px; border-radius: var(--cy-radius-circle); border: 2px solid var(--cy-border); border-top-color: var(--cy-accent); animation: cy-spin 0.8s linear infinite; }
@keyframes cy-spin { to { transform: rotate(360deg); } }
.cy-queue-name { color: var(--cy-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-queue-meta { color: var(--cy-muted); flex: 0 0 auto; }
.cy-queue-error { color: var(--cy-danger); flex: 0 0 auto; }
.cy-queue-remove { flex: 0 0 auto; padding: var(--cy-space-0-5) var(--cy-space-3); color: var(--cy-muted); border-radius: var(--cy-radius-3); }
.cy-queue-remove:hover { color: var(--cy-danger); }
.cy-queue-sticker { width: 24px; height: 24px; object-fit: contain; }
</style>
