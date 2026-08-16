<script setup lang="ts">
// CyDictationHint:输入法转写字幕浮层（spec §5.12 / doc 11 §3）——mode==='dictating' 时浮于输入区上方。
// dictation.caption 实时字幕 + 「松开提交 · 上滑取消」提示；按住期间由 CyChatInput 的 pointer 事件控制 start/stop/cancel。
import { useVoiceStore } from '../stores/voice.store'

const voiceStore = useVoiceStore()
</script>

<template>
  <div class="cy-dictation-hint" role="status" aria-label="输入法转写">
    <span class="cy-dh-caption">{{ voiceStore.dictation.caption || '正在聆听…' }}</span>
    <span class="cy-dh-tip">松开提交 · 上滑取消</span>
  </div>
</template>

<style scoped>
.cy-dictation-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  margin-top: 8px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-accent-strong);
  border-radius: 12px;
}

.cy-dh-caption {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--cy-text);
  font-size: 13px;
}

.cy-dh-tip {
  flex: 0 0 auto;
  color: var(--cy-muted);
  font-size: 11px;
  white-space: nowrap;
}
</style>
