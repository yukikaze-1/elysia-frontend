// src/renderer/src/attachments/attachment-state.ts
// 阶段 3 G3（spec §4.3，D4）：附件状态机纯函数——selected→validating→ready→uploading→(发送编排)/failed/cancelled，
// 省略 uploaded 瞬态（docs/06 §7 枚举一致）；拖拽/粘贴/点击仅 source 不同；uploading 禁止移除。
// 信任边界：Renderer 纯逻辑层不得 import Main——kindFromMime 从本进程 utils/media.ts 取（同 shared 常量实现）。
import type { PendingAttachment, PendingSendItem } from '@shared/contracts'
import { ATTACHMENT_AGGREGATE_BYTES, ATTACHMENT_MAX_BYTES_BY_KIND, ATTACHMENT_MAX_FILES } from '@shared/contracts/attachments'
import { kindFromMime } from '../utils/media'

export interface PendingQueueState {
  pendingById: Record<string, PendingSendItem>
  order: string[]
}

export const emptyQueue = (): PendingQueueState => ({ pendingById: {}, order: [] })

export type AttachmentQueueAction =
  | { type: 'add'; item: PendingSendItem }
  | { type: 'validate'; localId: string }
  | { type: 'validate-ok'; localId: string }
  | { type: 'validate-fail'; localId: string; reason: string; message?: string }
  | { type: 'upload'; localIds: string[] }
  | { type: 'upload-fail'; localId: string; reason: string; message?: string }
  | { type: 'upload-revert'; localIds: string[] }   // P2-3：send 失败后 uploading → ready（保留条目可重试/移除）
  | { type: 'cancel' }
  | { type: 'remove'; localId: string }
  | { type: 'clear' }

function patchAttachment(state: PendingQueueState, localId: string, updater: (a: PendingAttachment) => PendingAttachment): PendingQueueState {
  const cur = state.pendingById[localId]
  if (!cur || cur.kind !== 'attachment') return state
  const next = updater(cur)
  if (next === cur) return state
  return { pendingById: { ...state.pendingById, [localId]: next }, order: state.order }
}

export function attachmentQueueReducer(state: PendingQueueState, action: AttachmentQueueAction): PendingQueueState {
  switch (action.type) {
    case 'add': {
      const id = action.item.kind === 'attachment' ? action.item.localId : action.item.stickerId   // G4 PendingSticker 用 stickerId
      if (state.pendingById[id]) return state
      return { pendingById: { ...state.pendingById, [id]: action.item }, order: [...state.order, id] }
    }
    case 'validate':
      return patchAttachment(state, action.localId, (a) => (a.status === 'selected' ? { ...a, status: 'validating' } : a))
    case 'validate-ok':
      return patchAttachment(state, action.localId, (a) => (a.status === 'validating' ? { ...a, status: 'ready', reason: undefined } : a))
    case 'validate-fail':
      return patchAttachment(state, action.localId, (a) => (a.status === 'validating' ? { ...a, status: 'failed', reason: action.reason, ...(action.message ? { message: action.message as never } : {}) } : a))
    case 'upload': {
      let s = state
      for (const id of action.localIds) {
        s = patchAttachment(s, id, (a) => (a.status === 'ready' || a.status === 'selected' ? { ...a, status: 'uploading' } : a))
      }
      return s
    }
    case 'upload-fail':
      return patchAttachment(state, action.localId, (a) => (a.status === 'uploading' ? { ...a, status: 'failed', reason: action.reason } : a))
    case 'upload-revert': {
      let s = state
      for (const id of action.localIds) {
        s = patchAttachment(s, id, (a) => (a.status === 'uploading' ? { ...a, status: 'ready' } : a))
      }
      return s
    }
    case 'cancel': {
      // P2-4：spec §4.8「置 cancelled 移除」——取消后条目直接从队列移除，不再滞留 cancelled 需手动移除
      const pendingById = { ...state.pendingById }
      const order = state.order.filter((id) => {
        const a = pendingById[id]
        if (a?.kind === 'attachment' && a.status === 'uploading') { delete pendingById[id]; return false }
        return true
      })
      return { pendingById, order }
    }
    case 'remove': {
      if (!state.pendingById[action.localId]) return state
      const pendingById = { ...state.pendingById }
      delete pendingById[action.localId]
      return { pendingById, order: state.order.filter((id) => id !== action.localId) }
    }
    case 'clear':
      return emptyQueue()
  }
}

/** 发送条件：无 failed/validating/uploading；附件全 ready 或已移除（batch 原子，D3） */
export function canSendQueue(state: PendingQueueState): { canSend: boolean; blockReason?: string } {
  const atts = state.order.map((id) => state.pendingById[id]).filter((i): i is PendingAttachment => i?.kind === 'attachment')
  if (atts.some((a) => a.status === 'failed')) return { canSend: false, blockReason: '请移除失败附件后再发送' }
  if (atts.some((a) => a.status === 'validating')) return { canSend: false, blockReason: '附件校验中，请稍候' }
  if (atts.some((a) => a.status === 'uploading')) return { canSend: false, blockReason: '附件上传中' }
  return { canSend: true }
}

export interface ClientPrecheckItem {
  name: string
  ok: boolean
  message?: string
}

/** Renderer UX 预检（数量/聚合/单文件按 kind 限额；Main validateFiles 为权威）。
 *  P1-1：逐项结果——聚合级（数量/总大小）整批 ok:false；单文件超限仅该文件 ok:false，其余文件 ok:true 继续 selected→validateAll */
export function clientPrecheck(files: Array<{ name: string; size: number; mediaType: string }>): { ok: boolean; reasons: string[]; perFile: ClientPrecheckItem[] } {
  const reasons: string[] = []
  if (files.length > ATTACHMENT_MAX_FILES) reasons.push('一次最多选择 10 个文件')
  const aggregate = files.reduce((s, f) => s + f.size, 0)
  if (aggregate > ATTACHMENT_AGGREGATE_BYTES) reasons.push('附件总大小超过 64MB')
  const perFile = files.map((f) => {
    const kind = kindFromMime(f.mediaType)
    if (kind !== 'file' && f.size > ATTACHMENT_MAX_BYTES_BY_KIND[kind]) {
      return { name: f.name, ok: false, message: `「${f.name}」超过该类型大小上限` }
    }
    return { name: f.name, ok: true }
  })
  return { ok: reasons.length === 0 && perFile.every((p) => p.ok), reasons, perFile }
}
