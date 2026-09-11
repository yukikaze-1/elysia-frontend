// src/renderer/src/utils/markdown.ts
// 阶段 7 批次 A（D7A-01）：marked.parse → DOMPurify.sanitize（显式白名单配置）→ 切分代码块。
// 不使用 USE_PROFILES（DOMPurify 3.4.x 中与显式 ALLOWED_TAGS/ALLOWED_ATTR 互斥——html profile 整体覆盖显式表）。
// 三层机制：①本 ALLOWED_URI_REGEXP ②DOMPurify 内部 ATTR_WHITESPACE 全局剥离（purify.es.mjs _sanitizeAttributes:1644/:326）③CyMarkdown.vue 点击层（preventDefault + 仅 http(s) openExternal）。
// 单测（happy-dom）为行为记录层——安全门禁在 tests/integration/markdown-xss.spec.ts（真实 Chromium）。
// 已知行为变更（记录于决策记录）：img src 的 data: 经 DOMPurify DATA_URI_TAGS 分支保留（img 上下文无脚本面；现 sanitizeHtml 为更严口径）。
//
// 多套 UI 基础（2026-09-10 重构）：本模块此前同时承担「安全消毒」与「代码块 HTML 拼装」两件事，
// 后者把 `<div class="cy-code-block">…<button class="cy-code-copy">复制</button>…` 硬编码进功能层，
// 使 UI 结构/文案/CSS 类名渗入非 UI 模块。现分工收口：
//   - 本模块 = 消毒（安全边界，不可外移）+ 把消毒后 HTML 切分成「HTML 块 / 代码块数据」；
//   - CyCodeBlock.vue = 代码块的结构、文案、样式与复制交互（UI 层）。
// 消毒顺序与语义逐字未变：仍是 marked.parse → DOMPurify.sanitize(DOMPURIFY_CONFIG)，
// 只是消毒【之后】不再拼接 UI 标记，改为按 `<pre><code>` 边界切分为数据。
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'   // 3.4.14：顶层 type Config（无 namespace——别名为防 TS2503，准确性 R2 实测）
import { marked } from 'marked'
import { subscribeSessionBoundary } from './session-boundary'

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

/**
 * 消毒后 markdown 的块序列。
 * - `html`：非代码块内容，**已消毒**，可直接 v-html；
 * - `code`：代码块数据。`content` 为**纯文本**（由组件以插值渲染，不经 HTML 解析），
 *   `language` 已按 CSS 安全字符集过滤，空串表示未标注语言。
 */
export type MarkdownBlock =
  | { readonly kind: 'html'; readonly html: string }
  | { readonly kind: 'code'; readonly language: string; readonly content: string }

/**
 * 模块级 markdown 渲染缓存（阶段 7 批次 C，D7C-08：选 Map 而非 WeakMap——string key 非弱持有）。
 * renderMarkdown 是 text 的纯函数（DOMPurify 配置为静态常量，非运行时变量），故可按 source 字符串记忆化；
 * key = source 文本，value = 消毒后的块序列（post-sanitize，安全）。敏感文本作为值驻留 renderer 堆内
 * （M-1 接受档）——仅会话内清空（会话边界订阅，见文件末）、不跨信任边界。
 */
/**
 * 渲染缓存**有界**（H-08，2026-09-11）。
 *
 * 键是**整段源文本**，而流式回复每个 80ms 节流周期都会产生一个更长的新文本
 * ⇒ 一条回复就写入 N 个条目、总字节 O(N²)，且此前只在会话切换时清空
 * （`clearMarkdownCache`），单条长回复即可长时间驻留数 MB。
 *
 * 上限与淘汰：超出时按插入顺序（Map 保序 = FIFO）淘汰最旧的四分之一。这里是**纯渲染缓存**，
 * 淘汰永远安全——最坏只是下一次重新 parse+sanitize。刻意不做 LRU（读取时改序会带来额外开销，
 * 而本缓存的读取密集度远低于写入；FIFO 已足够把内存钉在有界区间）。
 */
const MARKDOWN_CACHE_MAX = 300
const markdownCache = new Map<string, readonly MarkdownBlock[]>()

function evictMarkdownCacheIfNeeded(): void {
  if (markdownCache.size < MARKDOWN_CACHE_MAX) return
  const drop = Math.ceil(MARKDOWN_CACHE_MAX / 4)
  let removed = 0
  for (const key of markdownCache.keys()) {
    markdownCache.delete(key)
    if (++removed >= drop) break
  }
}

/** 诊断：当前缓存条目数（测试断言"有界"用；也便于诊断包反映渲染层内存面） */
export function markdownCacheSize(): number {
  return markdownCache.size
}

/** 代码块语言标识的安全字符集（对齐 Markdown 语言标识惯例；防注入 class 名） */
const LANGUAGE_PATTERN = /^[A-Za-z0-9_+-]{1,32}$/
/** `<pre><code …>…</code></pre>` 边界：DOMPurify 输出为规范化 HTML，属性保持带引号形式 */
const CODE_BLOCK_PATTERN_ALL = /<pre>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/g
const LANGUAGE_CLASS_PATTERN = /\blanguage-([A-Za-z0-9_+-]+)\b/

/** 从 `<code>` 属性串提取语言：仅取 `language-xxx` 首段且须过安全字符集，否则视为未标注 */
function languageFromAttrs(attrs: string): string {
  const matched = LANGUAGE_CLASS_PATTERN.exec(attrs)
  return matched && LANGUAGE_PATTERN.test(matched[1]) ? matched[1] : ''
}

/** 纯空白 html 段不产生可见内容，丢弃以免渲染出空容器 */
function pushHtml(blocks: MarkdownBlock[], html: string): void {
  if (html.trim()) blocks.push({ kind: 'html', html })
}

/**
 * 把消毒后的 HTML 还原为文本（用于代码块内容）。
 * 代码块内容将以插值方式渲染，须还原实体，否则会显示 `&lt;div&gt;` 字面量。
 * 只处理能由 marked/DOMPurify 产生的 5 个实体 + 数字实体；顺序固定避免二次解码。
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 消毒后 HTML → 块序列。
 * 只切分**顶层** `<pre><code>`（markdown 围栏代码块）。嵌套在列表/引用内的代码块
 * 保留在 html 块中，由 CyMarkdown 的 :deep() 样式覆盖——与重构前行为一致。
 */
export function splitCodeBlocks(html: string): readonly MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let cursor = 0
  CODE_BLOCK_PATTERN_ALL.lastIndex = 0
  for (let m = CODE_BLOCK_PATTERN_ALL.exec(html); m !== null; m = CODE_BLOCK_PATTERN_ALL.exec(html)) {
    pushHtml(blocks, html.slice(cursor, m.index))
    blocks.push({
      kind: 'code',
      language: languageFromAttrs(m[1]),
      content: trimCodeText(decodeEntities(m[2])),
    })
    cursor = m.index + m[0].length
  }
  pushHtml(blocks, html.slice(cursor))
  return blocks
}

/** Markdown → 消毒后的块序列：marked.parse（GFM 默认）→ DOMPurify → 切分；命中缓存则跳过 parse+sanitize */
export function renderMarkdown(text: string): readonly MarkdownBlock[] {
  const cached = markdownCache.get(text)
  if (cached !== undefined) return cached
  const sanitized = DOMPurify.sanitize(marked.parse(text, { async: false }), DOMPURIFY_CONFIG)
  const blocks = splitCodeBlocks(sanitized)
  evictMarkdownCacheIfNeeded()
  markdownCache.set(text, blocks)
  return blocks
}

/**
 * 清空 markdown 渲染缓存——会话边界挂载点调用，防敏感内容跨会话驻留。
 *
 * 订阅在模块加载时即建立（而非组件挂载时）：只要本模块被加载（即只要真的有 markdown
 * 渲染能力存在），会话切换必清空，不依赖任何组件是否处于挂载态。
 * 方向为「渲染层订阅功能层事件」——功能层（stores/）不再 import 本模块。
 */
export function clearMarkdownCache(): void {
  markdownCache.clear()
}

subscribeSessionBoundary(() => { clearMarkdownCache() })

/** 复制文本：去尾部换行（\n+$ 语义——只去换行不去空格，与现实现一致） */
export function trimCodeText(text: string): string {
  return text.replace(/\n+$/, '')
}
