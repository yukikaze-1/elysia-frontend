<script setup lang="ts">
// CyTtsPlayer:TTS 播放宿主（隐藏 <audio>，宿主 CyChatView，spec §5.12 / D-P8）——由 voiceStore 驱动：
// watch tts.url → 设 src + play；@ended → onTtsPlaybackEnded（清态）；@error → onTtsPlaybackError（D-P8 onerror 清态）。
// url 清空（audio.session.cancelled / playback 结束）→ 暂停 + 卸载 src。play() 被自动播放策略拒绝 → catch 静默（onerror/ended 兜底）。
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useVoiceStore } from '../stores/voice.store'
import { useLive2dStore } from '../stores/live2d.store'

const voiceStore = useVoiceStore()
const live2dStore = useLive2dStore()
const audioRef = ref<HTMLAudioElement>()

// C1（批次 C）：把 <audio> 宿主告知两边（多套 UI 基础，2026-09-10 方向反转）：
//   · voiceStore 只留诊断句柄（非响应式，不参与口部接线）；
//   · 口部数据源的 attach 目标由**本组件直接告知 live2dStore**——此前 live2dStore 自己去读
//     voiceStore.ttsAudioEl，即功能层伸手取 UI 的 DOM 宿主。现由 UI 主动上报（同 setSurfaceVisible 方向）。
// 卸载一并清空（元素消失 → 口部数据源 detach 归零）。
onMounted(() => {
  const el = audioRef.value ?? null
  voiceStore.setTtsAudioEl(el)
  live2dStore.setTtsAudioElement(el)
})
onUnmounted(() => {
  voiceStore.setTtsAudioEl(null)
  live2dStore.setTtsAudioElement(null)
})

watch(
  () => voiceStore.tts.url,
  (url) => {
    const audio = audioRef.value
    if (!audio) return
    if (url) {
      audio.src = url
      void audio.play().catch(() => { /* 播放被拒不抛未处理；store 态由 ended/error 兜底 */ })
    } else {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }
)

function onEnded(): void { voiceStore.onTtsPlaybackEnded() }
function onError(): void { voiceStore.onTtsPlaybackError() }
</script>

<template>
  <audio ref="audioRef" class="cy-tts-player" @ended="onEnded" @error="onError" aria-hidden="true" />
</template>

<style scoped>
.cy-tts-player {
  display: none;
}
</style>
