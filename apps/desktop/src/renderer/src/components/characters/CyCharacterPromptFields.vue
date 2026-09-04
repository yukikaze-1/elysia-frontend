<script setup lang="ts">
import type { CharacterDraft } from '@shared/contracts'
import CyCharacterExamplesEditor from './CyCharacterExamplesEditor.vue'

defineProps<{ draft: CharacterDraft }>()
const emit = defineEmits<{ update: [path: string, value: unknown] }>()

function update(path: string, event: Event): void {
  emit('update', path, (event.target as HTMLTextAreaElement).value)
}

function updateExamples(examples: CharacterDraft['promptProfile']['examples']): void {
  emit('update', 'promptProfile.examples', examples)
}

function focusExample(index: number, field: 'user' | 'assistant'): void {
  document.getElementById(`character-example-${index}-${field}`)?.focus()
}
</script>

<template>
  <fieldset class="cy-prompt-fields">
    <legend>人格与对话方式</legend>
    <p class="cy-help">这些是角色的 authored 设定，不是完整 system prompt。请使用自然语言描述。</p>
    <label>
      <span>核心人格 <em>*</em></span>
      <textarea data-field-path="/promptProfile/corePersonality" :value="draft.promptProfile.corePersonality" rows="4" maxlength="8000" required @input="update('promptProfile.corePersonality', $event)" />
    </label>
    <label>
      <span>关系方式 <em>*</em></span>
      <textarea data-field-path="/promptProfile/relationshipStyle" :value="draft.promptProfile.relationshipStyle" rows="3" maxlength="6000" required @input="update('promptProfile.relationshipStyle', $event)" />
    </label>
    <div class="cy-field-row">
      <label>
        <span>情绪风格</span>
        <textarea data-field-path="/promptProfile/emotionStyle" :value="draft.promptProfile.emotionStyle" rows="3" maxlength="6000" @input="update('promptProfile.emotionStyle', $event)" />
      </label>
      <label>
        <span>表达方式 <em>*</em></span>
        <textarea data-field-path="/promptProfile/speakingStyle" :value="draft.promptProfile.speakingStyle" rows="3" maxlength="6000" required @input="update('promptProfile.speakingStyle', $event)" />
      </label>
    </div>
    <label>
      <span>对话主动性</span>
      <textarea data-field-path="/promptProfile/conversationInitiative" :value="draft.promptProfile.conversationInitiative" rows="3" maxlength="6000" @input="update('promptProfile.conversationInitiative', $event)" />
    </label>
  </fieldset>

  <CyCharacterExamplesEditor :examples="draft.promptProfile.examples" @update="updateExamples" @focus="focusExample" />
</template>

<style scoped>
.cy-prompt-fields { display: grid; gap: 11px; min-width: 0; padding: 13px 14px; border: 1px solid var(--cy-border); border-radius: 12px; background: var(--cy-surface); }
legend { padding: 0 5px; color: var(--cy-text); font-size: 13px; font-weight: 650; }
.cy-help { margin: 0; color: var(--cy-muted); font-size: 11px; line-height: 1.5; }
label { display: grid; gap: 5px; min-width: 0; color: var(--cy-muted); font-size: 11px; }
em { color: var(--cy-danger); font-style: normal; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: 8px 10px; border: 1px solid var(--cy-border); border-radius: 9px; background: var(--cy-pane); color: var(--cy-text); font: inherit; line-height: 1.5; }
.cy-field-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
textarea:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
@media (max-width: 720px) { .cy-field-row { grid-template-columns: 1fr; } }
</style>
