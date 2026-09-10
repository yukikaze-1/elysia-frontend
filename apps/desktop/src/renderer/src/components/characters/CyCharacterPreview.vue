<script setup lang="ts">
import { computed, ref } from 'vue'
import CyMarkdown from '../CyMarkdown.vue'
import { useCharacterEditorStore } from '../../stores/character-editor.store'
import { characterErrorMessage } from './character-error'

const editor = useCharacterEditorStore()
const userMessage = ref('请用一句话介绍一下自己。')
const previewErrorMessage = computed(() => characterErrorMessage(editor.previewError, '预览失败，请稍后重试。'))

async function preview(): Promise<void> {
  if (!userMessage.value.trim() || editor.previewStatus === 'loading') return
  try { await editor.previewCharacter(userMessage.value.trim()) } catch { /* Store exposes a safe public error. */ }
}
</script>

<template>
  <section class="cy-preview" aria-labelledby="cy-character-preview-title">
    <header>
      <div>
        <h3 id="cy-character-preview-title">临时预览</h3>
        <p>仅使用当前草稿生成预览，不进入会话、记忆或 TTS。</p>
      </div>
      <span v-if="editor.previewStatus === 'success'" class="cy-preview-chip">临时结果</span>
    </header>
    <label>
      <span>给角色的消息</span>
      <textarea v-model="userMessage" rows="2" maxlength="4000" placeholder="输入一条想测试的消息" />
    </label>
    <button type="button" :disabled="editor.previewStatus === 'loading' || !userMessage.trim() || !editor.remoteAvailable" @click="preview">
      {{ editor.previewStatus === 'loading' ? '预览中…' : editor.remoteAvailable ? '生成预览' : '离线不可预览' }}
    </button>
    <div v-if="editor.previewStatus === 'error'" class="cy-preview-error" role="alert">{{ previewErrorMessage }}</div>
    <div v-else-if="editor.previewStatus === 'success' && editor.preview" class="cy-preview-result">
      <CyMarkdown :source="editor.preview.reply" />
      <small>本结果不会修改草稿。</small>
    </div>
    <div v-else class="cy-preview-empty" role="status">运行预览后，结果会显示在这里。</div>
  </section>
</template>

<style scoped>
.cy-preview { display: grid; gap: var(--cy-space-4-5); padding: var(--cy-space-6-5) var(--cy-space-7); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); background: var(--cy-surface); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--cy-space-5); }
h3 { margin: 0; color: var(--cy-text); font-size: var(--cy-font-lg); }
p, small { margin: var(--cy-space-2) 0 0; color: var(--cy-muted); font-size: var(--cy-font-sm); line-height: 1.5; }
label { display: grid; gap: var(--cy-space-2-5); color: var(--cy-muted); font-size: var(--cy-font-sm); }
textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: var(--cy-space-4) var(--cy-space-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4-5); background: var(--cy-pane); color: var(--cy-text); font: inherit; }
button { justify-self: start; padding: var(--cy-space-3) var(--cy-space-5-5); border: 1px solid var(--cy-accent-strong); border-radius: var(--cy-radius-4); background: var(--cy-pane); color: var(--cy-accent-strong); font-size: var(--cy-font-md); }
button:disabled { opacity: .5; cursor: default; }
.cy-preview-chip { padding: var(--cy-space-1) var(--cy-space-3-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-pill); color: var(--cy-muted); font-size: var(--cy-font-xs); }
.cy-preview-result { padding: var(--cy-space-5); border-radius: var(--cy-radius-4-5); background: var(--cy-surface-soft); color: var(--cy-text); }
.cy-preview-result small { display: block; margin-top: var(--cy-space-4); }
.cy-preview-error { color: var(--cy-danger); font-size: var(--cy-font-sm); }
.cy-preview-empty { color: var(--cy-muted); font-size: var(--cy-font-sm); }
textarea:focus-visible, button:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
