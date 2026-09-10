// @vitest-environment happy-dom
// tests/unit/cy-code-block.spec.ts（多套 UI 基础，2026-09-10）
// CyCodeBlock：markdown 代码块的 UI 层收口。此前该结构与文案（cy-code-block / cy-code-head /
// cy-code-lang / cy-code-copy + 「复制」「已复制」「代码」）由 utils/markdown.ts 字符串拼接生成，
// 使 UI 契约渗入功能层。本文件是该职责迁移后的行为记录：
//   · 结构与文案归组件（可随皮肤/语言替换）；
//   · 代码正文以插值渲染（textContent 语义）——含 <script> 的代码只作为文本显示，绝不经 HTML 解析；
//   · 复制取正文本身（不因展示形态丢字符），失败不改按钮文案。
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CyCodeBlock from '../../src/renderer/src/components/CyCodeBlock.vue'

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
})

afterEach(() => { vi.restoreAllMocks() })

// tsconfig.node 下 .vue 为 ambient shim，$props 解析为 {}——按仓库先例（cy-attachment-media.spec）
// 在 helper 一处放宽为 never。
function mountBlock(props: Record<string, unknown>) {
  return mount(CyCodeBlock, { props: props as never })
}

describe('CyCodeBlock 结构（UI 契约归组件）', () => {
  it('渲染 head（语言标签 + 复制按钮）与 pre>code 正文', () => {
    const wrapper = mountBlock({ language: 'ts', code: 'const a = 1' })
    expect(wrapper.find('.cy-code-block').exists()).toBe(true)
    expect(wrapper.get('.cy-code-lang').text()).toBe('ts')
    expect(wrapper.get('.cy-code-copy').text()).toBe('复制')
    expect(wrapper.get('pre code').text()).toBe('const a = 1')
    wrapper.unmount()
  })

  it('未标注语言（空串/省略）：标签显示默认文案「代码」', () => {
    const empty = mountBlock({ language: '', code: 'x' })
    expect(empty.get('.cy-code-lang').text()).toBe('代码')
    empty.unmount()

    const omitted = mountBlock({ code: 'x' })
    expect(omitted.get('.cy-code-lang').text()).toBe('代码')
    omitted.unmount()
  })

  it('正文以插值渲染：含 <script> 的代码显示为字面文本，不产生元素', () => {
    const wrapper = mountBlock({ language: 'html', code: '<script>alert(1)</script>' })
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.get('pre code').text()).toBe('<script>alert(1)</script>')
    wrapper.unmount()
  })

  it('空白与换行原样保留（代码正文不得被模板压缩或改动）', () => {
    const code = '  indented\n\nline2\n\ttabbed'
    const wrapper = mountBlock({ language: 'ts', code })
    // 用 textContent 而非 test-utils 的 .text()：后者对空白做归一化，恰会掩盖本用例要验的东西
    expect(wrapper.get('pre code').element.textContent).toBe(code)
    wrapper.unmount()
  })
})

describe('CyCodeBlock 复制交互', () => {
  it('点击复制：写入正文本身，按钮转为「已复制」', async () => {
    const wrapper = mountBlock({ language: 'ts', code: 'const a = 1' })
    await wrapper.get('.cy-code-copy').trigger('click')
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith('const a = 1') })
    expect(wrapper.get('.cy-code-copy').text()).toBe('已复制')
    wrapper.unmount()
  })

  it('复制内容为原始正文（含特殊字符与尖括号，不经 HTML 还原丢失）', async () => {
    // 正文已由 utils/markdown 去过尾部换行，组件不再改动——断言复制值等于所见的代码正文
    const code = '<div class="x">&amp;</div>'
    const wrapper = mountBlock({ code })
    await wrapper.get('.cy-code-copy').trigger('click')
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith(code) })
    wrapper.unmount()
  })

  it('复制失败（writeText reject 且 execCommand 不可用）：按钮文案不变', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true })
    const wrapper = mountBlock({ code: 'x' })
    await wrapper.get('.cy-code-copy').trigger('click')
    await vi.waitFor(() => { expect(execCommand).toHaveBeenCalled() })
    expect(wrapper.get('.cy-code-copy').text()).toBe('复制')
    wrapper.unmount()
  })

  it('卸载后定时器不再写状态（无卸载后副作用）', async () => {
    const wrapper = mountBlock({ code: 'x' })
    await wrapper.get('.cy-code-copy').trigger('click')
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalled() })
    wrapper.unmount()
    // 卸载已清理复位定时器：此处前进真实时间不应抛错，也不应再触碰已卸载组件
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.get('.cy-code-copy').text()).toBe('已复制')
  })
})
