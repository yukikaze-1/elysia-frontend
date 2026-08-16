<script setup lang="ts">
// CyRealtimeBar:实时语音会话状态条（spec §5.12 / doc 11 §3）——mode==='realtime' 时替换输入区。
// 聆听状态 + partial 字幕 + 轮次数 + [停止]（stopRealtime）。
import { useVoiceStore } from '../stores/voice.store'

const voiceStore = useVoiceStore()

function onStop(): void { void voiceStore.stopRealtime() }
</script>

<template>
  <div class="cy-realtime-bar" role="status" aria-label="实时语音会话">
    <span class="cy-rt-status">
      <i class="cy-rt-pulse" aria-hidden="true" />
      <span>聆听中</span>
    </span>
    <span v-if="voiceStore.realtime.caption" class="cy-rt-caption">{{ voiceStore.realtime.caption }}</span>
    <span class="cy-rt-turn">已说 {{ voiceStore.realtime.turnCount }} 轮</span>
    <button class="cy-rt-stop" @click="onStop">停止</button>
  </div>
</template>

<style scoped>
.cy-realtime-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-rt-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--cy-accent);
  font-size: 13px;
  white-space: nowrap;
}

.cy-rt-pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--cy-accent);
  animation: cy-rt-blink 1.2s ease-in-out infinite;
}

@keyframes cy-rt-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

.cy-rt-caption {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--cy-text);
  font-size: 13px;
}

.cy-rt-turn {
  flex: 0 0 auto;
  color: var(--cy-muted);
  font-size: 12px;
  white-space: nowrap;
}

.cy-rt-stop {
  flex: 0 0 auto;
  padding: 5px 13px;
  border: 1px solid var(--cy-border);
  border-radius: 8px;
  background: var(--cy-surface-soft);
  color: var(--cy-danger);
  font-size: 12px;
}

.cy-rt-stop:hover {
  background: var(--cy-surface-hover);
}
</style>
