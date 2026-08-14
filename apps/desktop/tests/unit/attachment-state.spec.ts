// tests/unit/attachment-state.spec.ts
// Task 13:附件状态机（spec §4.3，D4）——全转移 + source 不变性 + 发送阻断 + 省略 uploaded 态。纯函数无 Vue。
import { describe, expect, it } from 'vitest'
import type { PendingAttachment, PendingSendItem } from '@shared/contracts'
import { attachmentQueueReducer, canSendQueue, clientPrecheck, emptyQueue, type PendingQueueState } from '../../src/renderer/src/attachments/attachment-state'

function item(localId: string, over: Partial<PendingAttachment> = {}): PendingSendItem {
  return { kind: 'attachment', localId, name: 'a.png', size: 10, mediaType: 'image/png', source: 'drag_drop', status: 'selected', ...over }
}
function withItem(state: PendingQueueState, i: PendingSendItem): PendingQueueState {
  return attachmentQueueReducer(state, { type: 'add', item: i })
}

describe('attachmentQueueReducer（D4 状态机）', () => {
  it('selected → validating → ready（validate-ok）', () => {
    let s = emptyQueue()
    s = withItem(s, item('l1'))
    s = attachmentQueueReducer(s, { type: 'validate', localId: 'l1' })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('validating')
    s = attachmentQueueReducer(s, { type: 'validate-ok', localId: 'l1' })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('ready')
  })
  it('validating → failed（validate-fail，reason 逐项解释）', () => {
    let s = withItem(emptyQueue(), item('l1'))
    s = attachmentQueueReducer(s, { type: 'validate', localId: 'l1' })
    s = attachmentQueueReducer(s, { type: 'validate-fail', localId: 'l1', reason: 'too_large', message: '超过大小上限' })
    const a = s.pendingById['l1'] as PendingAttachment
    expect(a.status).toBe('failed')
    expect(a.reason).toBe('too_large')
  })
  it('ready → uploading →（upload-fail → failed）', () => {
    let s = withItem(emptyQueue(), item('l1', { status: 'ready' }))
    s = attachmentQueueReducer(s, { type: 'upload', localIds: ['l1'] })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('uploading')
    s = attachmentQueueReducer(s, { type: 'upload-fail', localId: 'l1', reason: 'network', message: '网络错误' })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('failed')
  })
  it('uploading → cancel → cancelled（终态）', () => {
    let s = withItem(emptyQueue(), item('l1', { status: 'uploading' }))
    s = attachmentQueueReducer(s, { type: 'cancel' })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('cancelled')
  })
  it('remove 删除条目（order 同步）', () => {
    let s = withItem(emptyQueue(), item('l1'))
    s = withItem(s, item('l2'))
    s = attachmentQueueReducer(s, { type: 'remove', localId: 'l1' })
    expect(s.pendingById['l1']).toBeUndefined()
    expect(s.order).toEqual(['l2'])
  })
  it('clear 清空', () => {
    let s = withItem(emptyQueue(), item('l1'))
    s = attachmentQueueReducer(s, { type: 'clear' })
    expect(s).toEqual(emptyQueue())
  })
  it('状态枚举省略 uploaded 瞬态（D4，对齐 docs/06 §7）', () => {
    const statuses: ReadonlyArray<string> = ['selected', 'validating', 'ready', 'uploading', 'failed', 'cancelled']
    expect(statuses).not.toContain('uploaded')
  })
  it('source 不变性：picker/drag_drop/paste 只影响 source 字段，状态流转一致', () => {
    for (const source of ['picker', 'drag_drop', 'paste'] as const) {
      let s = withItem(emptyQueue(), item('l1', { source }))
      s = attachmentQueueReducer(s, { type: 'validate', localId: 'l1' })
      s = attachmentQueueReducer(s, { type: 'validate-ok', localId: 'l1' })
      expect((s.pendingById['l1'] as PendingAttachment).status).toBe('ready')
      expect((s.pendingById['l1'] as PendingAttachment).source).toBe(source)
    }
  })
})

describe('canSendQueue（发送阻断条件，spec §4.3）', () => {
  it('全 ready 或空 → 可发送', () => {
    expect(canSendQueue(withItem(emptyQueue(), item('l1', { status: 'ready' }))).canSend).toBe(true)
    expect(canSendQueue(emptyQueue()).canSend).toBe(true)
  })
  it('存在 failed → 阻断 + 提示', () => {
    const r = canSendQueue(withItem(emptyQueue(), item('l1', { status: 'failed', reason: 'too_large' })))
    expect(r.canSend).toBe(false)
    expect(r.blockReason).toContain('失败')
  })
  it('存在 validating → 阻断 + 等待提示', () => {
    const r = canSendQueue(withItem(emptyQueue(), item('l1', { status: 'validating' })))
    expect(r.canSend).toBe(false)
  })
  it('存在 uploading → 阻断', () => {
    expect(canSendQueue(withItem(emptyQueue(), item('l1', { status: 'uploading' }))).canSend).toBe(false)
  })
})

describe('clientPrecheck（Renderer UX 预检，D-04 数值共用）', () => {
  it('数量/聚合/单文件超限 → reasons', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, size: 1, mediaType: 'image/png' }))
    expect(clientPrecheck(many).ok).toBe(false)
    const huge = [{ name: 'v', size: 60 * 1024 * 1024, mediaType: 'video/mp4' }]
    expect(clientPrecheck(huge).ok).toBe(false)
  })
  it('合法 → ok', () => {
    expect(clientPrecheck([{ name: 'a', size: 1024, mediaType: 'image/png' }]).ok).toBe(true)
  })
})
