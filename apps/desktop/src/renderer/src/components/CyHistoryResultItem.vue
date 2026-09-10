<script setup lang="ts">
// CyHistoryResultItem:单条命中行（spec §4.1）——时间/发送者/命中片段/类型 chip/跳转按钮。P0-1：真实后端 search item 无 kind/url，
// 结果项为纯文本行（chip 显示「消息」）；缩略图分支仅在 hit.resource 存在时触发（Mock 领域富化演示 / 未来资源端点补充，见 Task 6「P0-1 设计缺口」）。
import { computed } from 'vue'
import type { ChatHistoryItem } from '@shared/contracts'
import { stickerRenderUrl } from '@shared/domain'

const props = defineProps<{ hit: ChatHistoryItem }>()
defineEmits<{ jump: [hit: ChatHistoryItem] }>()

const KIND_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频', file: '文件', link: '链接', sticker: '表情' }
const typeLabel = computed(() => (props.hit.resource ? KIND_LABEL[props.hit.resource.kind] ?? props.hit.resource.kind : '消息'))
const isSticker = computed(() => props.hit.resource?.kind === 'sticker')
const stickerSrc = computed(() => {
  const id = props.hit.resource?.stickerId
  return id ? stickerRenderUrl(id) : undefined
})
const timeText = computed(() => {
  const d = new Date(props.hit.createdAt)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
})
</script>

<template>
  <li class="cy-history-item" :data-hit-id="hit.hitId">
    <div class="cy-hit-main">
      <span class="cy-hit-time">{{ timeText }}</span>
      <span class="cy-hit-sender">{{ hit.senderLabel }}</span>
      <span class="cy-hit-chip" :class="`kind-${hit.resource?.kind ?? 'text'}`">{{ typeLabel }}</span>
    </div>
    <p class="cy-hit-snippet">{{ hit.snippet || '（无文本命中）' }}</p>
    <img v-if="isSticker && stickerSrc" class="cy-hit-thumb" :src="stickerSrc" alt="表情" />
    <button class="cy-jump-btn" @click="$emit('jump', hit)">跳转</button>
  </li>
</template>

<style scoped>
.cy-history-item { display: grid; grid-template-columns: 1fr auto; gap: var(--cy-space-3) var(--cy-space-5); align-items: center; padding: var(--cy-space-4-5) var(--cy-space-5-5); background: var(--cy-surface); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); }
.cy-hit-main { display: flex; align-items: center; gap: var(--cy-space-4); font-size: var(--cy-font-md); }
.cy-hit-time { color: var(--cy-muted); }
.cy-hit-sender { color: var(--cy-text); font-weight: 500; }
.cy-hit-chip { padding: var(--cy-space-0-5) var(--cy-space-3-5); border-radius: var(--cy-radius-pill); background: var(--cy-surface-soft); color: var(--cy-muted); border: 1px solid var(--cy-border); font-size: var(--cy-font-sm); }
.cy-hit-chip.kind-sticker { color: var(--cy-accent-text); background: var(--cy-accent); }
.cy-hit-snippet { grid-column: 1 / -1; margin: 0; color: var(--cy-text); font-size: var(--cy-font-lg); }
.cy-hit-thumb { grid-column: 1 / -1; width: 56px; height: 56px; object-fit: contain; border-radius: var(--cy-radius-4); background: var(--cy-surface-soft); }
.cy-jump-btn { padding: var(--cy-space-2-5) var(--cy-space-6); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-surface); color: var(--cy-text); font-size: var(--cy-font-md); }
.cy-jump-btn:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
