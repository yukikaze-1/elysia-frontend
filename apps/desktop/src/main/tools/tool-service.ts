import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { computeParamHash, canonicalJsonStringify } from './param-hash'
import type { RegisteredTool } from './tool-registry'
import { isPathBlacklisted, normalizeToolPath } from './tool-policy'
import { redactToolArguments } from './input-summary'
import { createExecutors, ToolExecError, type ExecResult } from './tool-executors'
import { computeTextDiff, detectTextFormat } from './text-diff'
import type { PublicToolEvent, ToolAttachment, ToolCallStatus } from '@shared/contracts/tool'
import { GRANT_TTL_OPTIONS_MS } from '@shared/contracts/tool'   // 批次 C（D6C-04）：grant TTL 白名单（grantDirectory F-3 双校验）
import type { ToolStatusCommand, ToolWireStatus, DesktopCallStatus } from '@shared/contracts/backend'
import type { AuditEvent } from '../diagnostics/audit'

export interface DesktopToolRequest {
  callId: string; sourceCallId: string; toolName: string; toolVersion: string
  runtime: 'desktop'; arguments: Record<string, unknown>
  reason?: string; expiresAt: number; paramHash?: string
}
export interface FilePickerOptions { title: string; filters: { name: string; extensions: string[] }[] }
export interface CaptureSourceInfo { sourceId: string; sourceName: string; thumbnailDataUrl: string }
export interface ToolServiceDeps {
  registry: Map<string, RegisteredTool>
  platform: 'posix' | 'windows'
  audit: (ev: AuditEvent) => void
  pickFile?: (opts: FilePickerOptions) => Promise<{ canceled: boolean; path?: string }>
  enumerateSources?: () => Promise<CaptureSourceInfo[]>
  renderPreview?: (sourceId: string) => Promise<{ previewDataUrl: string; bytes: Uint8Array }>   // capture picked 后（Task 4，A-2）
  finalizeUpload?: (callId: string, bytes: Uint8Array) => Promise<void>                          // 上传前钩子（Task 4）
  submitStatus: (cmd: ToolStatusCommand) => Promise<void>
  uploadAttachment: (callId: string, bytes: Uint8Array, mime: string, label?: string) => Promise<ToolAttachment>
  pushEvent: (ev: PublicToolEvent) => void
  selectedExemptTtlMs?: number
  allowRoots?: string[]
  isWayland?: boolean               // 注入（测试用）；缺省 isWaylandSession() env 判定（A-4）
  executorOverride?: (rec: ToolRecord, realPath?: string) => Promise<ExecResult>   // 测试注入（B-1/M12）
  selectedAdd?: (realPath: string) => void   // selected-set 写闭包（A-14：tool-service 注入；executor 可选调用）
  // —— 批次 C（D6C-04/05）：目录授权 ——
  grants?: import('./grant-store').GrantStore      // 批次 C（D6C-04）：grant 仓库（缺省 → 无 grant 面）
  pickDirectory?: (opts: { title: string }) => Promise<{ canceled: boolean; path?: string }>   // D6C-05 创建流注入
  backendIdentity?: () => string | undefined       // F-2：当前连接指纹（grant 创建时绑定；index.ts 懒绑定闭包）
  queryStatus?: (callId: string) => Promise<DesktopCallStatus | null>   // 批次 C（D6C-11，本 task 首次加入）：GET tools/calls 查询（注入才查；mock 不注入 → 不查，F-20）
}
export interface ToolRecord {
  id: string; desktopCallId?: string; toolName: string; title: string
  status: ToolCallStatus; reason?: string; inputSummary?: string; pathSummary?: string
  resultSummary?: string; error?: { code?: string; message?: string }; truncated?: boolean
  durationMs?: number; startedAt?: string; finishedAt?: string; attachmentCount?: number
  dataFlowNote?: string; diff?: PublicToolEvent['diff']; oldHash?: string           // oldHash=写前哈希依据（A-1/M7）
  captureSources?: PublicToolEvent['captureSources']; capturePreview?: PublicToolEvent['capturePreview']
  expiresAt: number; paramHash?: string; arguments_: Record<string, unknown>; toolVersion: string
  statusSent: boolean; realPath?: string        // L1：决策链 step 5 normalize 缓存（executor/串行锁读取）
  attachments?: ToolAttachment[]                // M2：完成时缓存（重连重发复用 URL，D6B-11）
}
export interface ToolService {
  handleRequest(req: DesktopToolRequest): Promise<void>
  decide(callId: string, decision: 'allow_once' | 'deny'): Promise<void>
  cancel(callId: string): Promise<void>
  listRecent(limit?: number): PublicToolEvent[]
  pickSource(callId: string, sourceId: string): Promise<void>
  confirmUpload(callId: string): Promise<void>
  grantDirectory(callId: string, ttlMs: number): Promise<void>   // 批次 C（D6C-05）：目录授权创建流
  reconnect(): Promise<void>
  shutdown(): void
  getRecord(callId: string): ToolRecord | undefined
}

export const FILE_READ_MAX_BYTES = 2 * 1024 * 1024
export const RESULT_INLINE_BYTES = 64 * 1024
export const MAX_WRITE_CONTENT_BYTES = 2 * 1024 * 1024
export const SELECT_EXEMPT_TTL_MS = 10 * 60 * 1000
export const TEXT_FILE_FILTERS = { name: '文本文件', extensions: ['txt','md','markdown','json','log','csv','tsv','js','ts','jsx','tsx','py','rb','go','rs','c','h','cpp','hpp','java','kt','swift','css','scss','html','htm','yaml','yml','toml','ini','cfg','conf','xml','svg','sh','bash','env'] }
export const PATH_SUMMARY_MAX = 120
export const THUMBNAIL_DATA_URL_MAX = 64 * 1024      // 缩略图 data URL 上限（A-18/L-5/B5；超出丢弃并提示 dropped）
export const PREVIEW_DATA_URL_MAX = 256 * 1024       // 全尺寸预览 data URL 上限（A-18/L-5；超限降级为缩略图）
export const CAPTURE_SESSION_TTL_MS = 120_000        // capture 子状态机停留态超时（M1：awaiting_pick/picked 无执行超时兜底——Renderer 不响应时记录不得永久停留 running）
export const MAX_RECORDS = 200   // L-1（D6C-09a）：records 容量上限（超出逐最旧终态；awaiting/running 永不逐出）

/** 工具服务结构化错误（IPC 层映射为结构化拒绝） */
export class ToolServiceError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
// M10 注记：tool-service ↔ tool-executors 存在值导入互引（createExecutors vs 常量/类型）——当前仅函数体内使用不触发 TDZ；
// 若实现期遇循环 import 告警，把 FILE_READ_MAX_BYTES 等常量下沉到 main/tools/limits.ts（评估后记录取舍）

export function createToolService(deps: ToolServiceDeps): ToolService {
  const records = new Map<string, ToolRecord>()
  const byCallId = new Map<string, string>()              // desktopCallId → sourceCallId（decide/cancel/pick/confirm 索引）
  const selectedSet = new Map<string, number>()      // realPath → selectedAt
  const awaitingQueue: string[] = []                 // FIFO（A8）
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const executors = createExecutors({ ...deps, selectedAdd: (p) => selectedSet.set(p, Date.now()) })   // selected-set 写闭包（A-14）
  const serialLocks = new Map<string, Promise<unknown>>()   // per-path 写串行锁（A-8）
  let shutdownFlag = false
  // capture 子状态机会话（D6B-16/M-5/A-2）：awaiting_pick → picked → awaiting_confirm 钉死（乱序拒 CAPTURE_STATE_INVALID、sourceId ∈ 枚举快照）
  interface CaptureSession { sourceId?: string; previewDataUrl?: string; bytes?: Uint8Array; dropped?: number }
  const captureSessions = new Map<string, CaptureSession>()
  const captureTimers = new Map<string, ReturnType<typeof setTimeout>>()   // M1：停留态 TTL 定时器（CAPTURE_SESSION_TTL_MS）

  /** Wayland 会话判定（D6B-05；deps.isWayland 注入优先，缺省 env 判定，A-4） */
  function isWaylandSession(): boolean {
    if (deps.isWayland !== undefined) return deps.isWayland
    const t = process.env.XDG_SESSION_TYPE?.toLowerCase()
    return t === 'wayland' || (!!process.env.WAYLAND_DISPLAY && t !== 'x11')
  }

  function emit(rec: ToolRecord, extra: Partial<PublicToolEvent> = {}): void {
    deps.pushEvent({
      id: rec.id, desktopCallId: rec.desktopCallId, toolName: rec.toolName, title: rec.title,
      runtime: 'desktop', status: rec.status, reason: rec.reason, inputSummary: rec.inputSummary,
      pathSummary: rec.pathSummary, resultSummary: rec.resultSummary, error: rec.error,
      truncated: rec.truncated, durationMs: rec.durationMs, startedAt: rec.startedAt, finishedAt: rec.finishedAt,
      attachmentCount: rec.attachmentCount, dataFlowNote: rec.dataFlowNote, diff: rec.diff,
      captureSources: rec.captureSources, capturePreview: rec.capturePreview, occurredAt: new Date().toISOString(), ...extra,
    })
  }
  function wireSend(rec: ToolRecord, status: ToolWireStatus, extra: Partial<ToolStatusCommand> = {}): Promise<void> {
    return deps.submitStatus({ callId: rec.desktopCallId!, status, toolName: rec.toolName, toolVersion: rec.toolVersion,
      runtime: 'desktop', paramHash: rec.paramHash ?? computeParamHash(rec.arguments_), ...extra })
      .then(() => { rec.statusSent = true })
      .catch(() => { rec.statusSent = false })
  }
  function toWire(display: ToolCallStatus): ToolWireStatus | null {
    switch (display) {
      case 'running': return 'running'
      case 'completed': return 'result'
      case 'failed': return 'error'
      case 'rejected': return 'rejected'
      case 'cancelled': case 'timeout': return 'cancelled'
      default: return null   // requested/awaiting_permission
    }
  }
  function derivePathSummary(args: Record<string, unknown>): string | undefined {
    if (typeof args.path !== 'string' || !args.path) return undefined
    const p = args.path.replace(/\\/g, '/')
    const seg = p.split('/').filter(Boolean)
    if (seg.length === 0) return p.slice(0, PATH_SUMMARY_MAX)
    const name = seg.at(-1)!
    const parent = seg.length > 1 ? seg.slice(0, -1).join('/') : ''
    return (parent ? `${parent}/` : '') + name   // 父目录+basename（H-1）
  }
  function isExempt(path: string): boolean {
    const t = selectedSet.get(path)
    return t !== undefined && Date.now() - t <= (deps.selectedExemptTtlMs ?? SELECT_EXEMPT_TTL_MS)
  }
  function audit(type: string, rec: ToolRecord, extra: Record<string, unknown> = {}): void {
    deps.audit({ ts: new Date().toISOString(), type, runtime: 'desktop', toolId: rec.id, toolName: rec.toolName,   // F-3：toolName 字段化（审批历史按工具过滤数据源）
      callId: rec.desktopCallId, status: rec.status, summary: rec.inputSummary, ...extra })   // 去强转：AuditEvent 扩展后字段全兼容（F-3）
  }
  function dequeueNext(): void {
    while (awaitingQueue.length > 0) {
      const id = awaitingQueue.shift()!
      const rec = records.get(id)
      if (!rec || rec.status !== 'awaiting_permission') continue
      emit(rec)
      return
    }
  }
  // desktopCallId → sourceCallId 索引（decide/cancel/pick/confirm 以桥 callId 入参，doc 02 §10.3）
  function idOf(callId: string): string | undefined { return byCallId.get(callId) ?? callId }

  function reject(req: DesktopToolRequest, code: string, message: string): void {
    const existing = records.get(req.sourceCallId)
    if (existing) {
      // M3②+批次最终 M-3：既有记录（awaiting/running 等）不被覆盖——补发 rejected 事件 + wire；
      // 同步原记录状态（终态单向：仅非终态推进为 rejected）+ 清 expiresAt 定时器 + 队列晋升（防双终态 wire 与队列头阻塞，M-3 修正）
      if (!['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(existing.status)) {
        existing.status = 'rejected'; existing.error = { code, message }; existing.finishedAt = new Date().toISOString()
        const timer = timers.get(existing.id); if (timer) { clearTimeout(timer); timers.delete(existing.id) }
        promoteQueue(existing.id)
      }
      const ev: ToolRecord = { ...existing, desktopCallId: req.callId }
      void wireSend(ev, 'rejected', { error: { code, message } })
      audit('tool:terminal', ev, { errorCode: code })
      emit(ev)
      return
    }
    const rec: ToolRecord = { id: req.sourceCallId, desktopCallId: req.callId, toolName: req.toolName, title: deps.registry.get(req.toolName)?.title ?? req.toolName,
      status: 'rejected', inputSummary: redactToolArguments(req.arguments), expiresAt: req.expiresAt, arguments_: req.arguments,
      toolVersion: req.toolVersion, statusSent: false, error: { code, message }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
    records.set(rec.id, rec); byCallId.set(req.callId, rec.id)
    evictIfNeeded()   // LOW-5（review）：reject 新记录也是终态（rejected）——策略拒洪泛不使 records 无上限增长
    void wireSend(rec, 'rejected', { error: { code, message } })   // H1：策略拒也回 wire rejected（spec §3.2 step 13「rejected（deny/策略拒）」）
    audit('tool:terminal', rec, { errorCode: code })
    emit(rec)
  }
  function terminal(rec: ToolRecord, display: 'failed' | 'timeout' | 'cancelled' | 'rejected', err?: { code?: string; message?: string }, cancelSource: 'user' | 'timeout' | 'backend' = 'user', wireStatus?: ToolWireStatus): void {   // M2：扩 'rejected'（shutdown 用）；wireStatus 显式覆盖（M1：执行超时 wire error{TIMEOUT}）
    captureSessions.delete(rec.id)   // capture 会话清理（完成/取消/超时，doc 04 §8.4）
    const captureTimer = captureTimers.get(rec.id); if (captureTimer) { clearTimeout(captureTimer); captureTimers.delete(rec.id) }   // M1：停留态 TTL 清除
    rec.captureSources = undefined; rec.capturePreview = undefined   // L3：终态事件不携带陈旧选择器/预览数据
    rec.status = display; rec.error = err; rec.finishedAt = new Date().toISOString(); rec.durationMs = durationOf(rec)
    const timer = timers.get(rec.id); if (timer) { clearTimeout(timer); timers.delete(rec.id) }
    const wire = wireStatus ?? (display === 'timeout' ? 'cancelled' : toWire(display) ?? 'error')
    void wireSend(rec, wire, err ? { error: err } : {})
    audit('tool:terminal', rec, { errorCode: err?.code, cancelSource })
    emit(rec)
    promoteQueue(rec.id)
  }
  function expire(rec: ToolRecord): void { terminal(rec, 'timeout', { code: 'TIMEOUT', message: '请求超时' }, 'timeout') }
  function durationOf(rec: ToolRecord): number | undefined {
    return rec.startedAt ? Math.max(0, Date.now() - Date.parse(rec.startedAt)) : undefined
  }
  function promoteQueue(callIdOrId?: string): void {
    const i = awaitingQueue.indexOf(callIdOrId ?? '')   // 队列存 rec.id（sourceCallId）——调用方传 rec.id（L8）
    if (i >= 0) awaitingQueue.splice(i, 1)
    dequeueNext()
  }
  /** L-1 容量驱逐（D6C-09a）：records 超 MAX_RECORDS 时逐最旧终态（awaiting/running 永不逐出）；
   * 终态记录的 expiresAt 定时器已清（terminal/decide 先例），此处再清属双保险 */
  function evictIfNeeded(): void {
    if (records.size <= MAX_RECORDS) return
    const terminal = [...records.values()].filter((r) => ['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(r.status))
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))   // 最旧优先
    for (const rec of terminal) {
      if (records.size <= MAX_RECORDS) break
      records.delete(rec.id)
      if (rec.desktopCallId) byCallId.delete(rec.desktopCallId)
      const t = timers.get(rec.id); if (t) { clearTimeout(t); timers.delete(rec.id) }
    }
  }
  async function decide(callId: string, decision: 'allow_once' | 'deny'): Promise<void> {
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    if (!rec || rec.status !== 'awaiting_permission') throw new ToolServiceError('TOOL_STATE_INVALID', 'callId 不在等待授权态')
    const timer = timers.get(rec.id); if (timer) { clearTimeout(timer); timers.delete(rec.id) }
    audit('tool:decision', rec, { permissionDecision: decision, riskLevel: deps.registry.get(rec.toolName)?.localRisk })
    if (decision === 'deny') {
      rec.status = 'rejected'; rec.finishedAt = new Date().toISOString()
      await wireSend(rec, 'rejected')
      audit('tool:terminal', rec)
      emit(rec); promoteQueue(rec.id)
      return
    }
    await run(rec, deps.registry.get(rec.toolName)!)
    promoteQueue(rec.id)
  }
  async function cancel(callId: string): Promise<void> {
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    if (!rec || ['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(rec.status)) throw new ToolServiceError('TOOL_STATE_INVALID', 'callId 已终态')
    terminal(rec, 'cancelled', undefined, 'user')
  }
  /** 断线重连（D6B-11/A-8）：终态且 statusSent=false 重发（附件 URL 随重发带上、字节不重传，M2）；selected-set 清空 */
  async function reconnect(): Promise<void> {
    selectedSet.clear()
    for (const rec of records.values()) {
      if (['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(rec.status) && !rec.statusSent) {
        const wire = toWire(rec.status) ?? 'cancelled'
        void wireSend(rec, wire, rec.attachments?.length ? { attachments: rec.attachments } : {})
      }
    }
    // 批次 C（D6C-11）：awaiting 记录查询服务端状态（注入 queryStatus 才查；mock 不注入 → 不查）
    if (deps.queryStatus) {
      for (const rec of records.values()) {
        if (rec.status !== 'awaiting_permission' || !rec.desktopCallId) continue
        const st = await deps.queryStatus(rec.desktopCallId).catch(() => null)
        if (!st) continue   // null/失败 → 保持本地态（禁止自动执行，doc 02 §16.2）
        if (st.status === 'expired') { terminal(rec, 'timeout', { code: 'EXPIRED', message: '服务端已过期' }, 'timeout', 'cancelled'); continue }
        if (st.status === 'cancelled' || st.status === 'rejected') { terminal(rec, 'cancelled', undefined, 'backend', 'cancelled'); continue }
        // succeeded/failed/pending/accepted/running/offline → 保持本地态
      }
    }
  }
  /** 应用退出（B2/A-8）：停止接收；未决授权按拒绝 + 审计 cancelSource:'user' */
  function shutdown(): void {
    shutdownFlag = true
    for (const rec of records.values()) {
      if (rec.status === 'awaiting_permission') terminal(rec, 'rejected', { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' }, 'user')
    }
    awaitingQueue.length = 0
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }
  /** 最近公开记录（tool:list，F-2 includeNonTerminalAlways：非终态全量 + 终态补足到 limit——L-2 水合数据源；
   * L2 取舍注记：diff/captureSources/capturePreview 不进 listRecent——tool:list 仅作 hydration 用，capture/diff 交互态由 tool:event 实时推送） */
  function listRecent(limit = 20): PublicToolEvent[] {
    const all = [...records.values()].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    const TERMINAL = ['completed', 'failed', 'rejected', 'cancelled', 'timeout']
    const nonTerminal = all.filter((r) => !TERMINAL.includes(r.status))
    const terminal = all.filter((r) => TERMINAL.includes(r.status)).slice(0, Math.max(0, limit - nonTerminal.length))
    return [...nonTerminal, ...terminal].map((rec) => ({
      id: rec.id, desktopCallId: rec.desktopCallId, toolName: rec.toolName, title: rec.title, runtime: 'desktop' as const,
      status: rec.status, reason: rec.reason, inputSummary: rec.inputSummary, pathSummary: rec.pathSummary,
      resultSummary: rec.resultSummary, error: rec.error, truncated: rec.truncated, durationMs: rec.durationMs,
      startedAt: rec.startedAt, finishedAt: rec.finishedAt, attachmentCount: rec.attachmentCount, dataFlowNote: rec.dataFlowNote,
      occurredAt: rec.finishedAt ?? rec.startedAt ?? new Date().toISOString(),
    }))
  }
  function getRecord(callId: string): ToolRecord | undefined {
    const id = idOf(callId); return id ? records.get(id) : undefined
  }
  /** per-path 写串行锁（A-8/doc 04 §12）：写执行包进同路径 Promise 链 */
  function withPathLock<T>(realPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = serialLocks.get(realPath) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    serialLocks.set(realPath, next)
    return next
  }
  /** capture 子状态机 pickSource（D6B-16/M-5/A-2）：awaiting_pick → picked（预览下发 ≤256KiB，超限降级缩略图） */
  async function pickSource(callId: string, sourceId: string): Promise<void> {
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    if (!rec || rec.status !== 'running') throw new ToolServiceError('CAPTURE_STATE_INVALID', '不在 awaiting_pick 态')
    const sess = captureSessions.get(rec.id)
    const known = (rec.captureSources ?? []).some(s => s.sourceId === sourceId)
    if (!sess || !known) throw new ToolServiceError('CAPTURE_STATE_INVALID', 'sourceId 不在枚举快照')
    // picked：全尺寸预览（≤256KiB，超限降级为缩略图，A-18/L-5）
    const render = deps.renderPreview ?? (async (sid) => {
      const { desktopCapturer } = await import('electron')
      const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1920, height: 1080 } })
      const s = srcs.find(x => x.id === sid)
      if (!s) throw new ToolServiceError('CAPTURE_STATE_INVALID', 'sourceId 不存在')
      return { previewDataUrl: s.thumbnail.toDataURL(), bytes: s.thumbnail.toPNG() }
    })
    const { previewDataUrl, bytes } = await render(sourceId)
    sess.sourceId = sourceId; sess.bytes = bytes
    const thumb = rec.captureSources?.find(s => s.sourceId === sourceId)?.thumbnailDataUrl
    const finalPreview = previewDataUrl.length > PREVIEW_DATA_URL_MAX ? (thumb ?? previewDataUrl) : previewDataUrl
    sess.previewDataUrl = finalPreview
    rec.capturePreview = { sourceId, previewDataUrl: finalPreview }
    emit(rec)   // picked（preview 下发 → awaiting_confirm；TTL 定时器保持运行——picked 停留同样守卫，M1）
  }
  /** capture 子状态机 confirmUpload（D6B-16/M-5/A-2）：awaiting_confirm → 上传回填 → 终态清理 */
  async function confirmUpload(callId: string): Promise<void> {
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    const sess = rec ? captureSessions.get(rec.id) : undefined
    if (!rec || rec.status !== 'running' || !sess?.previewDataUrl) throw new ToolServiceError('CAPTURE_STATE_INVALID', '预览未下发，禁止上传')
    // awaiting_confirm → 上传 → 终态
    const upload = deps.finalizeUpload ?? (async (_cid: string, _bytes: Uint8Array) => {})
    await upload(rec.desktopCallId!, sess.bytes!)
    const attachment = await deps.uploadAttachment(rec.desktopCallId!, sess.bytes!, 'image/png', `capture-${rec.desktopCallId}.png`)
    rec.status = 'completed'; rec.resultSummary = `已捕获 ${sess.sourceId}`; rec.attachmentCount = 1
    rec.attachments = [attachment]   // M2：缓存附件（重连重发复用 URL，D6B-11——与 run() completed 路径同口径）
    rec.finishedAt = new Date().toISOString(); rec.durationMs = durationOf(rec)
    await wireSend(rec, 'result', { attachments: [attachment] })
    audit('tool:terminal', rec)
    rec.captureSources = undefined; rec.capturePreview = undefined   // L-7：终态 emit 前清（前移——对齐 terminal() 先例；emit 后清会让 completed 事件携带陈旧选择器/预览数据）
    emit(rec)
    captureSessions.delete(rec.id)   // 终态清理（含取消/超时路径经 terminal() 增删——见下）
    const captureTimer = captureTimers.get(rec.id); if (captureTimer) { clearTimeout(captureTimer); captureTimers.delete(rec.id) }   // M1：TTL 清除
  }
  /** 目录授权创建流（D6C-05/§3.3 定案）：awaiting → pickDirectory → add grant → F-1 复核命中 → run。
   * 守卫链：F-14 grants 缺省 → TOOL_STATE_INVALID / 状态复核 / 工具二值 / realPath / F-3 ttl 白名单双校验 /
   * N-4 断连不创建 / 取消不创建 / N-1 dialog 后状态复核 / V-5 dialog 后身份复核 / F-1 picked 不覆盖目标不执行 /
   * F-6 expiresAt 定时器清理 / F-16 run 抛错仍 promoteQueue */
  async function grantDirectory(callId: string, ttlMs: number): Promise<void> {
    if (!deps.grants) throw new ToolServiceError('TOOL_STATE_INVALID', '目录授权不可用')   // F-14
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    if (!rec || rec.status !== 'awaiting_permission') throw new ToolServiceError('TOOL_STATE_INVALID', 'callId 不在等待授权态')
    const tool = deps.registry.get(rec.toolName)!
    if (rec.toolName !== 'desktop.file.read' && rec.toolName !== 'desktop.file.write') throw new ToolServiceError('TOOL_STATE_INVALID', '该工具不支持目录授权')   // 用 rec.toolName 判别兼收窄（add 需要工具名二值 union）
    if (!rec.realPath) throw new ToolServiceError('PATH_UNSAFE', '目标路径不可用')
    if (!(GRANT_TTL_OPTIONS_MS as readonly number[]).includes(ttlMs)) throw new ToolServiceError('INVALID_ARGUMENTS', 'ttl 不在授权选项内')   // F-3 双保险（显式收窄，无 as never）
    const identity = deps.backendIdentity?.()   // N-4
    if (!identity) return   // 断连 → 不创建（保持 awaiting；fail-closed）
    const picked = deps.pickDirectory ? await deps.pickDirectory({ title: '选择授权目录' }) : { canceled: true }
    if (picked.canceled || !picked.path) return   // 取消 → 保持 awaiting
    if (rec.status !== 'awaiting_permission') return   // N-1：dialog 期间已终态 → 不建不 run
    if (deps.backendIdentity?.() !== identity) return   // V-5：dialog 期间连接切换 → 不创建
    const grant = deps.grants.add({ toolName: rec.toolName, scope: { directory: picked.path }, backendIdentity: identity, expiresAt: Date.now() + ttlMs, source: 'directory' })   // add 内含黑名单复核 + N-6 幂等 + V-1 归一化
    if (!(rec.realPath && deps.grants.matches(rec.toolName, rec.realPath))) return   // F-1：picked 不覆盖目标 → grant 已建不执行
    audit('tool:decision', rec, { permissionDecision: 'allow_scoped', permissionGrantId: grant.id })
    const t = timers.get(rec.id); if (t) { clearTimeout(t); timers.delete(rec.id) }   // F-6
    try { await run(rec, tool) } finally { promoteQueue(rec.id) }   // F-16
  }
  function realPathOf(rec: ToolRecord): string | undefined {   // L1：读决策链缓存（handleRequest step 5 normalize 产物）
    return rec.realPath
  }
  function codeOf(e: unknown): string {
    if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') return (e as { code: string }).code
    return 'EXECUTION_FAILED'
  }
  function messageOf(e: unknown): string {
    if (e instanceof Error) return e.message
    return String(e ?? '')
  }
  async function run(rec: ToolRecord, tool: RegisteredTool): Promise<void> {
    if (rec.status !== 'requested' && rec.status !== 'awaiting_permission') return   // N-1/L-3：已终态记录整体拒绝（防定时器过期后复活）
    rec.status = 'running'; rec.startedAt ??= new Date().toISOString()
    audit('tool:executing', rec)
    emit(rec)
    await wireSend(rec, 'running')                    // A-7：执行前发 running（上传时序 M4 前置）
    // 执行超时定时器（M1：wire error{TIMEOUT}——与 expiresAt 超时的 wire cancelled 区分）
    const timeout = setTimeout(() => { if (rec.status === 'running') { terminal(rec, 'timeout', { code: 'TIMEOUT', message: '执行超时' }, 'timeout', 'error') } }, tool.defaultTimeoutMs)
    try {
      const path = realPathOf(rec)
      const exec = (): Promise<ExecResult> => deps.executorOverride ? deps.executorOverride(rec, path) : executors.execute(rec, path)
      const result = path ? await withPathLock(path, exec) : await exec()   // per-path 串行锁（A-8，H7 交错断言；锁 key = 缓存 realpath，L1）
      if (rec.status !== 'running') return    // 已终态（取消等）
      // capture 子状态机入口（A-2/完整 H3④）：枚举完成 → awaiting_pick（captureSources 下发）；不 outputSchema、不 completed
      if (rec.toolName === 'desktop.screen.capture' && result.captureSession) {
        const sources = (result.output['sources'] as PublicToolEvent['captureSources']) ?? []   // CFA：局部常量 + 空兜底（TS18048）
        rec.captureSources = sources
        const dropped = result.output['dropped'] as number | undefined
        rec.resultSummary = `已枚举 ${sources.length} 个源${dropped ? `，丢弃 ${dropped} 个超大缩略图` : ''}，等待选择`   // M4：dropped 提示面世（Renderer 可见）
        rec.status = 'running'; emit(rec)          // awaiting_pick 态（captureSources 下发）
        captureSessions.set(rec.id, { dropped })
        captureTimers.set(rec.id, setTimeout(() => {   // M1：停留态 TTL 兜底（awaiting_pick 与 picked 均守卫；pick/confirm/terminal 清除）
          if (rec.status === 'running' && captureSessions.has(rec.id)) {
            terminal(rec, 'cancelled', { code: 'TIMEOUT', message: '截图会话超时' }, 'timeout')
          }
        }, CAPTURE_SESSION_TTL_MS))
        return                                     // 等待 pickSource——不 outputSchema、不 completed
      }
      // 12 outputSchema 校验（B1）
      const ok = tool.outputSchema.safeParse(result.output)
      if (!ok.success) { terminal(rec, 'failed', { code: 'INVALID_OUTPUT' }); return }
      rec.status = 'completed'; rec.resultSummary = result.summary; rec.attachmentCount = result.attachmentCount
      rec.attachments = result.attachments   // M2：缓存附件（重连重发复用 URL，D6B-11）
      rec.finishedAt = new Date().toISOString(); rec.durationMs = durationOf(rec)
      // M3/代码 M3：ToolStatusCommand.output 为 string → JSON.stringify
      await wireSend(rec, 'result', { output: JSON.stringify(result.output), attachments: result.attachments })
      audit('tool:terminal', rec)
      emit(rec)
    } catch (e) {
      if (rec.status === 'running') {
        const code = codeOf(e); const rawMessage = messageOf(e)
        terminal(rec, 'failed', { code, message: rawMessage === '' ? undefined : rawMessage })   // A-16/M6：error.message 空串归一 undefined
      }
    } finally { clearTimeout(timeout) }
  }
  /** 决策链 step 7（A2/L7）：write 授权前预读 + Diff（预读失败 FILE_TOO_LARGE/FILE_IS_BINARY → handleRequest 转 terminal failed，A-15） */
  async function preReadForDiff(rec: ToolRecord, realPath: string): Promise<void> {
    if (!fs.existsSync(realPath)) { rec.diff = { lines: [], added: 0, removed: 0, truncated: false, totalLines: 0, formatNote: '新建文件：UTF-8 无 BOM / LF', isNewFile: true }; return }
    const st = fs.statSync(realPath)
    if (st.size > FILE_READ_MAX_BYTES) throw new ToolExecError('FILE_TOO_LARGE', '目标文件超过 2 MiB 上限')
    const buf = fs.readFileSync(realPath)
    let oldText: string
    // ignoreBOM:true——TextDecoder 缺省会剥 BOM，detectTextFormat 的 hasBom 探测需见原始 BOM（D6B-19/L-2，Task 3 统一）
    try { oldText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) }
    catch { throw new ToolExecError('FILE_IS_BINARY', '目标文件不是 UTF-8 文本') }
    const d = computeTextDiff(oldText.replace(/^﻿/, ''), String(rec.arguments_['content']))   // L1：diff 用去 BOM 串（format 探测仍用原串，防 BOM 噪音首行差异）
    const fmt = detectTextFormat(oldText)
    const eolNote = fmt.eol === 'crlf' ? 'CRLF' : 'LF'
    rec.diff = { lines: d.lines, added: d.added, removed: d.removed, truncated: d.truncated, totalLines: d.totalLines,
      formatNote: `将按原文件格式写入：UTF-8${fmt.hasBom ? '（带 BOM）' : ' 无 BOM'} / ${eolNote}${fmt.endsWithNewline ? ' / 末尾换行将补齐' : ''}`,
      isNewFile: false }
    rec.oldHash = createHash('sha256').update(buf).digest('hex')   // 写前哈希检查依据（原子替换前复核，A-1）
  }
  async function handleRequest(req: DesktopToolRequest): Promise<void> {
    if (shutdownFlag) { reject(req, 'APP_SHUTTING_DOWN', '应用正在退出'); return }
    // 1 注册表+平台
    const tool = deps.registry.get(req.toolName)
    if (!tool || tool.version !== req.toolVersion) return reject(req, 'CAPABILITY_UNAVAILABLE', '未注册或版本不匹配')
    if (!tool.supportedPlatforms.includes(deps.platform === 'windows' ? 'windows' : 'linux')) return reject(req, 'CAPABILITY_UNAVAILABLE', '平台不支持')
    // 2 参数 schema（strict）
    const parsed = tool.inputSchema.safeParse(req.arguments)
    if (!parsed.success) return reject(req, 'INVALID_ARGUMENTS', '参数不合法')
    // 3 幂等（doc 04 §13；M3①：canonicalJsonStringify——JSON.stringify 键序敏感误判）
    const existing = records.get(req.sourceCallId)
    if (existing) {
      if (canonicalJsonStringify(existing.arguments_) !== canonicalJsonStringify(req.arguments)) return reject(req, 'PARAM_MISMATCH', '同 callId 参数不一致')
      emit(existing)   // 返回当前状态不重复弹窗
      return
    }
    // 4 paramHash（D6B-22；real 有值必验；mock 无值 → 本地计算回退）
    const paramHash = req.paramHash ?? computeParamHash(req.arguments)
    if (req.paramHash !== undefined && req.paramHash !== computeParamHash(req.arguments)) return reject(req, 'PARAM_HASH_MISMATCH', '参数哈希不一致')
    // 5 full realpath + 黑名单（isPathTool）
    let realPath: string | undefined
    if (tool.isPathTool) {
      const p = req.arguments['path']
      if (typeof p === 'string') {
        try {
          const r = normalizeToolPath(p, { platform: deps.platform })
          realPath = r.realPath
        } catch { return reject(req, 'PATH_UNSAFE', '路径不安全') }   // lint：e 未使用 → 省略绑定
        const rp = realPath   // 局部 const 供闭包（TS CFA 不把外层 let 窄化传入闭包）
        const blacklisted = isPathBlacklisted(rp) && !(deps.allowRoots ?? []).some(root => rp === root || rp.startsWith(root + '/'))
        if (blacklisted) return reject(req, 'PATH_BLOCKLISTED', '路径被黑名单拦截')
      }
    }
    // 6 Wayland 门禁（capture 授权前，A1）
    if (req.toolName === 'desktop.screen.capture' && isWaylandSession()) return reject(req, 'CAPTURE_UNAVAILABLE', '当前桌面环境不支持屏幕捕获')
    // 记录创建
    const rec: ToolRecord = { id: req.sourceCallId, desktopCallId: req.callId, toolName: req.toolName, title: tool.title,
      status: 'requested', reason: req.reason, inputSummary: redactToolArguments(req.arguments), pathSummary: derivePathSummary(req.arguments),
      dataFlowNote: tool.dataFlowNote, expiresAt: req.expiresAt, paramHash, arguments_: req.arguments, toolVersion: req.toolVersion,
      statusSent: false, realPath, startedAt: new Date().toISOString() }
    records.set(rec.id, rec); byCallId.set(req.callId, rec.id)
    evictIfNeeded()   // L-1（D6C-09a）：超 MAX_RECORDS 逐最旧终态（新记录 requested 非终态不逐出）
    audit('tool:request-received', rec)
    // 9 wire accepted（步骤 1~6 通过即发——先于预读与授权判定，spec step 9/M1/A-12 一致性）
    await wireSend(rec, 'accepted')
    // 7 write 授权前预读 + Diff（A2/L7；预读失败（FILE_TOO_LARGE/FILE_IS_BINARY）→ terminal failed，A-15）
    if (req.toolName === 'desktop.file.write' && realPath) {
      try { await preReadForDiff(rec, realPath) }
      catch (e) {
        const raw = messageOf(e)
        terminal(rec, 'failed', { code: codeOf(e), message: raw === '' ? undefined : raw })   // L3：error.message 空串归一（同 run() A-16/M6 口径）
        return
      }
    }
    // 8 授权判定（D6C-04/F-8）：grant 匹配优先于 selected-set 豁免；capture 恒强确认；黑名单优先（step 5 已拒）
    const grant = (req.toolName === 'desktop.file.read' || req.toolName === 'desktop.file.write') && realPath
      ? deps.grants?.matches(req.toolName, realPath) : undefined
    const decision = tool.permissionMode === 'automatic' ? 'auto'
      : grant ? 'auto'
      : (req.toolName === 'desktop.file.read' && realPath && isExempt(realPath)) ? 'auto'
      : 'prompt'
    if (decision === 'auto') {
      if (grant) audit('tool:decision', rec, { permissionDecision: 'allow_scoped', permissionGrantId: grant.id, riskLevel: tool.localRisk })   // N-7：grant 命中审计（豁免命中不审计 allow_scoped）
      await run(rec, tool)
    } else {
      rec.status = 'awaiting_permission'; awaitingQueue.push(rec.id)
      if (awaitingQueue.length === 1) emit(rec)
      // expiresAt 定时器（超时 → timeout + wire cancelled）；已过期（remaining<=0）→ 立即 expire（L2）
      const remaining = req.expiresAt - Date.now()
      if (remaining > 0) timers.set(rec.id, setTimeout(() => expire(rec), remaining))
      else expire(rec)
    }
  }

  return { handleRequest, decide, cancel, listRecent, pickSource, confirmUpload, reconnect, shutdown, getRecord, grantDirectory }
}
