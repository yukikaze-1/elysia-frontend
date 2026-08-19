// @vitest-environment happy-dom
// 阶段 6 批次 B（Task 7）：toolStore——三来路归一化（tool:event 实时 / backend 事件只读）/ 终态单向 /
// D6B-21 合并 / pendingPathSummary+pendingDiff+pendingDataFlowNote 侧信道 / clearForGeneration 只清终态。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useToolStore } from '../../src/renderer/src/stores/tool.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
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
    const decide = vi.fn(); const cancel = vi.fn()
    setDesktopApi({ toolDecide: decide, toolCancel: cancel } as unknown as DesktopApiLike)
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
