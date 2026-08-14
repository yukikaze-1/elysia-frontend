// tests/unit/markdown-sanitize.spec.ts
// Task 5:renderMarkdown 基础 markdown 渲染 + XSS 消毒(script/on* 剥离)——utils/markdown.ts 的领域纯逻辑。
// 组件 v-html 渲染安全由 sanitize 保证;UI 视觉留阶段 3 E2E。
import { describe, expect, it } from 'vitest'
import { renderMarkdown, wrapCodeBlocks, trimCodeText } from '../../src/renderer/src/utils/markdown'

describe('Markdown 渲染 + 消毒', () => {
  it('基础 markdown(标题/粗体/列表/代码块)', () => {
    expect(renderMarkdown('# 标题')).toContain('<h1')
    expect(renderMarkdown('**粗体**')).toContain('<strong')
    expect(renderMarkdown('- a\n- b')).toContain('<li')
  })
  it('XSS:script/on* 被剥离', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script')
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('onerror')
  })
  it('XSS:entity/无引号编码的 javascript: 协议被剥离', () => {
    // marked 对链接 href 不做 & 转义、对 raw HTML 透传:`&colon;`/`&#58;` 与无引号值都可能是协议注入载体
    expect(renderMarkdown('[x](javascript&colon;alert(1))')).not.toContain('javascript')
    expect(renderMarkdown('<a href=javascript:alert(1)>x</a>')).not.toContain('javascript:')
  })
})

describe('阶段 3 G2 代码块（spec §4.6.1 D7）', () => {
  it('renderMarkdown 输出含 cy-code-block 包裹 + 语言标签 + 保留 <code>（复制取文）', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('cy-code-block')
    expect(html).toContain('cy-code-lang')
    expect(html).toContain('ts')
    expect(html).toContain('<code class="language-ts">')
  })
  it('wrapCodeBlocks 无语言 → 默认「代码」', () => {
    expect(wrapCodeBlocks('<pre><code>plain</code></pre>')).toContain('代码')
  })
  it('trimCodeText 去尾部换行', () => {
    expect(trimCodeText('a\nb\n\n')).toBe('a\nb')
  })
  it('代码内容含 <script> 被 sanitize 转义/剥离不执行（CSP 纵深）', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```')
    expect(html).not.toContain('<script>alert')
  })
})
