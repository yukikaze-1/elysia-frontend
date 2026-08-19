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
})
