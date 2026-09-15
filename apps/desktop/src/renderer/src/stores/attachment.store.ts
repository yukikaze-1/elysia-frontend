// src/renderer/src/stores/attachment.store.ts
// 阶段 3 G3（spec §4.3/§4.4）：附件 store——纯状态机（attachment-state）+ IPC 编排。
// 队列内存态（重启不恢复，docs/06 §7）；File 引用/粘贴 bytes 不落 store 序列化面（仅引用与元数据）。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AttachmentKind, AttachmentSource, MessageAttachment, PendingAttachment, PendingSticker } from '@shared/contracts'
import { MAX_IPC_MESSAGE_BYTES } from '@shared/contracts'
import { api } from './desktop-api'
import { currentConversationIdRef } from './session'
import { attachmentQueueReducer, canSendQueue, clientPrecheck, emptyQueue, type PendingQueueState } from '../attachments/attachment-state'

export interface AddFileInput { name: string; size: number; mediaType: string; source: 'picker' | 'drag_drop' | 'paste'; file?: File; bytes?: ArrayBuffer }

/** 尚未选中任何会话时的队列归属（composer 此时不可发送，仅用于让状态有处可放） */
const NO_OWNER = '__none__'

export const useAttachmentStore = defineStore('attachment', () => {
  /**
   * R2（2026-09-15 评审）：队列改为**按会话归属**。
   *
   * 修复前 `state` 是单份全局队列：在会话 A 拖入文件、切到 B，条目仍在 B 的输入区上方显示，
   * 点发送就作为 **B 的附件**上传发出（私有文件静默改属到另一个会话/角色）。
   * 草稿本来就是 per-conversation（`draft.store` 以 conversationId 为键），消息更是，只有附件跨界。
   *
   * 队列按 `conversationId` 分桶；`state` 是**当前会话那一桶**的视图，写入一律经 `commitTo(owner, …)`
   * （显式指定归属，避免「用当前会话的 id 写别人桶里的条目」）。
   */
  const queues = ref<Record<string, PendingQueueState>>({})
  const ownerId = computed(() => currentConversationIdRef().value ?? NO_OWNER)
  const state = computed<PendingQueueState>(() => queues.value[ownerId.value] ?? emptyQueue())
  const kindByLocalId = ref<Record<string, AttachmentKind>>({})
  /** File/bytes 引用（D5：Renderer 只持有浏览器 File 引用；path 由 Preload 经 webUtils 注入，不落 store 序列化面） */
  const fileByLocalId = ref<Record<string, { file?: File; bytes?: ArrayBuffer }>>({})
  const uploading = ref(false)
  const uploadId = ref<string>()
  /**
   * R1/R3（2026-09-15）：需要让用户看见的一次性提示（会话已切换导致附件未发送 / 附件被拦导致文本未发送）。
   * 组件用 `role="alert"` 呈现后调 `clearNotice()` 消费；不做自动消失（信息比动画重要）。
   */
  const notice = ref<string>()

  const pendingById = computed(() => state.value.pendingById)
  const order = computed(() => state.value.order)
  const items = computed(() => order.value.map((id) => pendingById.value[id]).filter(Boolean))
  const hasFailed = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'failed'))
  const hasValidating = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'validating'))
  const hasReady = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'ready'))
  const canSend = computed(() => canSendQueue(state.value))

  /** 写入**指定归属**的队列（不写当前会话）——跨 await 的编排必须用它 */
  function commitTo(owner: string, action: Parameters<typeof attachmentQueueReducer>[1]): void {
    const cur = queues.value[owner] ?? emptyQueue()
    queues.value = { ...queues.value, [owner]: attachmentQueueReducer(cur, action) }
  }

  /** 写入当前会话的队列 */
  function commit(action: Parameters<typeof attachmentQueueReducer>[1]): void {
    commitTo(ownerId.value, action)
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
      // S4（2026-09-15）：粘贴型没有文件句柄，载荷走 IPC 的 `bytes` 分支，受**全局 IPC 不变量 4 MiB** 约束
      // （拖入/选择型走 fileRef，由 Main 自读盘，不受此限）。超限时在客户端就拦下并给出可行动的替代路径，
      // 而不是等 Main 的 schema 校验回一个通用错误。
      const tooBigForIpc = f.source === 'paste' && f.size > MAX_IPC_MESSAGE_BYTES
      const ok = !tooBigForIpc && (pre.reasons.length === 0 ? (pf?.ok ?? true) : false)
      const message = tooBigForIpc
        ? `「${f.name}」超过粘贴上限（4MB），请改用拖入或「+」选择文件`
        : (ok ? undefined : (pf && !pf.ok ? pf.message : (pre.reasons.length > 0 ? pre.reasons.join('；') : '附件校验失败')))
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

  /** selected/validating → Main 校验 → ready/failed（逐项）；结果回写到**发起时**的会话桶 */
  async function validateAll(): Promise<void> {
    const owner = ownerId.value
    const files = (queues.value[owner]?.order ?? [])
      .map((id) => queues.value[owner]?.pendingById[id])
      .filter((i): i is PendingAttachment => i?.kind === 'attachment' && (i.status === 'selected' || i.status === 'validating'))
    if (files.length === 0) return
    let results
    try {
      results = await api.attachmentsValidate({ files: files.map((f) => descriptor(f)) })
    } catch {
      for (const f of files) commitTo(owner, { type: 'validate-fail', localId: f.localId, reason: 'validate_error', message: '附件校验失败' })
      return
    }
    for (const r of results) {
      if (r.ok && r.kind) {
        commitTo(owner, { type: 'validate-ok', localId: r.localId })
        kindByLocalId.value[r.localId] = r.kind
      } else {
        commitTo(owner, { type: 'validate-fail', localId: r.localId, reason: r.reason ?? 'invalid', message: r.message })
      }
    }
  }

  /**
   * 发送编排（spec §4.4）：ready 队列 → 批量上传 → messageStore.send → 成功清出。
   * P2-3：send 失败（返回 false）不清队列——条目回 ready 保留（可重试/移除），不得无条件 clearOnSent 丢弃失败。
   *
   * 返回值（R3，2026-09-15 评审）：`'sent' | 'blocked' | 'failed' | 'noop'`。
   * 修复前返回 `void`，调用方**无法区分「被拦下」与「已发出」**——于是贴图豁免路径（有贴图时
   * `canSend` 跳过附件阻断）会在附件被拦、文本根本没发的情况下仍然 `draftStore.clear()`，
   * 用户输入被静默丢弃。现在「拦下」是一个显式结果，调用方据此保留草稿。
   */
  async function send(text: string, messageStore: { send(text: string, opts?: { attachments?: MessageAttachment[] }): Promise<boolean> }): Promise<'sent' | 'blocked' | 'failed' | 'noop'> {
    const owner = ownerId.value   // R1：快照归属，上传期间切会话不得改变这条消息的去向
    const bucket = queues.value[owner] ?? emptyQueue()
    // R3：**先过队列闸门**，再决定走不走附件编排。修复前闸门在 `ready.length === 0` 的早退之后，
    // 于是「队列里有失败附件、但本次没有 ready 附件」时会直接把文本发出去并报 'sent' ——
    // 界面同时还显示「请移除失败附件后再发送」，用户拿到的却是"已发送"。
    const gate = canSendQueue(bucket)
    if (!gate.canSend) {
      notice.value = gate.blockReason ?? '附件尚未就绪，未发送'
      return 'blocked'
    }
    const ready = bucket.order
      .map((id) => bucket.pendingById[id])
      .filter((i): i is PendingAttachment => i?.kind === 'attachment' && i.status === 'ready')
    if (ready.length === 0) return (await messageStore.send(text)) ? 'sent' : 'failed'
    const uid = crypto.randomUUID()
    uploadId.value = uid
    uploading.value = true
    commitTo(owner, { type: 'upload', localIds: ready.map((f) => f.localId) })
    try {
      const resp = await api.attachmentsUpload({ uploadId: uid, files: ready.map((f) => descriptor(f)) })
      if (ownerId.value !== owner) {
        // R1：上传期间用户切走了 ⇒ 附件回原会话的 ready，**绝不**把消息投到另一个会话
        commitTo(owner, { type: 'upload-revert', localIds: ready.map((f) => f.localId) })
        notice.value = '会话已切换，附件未发送（仍留在原会话的待发送区）'
        return 'blocked'
      }
      const ok = await messageStore.send(text, { attachments: resp.attachments })
      if (ok) clearOnSent(owner)
      else commitTo(owner, { type: 'upload-revert', localIds: ready.map((f) => f.localId) })
      return ok ? 'sent' : 'failed'
    } catch (e) {
      const cancelled = !uploading.value   // cancelUpload 已置 uploading=false → 走取消分支（TS 避免 boolean 字面量窄化比较）
      if (cancelled) commitTo(owner, { type: 'cancel' })
      else for (const f of ready) commitTo(owner, { type: 'upload-fail', localId: f.localId, reason: 'upload_failed', message: e instanceof Error ? e.message : '上传失败' })
      return 'failed'
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
    delete kindByLocalId.value[localId]   // 7D：单个移除即时释放强引用（上传中短路不清，由 clearOnSent/clear 兜底）
    delete fileByLocalId.value[localId]
  }

  function clearOnSent(owner: string = ownerId.value): void {
    // 只释放**该桶**条目的引用——队列已按会话分桶，全局清空会把别的会话待发送附件的
    // File/bytes 一起丢掉（那些条目还在，但已无可上传的数据）。
    for (const id of queues.value[owner]?.order ?? []) {
      delete kindByLocalId.value[id]
      delete fileByLocalId.value[id]
    }
    commitTo(owner, { type: 'clear' })
  }

  /** 清空**当前**会话的队列 */
  function clear(): void {
    clearFor(ownerId.value)
  }

  /** 清空**指定**会话的队列并释放其文件引用（会话删除时由 conversation.store 调用） */
  function clearFor(conversationId: string): void {
    const bucket = queues.value[conversationId]
    if (!bucket) return
    for (const id of bucket.order) {
      delete kindByLocalId.value[id]
      delete fileByLocalId.value[id]
    }
    const next = { ...queues.value }
    delete next[conversationId]
    queues.value = next
    uploading.value = false
    uploadId.value = undefined
  }

  function clearNotice(): void {
    notice.value = undefined
  }

  /** 供编排层写入一次性可见提示（例如粘贴文件读取失败） */
  function setNotice(text: string): void {
    notice.value = text
  }

  return { pendingById, order, items, kindByLocalId, fileByLocalId, uploading, uploadId, notice, hasFailed, hasValidating, hasReady, canSend, addFiles, addSticker, validateAll, send, cancelUpload, remove, clearOnSent, clear, clearFor, clearNotice, setNotice }
})
