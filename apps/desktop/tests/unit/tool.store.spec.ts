// @vitest-environment happy-dom
// 阶段 6 批次 B（Task 7）：toolStore——三来路归一化（tool:event 实时 / backend 事件只读）/ 终态单向 /
// D6B-21 合并 / pendingPathSummary+pendingDiff+pendingDataFlowNote 侧信道 / clearForGeneration 只清终态。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useToolStore } from '../../src/renderer/src/stores/tool.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { DesktopApiLike } from '../../src/renderer/src/stores/desktop-api.types'
import type { PublicToolEvent } from '@shared/contracts/tool'
import type { BackendEvent } from '@shared/contracts/events'

type ToolBackendEvent = Extract<BackendEvent, { event: 'tool.request' | 'tool.started' | 'tool.completed' }>

beforeEach(() => { setActivePinia(createPinia()) })

function mkLocal(status: PublicToolEvent['status'], id = 'tc_1'): PublicToolEvent {
  return { id, toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop', status, occurredAt: '2026-08-20T00:00:00.000Z', attachmentCount: 1 }
}

describe('toolStore 三来路归一化', () => {
  it('tool:event 事件 → 记录 + liveOrder', () => {
    const s = useToolStore(); s.upsertLocal(mkLocal('awaiting_permission'))
    expect(s.records['tc_1'].status).toBe('awaiting_permission')
    expect(s.liveOrder).toContain('tc_1'); expect(s.waitingForApproval).toBe(true)
  })
  it('实时区按活动会话过滤（真实联调收口：切换会话不显示他会话终态卡片）', () => {
    const s = useToolStore()
    s.upsertLocal({ ...mkLocal('completed', 'tc_a'), conversationId: 'conv-a' })
    s.upsertLocal({ ...mkLocal('completed', 'tc_b'), conversationId: 'conv-b' })
    // 活动会话未知 → 兼容显示（防 connection state 晚到闪没）
    expect(s.liveRecords().map(r => r.id)).toEqual(['tc_a', 'tc_b'])
    s.setActiveConversationId('conv-a')
    expect(s.liveRecords().map(r => r.id)).toEqual(['tc_a'])
    s.setActiveConversationId('conv-b')
    expect(s.liveRecords().map(r => r.id)).toEqual(['tc_b'])
    s.setActiveConversationId(undefined)
    expect(s.liveRecords().map(r => r.id)).toEqual(['tc_a', 'tc_b'])
  })
  it('waitingForApproval 只统计当前活动会话的 awaiting 记录', () => {
    const s = useToolStore()
    s.upsertLocal({ ...mkLocal('awaiting_permission', 'tc_a'), conversationId: 'conv-a' })
    s.upsertLocal({ ...mkLocal('awaiting_permission', 'tc_b'), conversationId: 'conv-b' })
    s.setActiveConversationId('conv-a')
    expect(s.waitingForApproval).toBe(true)
    s.upsertLocal({ ...mkLocal('completed', 'tc_a'), conversationId: 'conv-a' })
    expect(s.waitingForApproval).toBe(false)   // conv-b 的 awaiting 不计入当前会话
  })
  // 2026-09-16 审计 P1-2：toolWorkActive 是看门狗放宽窗口的驱动量，必须覆盖「正在执行」而不只是 awaiting
  // （后端等工具结果时那一代同样不发 generation.* 事件）。
  describe('toolWorkActive（P1-2：工具活动驱动静默窗口放宽）', () => {
    it('awaiting_permission 与 running 都算活动；终态不算', () => {
      const s = useToolStore()
      expect(s.toolWorkActive).toBe(false)
      s.upsertLocal(mkLocal('awaiting_permission', 'tc_a'))
      expect(s.toolWorkActive, '等授权期间那一代合法静默，必须放宽').toBe(true)
      s.upsertLocal(mkLocal('completed', 'tc_a'))
      expect(s.toolWorkActive).toBe(false)

      s.upsertLocal(mkLocal('running', 'tc_b'))
      expect(s.toolWorkActive, '正在执行同样不发 generation.* 事件').toBe(true)
      s.upsertLocal(mkLocal('failed', 'tc_b'))
      expect(s.toolWorkActive).toBe(false)
    })
    it('requested 也算活动（wire 六态里未终态即活动）', () => {
      const s = useToolStore()
      s.upsertLocal(mkLocal('requested', 'tc_req'))
      expect(s.toolWorkActive).toBe(true)
    })
    it('只统计当前活动会话：他会话的工具不得延长本会话的静默窗口', () => {
      const s = useToolStore()
      s.upsertLocal({ ...mkLocal('running', 'tc_a'), conversationId: 'conv-a' })
      s.upsertLocal({ ...mkLocal('running', 'tc_b'), conversationId: 'conv-b' })
      s.setActiveConversationId('conv-a')
      s.upsertLocal({ ...mkLocal('completed', 'tc_a'), conversationId: 'conv-a' })
      expect(s.toolWorkActive, 'conv-b 仍在执行，但当前会话已无工具活动').toBe(false)
    })
    it('timeout / cancelled / rejected 都是终态（不得把窗口永久放宽）', () => {
      const s = useToolStore()
      for (const st of ['timeout', 'cancelled', 'rejected'] as const) {
        s.upsertLocal(mkLocal(st, `tc_${st}`))
      }
      expect(s.toolWorkActive).toBe(false)
    })
  })
  it('backend 事件 → 只读记录（D6B-21：本地已存在不覆盖；判别键 event，代码 H5）', () => {
    const s = useToolStore(); s.upsertLocal(mkLocal('completed'))
    s.applyBackendEvent({ event: 'tool.completed', callId: 'tc_1', toolName: 'desktop.file.read', runtime: 'backend', success: false } as unknown as ToolBackendEvent)
    expect(s.records['tc_1'].status).toBe('completed')   // 本地终态不被 backend 覆盖
  })
  it('backend 事件 → 本地不存在时新建只读记录', () => {
    const s = useToolStore()
    s.applyBackendEvent({ event: 'tool.started', callId: 'tc_b1', toolName: 'search_web', runtime: 'backend', inputSummary: 'q=<str:2>' } as unknown as ToolBackendEvent)
    expect(s.records['tc_b1']).toMatchObject({ runtime: 'backend', status: 'running' })
  })
  it('UII-QQ 收尾：backend completed 失败按 errorType 分类——CANCELLED → cancelled（用户取消非红「执行失败」）', () => {
    const s = useToolStore()
    s.applyBackendEvent({ event: 'tool.completed', callId: 'tc_c1', toolName: 'search_web', runtime: 'backend', success: false, errorType: 'CANCELLED', error: { code: 'CANCELLED', message: '用户取消' } } as unknown as ToolBackendEvent)
    expect(s.records['tc_c1']).toMatchObject({ status: 'cancelled', errorType: 'CANCELLED' })
  })
  it('UII-QQ 收尾：backend completed 失败按 errorType 分类——TIMEOUT → timeout；未命中码仍 failed', () => {
    const s = useToolStore()
    s.applyBackendEvent({ event: 'tool.completed', callId: 'tc_t1', toolName: 'search_web', runtime: 'backend', success: false, errorType: 'TIMEOUT', error: { code: 'TIMEOUT', message: '执行超时' } } as unknown as ToolBackendEvent)
    expect(s.records['tc_t1']?.status).toBe('timeout')
    s.applyBackendEvent({ event: 'tool.completed', callId: 'tc_f1', toolName: 'search_web', runtime: 'backend', success: false, errorType: 'EXEC_ERROR', error: { code: 'EXEC_ERROR', message: 'boom' } } as unknown as ToolBackendEvent)
    expect(s.records['tc_f1']?.status).toBe('failed')
  })
  it('真实乱序：backend desktop started 先到时，本地 awaiting_permission 仍覆盖并打开权限窗', () => {
    const s = useToolStore()
    s.applyBackendEvent({ event: 'tool.started', callId: 'tc_d1', toolName: 'desktop.file.read', runtime: 'desktop', inputSummary: 'path=<redacted>' } as unknown as ToolBackendEvent)
    expect(s.records['tc_d1']).toMatchObject({ runtime: 'desktop', status: 'running' })
    expect(s.records['tc_d1'].desktopCallId).toBeUndefined()

    s.upsertLocal({ ...mkLocal('awaiting_permission', 'tc_d1'), desktopCallId: 'call_d1', pathSummary: 'stage6-read-deny.txt', dataFlowNote: '文件内容将发送到后端' })

    expect(s.records['tc_d1']).toMatchObject({ runtime: 'desktop', status: 'awaiting_permission', desktopCallId: 'call_d1' })
    expect(s.waitingForApproval).toBe(true)
    expect(s.pendingPathSummary?.pathSummary).toBe('stage6-read-deny.txt')
    expect(s.pendingDataFlowNote?.dataFlowNote).toContain('发送到后端')
  })
  it('本地 running 后的迟到 awaiting_permission 仍被单向状态机拒绝', () => {
    const s = useToolStore()
    s.upsertLocal({ ...mkLocal('running'), desktopCallId: 'call_1' })
    s.upsertLocal({ ...mkLocal('awaiting_permission'), desktopCallId: 'call_1', pathSummary: '/late.md', dataFlowNote: 'late' })
    expect(s.records['tc_1'].status).toBe('running')
    expect(s.waitingForApproval).toBe(false)
    expect(s.pendingPathSummary).toBeNull()
    expect(s.pendingDataFlowNote).toBeNull()
  })
  it('D6B-21 修正：backend 自身 started→completed 正常推进（仅 desktop 记录挡覆盖——Task 8 集成发现）', () => {
    const s = useToolStore()
    s.applyBackendEvent({ event: 'tool.started', callId: 'tc_b1', toolName: 'search_web', runtime: 'backend', inputSummary: 'q=<str:2>' } as unknown as ToolBackendEvent)
    s.applyBackendEvent({ event: 'tool.completed', callId: 'tc_b1', toolName: 'search_web', runtime: 'backend', success: true, outputSummary: 'ok' } as unknown as ToolBackendEvent)
    expect(s.records['tc_b1']).toMatchObject({ runtime: 'backend', status: 'completed', outputSummary: 'ok' })
    // desktop 记录存在 → backend completed 不覆盖（原 D6B-21 语义保持）
    const s2 = useToolStore()
    s2.upsertLocal(mkLocal('completed', 'tc_d1'))
    s2.applyBackendEvent({ event: 'tool.completed', callId: 'tc_d1', toolName: 'desktop.file.read', runtime: 'backend', success: false } as unknown as ToolBackendEvent)
    expect(s2.records['tc_d1'].status).toBe('completed')
  })
  it('终态单向：completed 后 running 事件忽略', () => {
    const s = useToolStore(); s.upsertLocal(mkLocal('completed')); s.upsertLocal(mkLocal('running'))
    expect(s.records['tc_1'].status).toBe('completed')
  })
  it('generation 清空只清终态（A9）：awaiting_permission 保留', () => {
    const s = useToolStore(); s.upsertLocal(mkLocal('awaiting_permission', 'tc_a')); s.upsertLocal(mkLocal('completed', 'tc_d'))
    s.clearForGeneration()
    expect(s.liveOrder).toContain('tc_a'); expect(s.liveOrder).not.toContain('tc_d')
  })
  it('pendingPathSummary 侧信道（M4）：awaiting 写入、终态清空', () => {
    const s = useToolStore()
    s.upsertLocal({ ...mkLocal('awaiting_permission'), pathSummary: '/home/u/notes.md' })
    expect(s.pendingPathSummary?.pathSummary).toBe('/home/u/notes.md')
    s.upsertLocal(mkLocal('completed'))
    expect(s.pendingPathSummary).toBeNull()
  })
  it('decide/cancel 调 api（setDesktopApi 注入，代码 H6）', async () => {
    // I-06：mock 用 `NonNullable<DesktopApiLike[...]>` 钉住**真实签名**——裸 `vi.fn()` 的 0 参类型
    // 会让下面 toHaveBeenCalledWith 的实参检查静默失效（形参列表为空 ⇒ 期望值不受检）。
    const decide = vi.fn<NonNullable<DesktopApiLike['toolDecide']>>(async () => {})
    const cancel = vi.fn<NonNullable<DesktopApiLike['toolCancel']>>(async () => {})
    setDesktopApi(createDesktopApiMock({ toolDecide: decide, toolCancel: cancel }))
    const s = useToolStore()
    await s.decide('call_1', 'deny'); await s.cancel('call_1')
    expect(decide).toHaveBeenCalledWith({ callId: 'call_1', decision: 'deny' }); expect(cancel).toHaveBeenCalledWith('call_1')
  })
  it('pendingDiff/pendingDataFlowNote 侧信道（A-3）：await 期间权限窗可取，终态清', () => {
    const s = useToolStore()
    s.upsertLocal({ ...mkLocal('awaiting_permission'), diff: { lines: [{ kind: 'added', text: 'x' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'UTF-8', isNewFile: false }, dataFlowNote: '写入内容将发送到后端' })
    expect(s.pendingDiff?.diff?.added).toBe(1)
    expect(s.pendingDataFlowNote?.dataFlowNote).toContain('发送到后端')
    s.upsertLocal(mkLocal('completed'))
    expect(s.pendingDiff).toBeNull(); expect(s.pendingDataFlowNote).toBeNull()
  })
  it('M2（fix round 1）：终态侧信道清理按 callId——A awaiting 时 B 终态不清 A；captureState 仅同工具终态清', () => {
    const s = useToolStore()
    // A awaiting（写侧信道）
    s.upsertLocal({ ...mkLocal('awaiting_permission', 'tc_a'), pathSummary: '/a.md', diff: { lines: [{ kind: 'added', text: 'x' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'UTF-8', isNewFile: false }, dataFlowNote: 'A 的数据' })
    // B 终态（不同 callId + 非 capture）→ A 侧信道保留
    s.upsertLocal(mkLocal('completed', 'tc_b'))
    expect(s.pendingPathSummary?.pathSummary).toBe('/a.md')
    expect(s.pendingDiff).not.toBeNull()
    expect(s.pendingDataFlowNote?.dataFlowNote).toBe('A 的数据')
    // A 自身终态 → 侧信道清
    s.upsertLocal(mkLocal('completed', 'tc_a'))
    expect(s.pendingPathSummary).toBeNull(); expect(s.pendingDiff).toBeNull(); expect(s.pendingDataFlowNote).toBeNull()
    // capture：capture running 写 captureState；非 capture 终态不清；同工具终态才清
    s.upsertLocal({ ...mkLocal('running', 'tc_c'), toolName: 'desktop.screen.capture', captureSources: [{ sourceId: 's1', sourceName: '窗口1', thumbnailDataUrl: 'data:image/png;base64,xx' }] })
    expect(s.captureState?.callId).toBe('tc_c')
    s.upsertLocal(mkLocal('completed', 'tc_d'))
    expect(s.captureState).not.toBeNull() // 非 capture 终态不清 captureState
    s.upsertLocal({ ...mkLocal('completed', 'tc_c'), toolName: 'desktop.screen.capture' })
    expect(s.captureState).toBeNull()
  })
  it('权限窗收尾只清审批侧信道，不清正在等待选源的 captureState', () => {
    const s = useToolStore()
    s.upsertLocal({ ...mkLocal('awaiting_permission', 'tc_cap'), toolName: 'desktop.screen.capture', desktopCallId: 'call_cap', dataFlowNote: '截图将发送到后端' })
    s.upsertLocal({ ...mkLocal('running', 'tc_cap'), toolName: 'desktop.screen.capture', desktopCallId: 'call_cap', captureSources: [{ sourceId: 's1', sourceName: '屏幕 1', thumbnailDataUrl: 'data:image/png;base64,xx' }] })

    s.clearApprovalLocal()

    expect(s.pendingDataFlowNote).toBeNull()
    expect(s.captureState).toMatchObject({ callId: 'call_cap', sources: [{ sourceId: 's1' }] })
    s.upsertLocal({ ...mkLocal('cancelled', 'tc_cap'), toolName: 'desktop.screen.capture', desktopCallId: 'call_cap' })
    expect(s.captureState).toBeNull()
  })
  it('L1（fix round 1）：liveOrder 截断只逐出最旧终态——awaiting 保留', () => {
    const s = useToolStore()
    s.upsertLocal(mkLocal('completed', 't1')); s.upsertLocal(mkLocal('completed', 't2')); s.upsertLocal(mkLocal('completed', 't3'))
    s.upsertLocal(mkLocal('awaiting_permission', 'wa'))
    expect(s.liveOrder).toContain('wa')
    expect(s.liveOrder).not.toContain('t1') // 只逐出最旧终态
    expect(s.waitingForApproval).toBe(true)
    expect(s.liveOrder.length).toBe(3)
  })
  it('L1b（fix round 1）：裁剪额度不足（非终态多）时 liveOrder 允许短暂 >3', () => {
    const s = useToolStore()
    s.upsertLocal(mkLocal('completed', 't1'))
    s.upsertLocal(mkLocal('awaiting_permission', 'wa1'))
    s.upsertLocal(mkLocal('awaiting_permission', 'wa2'))
    s.upsertLocal(mkLocal('running', 'r1'))
    s.upsertLocal(mkLocal('running', 'r2'))
    expect(s.liveOrder).toEqual(['wa1', 'wa2', 'r1', 'r2'])
    expect(s.waitingForApproval).toBe(true)
  })
  it('L2（fix round 1）：迟到 awaiting 事件（记录已终态）不写侧信道', () => {
    const s = useToolStore()
    s.upsertLocal(mkLocal('completed')) // tc_1 已终态
    s.upsertLocal({ ...mkLocal('awaiting_permission'), pathSummary: '/late.md', dataFlowNote: 'late' })
    expect(s.records['tc_1'].status).toBe('completed')
    expect(s.pendingPathSummary).toBeNull()
    expect(s.pendingDataFlowNote).toBeNull()
  })
})

describe('toolStore 批次 C（Task 7：L-2 水合 / F-23 四方法 / F-7 diff 同步）', () => {
  it('L-2 水合：init 先 await toolList 再订阅事件（F-15 定序——MED-2 修复：可控 promise 钉「水合完成前不订阅」）', async () => {
    const listEv: PublicToolEvent = { id: 'tc_1', desktopCallId: 'call_1', toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop', status: 'awaiting_permission', occurredAt: 'x' }
    let resolveList!: (v: PublicToolEvent[]) => void
    const listPromise = new Promise<PublicToolEvent[]>((r) => { resolveList = r })
    const onEvent = vi.fn<NonNullable<DesktopApiLike['onToolEvent']>>(() => () => {})
    setDesktopApi(createDesktopApiMock({ toolList: vi.fn(() => listPromise), onToolEvent: onEvent }))
    const store = useToolStore()
    const p = store.init()
    await Promise.resolve()   // 让 init 推进到 toolList await（挂起）
    expect(onEvent).not.toHaveBeenCalled()   // F-15：水合完成前不得订阅（错误实现「先订阅后水合」此处红）
    resolveList([listEv])
    await p
    expect(onEvent).toHaveBeenCalledTimes(1)   // 水合完成后订阅
    expect(store.records['tc_1']).toMatchObject({ status: 'awaiting_permission' })   // 快照归位
  })
  it('批次 C：grantDirectory/listGrants/revokeGrant/listHistory 调 api（F-23 命名映射）', async () => {
    const grantDirectory = vi.fn<NonNullable<DesktopApiLike['toolGrantDirectory']>>(async () => ({ executed: true }))
    const listGrants = vi.fn<NonNullable<DesktopApiLike['toolListGrants']>>(async () => [])
    const revokeGrant = vi.fn<NonNullable<DesktopApiLike['toolRevokeGrant']>>(async () => {})
    const listHistory = vi.fn<NonNullable<DesktopApiLike['toolListHistory']>>(async () => [])
    setDesktopApi(createDesktopApiMock({ toolGrantDirectory: grantDirectory, toolListGrants: listGrants, toolRevokeGrant: revokeGrant, toolListHistory: listHistory }))
    const store = useToolStore()
    await store.grantDirectory('call_1', 86_400_000)
    expect(grantDirectory).toHaveBeenCalledWith({ callId: 'call_1', ttlMs: 86_400_000 })
    expect(await store.grantDirectory('call_1', 86_400_000)).toBe(true)   // FINAL-LOW：executed 透传
    await store.listGrants()
    expect(listGrants).toHaveBeenCalled()
    await store.revokeGrant('g1')
    expect(revokeGrant).toHaveBeenCalledWith('g1')
    await store.listHistory(50)
    expect(listHistory).toHaveBeenCalledWith(50)
  })
  it('F-7：upsertLocal 同步写 record.diff（终态不清——grant 命中只读 Diff 数据源）', async () => {
    const ev = { id: 'tc_1', desktopCallId: 'call_1', toolName: 'desktop.file.write', title: '写入', runtime: 'desktop' as const, status: 'completed' as const, diff: { lines: [{ kind: 'added' as const, text: 'x\n' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'f', isNewFile: false }, occurredAt: 'x' }
    // I-06：原为 `as unknown as DesktopApiLike` 的部分 mock——工厂补齐其余键并保留签名校验
    setDesktopApi(createDesktopApiMock({ toolList: vi.fn(async () => []), onToolEvent: vi.fn(() => () => {}) }))
    const store = useToolStore()
    await store.init()
    store.upsertLocal(ev)
    expect(store.records['tc_1']?.diff).toEqual(ev.diff)   // 终态记录保留 diff（只读 Diff 卡数据源）
  })
})
