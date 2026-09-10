<script setup lang="ts">
// CyEmojiPicker:Emoji/表情包双 tab 弹出面板（spec §4.6，D7/D8）。选择不自动发送,由 CyChatInput 决定插入/入队。
// Emoji 网格最近优先;表情包 tab 委托 CyStickerPanel。
import { computed, onMounted, ref } from 'vue'
import { loadRecentEmoji, saveRecentEmoji } from '../utils/recent-emoji'
import CyStickerPanel from './CyStickerPanel.vue'

const emit = defineEmits<{
  (e: 'select-emoji', emoji: string): void
  (e: 'select-sticker', sticker: { kind: 'sticker'; stickerId: string; name?: string; status: 'ready' }): void
  (e: 'close'): void
}>()

const tab = ref<'emoji' | 'sticker'>('emoji')
const recent = ref<string[]>([])
const COMMON_EMOJI = ['😀', '😂', '😊', '👍', '🎉', '❤️', '🔥', '😢', '🙏', '🤔', '✨', '👏']

onMounted(() => { recent.value = loadRecentEmoji(window.localStorage) })

function pick(e: string): void {
  recent.value = [e, ...recent.value.filter((x) => x !== e)].slice(0, 24)
  saveRecentEmoji(recent.value, window.localStorage)
  emit('select-emoji', e)
}

/** 网格键盘:Tab 逐项;Enter/Space 选择（P1-3：逐按钮绑定，取聚焦按钮的 emoji，避免 currentTarget 网格无 dataset） */
function onGridKeydown(e: KeyboardEvent, item: string): void {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(item) }
  else if (e.key === 'Escape') emit('close')
}

const orderedEmoji = computed(() => [...recent.value, ...COMMON_EMOJI.filter((e) => !recent.value.includes(e))])
</script>

<template>
  <div class="cy-emoji-picker" role="dialog" aria-label="Emoji 与表情包">
    <nav class="cy-emoji-tabs" aria-label="面板分类">
      <button :class="{ active: tab === 'emoji' }" @click="tab = 'emoji'">Emoji</button>
      <button :class="{ active: tab === 'sticker' }" @click="tab = 'sticker'">表情包</button>
    </nav>
    <div v-if="tab === 'emoji'" class="cy-emoji-grid">
      <button v-for="e in orderedEmoji" :key="e" :data-emoji="e" :aria-label="e" class="cy-emoji-cell" @click="pick(e)" @keydown="onGridKeydown($event, e)">
        {{ e }}
      </button>
    </div>
    <CyStickerPanel v-else @select-sticker="(s) => emit('select-sticker', s)" @close="emit('close')" />
  </div>
</template>

<style scoped>
.cy-emoji-picker { display: flex; flex-direction: column; width: 288px; max-height: 300px; padding: var(--cy-space-5); background: var(--cy-pane); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); box-shadow: 0 8px 24px rgb(0 0 0 / 0.2); }
.cy-emoji-tabs { display: flex; gap: var(--cy-space-3); margin-bottom: var(--cy-space-4); }
.cy-emoji-tabs button { padding: var(--cy-space-2) var(--cy-space-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-surface); color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-emoji-tabs button.active { background: var(--cy-accent); color: var(--cy-accent-text); }
.cy-emoji-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: var(--cy-space-2); overflow-y: auto; }
.cy-emoji-cell { padding: var(--cy-space-2); border: 0; border-radius: var(--cy-radius-3); background: transparent; font-size: 20px; line-height: 1.4; }
.cy-emoji-cell:hover { background: var(--cy-surface-hover); }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 1px; }
</style>
