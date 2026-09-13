<script setup lang="ts">
// CyDropOverlay:拖入聊天区时覆盖式虚线投放区 + 支持类型说明（spec §3.2/§4.6，docs/03 §8.3）；离开即恢复。
//
// 刻意是**纯展示**组件（无 emits、`pointer-events: none`，见样式）：投放落区归聊天区根
// （`CyChatView` 的 `.cy-chat`），覆盖层若自己接收 drag 事件就会成为拖拽目标，使父层按
// dragenter/dragleave 配平算出的"仍在区域内"判断漂移（表现为覆盖层自己闪断）。
// 拖拽事件仍由下层元素接收并冒泡到聊天区根，所以落区语义不受影响。
defineProps<{ active: boolean; count: number }>()
</script>

<template>
  <Transition name="cy-fade">
    <div v-if="active" class="cy-drop-overlay">
      <div class="cy-drop-box">
        <p class="cy-drop-title">松开以添加 {{ count }} 个文件</p>
        <p class="cy-drop-sub">图片 / 视频 / 音频 / 文件（≤10 个，聚合 ≤64MB）</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.cy-drop-overlay { position: absolute; inset: 0; z-index: 30; display: grid; place-items: center; background: var(--cy-overlay); pointer-events: none; }
.cy-drop-box { padding: 26px 40px; border: 2px dashed var(--cy-accent); border-radius: 16px; background: var(--cy-surface); text-align: center; }
.cy-drop-title { margin: 0 0 var(--cy-space-3); color: var(--cy-text); font-size: var(--cy-font-xl); font-weight: 600; }
.cy-drop-sub { margin: 0; color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-fade-enter-active, .cy-fade-leave-active { transition: opacity 0.12s ease; }
.cy-fade-enter-from, .cy-fade-leave-to { opacity: 0; }
</style>
