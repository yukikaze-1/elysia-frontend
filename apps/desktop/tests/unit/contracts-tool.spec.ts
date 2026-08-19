import { describe, expect, it } from 'vitest'
import type { ToolCallRecord, ToolCallStatus, ToolWireStatus } from '@shared/contracts'
import type { PublicToolEvent } from '@shared/contracts/tool'

const MINIMAL_EVENT: PublicToolEvent = {
  id: 'tc_1', toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop',
  status: 'awaiting_permission', occurredAt: '2026-08-20T00:00:00.000Z',
}
const MINIMAL_RECORD: ToolCallRecord = {
  id: 'tc_1', toolName: 'desktop.file.read', runtime: 'desktop', status: 'completed',
}

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

describe('阶段 6 批次 B Task 1：PublicToolEvent / ToolCallRecord.attachmentCount', () => {
  it('PublicToolEvent 字段闭合：无 arguments/paramHash/expiresAt/安全元数据键', () => {
    const json = JSON.stringify(MINIMAL_EVENT)
    for (const banned of ['arguments', 'paramHash', 'expiresAt', 'riskLevel', 'permissionRequired', 'approvalAuthority']) {
      expect(json).not.toContain(banned)
    }
  })
  it('ToolCallRecord 支持可选 attachmentCount', () => {
    const rec: ToolCallRecord = { ...MINIMAL_RECORD, attachmentCount: 2 }
    expect(rec.attachmentCount).toBe(2)
  })
  it('PublicToolEvent.captureSources 形状闭合', () => {
    const ev: PublicToolEvent = { ...MINIMAL_EVENT, captureSources: [{ sourceId: 's1', sourceName: '屏幕 1', thumbnailDataUrl: 'data:image/png;base64,AA==' }] }
    expect(ev.captureSources?.[0].sourceId).toBe('s1')
  })
})
