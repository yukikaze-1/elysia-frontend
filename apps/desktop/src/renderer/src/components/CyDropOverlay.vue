<script setup lang="ts">
// CyDropOverlay:拖入聊天区时覆盖式虚线投放区 + 支持类型说明（spec §3.2/§4.6，docs/03 §8.3）；离开即恢复。
defineProps<{ active: boolean; count: number }>()
const emit = defineEmits<{ leave: [] }>()
</script>

<template>
  <Transition name="cy-fade">
    <div v-if="active" class="cy-drop-overlay" @dragleave.self="emit('leave')" @drop.prevent="emit('leave')">
      <div class="cy-drop-box">
        <p class="cy-drop-title">松开以添加 {{ count }} 个文件</p>
        <p class="cy-drop-sub">图片 / 视频 / 音频 / 文件（≤10 个，聚合 ≤64MB）</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.cy-drop-overlay { position: absolute; inset: 0; z-index: 30; display: grid; place-items: center; background: var(--cy-overlay); pointer-events: auto; }
.cy-drop-box { padding: 26px 40px; border: 2px dashed var(--cy-accent); border-radius: 16px; background: var(--cy-surface); text-align: center; }
.cy-drop-title { margin: 0 0 var(--cy-space-3); color: var(--cy-text); font-size: var(--cy-font-xl); font-weight: 600; }
.cy-drop-sub { margin: 0; color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-fade-enter-active, .cy-fade-leave-active { transition: opacity 0.12s ease; }
.cy-fade-enter-from, .cy-fade-leave-to { opacity: 0; }
</style>
