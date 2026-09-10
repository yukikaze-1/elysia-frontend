// @vitest-environment happy-dom
// tests/unit/markdown-sanitize.spec.ts（行为记录层——安全门禁归 tests/integration/markdown-xss.spec.ts 真实 Chromium）
// 行为差异标注（阶段 7 批次 A Task 2 实测 + Task 8 翻转尝试复验，2026-08-22）：DOMPurify 3.4.14 在 happy-dom 20.11.2 下遍历层失效——
// ① _readNodeName 缓存 getter 返回 ''（uponSanitizeElement 钩子实测 tagName=''）→ ALLOWED/ATTR 判定全不中；
// ② happy-dom NodeIterator 在当前节点被移除后 nextNode() 即终止（实测先访问 BODY/H1，移除 H1 后迭代器死亡），
//    消毒只处理到首个被移除元素就停，其后元素含危险标签/on*/危险协议原样保留。
// 因此「输出不含可执行面」类断言在 happy-dom 下无法成立——按 brief 行为差异处理：保留用例、断言不弱化，
// 以 it.fails 标注（断言仍执行且必须如预期失败——happy-dom 环境修复后可翻回 it）；安全门禁由
// tests/integration/markdown-xss.spec.ts（真实 Chromium）承载。Task 8 已复验翻转（7 用例 it.fails→it 全红：
// 失败清单与 Task 2 完全一致——<h1>/<style>/onerror/javascript:/cy-code-block/「代码」均未净化），
// 结论：happy-dom 环境缺陷未变，canary 维持 it.fails 并记录（集成层 2/2 全绿为安全判据）。配置钉住/纯函数断言不受影响。
//
// 2026-09-10（多套 UI 基础）：renderMarkdown 返回块序列而非 HTML 字符串；`wrapCodeBlocks`（功能层拼 HTML）
// 已删除，其职责拆为 utils/markdown 的 `splitCodeBlocks`（纯数据切分，本文件直接测）
// 与 CyCodeBlock.vue（结构/文案/样式，见 tests/unit/cy-code-block.spec.ts）。
// 新增 happy-dom 特有约束：DOMPurify 在本环境连 <pre> 一并剥除，故 splitCodeBlocks 对 renderMarkdown
// 的输出不触发——原先那条「代码块：包裹 + language 类保留」的 it.fails 正是此因。现改为：
//   · canary 断言改为「组件形态」等价物（见 blocksHtml：code 块还原为 <pre><code>），仍 it.fails、仍不弱化；
//   · 切分/实体还原等纯函数行为由 5 条常规用例确定覆盖（这些此前在 happy-dom 下完全测不到）。
import { describe, expect, it } from 'vitest'
import { renderMarkdown, splitCodeBlocks, trimCodeText, DOMPURIFY_CONFIG, type MarkdownBlock } from '../../src/renderer/src/utils/markdown'

/** 块序列 → 等价 HTML（code 块还原为组件渲染前的 <pre><code> 形态），使既有字符串断言语义不变 */
function blocksHtml(blocks: readonly MarkdownBlock[]): string {
  return blocks.map((b) => (b.kind === 'html' ? b.html : `<pre><code>${b.content}</code></pre>`)).join('')
}

describe('renderMarkdown（DOMPurify 显式白名单）', () => {
  it.fails('基础渲染：标题/粗体/列表/代码块', () => {
    const html = blocksHtml(renderMarkdown('# 标题\n\n**粗体**\n\n- 甲\n- 乙\n\n`code`'))
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>')
    expect(html).toContain('<li>')
    expect(html).toContain('<code>')
  })
  it.fails('DANGEROUS_TAGS 全剥（script/style/iframe/object/embed/link/meta/base/form/svg/math）', () => {
    const html = blocksHtml(renderMarkdown('<script>alert(1)</script><style>body{display:none}</style><iframe src="x"></iframe><svg onload="x()"></svg><form><input></form>'))
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
  })
  it.fails('on* 属性剥离（onerror/onload/onclick/onbegin）', () => {
    const html = blocksHtml(renderMarkdown('<img src="x" onerror="window.__xssFired=1"><div onclick="x()">t</div>'))
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('onclick')
  })
  it.fails('危险 URI 剥离：javascript:/data:/vbscript:（含实体与大小写变体）', () => {
    for (const payload of [
      '[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](javascript&colon;alert(1))',
      '[x](&#106;avascript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox(1))',
    ]) {
      const html = blocksHtml(renderMarkdown(payload))
      expect(html).not.toContain('javascript')
      expect(html).not.toContain('data:')
      expect(html).not.toContain('vbscript')
    }
  })
  it.fails('前导空白 URI 变体剥离（安全复核 M-1）', () => {
    const html = blocksHtml(renderMarkdown('[x]( javascript:alert(1))'))
    expect(html).not.toContain('javascript')
  })
  it('http/https/cyrene: 相对链接保留', () => {
    expect(blocksHtml(renderMarkdown('[a](https://example.com)'))).toContain('href="https://example.com"')
    expect(blocksHtml(renderMarkdown('[a](/relative/path)'))).toContain('href="/relative/path"')
  })
  it('style 属性剥离（当前 happy-dom 偶发通过——真实门禁归集成层）', () => {
    expect(blocksHtml(renderMarkdown('<div style="background:url(javascript:alert(1))">t</div>'))).not.toContain('style=')
  })
  it.fails('代码块：围栏内容进入 code 块且 language 保留', () => {
    // happy-dom 下 DOMPurify 剥掉 <pre>，切分不触发 → 整段留在 html 块内（本 canary 记录该环境缺陷）
    const blocks = renderMarkdown('```ts\nconst a = 1\n```')
    expect(blocks.some((b) => b.kind === 'code')).toBe(true)
    expect(blocksHtml(blocks)).toContain('const a = 1')
  })
  it('trimCodeText 只去尾部换行（\n+$ 语义；保尾部空格）', () => {
    expect(trimCodeText('a\n\n')).toBe('a')
    expect(trimCodeText('a  \n')).toBe('a  ')
  })
  it('代码内容含 <script> 被消毒', () => {
    const html = blocksHtml(renderMarkdown('```\n<script>alert(1)</script>\n```'))
    expect(html).not.toContain('<script>alert')
  })
})

// —— 多套 UI 基础：splitCodeBlocks 纯数据切分（此前由 wrapCodeBlocks 在 happy-dom 下无法覆盖）——
describe('splitCodeBlocks（消毒后 HTML → 块序列；纯函数，不依赖 DOMPurify）', () => {
  it('单块代码：切为 code 块并还原实体（&lt; → <）', () => {
    const blocks = splitCodeBlocks('<pre><code class="language-ts">const a = 1\n</code></pre>\n')
    expect(blocks).toEqual([{ kind: 'code', language: 'ts', content: 'const a = 1' }])
  })
  it('未标注语言：language 为空串（默认标签由 UI 层决定）', () => {
    const blocks = splitCodeBlocks('<pre><code>plain\n</code></pre>')
    expect(blocks).toEqual([{ kind: 'code', language: '', content: 'plain' }])
  })
  it('前后文本保留为 html 块，顺序不变（html / code / html）', () => {
    const blocks = splitCodeBlocks('<p>before</p>\n<pre><code class="language-js">let x\n</code></pre>\n<p>after</p>')
    expect(blocks.map((b) => b.kind)).toEqual(['html', 'code', 'html'])
    expect(blocks[0]).toEqual({ kind: 'html', html: '<p>before</p>\n' })
    expect(blocks[2]).toEqual({ kind: 'html', html: '\n<p>after</p>' })
  })
  it('多个代码块各自成块', () => {
    const blocks = splitCodeBlocks('<pre><code class="language-a">1\n</code></pre><pre><code class="language-b">2\n</code></pre>')
    expect(blocks.filter((b) => b.kind === 'code')).toEqual([
      { kind: 'code', language: 'a', content: '1' },
      { kind: 'code', language: 'b', content: '2' },
    ])
  })
  it('实体还原：代码中的尖括号/引号不丢失（组件以插值渲染，须为纯文本）', () => {
    const blocks = splitCodeBlocks('<pre><code class="language-html">&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;\n</code></pre>')
    expect(blocks[0]).toEqual({ kind: 'code', language: 'html', content: '<div class="x">&</div>' })
  })
  it('嵌套在列表内的代码块同样被切分（切分按 <pre><code> 边界，不要求块级位置）', () => {
    const blocks = splitCodeBlocks('<ul>\n<li><pre><code class="language-ts">x\n</code></pre>\n</li>\n</ul>')
    // 切分是纯文本替换式：命中即切出，两侧包裹标签留在 html 块中（Vue 模板会补齐结构）
    expect(blocks.filter((b) => b.kind === 'code')).toEqual([{ kind: 'code', language: 'ts', content: 'x' }])
    expect(blocksHtml(blocks)).toContain('x')
  })
  it('无代码块：整段为一个 html 块', () => {
    const blocks = splitCodeBlocks('<p>only</p>')
    expect(blocks).toEqual([{ kind: 'html', html: '<p>only</p>' }])
  })
  it('空前缀不产生空 html 块', () => {
    const blocks = splitCodeBlocks('<pre><code>x\n</code></pre><p>tail</p>')
    expect(blocks[0]?.kind).toBe('code')
    expect(blocks.some((b) => b.kind === 'html' && b.html === '')).toBe(false)
  })
  it('语言标识超长/非法字符被拒（不得注入 class 名）', () => {
    const blocks = splitCodeBlocks('<pre><code class="language-&quot;&gt;&lt;script&gt;">x\n</code></pre>')
    expect(blocks[0]).toMatchObject({ kind: 'code', language: '' })
    const long = splitCodeBlocks(`<pre><code class="language-${'a'.repeat(40)}">x\n</code></pre>`)
    expect(long[0]).toMatchObject({ kind: 'code', language: '' })
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
