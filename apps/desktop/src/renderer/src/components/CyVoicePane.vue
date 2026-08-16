<script setup lang="ts">
// CyVoicePane:设置中心「语音」子页（阶段 4 批次 B，spec §5.12 / doc 11 §2.3/§2.6/§3）——
// 开关绑 settingsStore.voice（enabled/realtimeEnabled/autoReadReply/showCaptions）；
// 麦克风设备下拉（navigator.mediaDevices.enumerateDevices 过滤 audioinput，绑 micDeviceId）；
// 「测试麦克风」：录 3s → 本地试听 + 时长 + 错误展示（权限拒绝/无设备），测试录音不入聊天流程（discardRecord 清态）；
// 转写专用 STT Profile 下拉（modelServiceStore.profiles 过滤 type==='stt' && enabled && executionLocation==='backend'，D-P20 不回列 desktop/local），
//   含「使用全局活动 STT」空选项，绑 dictation.sttProfileId；
// 转写插入位置单选（dictation.insertMode）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settings.store'
import { useModelServiceStore } from '../stores/model-service.store'
import { useVoiceStore } from '../stores/voice.store'

const settings = useSettingsStore()
const modelStore = useModelServiceStore()
const voiceStore = useVoiceStore()

const MIC_TEST_MS = 3000

// —— 麦克风设备枚举（枚举失败不阻塞设置页，下拉空项 + 错误提示） ——
const micDevices = ref<Array<{ deviceId: string; label: string }>>([])
const micListError = ref<string>()

onMounted(async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    micDevices.value = devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || `麦克风 ${String(d.deviceId).slice(0, 4)}` }))
  } catch {
    micListError.value = '无法枚举麦克风设备'
  }
})

function onMicDeviceChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  settings.setVoice({ micDeviceId: v || undefined })
}

// —— 开关 ——
type VoiceToggleKey = 'enabled' | 'realtimeEnabled' | 'autoReadReply' | 'showCaptions'
function onToggle(key: VoiceToggleKey, e: Event): void {
  settings.setVoice({ [key]: (e.target as HTMLInputElement).checked })
}

// —— 转写 STT Profile 下拉（D-P20：desktop/local_worker 会 STT_PROFILE_NOT_FOUND，不列） ——
const sttProfiles = computed(() =>
  modelStore.profiles.filter((p) => p.type === 'stt' && p.enabled && p.executionLocation === 'backend')
)
function onSttProfileChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  settings.setDictation({ sttProfileId: v || undefined })
}

// —— 测试麦克风：录 3s → 试听 + 时长；失败展示 micError ——
const micTesting = ref(false)
const micTestDuration = ref<number>()
const micTestError = ref<string>()
let micTestTimer: ReturnType<typeof setTimeout> | undefined

/** 等待进入 recording 态：startRecord 可能先过 consent（D-P16 挂起对话框）再恢复。
 *  评审 Important：**consent 挂起期间不得超时判失败**——否则用户停留 >5s 再点「同意」，
 *  confirmConsent 迟到的 startRecord 恢复会进入 recording 而无 3s 自停（无监督持续录音至 10 分钟硬上限）。
 *  评审 re-review：失败路径（startRecord 早退/控制帧拒绝/权限拒绝）的终态 `idle && !consentPending`
 *  在 watcher 注册前已定格，无「变化」事件可触发 → 必须注册前做**初始终态检查**。
 *  判定：
 *  - 注册时 mode==='recording' → true（直接成功）；
 *  - 注册时 mode==='idle' && !consentPending → false（初始即失败，终态已定格）；
 *  - consent 挂起中 → 等确认/取消：
 *    - mode→'recording' → true（含 confirm 后迟到恢复）；
 *    - consent 关闭后 micError/error 置位 → false（confirm 恢复动作已显式失败，立即收口）；
 *    - consent 关闭后无错误 → 宽限窗口（取消 vs confirm 恢复中——confirm 的 startRecord 恢复会
 *      瞬时 idle&&!pending，不得立即判失败）；宽限到点仍 idle → false（取消）。 */
const CONSENT_SETTLE_GRACE_MS = 3000
let recordingWaitStop: (() => void) | undefined
let recordingGraceTimer: ReturnType<typeof setTimeout> | undefined
function waitForRecording(): Promise<boolean> {
  return new Promise((resolve) => {
    if (voiceStore.mode === 'recording') { resolve(true); return }
    if (voiceStore.mode === 'idle' && !voiceStore.consentPending) { resolve(false); return }

    let settled = false
    let stopWatch: (() => void) | undefined
    const settle = (v: boolean): void => {
      if (settled) return
      settled = true
      if (recordingGraceTimer !== undefined) { clearTimeout(recordingGraceTimer); recordingGraceTimer = undefined }
      recordingWaitStop = undefined
      stopWatch?.()
      resolve(v)
    }
    stopWatch = watch(
      () => [voiceStore.mode, voiceStore.consentPending, voiceStore.micError, voiceStore.error] as const,
      ([mode, pending, micErr, err]) => {
        if (mode === 'recording') { settle(true); return }
        if (mode === 'idle' && !pending) {
          if (micErr || err) { settle(false); return }
          if (recordingGraceTimer !== undefined) clearTimeout(recordingGraceTimer)
          recordingGraceTimer = setTimeout(() => settle(false), CONSENT_SETTLE_GRACE_MS)
        }
      }
    )
    recordingWaitStop = stopWatch
  })
}

async function onTestMic(): Promise<void> {
  if (micTesting.value) return
  micTesting.value = true
  micTestError.value = undefined
  micTestDuration.value = undefined
  await voiceStore.startRecord()
  const started = await waitForRecording()
  if (!started) {
    micTesting.value = false
    micTestError.value = voiceStore.micError?.message ?? voiceStore.error?.message ?? '麦克风启动失败'
    return
  }
  // 已进 recording（直接成功或 consent 确认后迟到恢复）→ 武装 3s 自停
  micTestTimer = setTimeout(() => { void finishMicTest() }, MIC_TEST_MS)
}

async function finishMicTest(): Promise<void> {
  await voiceStore.stopRecord()
  micTesting.value = false
  micTestDuration.value = Math.max(1, Math.round(voiceStore.record.elapsedMs / 1000))
  voiceStore.replayRecord()
  // 测试录音不入聊天流程：立即丢弃（discardRecord 清态回 idle）
  await voiceStore.discardRecord()
}

onBeforeUnmount(() => {
  recordingWaitStop?.()
  if (recordingGraceTimer !== undefined) { clearTimeout(recordingGraceTimer); recordingGraceTimer = undefined }
  if (micTestTimer !== undefined) clearTimeout(micTestTimer)
  // 离开设置页时若仍有本页发起的测试录音（测试中/待发送态）→ 清理，不残留聊天待发送条
  if (micTesting.value || micTestDuration.value !== undefined) {
    // consent 挂起 → 取消本页测试麦克风的挂起动作：防 pane 卸载后点「同意」启动无监督录音
    if (voiceStore.consentPending) {
      voiceStore.dismissConsent()
    } else if (voiceStore.mode === 'recording' || voiceStore.mode === 'record_pending') {
      void voiceStore.reset()
    }
  }
})
</script>

<template>
  <section class="cy-voice-pane" aria-label="语音设置">
    <h3 class="cy-vp-title">语音输入</h3>

    <div class="cy-vp-group">
      <label class="cy-vp-row">
        <input type="checkbox" :checked="settings.voice.enabled" @change="onToggle('enabled', $event)" />
        <span class="cy-vp-label">启用语音输入<small>普通录音 + 输入法转写入口</small></span>
      </label>
      <label class="cy-vp-row">
        <input
          type="checkbox"
          :checked="settings.voice.realtimeEnabled"
          :disabled="!settings.voice.enabled"
          @change="onToggle('realtimeEnabled', $event)"
        />
        <span class="cy-vp-label">启用实时语音会话</span>
      </label>
      <label class="cy-vp-row">
        <input type="checkbox" :checked="settings.voice.autoReadReply" @change="onToggle('autoReadReply', $event)" />
        <span class="cy-vp-label">TTS 自动朗读 AI 回复</span>
      </label>
      <label class="cy-vp-row">
        <input type="checkbox" :checked="settings.voice.showCaptions" @change="onToggle('showCaptions', $event)" />
        <span class="cy-vp-label">显示直接语音字幕</span>
      </label>
    </div>

    <div class="cy-vp-group">
      <h4 class="cy-vp-sub">麦克风</h4>
      <div v-if="micListError" class="cy-vp-error" role="alert">{{ micListError }}</div>
      <label class="cy-vp-field">
        <span class="cy-vp-field-label">麦克风设备</span>
        <select :value="settings.voice.micDeviceId ?? ''" @change="onMicDeviceChange">
          <option value="">默认麦克风</option>
          <option v-for="d in micDevices" :key="d.deviceId" :value="d.deviceId">{{ d.label }}</option>
        </select>
      </label>
      <div class="cy-vp-mictest">
        <button class="cy-vp-btn" :disabled="micTesting || !settings.voice.enabled" @click="onTestMic">
          {{ micTesting ? '录音中…' : '测试麦克风' }}
        </button>
        <span v-if="micTestDuration !== undefined" class="cy-vp-mictest-result">录音 {{ micTestDuration }}s，已试听</span>
        <span v-if="micTestError" class="cy-vp-error" role="alert">{{ micTestError }}</span>
      </div>
    </div>

    <div class="cy-vp-group">
      <h4 class="cy-vp-sub">输入法转写</h4>
      <label class="cy-vp-field">
        <span class="cy-vp-field-label">转写 STT Profile</span>
        <select :value="settings.dictation.sttProfileId ?? ''" @change="onSttProfileChange">
          <option value="">使用全局活动 STT</option>
          <option v-for="p in sttProfiles" :key="p.id" :value="`${p.provider}/${p.model}`">{{ p.displayName }}（{{ p.model }}）</option>
        </select>
      </label>
      <fieldset class="cy-vp-radio-group">
        <legend>转写插入位置</legend>
        <label class="cy-vp-radio">
          <input
            type="radio"
            name="dictation-insert-mode"
            value="append"
            :checked="settings.dictation.insertMode === 'append'"
            @change="settings.setDictation({ insertMode: 'append' })"
          />
          <span>追加草稿末尾</span>
        </label>
        <label class="cy-vp-radio">
          <input
            type="radio"
            name="dictation-insert-mode"
            value="replace_selection"
            :checked="settings.dictation.insertMode === 'replace_selection'"
            @change="settings.setDictation({ insertMode: 'replace_selection' })"
          />
          <span>替换当前选区</span>
        </label>
      </fieldset>
    </div>
  </section>
</template>

<style scoped>
.cy-voice-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cy-vp-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.cy-vp-group {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 14px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
}

.cy-vp-sub {
  margin: 0 0 2px;
  font-size: 13px;
  font-weight: 600;
  color: var(--cy-muted);
}

.cy-vp-row {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
}

.cy-vp-label {
  display: flex;
  flex-direction: column;
  gap: 1px;
  color: var(--cy-text);
  font-size: 13px;
}

.cy-vp-label small {
  color: var(--cy-muted);
  font-size: 11px;
}

.cy-vp-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cy-vp-field-label {
  color: var(--cy-muted);
  font-size: 12px;
}

.cy-vp-field select {
  padding: 6px 9px;
  border: 1px solid var(--cy-border);
  border-radius: 8px;
  background: var(--cy-surface-soft);
  color: var(--cy-text);
  font-size: 13px;
}

.cy-vp-mictest {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.cy-vp-btn {
  padding: 6px 14px;
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

.cy-vp-mictest-result {
  color: var(--cy-success);
  font-size: 12px;
}

.cy-vp-error {
  color: var(--cy-danger);
  font-size: 12px;
}

.cy-vp-radio-group {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 0;
  padding: 0;
  border: 0;
}

.cy-vp-radio-group legend {
  color: var(--cy-muted);
  font-size: 12px;
  margin-bottom: 2px;
}

.cy-vp-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--cy-text);
  font-size: 13px;
}
</style>
