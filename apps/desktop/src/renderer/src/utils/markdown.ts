// src/renderer/src/utils/markdown.ts
// Markdown → 安全 HTML(C-13):marked.parse + 轻量消毒,组件 v-html 渲染。
// CSP(script-src 'self',无 unsafe-inline)已拦截内联 <script>/on* 事件处理器,这里是纵深防御。
// 已知限制:scoped 消毒器(危险标签/on*/危险协议),非完整 DOM 级 HTML 净化(DOMPurify 留待后续按需引入)。
import { marked } from 'marked'

/** 整块剥离的危险元素(含其内容)——标记/样式/嵌入/导航类都不该出现在聊天渲染里 */
const DANGEROUS_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg', 'math']

/** 危险相关命名实体小映射(numeric 实体 `&#58;`/`&#106;` 等走通用数值分支) */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
  tab: '\t',
  newline: '\n',
  nbsp: ' '
}

/**
 * HTML entity 归一化(循环直至稳定,防嵌套编码如 `&amp;colon;`)。
 * marked 对 raw HTML 透传、对链接 href 不做 & 转义,`javascript&colon;`/`&#58;`/`&#106;` 等
 * 会把协议编码后注入——先解回再匹配剥离才有效。仅解小映射命名实体 + 通用 numeric;
 * 其余命名实体(如 &copy;)保留,交给浏览器 v-html 渲染。
 */
function decodeEntities(input: string): string {
  let out = input
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/&(#(?:x[0-9a-fA-F]{1,6}|[0-9]{1,7})|[a-zA-Z][a-zA-Z0-9]{0,20});/g, (m, body: string) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X'
        const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
        if (code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
          try {
            return String.fromCodePoint(code)
          } catch {
            return m
          }
        }
        return m
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? m
    })
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 轻量 HTML 消毒(先 entity 归一化,再依次剥离):
 * ① 成对危险标签整块剥离(含内容),再剥残留的自闭合/未闭合开标签;
 * ② 剥离 on* 事件属性(单/双引号与无引号三种形态);
 * ③ 剥离 javascript:/data:/vbscript: 协议的 href/src/xlink:href 属性
 *    (带引号与不带引号值都匹配;值前部命中危险协议则整属性移除,含 markdown 链接语法生成的)。
 */
function sanitizeHtml(html: string): string {
  let out = decodeEntities(html)
  for (const tag of DANGEROUS_TAGS) {
    out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'gi'), '')
    out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>`, 'gi'), '')
  }
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '')
  out = out.replace(/\s+(?:href|src|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, (attr) => {
    const eq = attr.indexOf('=')
    const raw = attr.slice(eq + 1).trim()
    const value = raw.replace(/^["']|["']$/g, '')
    return /^(?:javascript|data|vbscript)\s*:/i.test(value) ? '' : attr
  })
  return out
}

/** 渲染 markdown → 消毒后 HTML(marked.parse 同步调用,async:false 保证 string 返回) */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  return sanitizeHtml(html)
}
