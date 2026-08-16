<script setup lang="ts">
// CyVoiceConsentDialog:后端 STT 首次操作确认对话框（D-P16，spec §5.12/§6）——
// 「音频将发送至后端识别（本机不保留）」+ [取消]→dismissConsent + [同意]→confirmConsent（持久化 consentBackendStt「不再提示」+ 重发挂起动作）。
// 自含 v-if=consentPending；由 CyChatInput（语音入口）与 CySettingsView（测试麦克风）双宿主（两视图互斥，不双渲染）。
import { useVoiceStore } from '../stores/voice.store'

const voiceStore = useVoiceStore()

function onCancel(): void { voiceStore.dismissConsent() }
function onConfirm(): void { void voiceStore.confirmConsent() }
</script>

<template>
  <div
    v-if="voiceStore.consentPending"
    class="cy-consent-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="后端语音识别确认"
  >
    <div class="cy-consent-box">
      <strong>语音将发送至后端识别</strong>
      <p>音频将发送至后端识别（本机不保留）。同意后不再提示。</p>
      <div class="cy-consent-actions">
        <button class="cy-consent-btn" @click="onCancel">取消</button>
        <button class="cy-consent-btn cy-consent-confirm" @click="onConfirm">同意</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cy-consent-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--cy-overlay);
}

.cy-consent-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(360px, 84vw);
  padding: 18px 20px;
  border-radius: 14px;
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  box-shadow: var(--cy-shadow);
}

.cy-consent-box strong {
  font-size: 15px;
}

.cy-consent-box p {
  margin: 0;
  color: var(--cy-muted);
  font-size: 13px;
  line-height: 1.5;
}

.cy-consent-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.cy-consent-btn {
  padding: 6px 16px;
  border: 1px solid var(--cy-border);
  border-radius: 9px;
  background: var(--cy-surface);
  color: var(--cy-text);
  font-size: 13px;
}

.cy-consent-btn:hover {
  background: var(--cy-surface-hover);
}

.cy-consent-confirm {
  border-color: var(--cy-accent);
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}
</style>
