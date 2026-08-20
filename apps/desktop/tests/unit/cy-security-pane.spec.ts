// @vitest-environment happy-dom
// tests/unit/cy-security-pane.spec.ts
// 阶段 6 批次 C（Task 7）：CySecurityPane 三分区——授权管理 / 审批历史 / 命令模板空态。
// 环境 happy-dom：Vue Test Utils 挂载（cy-tool-approval.spec 同款先例）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CySecurityPane from '../../src/renderer/src/components/CySecurityPane.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { HistoryEntry, PermissionGrant } from '@shared/contracts/tool'

const GRANT_ACTIVE: PermissionGrant = {
  id: 'g1', toolName: 'desktop.file.read', scope: { directory: '/home/u/docs' },
  backendIdentity: 'http://localhost:8000', expiresAt: Date.now() + 86_400_000, createdAt: 'x', source: 'directory',
}
const HIST_ENTRY: HistoryEntry = {
  ts: '2026-08-20T10:00:00Z', type: 'tool:decision', toolName: 'desktop.file.read',
  status: 'completed', permissionDecision: 'allow_scoped', permissionGrantId: 'g1', summary: '（已脱敏摘要）',
}

const api = {
  toolListGrants: vi.fn().mockResolvedValue([GRANT_ACTIVE]),
  toolListHistory: vi.fn().mockResolvedValue([HIST_ENTRY]),
  toolRevokeGrant: vi.fn(),
}
let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  setDesktopApi(api as never)
  vi.clearAllMocks()
  api.toolListGrants.mockResolvedValue([GRANT_ACTIVE])
  api.toolListHistory.mockResolvedValue([HIST_ENTRY])
})

describe('CySecurityPane 三分区（授权管理/审批历史/命令模板空态）', () => {
  it('三分区渲染（授权管理/审批历史/命令模板空态）', async () => {
    const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(w.find('[data-testid="grants-list"]').exists()).toBe(true)
    expect(w.find('[data-testid="history-list"]').exists()).toBe(true)
    expect(w.find('[data-testid="command-templates-empty"]').exists()).toBe(true)
  })
  it('授权管理：活动 grant 卡片显示后端身份 + 撤销按钮 → revokeGrant(id)', async () => {
    const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(w.find('[data-testid="grant-g1"]').exists()).toBe(true)
    expect(w.find('[data-testid="grant-backend"]').text()).toBe('http://localhost:8000')   // N-2
    await w.find('[data-testid="grant-revoke"]').trigger('click')
    await flushPromises()
    expect(api.toolRevokeGrant).toHaveBeenCalledWith('g1')
    expect(api.toolListGrants).toHaveBeenCalled()   // 刷新
  })
  it('已撤销/已过期灰显 + revokeSource 标注 + 无撤销按钮（F-25）', async () => {
    api.toolListGrants.mockResolvedValue([{ ...GRANT_ACTIVE, id: 'g2', revokedAt: 'x', revokeSource: 'user' }])
    const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(w.find('[data-testid="grant-g2"]').classes()).toContain('is-revoked')
    expect(w.find('[data-testid="grant-revoked-source"]').text()).toBe('已撤销')
    expect(w.find('[data-testid="grant-revoke"]').exists()).toBe(false)
  })
  it('授权管理空态：「暂无长期授权…」', async () => {
    api.toolListGrants.mockResolvedValue([])
    const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(w.find('[data-testid="grants-empty"]').text()).toContain('暂无长期授权')
  })
  it('审批历史：条目渲染 + 工具过滤 + 结果筛选 + 搜索（LOW-4）', async () => {
    api.toolListHistory.mockResolvedValue([
      HIST_ENTRY,   // { status:'completed', permissionDecision:'allow_scoped' }
      { ...HIST_ENTRY, toolName: 'desktop.file.write', ts: '2026-08-20T11:00:00Z' },
      { ...HIST_ENTRY, toolName: 'desktop.file.read', ts: '2026-08-20T12:00:00Z', status: 'failed', permissionDecision: undefined },
    ])
    const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(w.findAll('[data-testid="history-list"] li')).toHaveLength(3)
    await w.find('[data-testid="history-tool-filter"]').setValue('desktop.file.write')
    await flushPromises()
    expect(w.findAll('[data-testid="history-list"] li')).toHaveLength(1)
    await w.find('[data-testid="history-tool-filter"]').setValue('all')
    // LOW-4 结果筛选：failed → 仅 failed 条；success → completed/succeeded 条
    await w.find('[data-testid="history-result-filter"]').setValue('failed')
    await flushPromises()
    expect(w.findAll('[data-testid="history-list"] li')).toHaveLength(1)
    await w.find('[data-testid="history-result-filter"]').setValue('success')
    await flushPromises()
    expect(w.findAll('[data-testid="history-list"] li')).toHaveLength(2)   // completed ×2
    await w.find('[data-testid="history-result-filter"]').setValue('all')
    await w.find('[data-testid="history-search"]').setValue('脱敏')
    await flushPromises()
    expect(w.findAll('[data-testid="history-list"] li')).toHaveLength(3)   // summary 均含「脱敏」
  })
  it('allow_scoped 条目「撤销此授权」→ revokeGrant(permissionGrantId)', async () => {
    const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    await w.find('[data-testid="history-jump-revoke"]').trigger('click')
    await flushPromises()
    expect(api.toolRevokeGrant).toHaveBeenCalledWith('g1')   // permissionGrantId
  })
  it('命令模板空态文案（F-08）', async () => {
    const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(w.find('[data-testid="command-templates-empty"]').text()).toContain('未启用受控命令执行')
  })
})
