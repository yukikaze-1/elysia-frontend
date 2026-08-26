// @vitest-environment happy-dom
// tests/unit/markdown-cache.spec.ts（Task 3,阶段 7 批次 C）
// 缓存行为记录层——不承载安全门禁（安全判据在 tests/integration/markdown-xss.spec.ts 真实 Chromium）。
// 环境注记（对照 brief 的必要修正）：
//  - DOMPurify.sanitize 在 node env 解析为 undefined（dompurify ESM 仅 default export 且依赖 DOM 全局），
//    故本文件必须 `// @vitest-environment happy-dom`（与既有 markdown-sanitize.spec.ts 同口径）。
//  - resetConversation 挂载点测试需 setActivePinia(createPinia())（pinia useStore 无活动实例会 throw；
//    brief 片段省略了该行——按既有 message.store.spec.ts 同款补齐）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import DOMPurify from 'dompurify'   // 准确 r2 M-6 修正：default import（dompurify ESM 仅 export default；import * as 得 namespace，sanitize undefined 且非同一引用）
import { renderMarkdown, clearMarkdownCache } from '../../src/renderer/src/utils/markdown'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'

describe('renderMarkdown 缓存（Task 3）', () => {
  beforeEach(() => clearMarkdownCache())
  it('相同 source 二次调用命中缓存（DOMPurify.sanitize 不重复执行）', () => {
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    const html1 = renderMarkdown('**hello**')
    const html2 = renderMarkdown('**hello**')
    expect(html2).toBe(html1)
    expect(spy).toHaveBeenCalledTimes(1)   // 缓存命中跳过第二次 parse+sanitize
    spy.mockRestore()
  })
  it('不同 source 不命中，各自 parse', () => {
    const a = renderMarkdown('# A')
    const b = renderMarkdown('# B')
    expect(a).not.toBe(b)
    expect(a).toContain('A')
    expect(b).toContain('B')
  })
  it('clearMarkdownCache 后重新 parse', () => {
    renderMarkdown('**x**')
    clearMarkdownCache()
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    renderMarkdown('**x**')
    expect(spy).toHaveBeenCalledTimes(1)   // 清空后重新 parse
    spy.mockRestore()
  })
  // 完整 M-3 修复：resetConversation 挂载点触发缓存清空（不是只直接测 clearMarkdownCache）
  it('resetConversation 触发缓存清空（挂载点集成）', () => {
    setActivePinia(createPinia())
    renderMarkdown('**会话内文本**')
    const store = useMessageStore()
    store.resetConversation('conv-1')
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    renderMarkdown('**会话内文本**')   // 清空后应重新 parse
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
