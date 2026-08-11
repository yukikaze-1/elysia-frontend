<script setup lang="ts">
// CyMarkdown:markdown → 消毒 HTML → v-html(C-13)。
// 安全:CSP script-src 'self'(无 unsafe-inline/unsafe-eval)+ utils/markdown sanitize 双保险。
import { computed } from 'vue'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{ source: string }>()

const html = computed(() => renderMarkdown(props.source))
</script>

<template>
  <div class="cy-markdown" v-html="html" />
</template>

<style scoped>
/* scoped 样式不注入 v-html 生成的内容,须用 :deep() 命中 markdown 输出 */
.cy-markdown {
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.cy-markdown :deep(p) {
  margin: 0 0 8px;
}
.cy-markdown :deep(p:last-child) {
  margin-bottom: 0;
}
.cy-markdown :deep(h1),
.cy-markdown :deep(h2),
.cy-markdown :deep(h3) {
  margin: 8px 0;
  font-weight: 600;
  line-height: 1.35;
}
.cy-markdown :deep(h1) {
  font-size: 17px;
}
.cy-markdown :deep(h2) {
  font-size: 16px;
}
.cy-markdown :deep(h3) {
  font-size: 15px;
}
.cy-markdown :deep(ul),
.cy-markdown :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}
.cy-markdown :deep(li) {
  margin: 2px 0;
}
.cy-markdown :deep(strong) {
  font-weight: 600;
}
.cy-markdown :deep(code) {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--cy-surface-soft);
  font-size: 13px;
}
.cy-markdown :deep(pre) {
  margin: 0 0 8px;
  padding: 10px;
  overflow-x: auto;
  border-radius: 8px;
  background: var(--cy-surface-soft);
}
.cy-markdown :deep(pre code) {
  padding: 0;
  background: transparent;
}
.cy-markdown :deep(a) {
  color: var(--cy-accent-strong);
}
.cy-markdown :deep(blockquote) {
  margin: 0 0 8px;
  padding-left: 10px;
  color: var(--cy-muted);
  border-left: 3px solid var(--cy-border);
}
.cy-markdown :deep(hr) {
  margin: 10px 0;
  border: 0;
  border-top: 1px solid var(--cy-border);
}
.cy-markdown :deep(table) {
  margin: 0 0 8px;
  border-collapse: collapse;
}
.cy-markdown :deep(th),
.cy-markdown :deep(td) {
  padding: 5px 9px;
  border: 1px solid var(--cy-border);
}
</style>
