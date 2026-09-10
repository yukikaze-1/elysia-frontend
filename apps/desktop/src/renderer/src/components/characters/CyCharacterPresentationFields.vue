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

/** 主动间隔的契约下限/上限（与输入框 min/max 同源，避免两处各写一份） */
const INTERVAL_FALLBACK = 3600
const INTERVAL_MIN = 60
const INTERVAL_MAX = 86400

function updateInterval(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim()
  // 2026-09-10 修复：`Number('')` 是 0（有限数），因此原实现把「清空输入框」解释成
  // intervalSeconds=0，与输入框 min=60 冲突（native rangeUnderflow 会拦住整个表单提交，
  // 而该字段位于折叠的「高级：主动对话」内，用户只会看到「点保存没反应」）。
  // 清空/非数值/超界回退默认值；不夹取到边界，避免把用户的中间输入静默改写。
  const parsed = Number(raw)
  const value = raw === '' || !Number.isFinite(parsed) || parsed < INTERVAL_MIN || parsed > INTERVAL_MAX
    ? INTERVAL_FALLBACK
    : parsed
  emit('update', 'runtimeDefaults.proactive.intervalSeconds', value)
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
        <input data-field-path="/runtimeDefaults/proactive/intervalSeconds" type="number" :min="INTERVAL_MIN" :max="INTERVAL_MAX" :value="draft.runtimeDefaults.proactive.intervalSeconds" @input="updateInterval" />
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
.cy-presentation-fields, .cy-advanced-fields { min-width: 0; padding: var(--cy-space-6-5) var(--cy-space-7); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); background: var(--cy-surface); }
legend { padding: 0 var(--cy-space-2-5); color: var(--cy-text); font-size: var(--cy-font-lg); font-weight: 650; }
.cy-field-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--cy-space-5); margin-bottom: var(--cy-space-5); }
label { display: grid; gap: var(--cy-space-2-5); min-width: 0; color: var(--cy-muted); font-size: var(--cy-font-sm); }
input { width: 100%; box-sizing: border-box; padding: var(--cy-space-4) var(--cy-space-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4-5); background: var(--cy-pane); color: var(--cy-text); font: inherit; }
.cy-advanced-fields summary { cursor: pointer; color: var(--cy-text); font-size: var(--cy-font-lg); font-weight: 650; }
.cy-advanced-grid { display: grid; gap: var(--cy-space-5); margin-top: var(--cy-space-6); }
.cy-check-field { display: flex; align-items: center; gap: var(--cy-space-4); }
.cy-check-field input { width: auto; }
.cy-help { margin: var(--cy-space-4) 0 0; color: var(--cy-muted); font-size: var(--cy-font-sm); line-height: 1.5; }
input:focus-visible, summary:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
@media (max-width: 720px) { .cy-field-row { grid-template-columns: 1fr; } }
</style>
