<script setup lang="ts">
import type { CharacterValidationResult } from '@shared/contracts'
import type { PublicError } from '../../utils/public-error'

defineProps<{
  result?: CharacterValidationResult
  error?: PublicError
  status?: 'idle' | 'loading' | 'success' | 'error'
}>()

const emit = defineEmits<{ validate: []; focus: [path: string] }>()

function severityLabel(severity: 'error' | 'warning'): string {
  return severity === 'error' ? '错误' : '提醒'
}
</script>

<template>
  <section class="cy-validation" aria-labelledby="cy-character-validation-title">
    <header>
      <div>
        <h3 id="cy-character-validation-title">校验</h3>
        <p>保存前会再次由后端校验；valid=false 时即使只有提醒也不能保存。</p>
      </div>
      <button type="button" :disabled="status === 'loading'" @click="emit('validate')">{{ status === 'loading' ? '校验中…' : '运行校验' }}</button>
    </header>
    <div v-if="status === 'idle' && !result" class="cy-validation-empty" role="status">尚未运行校验。</div>
    <div v-else-if="status === 'loading'" class="cy-validation-empty" role="status">正在校验当前草稿…</div>
    <div v-else-if="error" class="cy-validation-error" role="alert">{{ error.message }}</div>
    <template v-else-if="result">
      <div class="cy-validation-summary" :class="{ invalid: !result.valid }" role="status">
        {{ result.valid ? '草稿可以提交（请留意提醒）' : '草稿未通过校验，暂不能保存' }}
        <span v-if="result.estimatedPromptChars !== undefined">约 {{ result.estimatedPromptChars }} 字符</span>
      </div>
      <ul v-if="result.issues.length" class="cy-issue-list">
        <li v-for="issue in result.issues" :key="`${issue.severity}:${issue.code}:${issue.path}:${issue.message}`" :class="issue.severity" :data-issue-path="issue.path">
          <button type="button" @click="emit('focus', issue.path)">
            <span>{{ severityLabel(issue.severity) }}</span>
            <span>{{ issue.message }}</span>
            <code>{{ issue.path || '（全局）' }}</code>
          </button>
        </li>
      </ul>
      <div v-else class="cy-validation-empty" role="status">没有发现问题。</div>
    </template>
  </section>
</template>

<style scoped>
.cy-validation { display: grid; gap: 9px; padding: 13px 14px; border: 1px solid var(--cy-border); border-radius: 12px; background: var(--cy-surface); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
h3 { margin: 0; color: var(--cy-text); font-size: 13px; }
p { margin: 4px 0 0; color: var(--cy-muted); font-size: 11px; line-height: 1.5; }
button { padding: 5px 9px; border: 1px solid var(--cy-border); border-radius: 7px; background: var(--cy-pane); color: var(--cy-text); font-size: 11px; }
button:hover:not(:disabled) { background: var(--cy-surface-hover); }
button:disabled { opacity: .5; }
.cy-validation-empty, .cy-validation-error, .cy-validation-summary { padding: 8px 9px; border-radius: 8px; color: var(--cy-muted); font-size: 11px; }
.cy-validation-error { color: var(--cy-danger); border: 1px dashed var(--cy-danger); }
.cy-validation-summary { color: var(--cy-success); background: var(--cy-surface-soft); }
.cy-validation-summary.invalid { color: var(--cy-danger); }
.cy-validation-summary span { float: right; color: var(--cy-muted); }
.cy-issue-list { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.cy-issue-list li button { display: grid; grid-template-columns: auto 1fr auto; align-items: baseline; width: 100%; gap: 7px; text-align: left; }
.cy-issue-list li.error button { color: var(--cy-danger); border-color: color-mix(in srgb, var(--cy-danger) 45%, var(--cy-border)); }
.cy-issue-list li.warning button { color: var(--cy-warning); }
code { color: var(--cy-muted); font-size: 10px; overflow-wrap: anywhere; }
button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
