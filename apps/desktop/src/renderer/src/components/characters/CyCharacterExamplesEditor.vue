<script setup lang="ts">
import type { CharacterExample } from '@shared/contracts'

const props = defineProps<{ examples: CharacterExample[] }>()
const emit = defineEmits<{
  update: [examples: CharacterExample[]]
  focus: [index: number, field: 'user' | 'assistant']
}>()

function cloneExamples(): CharacterExample[] {
  return props.examples.map((example) => ({ ...example }))
}

function addExample(): void {
  if (props.examples.length >= 20) return
  emit('update', [...cloneExamples(), { user: '', assistant: '' }])
  queueMicrotask(() => emit('focus', props.examples.length, 'user'))
}

function removeExample(index: number): void {
  if (index < 0 || index >= props.examples.length) return
  const next = cloneExamples()
  next.splice(index, 1)
  emit('update', next)
}

function moveExample(index: number, direction: -1 | 1): void {
  const target = index + direction
  if (index < 0 || target < 0 || index >= props.examples.length || target >= props.examples.length) return
  const next = cloneExamples()
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  emit('update', next)
  queueMicrotask(() => emit('focus', target, 'user'))
}

function updateExample(index: number, field: 'user' | 'assistant', value: string): void {
  if (!props.examples[index]) return
  const next = cloneExamples()
  next[index] = { ...next[index], [field]: value }
  emit('update', next)
}
</script>

<template>
  <fieldset class="cy-examples-editor">
    <legend>示例对话</legend>
    <p class="cy-help">用少量示例说明角色的回应方式。最多 20 组，内容会作为 authored 角色定义保存。</p>

    <div v-if="!examples.length" class="cy-empty-example" role="status">还没有示例对话。</div>
    <ol v-else class="cy-example-list">
      <li v-for="(example, index) in examples" :key="index" class="cy-example-item">
        <header>
          <strong>示例 {{ index + 1 }}</strong>
          <div class="cy-example-actions">
            <button type="button" :disabled="index === 0" :aria-label="`示例 ${index + 1} 上移`" @click="moveExample(index, -1)">↑</button>
            <button type="button" :disabled="index === examples.length - 1" :aria-label="`示例 ${index + 1} 下移`" @click="moveExample(index, 1)">↓</button>
            <button type="button" class="danger" :aria-label="`删除示例 ${index + 1}`" @click="removeExample(index)">删除</button>
          </div>
        </header>
        <label>
          <span>用户</span>
          <textarea
            :id="`character-example-${index}-user`"
            :data-field-path="`/promptProfile/examples/${index}/user`"
            :value="example.user"
            rows="2"
            maxlength="2000"
            @focus="emit('focus', index, 'user')"
            @input="updateExample(index, 'user', ($event.target as HTMLTextAreaElement).value)"
          />
        </label>
        <label>
          <span>角色</span>
          <textarea
            :id="`character-example-${index}-assistant`"
            :data-field-path="`/promptProfile/examples/${index}/assistant`"
            :value="example.assistant"
            rows="2"
            maxlength="2000"
            @focus="emit('focus', index, 'assistant')"
            @input="updateExample(index, 'assistant', ($event.target as HTMLTextAreaElement).value)"
          />
        </label>
      </li>
    </ol>

    <footer class="cy-examples-footer">
      <button type="button" :disabled="examples.length >= 20" @click="addExample">添加示例</button>
      <span>{{ examples.length }}/20</span>
    </footer>
  </fieldset>
</template>

<style scoped>
.cy-examples-editor { min-width: 0; padding: 13px 14px; border: 1px solid var(--cy-border); border-radius: 12px; background: var(--cy-surface); }
legend { padding: 0 5px; color: var(--cy-text); font-size: 13px; font-weight: 650; }
.cy-help { margin: 0 0 10px; color: var(--cy-muted); font-size: 11px; line-height: 1.5; }
.cy-empty-example { padding: 9px; border: 1px dashed var(--cy-border); border-radius: 8px; color: var(--cy-muted); font-size: 12px; }
.cy-example-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.cy-example-item { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--cy-border); border-radius: 10px; background: var(--cy-surface-soft); }
.cy-example-item header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cy-example-item header strong { color: var(--cy-text); font-size: 12px; }
.cy-example-actions { display: flex; gap: 5px; }
label { display: grid; gap: 4px; color: var(--cy-muted); font-size: 11px; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: 7px 9px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-pane); color: var(--cy-text); font: inherit; line-height: 1.5; }
.cy-examples-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--cy-muted); font-size: 11px; }
button { padding: 5px 9px; border: 1px solid var(--cy-border); border-radius: 7px; background: var(--cy-pane); color: var(--cy-text); font-size: 11px; }
button.danger { color: var(--cy-danger); }
button:hover:not(:disabled) { background: var(--cy-surface-hover); }
button:disabled { opacity: 0.45; cursor: default; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
