// tests/unit/attachment-state.spec.ts
// Task 13:附件状态机（spec §4.3，D4）——全转移 + source 不变性 + 发送阻断 + 省略 uploaded 态。纯函数无 Vue。
import { describe, expect, it } from 'vitest'
import type { PendingAttachment, PendingAttachmentStatus, PendingSendItem } from '@shared/contracts'
import { attachmentQueueReducer, canSendQueue, clientPrecheck, emptyQueue, type AttachmentQueueAction, type PendingQueueState } from '../../src/renderer/src/attachments/attachment-state'

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
  it('P2-4：uploading → cancel → 条目移除（spec §4.8 置 cancelled 移除，不再滞留 cancelled）', () => {
    let s = withItem(emptyQueue(), item('l1', { status: 'uploading' }))
    s = withItem(s, item('l2', { status: 'ready' }))
    s = attachmentQueueReducer(s, { type: 'cancel' })
    expect(s.pendingById['l1']).toBeUndefined()   // uploading 条目被移除
    expect(s.pendingById['l2']).toBeDefined()     // 非 uploading 条目保留
    expect(s.order).toEqual(['l2'])
  })
  it('P2-3：uploading → upload-revert → ready（send 失败保留可重试）', () => {
    let s = withItem(emptyQueue(), item('l1', { status: 'uploading' }))
    s = attachmentQueueReducer(s, { type: 'upload-revert', localIds: ['l1'] })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('ready')
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
  // 2026-09-10 陈旧性审查重写：原实现是
  //   `const statuses: ReadonlyArray<string> = ['selected',…,'cancelled']; expect(statuses).not.toContain('uploaded')`
  // ——对自己的字面量取反，且注解放宽成 string[] 后连 typecheck 都不再约束它，源码怎么改都不会失败。
  // 改成断言真正在跑的状态机：reducer 产出的状态必须全部落在 PendingAttachmentStatus 内（含'uploaded' 即失败）。
  it('状态枚举省略 uploaded 瞬态（D4，对齐 docs/06 §7）', () => {
    const declared: Record<PendingAttachmentStatus, true> = {
      selected: true, validating: true, ready: true, uploading: true, failed: true, cancelled: true
    }
    expect(Object.keys(declared)).not.toContain('uploaded')

    // 走一遍全部转移（顺序累积），确认 reducer 只会产出声明过的状态（新增隐式瞬态态会在此暴露）
    const seen = new Set<PendingAttachmentStatus>()
    let s = withItem(emptyQueue(), item('l1'))
    seen.add((s.pendingById['l1'] as PendingAttachment).status)
    const transitions: AttachmentQueueAction[] = [
      { type: 'validate', localId: 'l1' },
      { type: 'validate-ok', localId: 'l1' },
      { type: 'upload', localIds: ['l1'] }
    ]
    for (const action of transitions) {
      s = attachmentQueueReducer(s, action)
      const status = (s.pendingById['l1'] as PendingAttachment | undefined)?.status
      if (status) seen.add(status)
    }
    const failed = attachmentQueueReducer(
      attachmentQueueReducer(withItem(emptyQueue(), item('l1')), { type: 'validate', localId: 'l1' }),
      { type: 'validate-fail', localId: 'l1', reason: 'too_large', message: '超过大小上限' }
    )
    seen.add((failed.pendingById['l1'] as PendingAttachment).status)
    expect([...seen].sort()).toEqual(['failed', 'ready', 'selected', 'uploading', 'validating'].sort())
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
  it('P1-1：逐项预检——单文件超限只该文件 perFile.ok=false，其余 perFile.ok=true（聚合级 failures 走 reasons）', () => {
    const r = clientPrecheck([
      { name: 'big.png', size: 11 * 1024 * 1024, mediaType: 'image/png' },
      { name: 'ok.png', size: 10, mediaType: 'image/png' }
    ])
    expect(r.ok).toBe(false)
    expect(r.reasons).toHaveLength(0)                          // 无聚合级失败
    expect(r.perFile.find((p) => p.name === 'big.png')?.ok).toBe(false)
    expect(r.perFile.find((p) => p.name === 'big.png')?.message).toContain('超过')
    expect(r.perFile.find((p) => p.name === 'ok.png')?.ok).toBe(true)
  })
})
