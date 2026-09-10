<script setup lang="ts">
// CyTtsVoices:TTS 声音列表与试听（阶段 4 批次 A，spec §3.3/§5.4 + brief Step 8）。
// 声音列表来自 modelStore.voices（id/name/languages）；currentVoice 高亮；「设为当前声音」→ modelStore.setVoice(voiceId 字符串)；
// 「试听」→ modelStore.preview({ voiceId })——preview 是「可调用 + 可读状态」双用句柄：
// 调用触发试听，`.url`/`.error` 读取结果（响应式 getter）；试听为独立操作，不打断当前生成。
// 播放只跟随本次按钮操作显式触发，不使用 autoplay：preview URL 会跨 tab 保留，若在重新挂载时 autoplay，
// TTS → STT → TTS 会把上一段试听再次播放。
import { nextTick, ref, computed } from 'vue'
import { useModelServiceStore } from '../stores/model-service.store'
import { errorMessage } from '../utils/error-message'

const modelStore = useModelServiceStore()
const previewAudio = ref<HTMLAudioElement>()
// 多套 UI 基础：错误文案统一走映射器（store 只产 code）
const voicesErrorText = computed(() => errorMessage(modelStore.voicesError, '获取声音列表失败，请稍后重试。'))

async function onPreview(voiceId: string): Promise<void> {
  await modelStore.preview({ voiceId })
  if (!modelStore.preview?.url) return
  await nextTick()
  const audio = previewAudio.value
  if (!audio) return // 请求完成前已离开 TTS 页签：不在后续重新挂载时补播
  audio.currentTime = 0
  void audio.play().catch(() => { /* 播放策略拒绝时保留 controls，允许用户手动播放 */ })
}
function onSetVoice(voiceId: string): void { void modelStore.setVoice(voiceId) }
</script>

<template>
  <section class="cy-tts-voices" aria-label="TTS 声音">
    <h3 class="cy-tts-title">TTS 声音</h3>

    <div v-if="modelStore.voicesError" class="cy-ms-error" role="alert">{{ voicesErrorText }}</div>

    <div v-if="!modelStore.voices || modelStore.voices.length === 0" class="cy-ms-state">暂无可用声音</div>
    <ul v-else class="cy-tts-list">
      <li
        v-for="v in modelStore.voices"
        :key="v.id"
        class="cy-tts-item"
        :class="{ current: modelStore.currentVoice === v.id }"
        :data-voice-id="v.id"
      >
        <div class="cy-tts-meta">
          <strong>{{ v.name || v.id }}</strong>
          <span class="cy-tts-id">{{ v.id }}</span>
          <span class="cy-tts-lang">{{ v.languages.length ? v.languages.join(' / ') : '—' }}</span>
          <span v-if="modelStore.currentVoice === v.id" class="cy-tts-current">当前声音</span>
        </div>
        <div class="cy-tts-actions">
          <button class="cy-profile-btn" :disabled="modelStore.currentVoice === v.id" @click="onSetVoice(v.id)">设为当前声音</button>
          <button class="cy-profile-btn" :disabled="modelStore.previewing" @click="onPreview(v.id)">试听</button>
        </div>
      </li>
    </ul>

    <div v-if="modelStore.preview?.error" class="cy-ms-error" role="alert">{{ modelStore.preview.error }}</div>
    <audio
      v-if="modelStore.preview?.url"
      ref="previewAudio"
      :src="modelStore.preview.url"
      class="cy-tts-audio"
      controls
    />
  </section>
</template>

<style scoped>
.cy-tts-voices { display: flex; flex-direction: column; gap: var(--cy-space-5); margin-top: var(--cy-space-7); padding-top: var(--cy-space-6); border-top: 1px solid var(--cy-border); }
.cy-tts-title { margin: 0; font-size: var(--cy-font-lg); color: var(--cy-muted); font-weight: 600; }
.cy-ms-error { display: flex; align-items: center; gap: var(--cy-space-4); padding: var(--cy-space-4) var(--cy-space-5-5); color: var(--cy-danger); background: var(--cy-surface-soft); border: 1px dashed var(--cy-danger); border-radius: var(--cy-radius-5); font-size: var(--cy-font-md); }
.cy-ms-state { padding: var(--cy-space-9) 0; color: var(--cy-muted); text-align: center; font-size: var(--cy-font-lg); }
.cy-tts-list { display: flex; flex-direction: column; gap: var(--cy-space-3-5); margin: 0; padding: 0; list-style: none; }
.cy-tts-item { display: flex; align-items: center; justify-content: space-between; gap: var(--cy-space-5); flex-wrap: wrap; padding: var(--cy-space-4-5) var(--cy-space-6); background: var(--cy-surface); border: 1px solid var(--cy-border); border-radius: 11px; }
.cy-tts-item.current { border-color: var(--cy-accent-strong); }
.cy-tts-meta { display: flex; align-items: center; gap: var(--cy-space-4); flex-wrap: wrap; font-size: var(--cy-font-lg); }
.cy-tts-id { color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-tts-lang { color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-tts-current { padding: var(--cy-space-0-5) var(--cy-space-4); border-radius: var(--cy-radius-pill); background: var(--cy-accent); color: var(--cy-accent-text); font-size: var(--cy-font-sm); }
.cy-tts-actions { display: flex; gap: var(--cy-space-3-5); }
.cy-profile-btn { display: inline-flex; align-items: center; gap: var(--cy-space-2-5); padding: var(--cy-space-2-5) var(--cy-space-5-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-surface); color: var(--cy-text); font-size: var(--cy-font-md); }
.cy-profile-btn:disabled { opacity: 0.55; cursor: default; }
.cy-profile-btn:hover:not(:disabled) { background: var(--cy-surface-hover); }
.cy-tts-audio { width: 100%; }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
