// @vitest-environment happy-dom
// tests/unit/cy-tool-approval.spec.ts
// fix round 1（M1，spec 违背）：CyToolApproval 在 CyLiveToolCards 内常驻挂载（:open 切换无 v-if），
// onMounted 只执行一次且此时 open 恒 false——初始焦点（拒绝按钮）必须经 watch(open) 驱动。
// 环境 happy-dom：Vue Test Utils 挂载（cy-voice-pane.spec 同款先例）。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CyToolApproval from '../../src/renderer/src/components/CyToolApproval.vue'
import { useToolStore } from '../../src/renderer/src/stores/tool.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { DesktopApiLike } from '../../src/renderer/src/stores/desktop-api.types'
import type { PublicToolEvent } from '@shared/contracts/tool'

const mockApi = {
  onToolEvent: vi.fn(() => () => {}), toolDecide: vi.fn(), toolCancel: vi.fn(),
  toolList: vi.fn(), toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolGrantDirectory: vi.fn(), toolListGrants: vi.fn(), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn()
} as unknown as DesktopApiLike

beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi) })

function awaiting(id = 'tc_1'): PublicToolEvent {
  return { id, toolName: 'desktop.file.write', title: '写入文件', runtime: 'desktop', status: 'awaiting_permission',
    occurredAt: '2026-08-20T00:00:00.000Z', pathSummary: '/home/u/notes.md', dataFlowNote: '写入内容将发送到后端' }
}

describe('CyToolApproval（fix round 1 M1：打开时初始焦点在拒绝按钮）', () => {
  it('open 变 true（有待授权记录）→ 权限窗渲染且初始焦点在拒绝按钮', async () => {
    useToolStore().upsertLocal(awaiting())
    // attachTo：默认挂载于脱离 document 的容器，element.focus() 不会成为 document.activeElement
    const wrapper = mount(CyToolApproval, { props: { open: false }, attachTo: document.body })
    expect(wrapper.find('[data-testid="tool-approval"]').exists()).toBe(false) // 关闭态不渲染
    // tsconfig.node 下 .vue 为 ambient shim（DefineComponent<object,...>），setProps 参数无类型信息——
    // 按仓库先例（history-viewer.store.spec `as never`）断言为 never
    await wrapper.setProps({ open: true } as never)
    await nextTick()
    await flushPromises()
    const deny = wrapper.find('[data-testid="approval-deny"]')
    expect(wrapper.find('[data-testid="tool-approval"]').exists()).toBe(true)
    expect(deny.exists()).toBe(true)
    expect(document.activeElement).toBe(deny.element) // 初始焦点在拒绝按钮（防误触「允许一次」）
    wrapper.unmount()
  })

  it('无 awaiting 记录时 open=true 也不渲染（非自动弹出兜底）', async () => {
    const wrapper = mount(CyToolApproval, { props: { open: true } })
    await nextTick()
    expect(wrapper.find('[data-testid="tool-approval"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
