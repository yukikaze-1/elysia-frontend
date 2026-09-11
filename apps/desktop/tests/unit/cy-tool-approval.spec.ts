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
import { GRANT_DEFAULT_TTL_MS } from '@shared/contracts/tool'
import { readFileSync } from 'fs'
import { join } from 'path'

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

describe('CyToolApproval 第三入口「允许指定目录」（批次 C Task 7，D6C-05/F-18/L-8）', () => {
  function awaitingRead(extra: Partial<PublicToolEvent> = {}): PublicToolEvent {
    return { ...awaiting('tc_1'), toolName: 'desktop.file.read', desktopCallId: 'call_1', ...extra }
  }
  it('「允许指定目录」仅 read/write awaiting 显示（D6C-05）', async () => {
    const s = useToolStore()
    s.upsertLocal(awaitingRead())
    const read = mount(CyToolApproval, { props: { open: true } })
    expect(read.find('[data-testid="approval-grant-dir"]').exists()).toBe(true)
    // 同测试内切换：read 终态化后注入 capture awaiting → current 变为 capture，第三入口不显示
    s.upsertLocal({ ...awaiting('tc_1'), status: 'completed' })
    s.upsertLocal({ ...awaiting('tc_cap'), toolName: 'desktop.screen.capture' })
    const cap = mount(CyToolApproval, { props: { open: true } })
    expect(cap.find('[data-testid="tool-approval"]').exists()).toBe(true)
    expect(cap.find('[data-testid="approval-grant-dir"]').exists()).toBe(false)
  })
  it('MED-1（Task 7 review）：grant 子面板跨请求状态泄漏回归——打开 grant 面板后 deny → capture awaiting 重开面板无 grant-box', async () => {
    const s = useToolStore()
    s.upsertLocal(awaitingRead())
    const w = mount(CyToolApproval, { props: { open: true } })
    await w.find('[data-testid="approval-grant-dir"]').trigger('click')
    expect(w.find('[data-testid="approval-grant-box"]').exists()).toBe(true)   // 子面板打开
    await w.find('[data-testid="approval-deny"]').trigger('click')   // deny 关闭（不复位路径——watch(open) 复位承接）
    // 切换 capture awaiting → 重开面板
    s.upsertLocal({ ...awaiting('tc_1'), status: 'rejected' })
    s.upsertLocal({ ...awaiting('tc_cap'), toolName: 'desktop.screen.capture' })
    const w2 = mount(CyToolApproval, { props: { open: true } })
    expect(w2.find('[data-testid="approval-grant-box"]').exists()).toBe(false)   // 双门：isGrantable && openGrantPicker——capture 不显示授权 UI
  })
  it('TTL select 默认 24h + 确认 → grantDirectory(callId, ttlMs)（F-18；LOW-2：用户选择不被覆盖——选 1h → 确认收 1h）', async () => {
    const s = useToolStore()
    s.upsertLocal(awaitingRead())
    const spy = vi.spyOn(s, 'grantDirectory').mockResolvedValue(true)
    const w = mount(CyToolApproval, { props: { open: true } })
    await w.find('[data-testid="approval-grant-dir"]').trigger('click')
    expect((w.find('[data-testid="grant-ttl-select"]').element as HTMLSelectElement).value).toBe(String(GRANT_DEFAULT_TTL_MS))   // 默认 24h
    await w.find('[data-testid="approval-grant-confirm"]').trigger('click')
    expect(spy).toHaveBeenCalledWith('call_1', 86_400_000)   // GRANT_DEFAULT_TTL_MS
    // LOW-2（Task 7 review）：用户选择不被 :value 绑定覆盖——选 1h → 确认收到 1h
    spy.mockClear()
    const w2 = mount(CyToolApproval, { props: { open: true } })
    await w2.find('[data-testid="approval-grant-dir"]').trigger('click')
    await w2.find('[data-testid="grant-ttl-select"]').setValue(String(3600_000))
    await w2.find('[data-testid="approval-grant-confirm"]').trigger('click')
    expect(spy).toHaveBeenCalledWith('call_1', 3600_000)   // 1h（3600_000 ∈ GRANT_TTL_OPTIONS_MS）
  })
  it('FINAL-LOW（F-1 miss 反馈）：grantDirectory 返回 false → 提示「授权已创建，但当前请求目标不在授权目录内」不关窗', async () => {
    const s = useToolStore()
    s.upsertLocal(awaitingRead())
    vi.spyOn(s, 'grantDirectory').mockResolvedValue(false)   // F-1 miss：grant 已建未执行
    const w = mount(CyToolApproval, { props: { open: true } })
    await w.find('[data-testid="approval-grant-dir"]').trigger('click')
    await w.find('[data-testid="approval-grant-confirm"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tool-approval"]').exists()).toBe(true)   // 不关窗
    expect(w.find('.cy-approval-grant-error').text()).toContain('不在授权目录内')   // 提示可见
    expect(w.find('[data-testid="approval-grant-box"]').exists()).toBe(true)   // 面板保持
  })
  it('提交期间禁用（L-8 防抖）', async () => {
    const s = useToolStore()
    s.upsertLocal(awaitingRead())
    let resolveGrant!: (value?: unknown) => void
    vi.spyOn(s, 'grantDirectory').mockImplementation(() => new Promise((r) => { resolveGrant = r }) as never)
    const w = mount(CyToolApproval, { props: { open: true } })
    await w.find('[data-testid="approval-grant-dir"]').trigger('click')
    await w.find('[data-testid="approval-grant-confirm"]').trigger('click')
    expect((w.find('[data-testid="approval-grant-confirm"]').attributes() as Record<string, string | undefined>).disabled).toBeDefined()   // pending 时禁用
    resolveGrant(true)   // FINAL-LOW：executed=true（否则走 F-1 miss 提示分支不关窗）
    await nextTick()
    await nextTick()   // 第二个 nextTick：granting=false 的渲染 flush 在 promise 续延之后入队，需再冲刷一次
    // 完成恢复：成功后面板关闭——确认按钮随面板移除（不再存在禁用态；emit('close') 既有语义）
    expect(w.find('[data-testid="approval-grant-confirm"]').exists()).toBe(false)
  })
})

// 2026-09-11 全量评审 M-20 的收口断言：安全授权按钮曾用「背景族」token 作文本色。
// `--cy-accent`（亮色 #e7edff / 暗色 #2a3c5f）是给实底用的浅色，在白底/深底上作文字只有 ≈1.17:1，
// 而 token-contract.spec.ts 只校验「引用的 token 已定义」，不区分用法，因此该缺陷能长期存活。
// 本断言按文件与规则级钉住：授权按钮的 color 必须是配对的文字色 token。
describe('CyToolApproval 授权按钮文本可读性（M-20）', () => {
  it('「允许一次」/「本次允许」不得用背景族 token 作文本色', () => {
    const sfc = readFileSync(join(__dirname, '../../src/renderer/src/components/CyToolApproval.vue'), 'utf8')
    for (const sel of ['.cy-btn-approve', '.cy-btn-grant']) {
      const body = sfc.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`))?.[0] ?? ''
      expect(body, `应存在规则 ${sel}`).not.toBe('')
      // 只取 color 属性的值：不能直接 match(/color:/)，那会命中 border-color:
      const values = [...body.matchAll(/(?:^|[;\s])color:\s*([^;}]+)/g)].map((m) => m[1].trim())
      expect(values, `${sel} 应显式声明 color`).toHaveLength(1)
      expect(values[0], `${sel} 的文本色应为与 accent 配对的可读文字色`).toBe('var(--cy-accent-text)')
    }
  })
})
