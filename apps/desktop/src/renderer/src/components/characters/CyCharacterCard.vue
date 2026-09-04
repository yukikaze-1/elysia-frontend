<script setup lang="ts">
import { computed } from 'vue'
import type { CharacterSummary } from '@shared/contracts'

const props = defineProps<{
  character: CharacterSummary
  defaultCharacterId?: string
}>()

const emit = defineEmits<{ select: [characterId: string] }>()
const avatarText = computed(() => Array.from(props.character.displayName.trim())[0] ?? '角')
const avatarStyle = computed(() => props.character.presentation.themeColor
  ? { backgroundColor: props.character.presentation.themeColor }
  : undefined)
</script>

<template>
  <article class="cy-character-card" :data-character-id="character.characterId">
    <div class="cy-character-avatar" :style="avatarStyle" aria-hidden="true">{{ avatarText }}</div>
    <div class="cy-character-card-body">
      <header>
        <strong>{{ character.displayName }}</strong>
        <span v-if="character.characterId === defaultCharacterId" class="cy-badge default">默认</span>
        <span class="cy-badge">{{ character.source === 'builtin' ? '内置' : '自定义' }}</span>
        <span v-if="character.status === 'archived'" class="cy-badge archived">已归档</span>
      </header>
      <p>{{ character.description || '暂无简介' }}</p>
      <footer>
        <span>revision {{ character.currentRevision }}</span>
        <button type="button" :aria-label="`查看 ${character.displayName} 详情`" @click="emit('select', character.characterId)">查看详情</button>
      </footer>
    </div>
  </article>
</template>

<style scoped>
.cy-character-card { display: flex; gap: 12px; min-width: 0; padding: 12px; border: 1px solid var(--cy-border); border-radius: 12px; background: var(--cy-surface); }
.cy-character-avatar { display: grid; flex: 0 0 42px; width: 42px; height: 42px; place-items: center; border: 1px solid color-mix(in srgb, var(--cy-border) 75%, transparent); border-radius: 13px; background: var(--cy-accent); color: var(--cy-accent-text); font-weight: 650; }
.cy-character-card-body { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 7px; }
header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
header strong { color: var(--cy-text); font-size: 14px; }
.cy-badge { padding: 1px 7px; border: 1px solid var(--cy-border); border-radius: 999px; color: var(--cy-muted); font-size: 10px; }
.cy-badge.default { color: var(--cy-accent-strong); border-color: color-mix(in srgb, var(--cy-accent-strong) 40%, var(--cy-border)); }
.cy-badge.archived { color: var(--cy-warning); }
p { margin: 0; color: var(--cy-muted); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--cy-muted); font-size: 11px; }
button { padding: 5px 10px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-pane); color: var(--cy-text); font-size: 12px; }
button:hover { background: var(--cy-surface-hover); }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
