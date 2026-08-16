<script setup lang="ts">
// CyVoicePending:待发送语音输入条（spec §5.12 / doc 11 §3）——普通录音停止后显示于 textarea 上方。
// 转写字幕只展示、不写草稿（D-P17 未识别语义）；无字幕时「确认发送」禁用（仅丢弃/重录）。
// [试听] 本地回放 AudioBuffer（replayRecord）；[重录] 丢弃后重新 startRecord；[删除] discardRecord；[确认发送] commitRecord。
import { computed, ref } from 'vue'
import { useVoiceStore } from '../stores/voice.store'

const voiceStore = useVoiceStore()

const transcript = computed(() => voiceStore.record.transcript?.trim() ?? '')
const hasTranscript = computed(() => transcript.value.length > 0)
const hasAudio = computed(() => !!voiceStore.record.audioBuffer)
const committing = ref(false)

function onReplay(): void { voiceStore.replayRecord() }

async function onRerecord(): Promise<void> {
  await voiceStore.discardRecord()
  await voiceStore.startRecord()
}

function onDelete(): void { void voiceStore.discardRecord() }

async function onConfirm(): Promise<void> {
  if (!hasTranscript.value || committing.value) return
  committing.value = true
  await voiceStore.commitRecord()
  committing.value = false
}
</script>

<template>
  <div class="cy-voice-pending" role="status" aria-label="待发送语音">
    <div class="cy-vp-caption">
      <span v-if="hasTranscript" class="cy-vp-text">{{ transcript }}</span>
      <span v-else class="cy-vp-empty">未识别，请重试</span>
    </div>
    <div class="cy-vp-actions">
      <button class="cy-vp-btn" :disabled="!hasAudio" title="试听录音" @click="onReplay">试听</button>
      <button class="cy-vp-btn" title="重新录制" @click="onRerecord">重录</button>
      <button class="cy-vp-btn" title="删除录音" @click="onDelete">删除</button>
      <button
        class="cy-vp-btn cy-vp-send"
        :disabled="!hasTranscript || committing"
        title="确认发送"
        @click="onConfirm"
      >确认发送</button>
    </div>
  </div>
</template>

<style scoped>
.cy-voice-pending {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  margin-bottom: 8px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
}

.cy-vp-caption {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--cy-text);
}

.cy-vp-empty {
  color: var(--cy-muted);
}

.cy-vp-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.cy-vp-btn {
  padding: 5px 11px;
  border: 1px solid var(--cy-border);
  border-radius: 8px;
  background: var(--cy-surface-soft);
  color: var(--cy-text);
  font-size: 12px;
}

.cy-vp-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cy-vp-btn:hover:not(:disabled) {
  background: var(--cy-surface-hover);
}

.cy-vp-send {
  border-color: var(--cy-accent-strong);
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}
</style>
