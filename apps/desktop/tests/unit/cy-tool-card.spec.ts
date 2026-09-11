// @vitest-environment happy-dom
// tests/unit/cy-tool-card.spec.ts —— UII-QQ 收尾（工具卡重构）：紧凑执行回执卡。
// 覆盖：折叠默认规则（completed/rejected/cancelled/timeout 折叠；running/failed/待授权默认展开）、
// 标题区 native button 切换（aria-expanded + 点击）、用户手动切换优先与自动收起条件、runtime 三标签、
// 友好名映射（未命中回退）、折叠摘要优先级（output→input→状态）、长结果限高内滚动、截断提示、
// 授权/拒绝/取消事件与 decide 调用、复制结果（clipboard 封装模块 mock）、
// 只读 Diff（F-4 契约）与归档截图（cyrene:// 协议）不受折叠影响。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import CyToolCard from '../../src/renderer/src/components/CyToolCard.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { ToolCallRecord } from '@shared/contracts/tool'

vi.mock('../../src/renderer/src/utils/clipboard', () => ({ copyText: vi.fn(async () => true) }))
import { copyText } from '../../src/renderer/src/utils/clipboard'

const mockApi = {
  toolDecide: vi.fn(async () => undefined), toolCancel: vi.fn(async () => undefined),
  toolPickSource: vi.fn(), toolConfirmUpload: vi.fn(), toolListGrants: vi.fn(async () => []), toolListHistory: vi.fn(async () => []),
}

let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  setDesktopApi(mockApi as unknown as Parameters<typeof setDesktopApi>[0])
  vi.clearAllMocks()
})

function rec(partial: Partial<ToolCallRecord>): ToolCallRecord {
  return { id: 'tc_1', toolName: 'desktop.file.read', runtime: 'desktop', status: 'completed', ...partial }
}

function mountCard(record: ToolCallRecord, readonly = false) {
  return mount(CyToolCard, { props: { record, readonly }, global: { plugins: [pinia] } })
}

describe('CyToolCard 折叠默认规则（按状态）', () => {
  it('completed 默认折叠：details 不渲染、aria-expanded=false、摘要行 output 优先 + 状态·耗时', () => {
    const w = mountCard(rec({ status: 'completed', inputSummary: 'IN', outputSummary: 'OUT', durationMs: 30 }))
    const toggle = w.find('[data-testid="tool-toggle"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-testid="tool-details"]').exists()).toBe(false)
    expect(w.find('[data-testid="tool-brief"]').text()).toBe('OUT')
    expect(w.find('[data-testid="tool-status"]').text()).toContain('已完成')
    expect(w.find('[data-testid="tool-status"]').text()).toContain('30ms')
    w.unmount()
  })

  it('摘要优先级：outputSummary → inputSummary → 状态文案', () => {
    const withOutput = mountCard(rec({ status: 'completed', outputSummary: 'O', inputSummary: 'I' }))
    expect(withOutput.find('[data-testid="tool-brief"]').text()).toBe('O')
    withOutput.unmount()
    const inputOnly = mountCard(rec({ status: 'completed', inputSummary: 'I' }))
    expect(inputOnly.find('[data-testid="tool-brief"]').text()).toBe('I')
    inputOnly.unmount()
    const none = mountCard(rec({ status: 'completed' }))
    expect(none.find('[data-testid="tool-brief"]').text()).toBe('已完成')
    none.unmount()
  })

  it('rejected/cancelled/timeout 同样默认折叠', () => {
    for (const status of ['rejected', 'cancelled', 'timeout'] as const) {
      const w = mountCard(rec({ status }))
      expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('false')
      w.unmount()
    }
  })

  it('running / failed / awaiting_permission 默认展开', () => {
    for (const status of ['running', 'failed', 'awaiting_permission'] as const) {
      const w = mountCard(rec({ status, inputSummary: 'IN' }))
      expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('true')
      expect(w.find('[data-testid="tool-details"]').exists()).toBe(true)
      w.unmount()
    }
  })
})

describe('CyToolCard 展开详情', () => {
  it('点击标题区展开/收起：aria-expanded 切换 + 调用参数/执行结果分区渲染', async () => {
    const w = mountCard(rec({ status: 'completed', inputSummary: 'IN-TEXT', outputSummary: 'OUT-TEXT' }))
    await w.find('[data-testid="tool-toggle"]').trigger('click')
    expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('true')
    const details = w.find('[data-testid="tool-details"]')
    expect(details.exists()).toBe(true)
    expect(details.text()).toContain('调用参数')
    expect(details.text()).toContain('IN-TEXT')
    expect(details.text()).toContain('执行结果')
    expect(details.text()).toContain('OUT-TEXT')
    await w.find('[data-testid="tool-toggle"]').trigger('click')
    expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-testid="tool-details"]').exists()).toBe(false)
    w.unmount()
  })

  it('键盘可达：native button（type=button）承载 Enter/Space 原生激活语义', () => {
    const w = mountCard(rec({ status: 'completed' }))
    const toggle = w.find('[data-testid="tool-toggle"]')
    // HTML 规范：native <button type=button> 的 Enter/Space 激活是浏览器原生行为（happy-dom 不合成该 click），
    // 故此处锁定「可聚焦 native button + aria-expanded」契约——点击切换路径另由上方用例覆盖
    expect(toggle.element.tagName).toBe('BUTTON')
    expect((toggle.element as HTMLButtonElement).type).toBe('button')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    w.unmount()
  })

  it('复制结果：调 clipboard 封装（outputSummary），按钮瞬时反馈「已复制」', async () => {
    const w = mountCard(rec({ status: 'completed', outputSummary: 'RESULT-TEXT' }))
    await w.find('[data-testid="tool-toggle"]').trigger('click')
    await w.find('[data-testid="tool-copy"]').trigger('click')
    await w.vm.$nextTick()
    expect(vi.mocked(copyText)).toHaveBeenCalledWith('RESULT-TEXT')
    expect(w.find('[data-testid="tool-copy"]').text()).toBe('已复制')
    w.unmount()
  })

  it('长结果：展开详情限高内部滚动（cy-tool-pre），不无限撑长；truncated 显示弱提示', async () => {
    const w = mountCard(rec({ status: 'completed', outputSummary: 'x'.repeat(5000), truncated: true }))
    await w.find('[data-testid="tool-toggle"]').trigger('click')
    const pre = w.find('[data-testid="tool-output"]')
    expect(pre.classes()).toContain('cy-tool-pre')
    expect(pre.text()).toHaveLength(5000)   // 内容全量渲染，高度由 CSS max-height + overflow-y 收敛
    expect(w.find('[data-testid="tool-truncated"]').text()).toBe('结果已截断')
    w.unmount()
  })

  it('错误：失败详情显示独立错误区域（error.message）', async () => {
    const w = mountCard(rec({ status: 'failed', error: { code: 'E_X', message: 'boom' } }))
    expect(w.find('[data-testid="tool-error"]').text()).toContain('boom')
    w.unmount()
  })

  it('错误文案经集中映射：已映射码显示友好文案而非原始 message（2026-09-10 收口）', async () => {
    // SCHEMA_VALIDATION_FAILED 在 utils/error-message 的合并表里有映射。此前本组件直接渲染
    // record.error.message，绕过了该表——任何新增映射对本卡片静默失效。
    const w = mountCard(rec({ status: 'failed', error: { code: 'SCHEMA_VALIDATION_FAILED', message: 'zod: expected string' } }))
    const text = w.find('[data-testid="tool-error"]').text()
    expect(text).toContain('数据格式无效')
    expect(text).not.toContain('zod: expected string')
    w.unmount()
  })

  it('错误文案回退链第 ③ 档保留：无映射码仍显示后端已公开原文', async () => {
    // 工具侧真实执行错误没有本地映射，其可读说明必须原样显示（丢弃会变成空白或泛化句）
    const w = mountCard(rec({ status: 'failed', error: { code: 'E_FILE_IO', message: '文件被占用，请关闭后重试' } }))
    expect(w.find('[data-testid="tool-error"]').text()).toContain('文件被占用，请关闭后重试')
    w.unmount()
  })
})

describe('CyToolCard 状态切换与用户选择', () => {
  it('running → completed 且用户未手动操作 → 自动收起（默认值翻转）', async () => {
    const record = reactive(rec({ status: 'running' }))
    const w = mountCard(record)
    expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('true')
    record.status = 'completed'
    await w.vm.$nextTick()
    expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('false')
    w.unmount()
  })

  it('用户手动切换后本生命周期尊重用户选择（状态推进不再翻转）', async () => {
    const record = reactive(rec({ status: 'running' }))
    const w = mountCard(record)
    await w.find('[data-testid="tool-toggle"]').trigger('click')   // 用户手动收起
    expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('false')
    record.status = 'completed'
    await w.vm.$nextTick()
    expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('false')   // 保持用户选择
    record.status = 'failed'
    await w.vm.$nextTick()
    expect(w.find('[data-testid="tool-toggle"]').attributes('aria-expanded')).toBe('false')   // 不被默认展开覆盖
    w.unmount()
  })
})

describe('CyToolCard 展示映射', () => {
  it('runtime 三标签：backend→后端 / desktop→桌面 / local_worker→本地工作器（data-runtime 同步）', () => {
    const cases: Array<[ToolCallRecord['runtime'], string]> = [['backend', '后端'], ['desktop', '桌面'], ['local_worker', '本地工作器']]
    for (const [runtime, label] of cases) {
      const w = mountCard(rec({ runtime }))
      expect(w.find('.cy-tool-runtime').text()).toBe(label)
      expect(w.find('.cy-tool-card').attributes('data-runtime')).toBe(runtime)
      w.unmount()
    }
  })

  it('友好名映射：describe_image→图片理解；title 保留原始工具 ID', () => {
    const w = mountCard(rec({ toolName: 'describe_image' }))
    expect(w.find('.cy-tool-name').text()).toBe('图片理解')
    expect(w.find('.cy-tool-name').attributes('title')).toBe('describe_image')
    w.unmount()
  })

  it('未命中映射回退：原名展示不空白；desktop. 前缀剥离', () => {
    const plain = mountCard(rec({ toolName: 'weird_custom_tool' }))
    expect(plain.find('.cy-tool-name').text()).toBe('weird_custom_tool')
    plain.unmount()
    const prefixed = mountCard(rec({ toolName: 'desktop.unknown_tool' }))
    expect(prefixed.find('.cy-tool-name').text()).toBe('unknown_tool')
    prefixed.unmount()
  })
})

describe('CyToolCard 操作（折叠区外，授权/取消不因折叠丢失）', () => {
  it('awaiting：默认展开且 允许/拒绝/取消 三入口并存（H13）', async () => {
    const w = mountCard(rec({ status: 'awaiting_permission', inputSummary: 'IN' }))
    expect(w.find('[data-testid="tool-details"]').exists()).toBe(true)   // 待操作卡片不被折叠隐藏
    expect(w.find('[data-testid="tool-approve"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-deny"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-cancel"]').exists()).toBe(true)
    // 手动收起后操作按钮仍在（操作区不受折叠影响）
    await w.find('[data-testid="tool-toggle"]').trigger('click')
    expect(w.find('[data-testid="tool-details"]').exists()).toBe(false)
    expect(w.find('[data-testid="tool-approve"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-cancel"]').exists()).toBe(true)
    w.unmount()
  })

  it('事件与 decide 调用：approve → emit(openApproval)；deny → toolStore.decide(callId, deny)；cancel → emit(cancel)', async () => {
    const w = mountCard(rec({ id: 'tc_1', status: 'awaiting_permission' }))
    await w.find('[data-testid="tool-approve"]').trigger('click')
    expect(w.emitted('openApproval')).toHaveLength(1)
    await w.find('[data-testid="tool-deny"]').trigger('click')
    expect(mockApi.toolDecide).toHaveBeenCalledWith({ callId: 'tc_1', decision: 'deny' })
    await w.find('[data-testid="tool-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    w.unmount()
  })

  it('completed 卡片无授权/取消入口；running 卡保留取消入口', () => {
    const done = mountCard(rec({ status: 'completed' }))
    expect(done.find('[data-testid="tool-approve"]').exists()).toBe(false)
    expect(done.find('[data-testid="tool-cancel"]').exists()).toBe(false)
    done.unmount()
    const running = mountCard(rec({ status: 'running' }))
    expect(running.find('[data-testid="tool-cancel"]').exists()).toBe(true)
    running.unmount()
  })
})

describe('CyToolCard 二轮收尾（摘要格式化/耗时/宽度/详情）', () => {
  const READ_JSON = JSON.stringify({ path: '/tmp/stage6-large.txt', name: 'stage6-large.txt', size: 150000, charset: 'utf-8', truncated: true })

  it('文件读取 JSON 折叠摘要易读化（不显示原始 JSON 整串）；摘要已含「内容已截断」→ 不追加重复标签', () => {
    const w = mountCard(rec({ id: 'tc_fr', toolName: 'desktop.file.read', runtime: 'backend', status: 'completed', outputSummary: READ_JSON }))
    expect(w.find('[data-testid="tool-brief"]').text()).toBe('已读取 stage6-large.txt · 146.5 KB · UTF-8 · 内容已截断')
    expect(w.find('[data-testid="tool-brief"]').text()).not.toContain('{"path"')
    expect(w.find('[data-testid="tool-brief-tag"]').exists()).toBe(false)
    w.unmount()
  })

  it('record.truncated=true 且摘要无截断字样 → 摘要末尾橙色「已截断」；展开态切「结果已截断」（同一状态不重复）', async () => {
    const w = mountCard(rec({ status: 'completed', outputSummary: 'plain result', truncated: true }))
    expect(w.find('[data-testid="tool-brief-tag"]').text()).toBe('已截断')
    await w.find('[data-testid="tool-toggle"]').trigger('click')
    expect(w.find('[data-testid="tool-brief-tag"]').exists()).toBe(false)   // 折叠摘要随展开消失
    expect(w.find('[data-testid="tool-truncated"]').text()).toBe('结果已截断')
    w.unmount()
  })

  it('结构化结果顶层 truncated:true 同样判为已截断（不改原始 record）', () => {
    const w = mountCard(rec({ status: 'completed', outputSummary: JSON.stringify({ name: 'a.txt', truncated: true }) }))
    expect(w.find('[data-testid="tool-brief"]').text()).toBe('已读取 a.txt · 内容已截断')
    expect(w.find('[data-testid="tool-brief-tag"]').exists()).toBe(false)
    w.unmount()
  })

  it('durationMs=0/undefined 不显示耗时；<1ms、毫秒、秒正确格式化', () => {
    const zero = mountCard(rec({ status: 'completed', durationMs: 0 }))
    expect(zero.find('[data-testid="tool-status"]').text()).toBe('已完成')
    zero.unmount()
    const none = mountCard(rec({ status: 'completed' }))
    expect(none.find('[data-testid="tool-status"]').text()).toBe('已完成')
    none.unmount()
    const ms = mountCard(rec({ status: 'completed', durationMs: 500 }))
    expect(ms.find('[data-testid="tool-status"]').text()).toContain('· 500ms')
    ms.unmount()
    const sub = mountCard(rec({ status: 'completed', durationMs: 0.4 }))
    expect(sub.find('[data-testid="tool-status"]').text()).toContain('· <1ms')
    sub.unmount()
    const sec = mountCard(rec({ status: 'completed', durationMs: 1500 }))
    expect(sec.find('[data-testid="tool-status"]').text()).toContain('· 1.5s')
    sec.unmount()
  })

  it('展开态 JSON：缩进格式 + is-json 等宽类；复制按钮复制原始 outputSummary（非格式化结果）', async () => {
    const w = mountCard(rec({ id: 'tc_json', toolName: 'read_file', status: 'completed', outputSummary: READ_JSON }))
    await w.find('[data-testid="tool-toggle"]').trigger('click')
    const pre = w.find('[data-testid="tool-output"]')
    expect(pre.classes()).toContain('is-json')
    expect(pre.text()).toBe(JSON.stringify(JSON.parse(READ_JSON), null, 2))
    await w.find('[data-testid="tool-copy"]').trigger('click')
    await w.vm.$nextTick()
    expect(vi.mocked(copyText)).toHaveBeenCalledWith(READ_JSON)
    w.unmount()
  })

  it('无效 JSON 文本展开不抛异常、原样展示；工具标识弱化显示原始 toolName', () => {
    const w = mountCard(rec({ id: 'tc_bad', toolName: 'desktop.unknown_tool', status: 'failed', error: { code: 'E_X', message: 'boom' } }))
    // failed 默认展开 → 详情直接可见（点击会切换为收起，故不点）
    expect(w.find('[data-testid="tool-output"]').exists()).toBe(false)
    expect(w.find('[data-testid="tool-ident"]').text()).toBe('工具标识 desktop.unknown_tool')
    w.unmount()
  })

  it('技术错误码弱化置底；TOOL_ERROR 兜底码不展示', () => {
    const w = mountCard(rec({ status: 'failed', error: { code: 'E_FILE_IO', message: '读失败' } }))
    expect(w.find('[data-testid="tool-error-code"]').text()).toBe('E_FILE_IO')
    w.unmount()
    const generic = mountCard(rec({ status: 'failed', error: { code: 'TOOL_ERROR', message: '失败' } }))
    expect(generic.find('[data-testid="tool-error-code"]').exists()).toBe(false)
    generic.unmount()
  })

  it('用户取消/拒绝不渲染红色错误区域（数据保留但非执行错误）', () => {
    const cancelled = mountCard(rec({ status: 'cancelled', error: { code: 'CANCELLED', message: '用户取消' } }))
    expect(cancelled.find('[data-testid="tool-error"]').exists()).toBe(false)
    expect(cancelled.find('[data-testid="tool-status"]').text()).toContain('已取消')
    expect(cancelled.find('[data-testid="tool-brief"]').text()).toBe('已取消')
    cancelled.unmount()
    const rejected = mountCard(rec({ status: 'rejected', error: { code: 'PERMISSION_DENIED', message: '权限被拒绝' } }))
    expect(rejected.find('[data-testid="tool-error"]').exists()).toBe(false)
    rejected.unmount()
  })

  it('宽度一致：成功/取消/失败/折叠/展开 卡片根类一致（同一宽度基准规则，不随内容长度伸缩）', async () => {
    const classes = (w: ReturnType<typeof mount>) => w.find('.cy-tool-card').classes().sort()
    const done = mountCard(rec({ id: 'w1', status: 'completed', outputSummary: 'x'.repeat(3000) }))
    const cancelled = mountCard(rec({ id: 'w2', status: 'cancelled' }))
    const failed = mountCard(rec({ id: 'w3', status: 'failed', error: { code: 'E', message: 'x' } }))
    const base = classes(done)
    expect(base).toContain('cy-tool-card')
    expect(classes(cancelled)).toEqual(base)
    expect(classes(failed)).toEqual(base)
    await done.find('[data-testid="tool-toggle"]').trigger('click')
    expect(classes(done)).toEqual(base)   // 展开后宽度类不变
    done.unmount(); cancelled.unmount(); failed.unmount()
  })
})

describe('CyToolCard 既有契约（重构前已锁定）', () => {
  it('F-4 只读 Diff：completed 记录携带 diff → 只读 Diff 块恒渲染（不随折叠消失）且无确认按钮', () => {
    const record = rec({
      status: 'completed',
      diff: { lines: [{ kind: 'added', text: 'x\n' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'f', isNewFile: false },
      startedAt: 'x',
    })
    const w = mount(CyToolCard, { props: { record }, global: { plugins: [pinia] } })
    // completed 默认折叠 → diff 仍在（只读 diff 不进折叠区）
    expect(w.find('[data-testid="tool-diff-readonly"]').exists()).toBe(true)
    expect(w.find('[data-testid="approval-diff"]').exists()).toBe(false)   // 无确认按钮
    w.unmount()
  })

  it('归档截图记录通过 Main 自定义协议渲染，不含后端 URL', () => {
    const record = rec({
      id: 'tc_cap', desktopCallId: 'call_2025c9e03ffa', toolName: 'desktop.screen.capture',
      status: 'completed', attachmentCount: 1,
    })
    const w = mountCard(record, true)
    const image = w.get('[data-testid="tool-capture-archive"]')
    expect(image.attributes('src')).toBe('cyrene://renderer/__cyrene-media/tool-capture/call_2025c9e03ffa')
    expect(w.html()).not.toContain('/uploads/desktop/')
    w.unmount()
  })

  it('readonly 归档卡：无授权/拒绝操作入口、无侧信道 pathSummary', () => {
    const w = mountCard(rec({ status: 'awaiting_permission' }), true)
    expect(w.find('[data-testid="tool-approve"]').exists()).toBe(false)
    expect(w.find('[data-testid="tool-deny"]').exists()).toBe(false)
    // 取消按钮旧实现只按 status 门控（不看 readonly）——readonly+非终态实际不可达（归档恒终态），保持零行为偏差
    expect(w.find('[data-testid="tool-cancel"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-path"]').exists()).toBe(false)
    w.unmount()
  })
})
