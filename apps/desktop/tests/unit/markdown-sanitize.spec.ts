// @vitest-environment happy-dom
// tests/unit/markdown-sanitize.spec.ts（行为记录层——安全门禁归 tests/integration/markdown-xss.spec.ts 真实 Chromium）
// 行为差异标注（阶段 7 批次 A Task 2 实测，2026-08-22）：DOMPurify 3.4.14 在 happy-dom 20.11.2 下遍历层失效——
// ① _readNodeName 缓存 getter 返回 ''（uponSanitizeElement 钩子实测 tagName=''）→ ALLOWED/ATTR 判定全不中；
// ② happy-dom NodeIterator 在当前节点被移除后 nextNode() 即终止（实测先访问 BODY/H1，移除 H1 后迭代器死亡），
//    消毒只处理到首个被移除元素就停，其后元素含危险标签/on*/危险协议原样保留。
// 因此「输出不含可执行面」类断言在 happy-dom 下无法成立——按 brief 行为差异处理：保留用例、断言不弱化，
// 以 it.fails 标注（断言仍执行且必须如预期失败——happy-dom 环境修复后可翻回 it）；安全门禁由
// tests/integration/markdown-xss.spec.ts（真实 Chromium，待后续任务创建）承载。配置钉住/纯函数断言不受影响。
import { describe, expect, it } from 'vitest'
import { renderMarkdown, wrapCodeBlocks, trimCodeText, DOMPURIFY_CONFIG } from '../../src/renderer/src/utils/markdown'

describe('renderMarkdown（DOMPurify 显式白名单）', () => {
  it.fails('基础渲染：标题/粗体/列表/代码块', () => {
    const html = renderMarkdown('# 标题\n\n**粗体**\n\n- 甲\n- 乙\n\n`code`')
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>')
    expect(html).toContain('<li>')
    expect(html).toContain('<code>')
    expect(html).toContain('cy-code-block')
  })
  it.fails('DANGEROUS_TAGS 全剥（script/style/iframe/object/embed/link/meta/base/form/svg/math）', () => {
    const html = renderMarkdown('<script>alert(1)</script><style>body{display:none}</style><iframe src="x"></iframe><svg onload="x()"></svg><form><input></form>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
  })
  it.fails('on* 属性剥离（onerror/onload/onclick/onbegin）', () => {
    const html = renderMarkdown('<img src="x" onerror="window.__xssFired=1"><div onclick="x()">t</div>')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('onclick')
  })
  it.fails('危险 URI 剥离：javascript:/data:/vbscript:（含实体与大小写变体）', () => {
    for (const payload of [
      '[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](javascript&colon;alert(1))',
      '[x](&#106;avascript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox(1))',
    ]) {
      const html = renderMarkdown(payload)
      expect(html).not.toContain('javascript')
      expect(html).not.toContain('data:')
      expect(html).not.toContain('vbscript')
    }
  })
  it.fails('前导空白 URI 变体剥离（安全复核 M-1）', () => {
    const html = renderMarkdown('[x]( javascript:alert(1))')
    expect(html).not.toContain('javascript')
  })
  it('http/https/cyrene: 相对链接保留', () => {
    expect(renderMarkdown('[a](https://example.com)')).toContain('href="https://example.com"')
    expect(renderMarkdown('[a](/relative/path)')).toContain('href="/relative/path"')
  })
  it('style 属性剥离（当前 happy-dom 偶发通过——真实门禁归集成层）', () => {
    expect(renderMarkdown('<div style="background:url(javascript:alert(1))">t</div>')).not.toContain('style=')
  })
  it.fails('代码块：包裹 + language 类保留', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('cy-code-block')
    expect(html).toContain('language-ts')
    expect(html).toContain('const a = 1')
  })
  it.fails('默认无语言标签「代码」', () => {
    const html = renderMarkdown('```\ncode\n```')
    expect(html).toContain('代码')
  })
  it('trimCodeText 只去尾部换行（\n+$ 语义；保尾部空格）', () => {
    expect(trimCodeText('a\n\n')).toBe('a')
    expect(trimCodeText('a  \n')).toBe('a  ')
  })
  it('wrapCodeBlocks 保留 <code> 属性 + 无语言默认「代码」（原实现逐字符不变，直接单测兜底）', () => {
    const html = wrapCodeBlocks('<pre><code class="language-ts">const a = 1</code></pre>')
    expect(html).toContain('cy-code-block')
    expect(html).toContain('language-ts')
    expect(wrapCodeBlocks('<pre><code>plain</code></pre>')).toContain('代码')
  })
  it('代码内容含 <script> 被消毒', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    expect(html).not.toContain('<script>alert')
  })
})

describe('DOMPURIFY_CONFIG（配置钉住——USE_PROFILES 缺席 + 显式白名单）', () => {
  it('不用 USE_PROFILES（与显式表互斥——spec D7A-01）', () => {
    expect((DOMPURIFY_CONFIG as Record<string, unknown>).USE_PROFILES).toBeUndefined()
  })
  it('ALLOWED_TAGS 含渲染面、不含 input/script/style', () => {
    const tags = DOMPURIFY_CONFIG.ALLOWED_TAGS as string[]
    expect(tags).toContain('a'); expect(tags).toContain('pre'); expect(tags).toContain('code'); expect(tags).toContain('img')
    expect(tags).not.toContain('input'); expect(tags).not.toContain('script'); expect(tags).not.toContain('style')
  })
  it('ALLOWED_ATTR 白名单（无 on*/style/id）', () => {
    const attrs = DOMPURIFY_CONFIG.ALLOWED_ATTR as string[]
    expect(attrs).toContain('href'); expect(attrs).toContain('src'); expect(attrs).toContain('class')
    expect(attrs).not.toContain('onerror'); expect(attrs).not.toContain('style'); expect(attrs).not.toContain('id')
  })
  it('ALLOW_DATA_ATTR false', () => {
    expect(DOMPURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false)
  })
})
