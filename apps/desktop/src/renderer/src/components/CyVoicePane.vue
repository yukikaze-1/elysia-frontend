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
import CySwitch from './CySwitch.vue'

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

// —— 开关（UII-QQ 设置页批次：CySwitch 统一布尔开关，handler 收布尔） ——
type VoiceToggleKey = 'enabled' | 'realtimeEnabled' | 'autoReadReply' | 'showCaptions'
function onToggle(key: VoiceToggleKey, checked: boolean): void {
  settings.setVoice({ [key]: checked })
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
 *  评审 Important：consent 挂起期间不得超时判失败——否则用户停留 >5s 再点「同意」，
 *  confirmConsent 迟到的 startRecord 恢复会进入 recording 而无 3s 自停（无监督持续录音至 10 分钟硬上限）。
 *  评审 re-review：失败路径（startRecord 早退/控制帧拒绝/权限拒绝）的终态 `idle && !consentPending`
 *  在 watcher 注册前已定格，无「变化」事件可触发 → 必须注册前做**初始终态检查**。
 *  评审轮 3：以 voiceStore.confirmDispatching（confirm 重发在途信号）替代时间窗——
 *  confirm 后重发的 startRecord 可能因 getUserMedia 权限提示 >3s 才进 recording（mode 保持 idle），
 *  时间窗会在此误判失败 → 无监督录音；只要 confirmDispatching 为 true 就继续等（无时间窗）。
 *  判定：
 *  - 注册时 mode==='recording' → true（直接成功）；
 *  - 注册时 idle && !consentPending && !confirmDispatching → false（初始即失败，终态已定格）；
 *  - 变化：mode→'recording' → true（含 confirm 后迟到恢复）；idle && !pending && !confirmDispatching → false
 *    （取消=dismissConsent 立即 false；confirm 动作失败=finally 复位后同样经此收口）；
 *    consentPending 或 confirmDispatching 为 true → 继续等（慢 getUserMedia/后端）。 */
let recordingWaitStop: (() => void) | undefined
function waitForRecording(): Promise<boolean> {
  return new Promise((resolve) => {
    if (voiceStore.mode === 'recording') { resolve(true); return }
    if (voiceStore.mode === 'idle' && !voiceStore.consentPending && !voiceStore.confirmDispatching) { resolve(false); return }

    let settled = false
    let stopWatch: (() => void) | undefined
    const settle = (v: boolean): void => {
      if (settled) return
      settled = true
      recordingWaitStop = undefined
      stopWatch?.()
      resolve(v)
    }
    stopWatch = watch(
      () => [voiceStore.mode, voiceStore.consentPending, voiceStore.confirmDispatching] as const,
      ([mode, pending, confirming]) => {
        if (mode === 'recording') { settle(true); return }
        if (mode === 'idle' && !pending && !confirming) settle(false)
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
  if (micTestTimer !== undefined) clearTimeout(micTestTimer)
  // 卸载契约（P0-01 §5.1）：离开设置页时若仍有本页发起的测试录音 → 清理，不残留聊天待发送条；
  // guard 仅由本页 mic 测试痕迹触发（不误杀聊天页进行中的录音，§10 残留不动）
  if (micTesting.value || micTestDuration.value !== undefined) {
    // consent 挂起 → 取消本页测试麦克风的挂起动作：防 pane 卸载后点「同意」启动无监督录音
    if (voiceStore.consentPending) {
      voiceStore.dismissConsent()
    } else if (voiceStore.mode === 'recording' || voiceStore.mode === 'record_pending') {
      void voiceStore.discardRecord() // 替代 reset()：仍清理后端会话（discardRecord 清态回 idle）
    }
  }
  // 无条件清瞬时错误：覆盖 onTestMic 失败残留在 idle 的 micError（防聊天页 composer banner 误展示）；
  // clearTransientErrors 仅清 micError/error/notice，不触采集/录音
  voiceStore.clearTransientErrors()
})
</script>

<template>
  <section class="cy-voice-pane" aria-label="语音设置">
    <h3 class="cy-vp-title">语音输入</h3>

    <div class="cy-vp-group">
      <label class="cy-vp-row">
        <CySwitch :model-value="settings.voice.enabled" aria-label="启用语音输入" @change="(v) => onToggle('enabled', v)" />
        <span class="cy-vp-label">启用语音输入<small>普通录音 + 输入法转写入口</small></span>
      </label>
      <label class="cy-vp-row">
        <CySwitch
          :model-value="settings.voice.realtimeEnabled"
          :disabled="!settings.voice.enabled"
          aria-label="启用实时语音会话"
          @change="(v) => onToggle('realtimeEnabled', v)"
        />
        <span class="cy-vp-label">启用实时语音会话</span>
      </label>
      <label class="cy-vp-row">
        <CySwitch :model-value="settings.voice.autoReadReply" aria-label="TTS 自动朗读 AI 回复" @change="(v) => onToggle('autoReadReply', v)" />
        <span class="cy-vp-label">TTS 自动朗读 AI 回复</span>
      </label>
      <label class="cy-vp-row">
        <CySwitch :model-value="settings.voice.showCaptions" aria-label="显示直接语音字幕" @change="(v) => onToggle('showCaptions', v)" />
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
  gap: var(--cy-space-8);
}

.cy-vp-title {
  margin: 0;
  font-size: var(--cy-font-xl);
  font-weight: 600;
}

.cy-vp-group {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-4-5);
  padding: var(--cy-space-6) var(--cy-space-7);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-6);
}

.cy-vp-sub {
  margin: 0 0 var(--cy-space-1);
  font-size: var(--cy-font-lg);
  font-weight: 600;
  color: var(--cy-muted);
}

.cy-vp-row {
  display: flex;
  align-items: center;
  gap: var(--cy-space-4-5);
  cursor: pointer;
}

.cy-vp-label {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-0-5);
  color: var(--cy-text);
  font-size: var(--cy-font-lg);
}

.cy-vp-label small {
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

.cy-vp-field {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-2-5);
}

.cy-vp-field-label {
  color: var(--cy-muted);
  font-size: var(--cy-font-md);
}

.cy-vp-field select {
  padding: var(--cy-space-3) var(--cy-space-4-5);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-4);
  background: var(--cy-surface-soft);
  color: var(--cy-text);
  font-size: var(--cy-font-lg);
}

.cy-vp-mictest {
  display: flex;
  align-items: center;
  gap: var(--cy-space-5);
  flex-wrap: wrap;
}

.cy-vp-btn {
  padding: var(--cy-space-3) var(--cy-space-7);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-4);
  background: var(--cy-surface-soft);
  color: var(--cy-text);
  font-size: var(--cy-font-md);
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
  font-size: var(--cy-font-md);
}

.cy-vp-error {
  color: var(--cy-danger);
  font-size: var(--cy-font-md);
}

.cy-vp-radio-group {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-3-5);
  margin: 0;
  padding: 0;
  border: 0;
}

.cy-vp-radio-group legend {
  color: var(--cy-muted);
  font-size: var(--cy-font-md);
  margin-bottom: var(--cy-space-1);
}

.cy-vp-radio {
  display: flex;
  align-items: center;
  gap: var(--cy-space-4);
  cursor: pointer;
  color: var(--cy-text);
  font-size: var(--cy-font-lg);
}
</style>
