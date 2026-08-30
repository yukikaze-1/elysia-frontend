// src/renderer/src/stores/tool.store.ts
// 阶段 6 批次 B（Task 7，spec A-9/A-3/M4/M11/L6，D6B-21）：toolStore——工具实时区单一事实源。
//
// 三来路归一化：
//   1. tool:event（Main pushEvent → preload onToolEvent）→ upsertLocal（desktop 实时权威，含侧信道）；
//   2. backend 事件（tool.started/tool.completed，经 bootstrap 旁路）→ applyBackendEvent 只读记录
//      （D6B-21：本地已存在不覆盖——后端不覆盖桌面工具的执行/审批现实）；
//   3. REST 历史/WS 回放（Task 5 pairToolCalls）→ Message.toolCalls 归档卡片（组件只读渲染，不经本 store）。
//
// 终态单向（spec D6A-05）：completed/failed/rejected/cancelled/timeout 后不再回执行态；
// running 不回退 awaiting_permission。liveOrder 截断只逐出最旧的终态记录（L1 fix：awaiting/running
// 不参与裁剪，可短暂 >LIVE_LIMIT——防 awaiting 被逐出导致 waitingForApproval 误变 false）。
// clearForGeneration（generation.started 接线）只清终态——awaiting_permission 跨代保留（A9）。
//
// 侧信道（A-3/M4/M11）：pendingPathSummary/pendingDiff/pendingDataFlowNote 供权限窗（四问/写 Diff）
// 与卡片取数据；awaiting_permission 写入（受终态单向守卫，L2 fix）、任何同 callId 终态清空
// （M2 fix：按 callId 匹配，B 终态不清 A 的侧信道；captureState 仅同工具终态清，L6）。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { HistoryEntry, PermissionGrant, PublicToolEvent, ToolCallRecord, ToolCallStatus } from '@shared/contracts/tool'
import type { BackendEvent } from '@shared/contracts/events'
import { isToolCancelType, isToolTimeoutType } from '@shared/domain/tool-status'
import { api } from './desktop-api'   // 既有 api 单例（代码 H6）

const LIVE_LIMIT = 3
const TERMINAL: ToolCallStatus[] = ['completed', 'failed', 'rejected', 'cancelled', 'timeout']
type ToolBackendEvent = Extract<BackendEvent, { event: 'tool.request' | 'tool.started' | 'tool.completed' }>   // 判别键 event（代码 H5）

export const useToolStore = defineStore('tool', () => {
  const records = ref<Record<string, ToolCallRecord>>({})
  const liveOrder = ref<string[]>([])
  const captureState = ref<{ callId: string; sources?: PublicToolEvent['captureSources']; preview?: PublicToolEvent['capturePreview'] } | null>(null)
  const pendingPathSummary = ref<{ callId: string; pathSummary: string } | null>(null)
  const pendingDiff = ref<{ callId: string; diff: NonNullable<PublicToolEvent['diff']> } | null>(null)          // A-3：权限窗写 Diff 数据源
  const pendingDataFlowNote = ref<{ callId: string; dataFlowNote: string } | null>(null)                        // A-3：四问④数据源
  const activeConversationId = ref<string | undefined>(undefined)   // 实时区会话隔离（真实联调收口：切换会话不显示他会话终态卡片）
  let unsubscribeEvent: (() => void) | undefined

  /** 可见 liveOrder：未归属记录恒显示（mock/兼容）；活动会话未知时已归属记录也显示
   *  （防 connection state 晚于首个工具事件时闪没）；活动会话已知后只显示归属匹配记录。 */
  const visibleLiveOrder = computed(() => liveOrder.value.filter((id) => {
    const rec = records.value[id]
    if (!rec) return false
    return rec.conversationId === undefined
      || activeConversationId.value === undefined
      || rec.conversationId === activeConversationId.value
  }))
  const waitingForApproval = computed(() => visibleLiveOrder.value.some(id => records.value[id]?.status === 'awaiting_permission'))

  function upsertRecord(id: string, rec: ToolCallRecord): boolean {
    const existing = records.value[id]
    if (existing && TERMINAL.includes(existing.status) && existing.status !== rec.status) return false   // 终态单向
    // 真实后端可能先发 tool.started(runtime=desktop)，再由 Main 下发本地 awaiting_permission。
    // 前者没有 desktopCallId，只是服务端生命周期占位，不能压过本地权限现实；只有已经
    // 进入本地 running 的记录（带 desktopCallId）才禁止回退到 awaiting_permission。
    if (existing?.status === 'running' && existing.desktopCallId && rec.status === 'awaiting_permission') return false
    records.value[id] = rec
    if (!liveOrder.value.includes(id)) liveOrder.value.push(id)
    trimLiveOrder()
    return true
  }
  /** L1（fix round 1）：liveOrder 截断只逐出最旧的**终态**记录——awaiting/running 不参与裁剪（可短暂 >3），
   *  防 awaiting 记录被逐出导致 waitingForApproval 变 false（Live2D waiting_permission 消失/权限窗关闭/探针不可达） */
  function trimLiveOrder(): void {
    if (liveOrder.value.length <= LIVE_LIMIT) return
    const excess = liveOrder.value.length - LIVE_LIMIT
    const evictable = liveOrder.value.filter((oid) => TERMINAL.includes(records.value[oid]?.status ?? 'completed'))
    const evict = new Set(evictable.slice(0, excess))
    if (evict.size) liveOrder.value = liveOrder.value.filter((oid) => !evict.has(oid))
  }
  function upsertLocal(ev: PublicToolEvent): void {
    const rec: ToolCallRecord = { id: ev.id, desktopCallId: ev.desktopCallId, conversationId: ev.conversationId, toolName: ev.toolName, runtime: 'desktop',
      status: ev.status, reason: ev.reason, inputSummary: ev.inputSummary, outputSummary: ev.resultSummary,
      error: ev.error, truncated: ev.truncated, durationMs: ev.durationMs, startedAt: ev.startedAt, finishedAt: ev.finishedAt,
      attachmentCount: ev.attachmentCount }
    // F-7（批次 C）：diff 同步写入记录（终态不清——只读 Diff 卡数据源；pendingDiff 侧信道仍保留给权限窗）
    if (ev.diff) rec.diff = ev.diff
    const applied = upsertRecord(ev.id, rec)
    const cid = ev.desktopCallId ?? ev.id
    // L2（fix round 1）：侧信道写入受终态单向守卫——迟到 awaiting 事件（记录已终态，upsertRecord 已拒）不写侧信道
    if (applied && ev.status === 'awaiting_permission' && records.value[ev.id]?.status === 'awaiting_permission') {
      if (ev.pathSummary) pendingPathSummary.value = { callId: cid, pathSummary: ev.pathSummary }
      if (ev.diff) pendingDiff.value = { callId: cid, diff: ev.diff }
      if (ev.dataFlowNote) pendingDataFlowNote.value = { callId: cid, dataFlowNote: ev.dataFlowNote }
    }
    // M2（fix round 1）：终态侧信道清理按 callId 匹配——A awaiting 时 B 终态不清 A 的侧信道（权限窗不退化）；
    // captureState 仅同工具（desktop.screen.capture）终态清
    if (TERMINAL.includes(ev.status)) clearApprovalFor(ev, cid)
    if (applied && ev.toolName === 'desktop.screen.capture' && ev.status === 'running' && (ev.captureSources || ev.capturePreview)) {
      captureState.value = { callId: cid, sources: ev.captureSources, preview: ev.capturePreview }
    }
  }
  /** M2（fix round 1）：按 callId 清理终态侧信道（权限窗关闭/回收）；captureState 额外要求工具匹配 */
  function clearApprovalFor(ev: PublicToolEvent, cid: string): void {
    if (pendingPathSummary.value?.callId === cid) pendingPathSummary.value = null
    if (pendingDiff.value?.callId === cid) pendingDiff.value = null
    if (pendingDataFlowNote.value?.callId === cid) pendingDataFlowNote.value = null
    if (ev.toolName === 'desktop.screen.capture' && captureState.value?.callId === cid) captureState.value = null
  }
  function clearApprovalLocal(): void {   // 权限窗关闭只回收审批侧信道；capture 交互态必须留到同 callId 终态事件清理
    pendingPathSummary.value = null; pendingDiff.value = null; pendingDataFlowNote.value = null
  }
  function applyBackendEvent(ev: ToolBackendEvent): void {
    if (ev.event === 'tool.started') {
      if (records.value[ev.callId]) return   // D6B-21：本地已存在不覆盖
      upsertRecord(ev.callId, { id: ev.callId, toolName: ev.toolName, runtime: ev.runtime, status: 'running', inputSummary: ev.inputSummary, generationId: ev.generationId, conversationId: ev.conversationId })
    } else if (ev.event === 'tool.completed') {
      const existing = records.value[ev.callId]
      if (existing && existing.runtime === 'desktop') return   // D6B-21 修正：仅 desktop 本地记录存在时不覆盖（本地裁决优先）；backend 自身 started→completed 正常推进（Task 8 集成发现）
      // UII-QQ 收尾：backend 失败按稳定错误类型分类——用户取消（CANCELLED/TOOL_CANCELLED/USER_CANCELLED，
      // 与 message.store isCancellationCode 同源口径）→ cancelled（灰「已取消」非红「执行失败」）；
      // TIMEOUT → timeout；未命中一律真实 failed。不凭猜测扩大代码集（见 shared/domain/tool-status）。
      const status: ToolCallStatus = ev.success
        ? 'completed'
        : isToolCancelType(ev.errorType) ? 'cancelled'
        : isToolTimeoutType(ev.errorType) ? 'timeout'
        : 'failed'
      upsertRecord(ev.callId, { id: ev.callId, toolName: ev.toolName, runtime: ev.runtime,
        status, outputSummary: ev.outputSummary, error: ev.error ? { code: String(ev.error['code'] ?? ''), message: String(ev.error['message'] ?? '') } : undefined,
        errorType: ev.errorType, truncated: ev.truncated, durationMs: ev.durationMs, generationId: ev.generationId, conversationId: ev.conversationId })
    }
    // tool.request 防御性忽略（批次 B 起 desktop 请求不再经 chat:event，D6B-08）
  }
  function clearForGeneration(): void { liveOrder.value = liveOrder.value.filter(id => !TERMINAL.includes(records.value[id]?.status ?? 'completed')) }  // A9
  /** 实时区会话隔离：bootstrap 在 connection state push 时同步活动会话（undefined = 未归属兼容态） */
  function setActiveConversationId(id: string | undefined): void { activeConversationId.value = id }
  // L-2/F-15（批次 C）：先 await toolList 水合完毕再订阅 onToolEvent（防旧快照覆盖新事件；水合快照 = Main 权威快照）。
  // 水合失败 fail-open（不阻塞启动）；toolList 为 DesktopApiLike 必填键（LOW-1：无 ?. 防御——测试 mock 须镜像全契约）。
  async function init(): Promise<void> {
    if (unsubscribeEvent) return
    const list = await api.toolList().catch(() => [])
    for (const ev of list) if (!TERMINAL.includes(ev.status)) upsertLocal(ev)   // 非终态必水合（终态可选；upsertLocal 幂等）
    unsubscribeEvent = api.onToolEvent((ev) => upsertLocal(ev))
  }
  // 批次 C 四方法（F-23 命名映射：store grantDirectory/listGrants/revokeGrant/listHistory ↔
  // preload toolGrantDirectory/toolListGrants/toolRevokeGrant/toolListHistory ↔ IpcChannels
  // toolGrantDirectory/toolGrants/toolGrantRevoke/toolHistory）：
  async function grantDirectory(callId: string, ttlMs: number): Promise<boolean> {   // FINAL-LOW：executed 透传（F-1 miss → false 供 UI 提示）
    const r = await api.toolGrantDirectory({ callId, ttlMs })
    return r.executed
  }
  async function listGrants(): Promise<PermissionGrant[]> {
    return api.toolListGrants()
  }
  async function revokeGrant(id: string): Promise<void> {
    await api.toolRevokeGrant(id)
  }
  async function listHistory(limit?: number): Promise<HistoryEntry[]> {
    return api.toolListHistory(limit)
  }
  async function decide(callId: string, decision: 'allow_once' | 'deny'): Promise<void> { await api.toolDecide({ callId, decision }) }
  async function cancel(callId: string): Promise<void> { await api.toolCancel(callId) }
  async function pickSource(callId: string, sourceId: string): Promise<void> { await api.toolPickSource(callId, sourceId) }
  async function confirmUpload(callId: string): Promise<void> { await api.toolConfirmUpload(callId) }
  function liveRecords(): ToolCallRecord[] { return visibleLiveOrder.value.map(id => records.value[id]).filter(Boolean) }
  return { records, liveOrder, activeConversationId, captureState, pendingPathSummary, pendingDiff, pendingDataFlowNote, waitingForApproval,
    init, applyBackendEvent, upsertLocal, clearForGeneration, setActiveConversationId, clearApprovalLocal, decide, cancel, pickSource, confirmUpload, liveRecords,
    grantDirectory, listGrants, revokeGrant, listHistory }
})
