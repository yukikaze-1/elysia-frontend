<script setup lang="ts">
// CyCodeBlock：markdown 代码块的 UI 层收口（多套 UI 基础，2026-09-10）。
//
// 此前这段结构与文案（`cy-code-block`/`cy-code-head`/`cy-code-lang`/`cy-code-copy` +
// 「复制」「已复制」「代码」）在 utils/markdown.ts 里以字符串拼接生成，使 UI 契约渗入
// 非 UI 模块。现在改由本组件渲染：换 UI 风格/换语言只需改这里，功能层（消毒管线）不动。
//
// 安全：`code` 以**插值**渲染（textContent 语义），绝不走 v-html——代码内容即使含
// `<script>` 也只作为文本显示。复制值取 textContent，故复制到的就是所见内容。
import { onBeforeUnmount, ref } from 'vue'
import { copyText } from '../utils/clipboard'

const props = defineProps<{
  /** 语言标识；空串 = 未标注（显示默认标签） */
  language?: string
  /** 代码正文（纯文本，已由 utils/markdown 从消毒后的 HTML 还原实体） */
  code: string
}>()

/** 未标注语言时的标签与复制按钮文案——UI 文案，随皮肤/语言变化只改此处 */
const DEFAULT_LANGUAGE_LABEL = '代码'
const COPY_LABEL = '复制'
const COPIED_LABEL = '已复制'
const COPIED_RESET_MS = 1500

const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined
// 2026-09-16 审计 P2：定时器建在 `await copyText(...)` **之后**，而 onBeforeUnmount 看不到它——
// 若组件在这段 await 期间被卸载（虚拟列表频繁换行就会），定时器仍会被建出来且永远没人清。
let unmounted = false

function onCopy(): void {
  void copyText(props.code).then((ok) => {
    if (!ok || unmounted) return   // 卸载后才落定的复制：不置位、不建定时器
    copied.value = true
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => { copied.value = false }, COPIED_RESET_MS)
  })
}

onBeforeUnmount(() => { unmounted = true; if (resetTimer) clearTimeout(resetTimer) })
</script>

<template>
  <div class="cy-code-block">
    <div class="cy-code-head">
      <span class="cy-code-lang">{{ language || DEFAULT_LANGUAGE_LABEL }}</span>
      <button
        type="button"
        class="cy-code-copy"
        :aria-label="copied ? COPIED_LABEL : COPY_LABEL"
        @click="onCopy"
      >{{ copied ? COPIED_LABEL : COPY_LABEL }}</button>
    </div>
    <pre><code>{{ code }}</code></pre>
  </div>
</template>

<style scoped>
.cy-code-block {
  margin: 0 0 var(--cy-space-4);
  border-radius: var(--cy-radius-4);
  overflow: hidden;
  border: 1px solid var(--cy-border);
  background: var(--cy-surface-soft);
}

.cy-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--cy-space-2) var(--cy-space-4);
  background: var(--cy-surface);
}

.cy-code-lang {
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

.cy-code-copy {
  border: 0;
  background: transparent;
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  cursor: pointer;
}

.cy-code-copy:hover {
  color: var(--cy-text);
}

.cy-code-block pre {
  margin: 0;
  border: 0;
  border-radius: 0;
}
</style>
