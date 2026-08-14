<script setup lang="ts">
// CyStickerPanel:内置 st_ 清单网格（spec §4.6，D8）——listStickers 拉取,加载中/失败重试/空清单三态。
// 选择 → emit PendingSticker（G3 待发送分支,不含 localId,stickerId 为身份）。
import { onMounted, ref } from 'vue'
import { stickerRenderUrl } from '@shared/domain'
import type { StickerItem } from '@shared/contracts/sticker'
import { api } from '../stores/desktop-api'

const emit = defineEmits<{
  (e: 'select-sticker', sticker: { kind: 'sticker'; stickerId: string; name?: string; status: 'ready' }): void
  (e: 'close'): void
}>()

const stickers = ref<StickerItem[]>([])
const loading = ref(false)
const failed = ref(false)
const message = ref('')

async function load(): Promise<void> {
  loading.value = true
  failed.value = false
  message.value = ''
  try {
    const manifest = await api.listStickers()
    stickers.value = manifest.stickers                       // P0-2：StickerManifest{stickers}
    if (manifest.stickers.length === 0) message.value = '暂无内置表情包'
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)

function pick(s: StickerItem): void {
  emit('select-sticker', { kind: 'sticker', stickerId: s.stickerId, status: 'ready' })   // 契约无 name 字段（P0-2）
}

function onGridKeydown(e: KeyboardEvent, s: StickerItem): void {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s) }
  else if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <div class="cy-sticker-panel">
    <div v-if="loading" class="cy-sticker-state">加载中…</div>
    <div v-else-if="failed" class="cy-sticker-state">
      <span>表情包加载失败</span>
      <button class="cy-sticker-retry" @click="load">重试</button>
    </div>
    <div v-else-if="message" class="cy-sticker-state">{{ message }}</div>
    <div v-else class="cy-sticker-grid">
      <button
        v-for="s in stickers"
        :key="s.stickerId"
        class="cy-sticker-cell"
        :aria-label="s.stickerId"
        @click="pick(s)"
        @keydown="onGridKeydown($event, s)"
      >
        <img :src="stickerRenderUrl(s.stickerId)" :alt="s.stickerId" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.cy-sticker-panel { display: flex; flex-direction: column; min-height: 120px; }
.cy-sticker-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px 0; color: var(--cy-muted); font-size: 13px; }
.cy-sticker-retry { padding: 4px 12px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-muted); }
.cy-sticker-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; overflow-y: auto; }
.cy-sticker-cell { padding: 4px; border: 0; border-radius: 8px; background: var(--cy-surface); }
.cy-sticker-cell img { width: 56px; height: 56px; object-fit: contain; }
.cy-sticker-cell:hover { background: var(--cy-surface-hover); }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 1px; }
</style>
