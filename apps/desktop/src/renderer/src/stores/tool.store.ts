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
// running 不回退 awaiting_permission。liveOrder 只保留最近 LIVE_LIMIT 条（实时区上限）。
// clearForGeneration（generation.started 接线）只清终态——awaiting_permission 跨代保留（A9）。
//
// 侧信道（A-3/M4/M11）：pendingPathSummary/pendingDiff/pendingDataFlowNote 供权限窗（四问/写 Diff）
// 与卡片取数据；awaiting_permission 写入、任何终态清空（clearApprovalLocal 完整清理含 captureState，L6）。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicToolEvent, ToolCallRecord, ToolCallStatus } from '@shared/contracts/tool'
import type { BackendEvent } from '@shared/contracts/events'
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
  let unsubscribeEvent: (() => void) | undefined

  const waitingForApproval = computed(() => liveOrder.value.some(id => records.value[id]?.status === 'awaiting_permission'))

  function upsertRecord(id: string, rec: ToolCallRecord): void {
    const existing = records.value[id]
    if (existing && TERMINAL.includes(existing.status) && existing.status !== rec.status) return   // 终态单向
    if (existing?.status === 'running' && rec.status === 'awaiting_permission') return            // 不回退
    records.value[id] = rec
    if (!liveOrder.value.includes(id)) liveOrder.value.push(id)
    if (liveOrder.value.length > LIVE_LIMIT) liveOrder.value = liveOrder.value.slice(-LIVE_LIMIT)
  }
  function upsertLocal(ev: PublicToolEvent): void {
    const rec: ToolCallRecord = { id: ev.id, desktopCallId: ev.desktopCallId, toolName: ev.toolName, runtime: 'desktop',
      status: ev.status, reason: ev.reason, inputSummary: ev.inputSummary, outputSummary: ev.resultSummary,
      error: ev.error, truncated: ev.truncated, durationMs: ev.durationMs, startedAt: ev.startedAt, finishedAt: ev.finishedAt,
      attachmentCount: ev.attachmentCount }
    upsertRecord(ev.id, rec)
    if (ev.status === 'awaiting_permission') {
      if (ev.pathSummary) pendingPathSummary.value = { callId: ev.desktopCallId ?? ev.id, pathSummary: ev.pathSummary }
      if (ev.diff) pendingDiff.value = { callId: ev.desktopCallId ?? ev.id, diff: ev.diff }
      if (ev.dataFlowNote) pendingDataFlowNote.value = { callId: ev.desktopCallId ?? ev.id, dataFlowNote: ev.dataFlowNote }
    }
    if (TERMINAL.includes(ev.status)) clearApprovalLocal()
    if (ev.toolName === 'desktop.screen.capture' && ev.status === 'running' && (ev.captureSources || ev.capturePreview)) {
      captureState.value = { callId: ev.desktopCallId ?? ev.id, sources: ev.captureSources, preview: ev.capturePreview }
    }
  }
  function clearApprovalLocal(): void {   // 完整 M11：终态清理侧信道（权限窗关闭/回收）
    pendingPathSummary.value = null; pendingDiff.value = null; pendingDataFlowNote.value = null
    captureState.value = null   // L6：capture 面板终态一并回收
  }
  function applyBackendEvent(ev: ToolBackendEvent): void {
    if (ev.event === 'tool.started') {
      if (records.value[ev.callId]) return   // D6B-21：本地已存在不覆盖
      upsertRecord(ev.callId, { id: ev.callId, toolName: ev.toolName, runtime: ev.runtime, status: 'running', inputSummary: ev.inputSummary, generationId: ev.generationId, conversationId: ev.conversationId })
    } else if (ev.event === 'tool.completed') {
      if (records.value[ev.callId]) return
      upsertRecord(ev.callId, { id: ev.callId, toolName: ev.toolName, runtime: ev.runtime,
        status: ev.success ? 'completed' : 'failed', outputSummary: ev.outputSummary, error: ev.error ? { code: String(ev.error['code'] ?? ''), message: String(ev.error['message'] ?? '') } : undefined,
        errorType: ev.errorType, truncated: ev.truncated, durationMs: ev.durationMs, generationId: ev.generationId, conversationId: ev.conversationId })
    }
    // tool.request 防御性忽略（批次 B 起 desktop 请求不再经 chat:event，D6B-08）
  }
  function clearForGeneration(): void { liveOrder.value = liveOrder.value.filter(id => !TERMINAL.includes(records.value[id]?.status ?? 'completed')) }  // A9
  function init(): void {
    if (!unsubscribeEvent) unsubscribeEvent = api.onToolEvent((ev) => upsertLocal(ev))
  }
  async function decide(callId: string, decision: 'allow_once' | 'deny'): Promise<void> { await api.toolDecide({ callId, decision }) }
  async function cancel(callId: string): Promise<void> { await api.toolCancel(callId) }
  async function pickSource(callId: string, sourceId: string): Promise<void> { await api.toolPickSource(callId, sourceId) }
  async function confirmUpload(callId: string): Promise<void> { await api.toolConfirmUpload(callId) }
  function liveRecords(): ToolCallRecord[] { return liveOrder.value.map(id => records.value[id]).filter(Boolean) }
  return { records, liveOrder, captureState, pendingPathSummary, pendingDiff, pendingDataFlowNote, waitingForApproval,
    init, applyBackendEvent, upsertLocal, clearForGeneration, clearApprovalLocal, decide, cancel, pickSource, confirmUpload, liveRecords }
})
