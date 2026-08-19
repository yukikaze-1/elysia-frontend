import { describe, expect, it } from 'vitest'
import type { ToolCallRecord, ToolCallStatus, ToolWireStatus } from '@shared/contracts'

describe('阶段 6 批次 A 领域模型（Task 1）', () => {
  it('ToolCallRecord 权威键 = id（sourceCallId），8 态展示状态闭合', () => {
    const record: ToolCallRecord = { id: 'tc_1', toolName: 'get_time', runtime: 'backend', status: 'completed' }
    expect(record.id).toBe('tc_1')
    const statuses: ToolCallStatus[] = ['requested', 'awaiting_permission', 'running', 'completed', 'failed', 'rejected', 'cancelled', 'timeout']
    expect(statuses).toHaveLength(8)
  })
  it('ToolWireStatus 六态协议态闭合（展示/协议态分离，D6A-05）', () => {
    const statuses: ToolWireStatus[] = ['accepted', 'rejected', 'running', 'result', 'error', 'cancelled']
    expect(statuses).toHaveLength(6)
  })
})
