// src/renderer/src/stores/attachment.store.ts
// 阶段 3 G3（spec §4.3/§4.4）：附件 store——纯状态机（attachment-state）+ IPC 编排。
// 队列内存态（重启不恢复，docs/06 §7）；File 引用/粘贴 bytes 不落 store 序列化面（仅引用与元数据）。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AttachmentKind, AttachmentSource, MessageAttachment, PendingAttachment, PendingSticker } from '@shared/contracts'
import { api } from './desktop-api'
import { attachmentQueueReducer, canSendQueue, clientPrecheck, emptyQueue, type PendingQueueState } from '../attachments/attachment-state'

export interface AddFileInput { name: string; size: number; mediaType: string; source: 'picker' | 'drag_drop' | 'paste'; file?: File; bytes?: ArrayBuffer }

export const useAttachmentStore = defineStore('attachment', () => {
  const state = ref<PendingQueueState>(emptyQueue())
  const kindByLocalId = ref<Record<string, AttachmentKind>>({})
  /** File/bytes 引用（D5：Renderer 只持有浏览器 File 引用；path 由 Preload 经 webUtils 注入，不落 store 序列化面） */
  const fileByLocalId = ref<Record<string, { file?: File; bytes?: ArrayBuffer }>>({})
  const uploading = ref(false)
  const uploadId = ref<string>()

  const pendingById = computed(() => state.value.pendingById)
  const order = computed(() => state.value.order)
  const items = computed(() => order.value.map((id) => pendingById.value[id]).filter(Boolean))
  const hasFailed = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'failed'))
  const hasValidating = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'validating'))
  const hasReady = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'ready'))
  const canSend = computed(() => canSendQueue(state.value))

  function commit(action: Parameters<typeof attachmentQueueReducer>[1]): void {
    state.value = attachmentQueueReducer(state.value, action)
  }

  // P2-1：source 用字面联合 AttachmentSource（desktop-api.types.ts DesktopAttachmentInputFile.source 为 'picker'|'drag_drop'|'paste'，
  // 宽化为 string 会 typecheck 报错）；PendingAttachment.source 本身即该联合
  function descriptor(f: PendingAttachment): { localId: string; name: string; size: number; mediaType: string; source: AttachmentSource; kind?: AttachmentKind; file?: File; bytes?: ArrayBuffer } {
    const refData = fileByLocalId.value[f.localId]
    const kind = kindByLocalId.value[f.localId]
    return { localId: f.localId, name: f.name, size: f.size, mediaType: f.mediaType, source: f.source, ...(kind ? { kind } : {}), ...(refData?.file ? { file: refData.file } : {}), ...(refData?.bytes ? { bytes: refData.bytes } : {}) }
  }

  /** 添加（pick/drop/paste 仅 source 不同）；客户端预检 → selected → 异步 validateAll。
   *  P1-1：逐项预检——聚合级失败整批 failed；单文件超限只 fail 该文件，其余继续 selected→validateAll（spec §4.3/§4.4 逐项） */
  function addFiles(files: AddFileInput[]): string[] {
    const pre = clientPrecheck(files)
    const ids: string[] = []
    files.forEach((f, index) => {
      const localId = `loc-${crypto.randomUUID()}`
      ids.push(localId)
      fileByLocalId.value[localId] = f.file || f.bytes ? { file: f.file, bytes: f.bytes } : {}
      // 逐项预检按位置匹配（perFile 与 files 同序），避免同名文件误判
      const pf = pre.perFile[index]
      const ok = pre.reasons.length === 0 ? (pf?.ok ?? true) : false
      const message = ok ? undefined : (pf && !pf.ok ? pf.message : (pre.reasons.length > 0 ? pre.reasons.join('；') : '附件校验失败'))
      commit({ type: 'add', item: { kind: 'attachment', localId, name: f.name, size: f.size, mediaType: f.mediaType, source: f.source, status: ok ? 'selected' : 'failed', ...(ok ? {} : { reason: 'precheck', message }) } })
      if (!ok) return
      commit({ type: 'validate', localId })
    })
    void validateAll()
    return ids
  }

  /** G4 贴图分支：入队即 ready（spec §2 G4 边界） */
  function addSticker(sticker: PendingSticker): void {
    commit({ type: 'add', item: sticker })
  }

  /** selected/validating → Main 校验 → ready/failed（逐项） */
  async function validateAll(): Promise<void> {
    const files = order.value
      .map((id) => pendingById.value[id])
      .filter((i): i is PendingAttachment => i?.kind === 'attachment' && (i.status === 'selected' || i.status === 'validating'))
    if (files.length === 0) return
    let results
    try {
      results = await api.attachmentsValidate({ files: files.map((f) => descriptor(f)) })
    } catch {
      for (const f of files) commit({ type: 'validate-fail', localId: f.localId, reason: 'validate_error', message: '附件校验失败' })
      return
    }
    for (const r of results) {
      if (r.ok && r.kind) {
        commit({ type: 'validate-ok', localId: r.localId })
        kindByLocalId.value[r.localId] = r.kind
      } else {
        commit({ type: 'validate-fail', localId: r.localId, reason: r.reason ?? 'invalid', message: r.message })
      }
    }
  }

  /** 发送编排（spec §4.4）：ready 队列 → 批量上传 → messageStore.send → 成功清出。
   *  P2-3：send 失败（返回 false）不清队列——条目回 ready 保留（可重试/移除），不得无条件 clearOnSent 丢弃失败 */
  async function send(text: string, messageStore: { send(text: string, opts?: { attachments?: MessageAttachment[] }): Promise<boolean> }): Promise<void> {
    const ready = order.value
      .map((id) => pendingById.value[id])
      .filter((i): i is PendingAttachment => i?.kind === 'attachment' && i.status === 'ready')
    if (ready.length === 0) { await messageStore.send(text); return }
    const blocked = canSendQueue(state.value)
    if (!blocked.canSend) return
    const uid = crypto.randomUUID()
    uploadId.value = uid
    uploading.value = true
    commit({ type: 'upload', localIds: ready.map((f) => f.localId) })
    try {
      const resp = await api.attachmentsUpload({ uploadId: uid, files: ready.map((f) => descriptor(f)) })
      const ok = await messageStore.send(text, { attachments: resp.attachments })
      if (ok) clearOnSent()
      else commit({ type: 'upload-revert', localIds: ready.map((f) => f.localId) })
    } catch (e) {
      const cancelled = !uploading.value   // cancelUpload 已置 uploading=false → 走取消分支（TS 避免 boolean 字面量窄化比较）
      if (cancelled) commit({ type: 'cancel' })
      else for (const f of ready) commit({ type: 'upload-fail', localId: f.localId, reason: 'upload_failed', message: e instanceof Error ? e.message : '上传失败' })
    } finally {
      uploading.value = false
      uploadId.value = undefined
    }
  }

  async function cancelUpload(): Promise<void> {
    if (!uploading.value || !uploadId.value) return
    uploading.value = false
    try { await api.attachmentsCancel(uploadId.value) } catch { /* 取消尽力 */ }
  }

  function remove(localId: string): void {
    if (uploading.value) return   // 上传中禁止移除（spec §4.3）
    commit({ type: 'remove', localId })
  }

  function clearOnSent(): void {
    state.value = attachmentQueueReducer(state.value, { type: 'clear' })
    kindByLocalId.value = {}
    fileByLocalId.value = {}
  }

  function clear(): void {
    state.value = emptyQueue()
    kindByLocalId.value = {}
    fileByLocalId.value = {}
    uploading.value = false
    uploadId.value = undefined
  }

  return { pendingById, order, items, kindByLocalId, fileByLocalId, uploading, uploadId, hasFailed, hasValidating, hasReady, canSend, addFiles, addSticker, validateAll, send, cancelUpload, remove, clearOnSent, clear }
})
