// @vitest-environment happy-dom
// tests/unit/cy-tool-card.spec.ts
// 阶段 6 批次 C（Task 7）：CyToolCard 只读 Diff（F-4）——grant 命中自动执行路径的完成记录
// 携带 diff（F-7 契约：ToolCallRecord.diff），卡片渲染只读 Diff 信息条（无确认按钮——approval-diff 仅权限窗）。
import { describe, expect, it, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CyToolCard from '../../src/renderer/src/components/CyToolCard.vue'
import type { ToolCallRecord } from '@shared/contracts/tool'

let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

describe('CyToolCard 只读 Diff（F-4）', () => {
  it('F-4 只读 Diff：completed 记录携带 diff → 渲染只读 Diff 块无确认按钮', () => {
    const rec: ToolCallRecord = {
      id: 'tc_1', toolName: 'desktop.file.write', runtime: 'desktop', status: 'completed',
      diff: { lines: [{ kind: 'added', text: 'x\n' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'f', isNewFile: false },
      startedAt: 'x',
    }
    const w = mount(CyToolCard, { props: { record: rec as never }, global: { plugins: [pinia] } })
    expect(w.find('[data-testid="tool-diff-readonly"]').exists()).toBe(true)
    expect(w.find('[data-testid="approval-diff"]').exists()).toBe(false)   // 无确认按钮
  })

  it('归档截图记录通过 Main 自定义协议渲染，不含后端 URL', () => {
    const rec: ToolCallRecord = {
      id: 'tc_cap', desktopCallId: 'call_2025c9e03ffa', toolName: 'desktop.screen.capture',
      runtime: 'desktop', status: 'completed', attachmentCount: 1
    }
    const w = mount(CyToolCard, { props: { record: rec, readonly: true }, global: { plugins: [pinia] } })
    const image = w.get('[data-testid="tool-capture-archive"]')
    expect(image.attributes('src')).toBe('cyrene://renderer/__cyrene-media/tool-capture/call_2025c9e03ffa')
    expect(w.html()).not.toContain('/uploads/desktop/')
  })
})
