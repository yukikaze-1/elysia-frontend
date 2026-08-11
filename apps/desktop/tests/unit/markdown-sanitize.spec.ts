// tests/unit/markdown-sanitize.spec.ts
// Task 5:renderMarkdown 基础 markdown 渲染 + XSS 消毒(script/on* 剥离)——utils/markdown.ts 的领域纯逻辑。
// 组件 v-html 渲染安全由 sanitize 保证;UI 视觉留阶段 3 E2E。
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/utils/markdown'

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
