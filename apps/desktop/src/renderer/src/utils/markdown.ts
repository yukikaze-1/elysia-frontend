// src/renderer/src/utils/markdown.ts
// Markdown → 安全 HTML(C-13):marked.parse + 轻量消毒,组件 v-html 渲染。
// CSP(script-src 'self',无 unsafe-inline)已拦截内联 <script>/on* 事件处理器,这里是纵深防御。
// 已知限制:scoped 消毒器(危险标签/on*/危险协议),非完整 DOM 级 HTML 净化(DOMPurify 留待后续按需引入)。
import { marked } from 'marked'

/** 整块剥离的危险元素(含其内容)——标记/样式/嵌入/导航类都不该出现在聊天渲染里 */
const DANGEROUS_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg', 'math']

/**
 * 轻量 HTML 消毒:
 * ① 成对危险标签整块剥离(含内容),再剥残留的自闭合/未闭合开标签;
 * ② 剥离 on* 事件属性(单/双引号与无引号三种形态);
 * ③ 剥离 javascript:/data:/vbscript: 协议的 href/src 属性(含 markdown 链接语法 [x](javascript:…) 生成的)。
 */
function sanitizeHtml(html: string): string {
  let out = html
  for (const tag of DANGEROUS_TAGS) {
    out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'gi'), '')
    out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>`, 'gi'), '')
  }
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '')
  out = out.replace(
    /\s+(?:href|src|xlink:href)\s*=\s*(?:"\s*(?:javascript|data|vbscript):[^"]*"|'\s*(?:javascript|data|vbscript):[^']*')/gi,
    ''
  )
  return out
}

/** 渲染 markdown → 消毒后 HTML(marked.parse 同步调用,async:false 保证 string 返回) */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  return sanitizeHtml(html)
}
