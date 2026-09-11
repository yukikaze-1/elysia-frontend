<script setup lang="ts">
// CyMarkdown:markdown → 消毒块序列 → HTML 块 v-html / 代码块组件(C-13)。
// G2(D7):代码块复制按钮 + 外部链接经 Main 白名单 + 流式渲染 80ms 节流。
// 安全:CSP script-src 'self'(无 unsafe-inline/unsafe-eval)+ utils/markdown sanitize 双保险。
//
// 多套 UI 基础（2026-09-10）：代码块此前是 utils/markdown 拼接的 HTML 字符串，本组件只能用
// `v-html` + `:deep()` 命中它，结构与文案归属功能层。现改为：消毒后由 utils/markdown 切分为
// 块序列，代码块作为数据交给 CyCodeBlock 渲染；本组件只保留最小「内容排版」样式
// （标题/列表/行内 code/引用/表格），代码块样式归 CyCodeBlock。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMarkdown, type MarkdownBlock } from '../utils/markdown'
import { createThrottle } from '../utils/throttle'
import { api } from '../stores/desktop-api'
import CyCodeBlock from './CyCodeBlock.vue'

const props = defineProps<{ source: string }>()

const MARKDOWN_THROTTLE_MS = 80

type KeyedBlock = { key: string; block: MarkdownBlock }

const blocks = ref<readonly MarkdownBlock[]>([])
let disposed = false
// 节流（H-03）：流式 delta 高频变化时合并重解析，但**保证至少每 80ms 渲染一次中间态**并
// 在停顿/完成时补上最终文本（spec §4.6.3）。此前用尾沿防抖，token 间隔 < 80ms 时回调
// 永不触发，助手气泡整段一次蹦出——节流的冷却窗口不因新调用后移，故不会。
const scheduleRender = createThrottle(() => { if (!disposed) blocks.value = renderMarkdown(props.source) }, MARKDOWN_THROTTLE_MS)

// 按序号为键：块序列是 (html, code, html, code…) 的有序切分，序号是稳定身份
const keyedBlocks = computed<KeyedBlock[]>(() => blocks.value.map((block, i) => ({ key: `${i}`, block })))

watch(() => props.source, () => scheduleRender.call())
onMounted(() => { blocks.value = renderMarkdown(props.source) })
onBeforeUnmount(() => { disposed = true; scheduleRender.cancel() })

/** 事件委托（CSP-safe，无内联 handler，spec §4.6.1/§4.6.2）：仅剩外链点击，代码块复制归 CyCodeBlock */
function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
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
  <div class="cy-markdown" @click="onClick">
    <template v-for="entry in keyedBlocks" :key="entry.key">
      <CyCodeBlock
        v-if="entry.block.kind === 'code'"
        :language="entry.block.language"
        :code="entry.block.content"
      />
      <div v-else class="cy-md-html" v-html="entry.block.html" />
    </template>
  </div>
</template>

<style scoped>
/* scoped 样式不注入 v-html 生成的内容,须用 :deep() 命中 markdown 输出 */
.cy-markdown {
  font-size: var(--cy-font-base);
  line-height: 1.6;
  word-break: break-word;
}

/* HTML 块容器必须对布局透明：否则会把 <p>/<ul> 包一层，破坏
   `margin` 折叠语义与 `p:last-child` 之类的相邻选择器。 */
.cy-md-html {
  display: contents;
}

.cy-markdown :deep(p) {
  margin: 0 0 var(--cy-space-4);
}
.cy-markdown :deep(p:last-child) {
  margin-bottom: 0;
}
.cy-markdown :deep(h1),
.cy-markdown :deep(h2),
.cy-markdown :deep(h3) {
  margin: var(--cy-space-4) 0;
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
  font-size: var(--cy-font-xl);
}
.cy-markdown :deep(ul),
.cy-markdown :deep(ol) {
  margin: 0 0 var(--cy-space-4);
  padding-left: 20px;
}
.cy-markdown :deep(li) {
  margin: var(--cy-space-1) 0;
}
.cy-markdown :deep(strong) {
  font-weight: 600;
}
.cy-markdown :deep(code) {
  padding: var(--cy-space-0-5) var(--cy-space-2-5);
  border-radius: 5px;
  background: var(--cy-surface-soft);
  font-size: var(--cy-font-lg);
}
.cy-markdown :deep(pre) {
  margin: 0 0 var(--cy-space-4);
  padding: var(--cy-space-5);
  overflow-x: auto;
  border-radius: var(--cy-radius-4);
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
  margin: 0 0 var(--cy-space-4);
  padding-left: var(--cy-space-5);
  color: var(--cy-muted);
  border-left: 3px solid var(--cy-border);
}
.cy-markdown :deep(hr) {
  margin: var(--cy-space-5) 0;
  border: 0;
  border-top: 1px solid var(--cy-border);
}
.cy-markdown :deep(table) {
  margin: 0 0 var(--cy-space-4);
  border-collapse: collapse;
}
.cy-markdown :deep(th),
.cy-markdown :deep(td) {
  padding: var(--cy-space-2-5) var(--cy-space-4-5);
  border: 1px solid var(--cy-border);
}
/* —— 嵌套在列表/引用内的代码块（未切分为顶层块）：保留基本可读性 ——
   顶层代码块的完整样式归 CyCodeBlock.vue。 */
.cy-markdown :deep(.cy-code-block) {
  margin: 0 0 var(--cy-space-4);
}
</style>
