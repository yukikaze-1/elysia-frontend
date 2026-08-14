<script setup lang="ts">
// CyMarkdown:markdown → 消毒 HTML → v-html(C-13)。
// G2(D7):代码块复制按钮 + 外部链接经 Main 白名单 + 流式渲染 80ms 尾沿防抖。
// 安全:CSP script-src 'self'(无 unsafe-inline/unsafe-eval)+ utils/markdown sanitize 双保险。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown, trimCodeText } from '../utils/markdown'
import { copyText } from '../utils/clipboard'
import { createTrailingDebounce } from '../utils/debounce-trailing'
import { api } from '../stores/desktop-api'

const props = defineProps<{ source: string }>()

const MARKDOWN_DEBOUNCE_MS = 80
const html = ref('')
let disposed = false
// 尾沿防抖：流式 delta 高频变化合并重解析；停顿/完成保证最终文本（spec §4.6.3）
const scheduleRender = createTrailingDebounce(() => { if (!disposed) html.value = renderMarkdown(props.source) }, MARKDOWN_DEBOUNCE_MS)

watch(() => props.source, () => scheduleRender())
onMounted(() => { html.value = renderMarkdown(props.source) })
onBeforeUnmount(() => { disposed = true })

/** 事件委托（CSP-safe，无内联 handler，spec §4.6.1/§4.6.2） */
function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  const copyBtn = target.closest<HTMLElement>('.cy-code-copy')
  if (copyBtn) {
    const block = copyBtn.closest<HTMLElement>('.cy-code-block')
    const code = block?.querySelector<HTMLElement>('pre code')
    if (code) {
      void copyText(trimCodeText(code.textContent ?? '')).then((ok) => {
        if (!ok) return
        copyBtn.textContent = '已复制'
        setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = '复制' }, 1500)
      })
    }
    e.preventDefault()
    return
  }
  const link = target.closest<HTMLAnchorElement>('a[href]')
  if (link) {
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      if (window.confirm('在浏览器中打开外部链接？')) void api.openExternal(href)
    }
    e.preventDefault() // 一律阻止默认导航（app 窗口内不开窗）
  }
}
</script>

<template>
  <div class="cy-markdown" v-html="html" @click="onClick" />
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
/* —— G2 D7 代码块：语言标签 + 复制按钮 + 基础样式（无高亮库）—— */
.cy-markdown :deep(.cy-code-block) {
  margin: 0 0 8px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--cy-border);
  background: var(--cy-surface-soft);
}
.cy-markdown :deep(.cy-code-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: var(--cy-surface);
}
.cy-markdown :deep(.cy-code-lang) {
  color: var(--cy-muted);
  font-size: 11px;
}
.cy-markdown :deep(.cy-code-copy) {
  border: 0;
  background: transparent;
  color: var(--cy-muted);
  font-size: 11px;
  cursor: pointer;
}
.cy-markdown :deep(.cy-code-copy:hover) {
  color: var(--cy-text);
}
.cy-markdown :deep(.cy-code-block pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
}
</style>
