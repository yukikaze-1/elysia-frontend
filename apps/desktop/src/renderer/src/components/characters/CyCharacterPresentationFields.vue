<script setup lang="ts">
import type { CharacterDraft } from '@shared/contracts'

defineProps<{ draft: CharacterDraft }>()
const emit = defineEmits<{ update: [path: string, value: unknown] }>()

function update(path: string, event: Event): void {
  emit('update', path, (event.target as HTMLInputElement).value)
}

function updateList(path: string, event: Event): void {
  const values = (event.target as HTMLInputElement).value
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  emit('update', path, values)
}

function updateBoolean(event: Event): void {
  emit('update', 'runtimeDefaults.proactive.enabled', (event.target as HTMLInputElement).checked)
}

function updateInterval(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('update', 'runtimeDefaults.proactive.intervalSeconds', Number.isFinite(value) ? value : 3600)
}
</script>

<template>
  <fieldset class="cy-presentation-fields">
    <legend>声音与呈现</legend>
    <div class="cy-field-row">
      <label>
        <span>声音服务商 ID</span>
        <input data-field-path="/runtimeDefaults/voice/providerId" :value="draft.runtimeDefaults.voice.providerId ?? ''" maxlength="160" @input="update('runtimeDefaults.voice.providerId', $event)" />
      </label>
      <label>
        <span>声音 ID</span>
        <input data-field-path="/runtimeDefaults/voice/voiceId" :value="draft.runtimeDefaults.voice.voiceId ?? ''" maxlength="160" @input="update('runtimeDefaults.voice.voiceId', $event)" />
      </label>
    </div>
    <div class="cy-field-row">
      <label>
        <span>主题色</span>
        <input data-field-path="/presentation/themeColor" :value="draft.presentation.themeColor ?? ''" maxlength="32" placeholder="#8db7f2" @input="update('presentation.themeColor', $event)" />
      </label>
      <label>
        <span>头像资源 ID</span>
        <input data-field-path="/presentation/avatarAssetId" :value="draft.presentation.avatarAssetId ?? ''" maxlength="200" @input="update('presentation.avatarAssetId', $event)" />
      </label>
    </div>
    <label>
      <span>Live2D 模型 ID</span>
      <input data-field-path="/presentation/live2dModelId" :value="draft.presentation.live2dModelId ?? ''" maxlength="200" @input="update('presentation.live2dModelId', $event)" />
    </label>
    <div class="cy-field-row">
      <label>
        <span>待机表情（逗号分隔）</span>
        <input data-field-path="/runtimeDefaults/emotion/idleExpressions" :value="draft.runtimeDefaults.emotion.idleExpressions.join(', ')" maxlength="1000" @input="updateList('runtimeDefaults.emotion.idleExpressions', $event)" />
      </label>
    </div>
  </fieldset>

  <details class="cy-advanced-fields">
    <summary>高级：主动对话</summary>
    <div class="cy-advanced-grid">
      <label class="cy-check-field">
        <input data-field-path="/runtimeDefaults/proactive/enabled" type="checkbox" :checked="draft.runtimeDefaults.proactive.enabled" @change="updateBoolean" />
        <span>允许角色主动发起对话</span>
      </label>
      <label>
        <span>唤醒词（逗号分隔）</span>
        <input data-field-path="/runtimeDefaults/wakeWords" :value="draft.runtimeDefaults.wakeWords.join(', ')" maxlength="1000" @input="updateList('runtimeDefaults.wakeWords', $event)" />
      </label>
      <label>
        <span>主动间隔（秒）</span>
        <input data-field-path="/runtimeDefaults/proactive/intervalSeconds" type="number" min="60" max="86400" :value="draft.runtimeDefaults.proactive.intervalSeconds" @input="updateInterval" />
      </label>
      <label>
        <span>主动触发词（逗号分隔）</span>
        <input data-field-path="/runtimeDefaults/proactive/triggers" :value="draft.runtimeDefaults.proactive.triggers.join(', ')" maxlength="1000" @input="updateList('runtimeDefaults.proactive.triggers', $event)" />
      </label>
    </div>
    <p class="cy-help">主动对话仍受应用权限、连接状态和后端策略约束。</p>
  </details>
</template>

<style scoped>
.cy-presentation-fields, .cy-advanced-fields { min-width: 0; padding: 13px 14px; border: 1px solid var(--cy-border); border-radius: 12px; background: var(--cy-surface); }
legend { padding: 0 5px; color: var(--cy-text); font-size: 13px; font-weight: 650; }
.cy-field-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
label { display: grid; gap: 5px; min-width: 0; color: var(--cy-muted); font-size: 11px; }
input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--cy-border); border-radius: 9px; background: var(--cy-pane); color: var(--cy-text); font: inherit; }
.cy-advanced-fields summary { cursor: pointer; color: var(--cy-text); font-size: 13px; font-weight: 650; }
.cy-advanced-grid { display: grid; gap: 10px; margin-top: 12px; }
.cy-check-field { display: flex; align-items: center; gap: 8px; }
.cy-check-field input { width: auto; }
.cy-help { margin: 8px 0 0; color: var(--cy-muted); font-size: 11px; line-height: 1.5; }
input:focus-visible, summary:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
@media (max-width: 720px) { .cy-field-row { grid-template-columns: 1fr; } }
</style>
