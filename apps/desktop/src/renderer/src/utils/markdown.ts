// src/renderer/src/utils/markdown.ts
// 阶段 7 批次 A（D7A-01）：marked.parse → DOMPurify.sanitize（显式白名单配置）→ wrapCodeBlocks。
// 不使用 USE_PROFILES（DOMPurify 3.4.x 中与显式 ALLOWED_TAGS/ALLOWED_ATTR 互斥——html profile 整体覆盖显式表）。
// 三层机制：①本 ALLOWED_URI_REGEXP ②DOMPurify 内部 ATTR_WHITESPACE 全局剥离（purify.es.mjs _sanitizeAttributes:1644/:326）③CyMarkdown.vue 点击层（preventDefault + 仅 http(s) openExternal）。
// 单测（happy-dom）为行为记录层——安全门禁在 tests/integration/markdown-xss.spec.ts（真实 Chromium）。
// 已知行为变更（记录于决策记录）：img src 的 data: 经 DOMPurify DATA_URI_TAGS 分支保留（img 上下文无脚本面；现 sanitizeHtml 为更严口径）。
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'   // 3.4.14：顶层 type Config（无 namespace——别名为防 TS2503，准确性 R2 实测）
import { marked } from 'marked'

export const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
    'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
    'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
    'th', 'thead', 'tr', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'class', 'start', 'type'],
  ALLOW_DATA_ATTR: false,
  // 回溯安全形态（安全复核 R2-MED-1 修正）：前导 C0/空格外层吞 + 负向断言内层再吞（两层都吞后仍不成 scheme 才放行）
  ALLOWED_URI_REGEXP: /^(?:[\u0000-\u0020]*)(?:(?:https?|cyrene|mailto):|(?!(?:[\u0000-\u0020]*)[a-z][a-z0-9+.\-]*:))/i,
  SANITIZE_DOM: true,
} satisfies DOMPurifyConfig

/** Markdown → 安全 HTML：marked.parse（GFM 默认）→ DOMPurify → 代码块包裹 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  return wrapCodeBlocks(DOMPurify.sanitize(html, DOMPURIFY_CONFIG))   // 先净化再包裹（复制按钮不被打回——现实现同序）
}

/** 代码块包裹：保留 <code> 元素（复制交互经 pre code 取 textContent），语言从 language-xxx class 提取——与现实现逐字符一致（markdown.ts:79-85） */
export function wrapCodeBlocks(html: string): string {
  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/gi, (_m, attrs: string, body: string) => {
    const langMatch = /class="[^"]*\blanguage-([a-zA-Z0-9_+-]+)[^"]*"/.exec(attrs)
    const lang = langMatch ? langMatch[1] : '代码'
    return `<div class="cy-code-block"><div class="cy-code-head"><span class="cy-code-lang">${lang}</span><button type="button" class="cy-code-copy" aria-label="复制代码">复制</button></div><pre><code${attrs}>${body}</code></pre></div>`
  })
}

/** 复制文本：去尾部换行（\n+$ 语义——只去换行不去空格，与现实现一致） */
export function trimCodeText(text: string): string {
  return text.replace(/\n+$/, '')
}
