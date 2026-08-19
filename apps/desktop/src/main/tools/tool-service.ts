import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { computeParamHash, canonicalJsonStringify } from './param-hash'
import type { RegisteredTool } from './tool-registry'
import { isPathBlacklisted, normalizeToolPath } from './tool-policy'
import { redactToolArguments } from './input-summary'
import { createExecutors, ToolExecError, type ExecResult } from './tool-executors'
import { computeTextDiff, detectTextFormat } from './text-diff'
import type { PublicToolEvent, ToolAttachment, ToolCallStatus } from '@shared/contracts/tool'
import type { ToolStatusCommand, ToolWireStatus } from '@shared/contracts/backend'
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
    deps.audit({ ts: new Date().toISOString(), type, runtime: 'desktop', toolId: rec.id, callId: rec.desktopCallId,
      status: rec.status, summary: rec.inputSummary, ...extra } as unknown as AuditEvent)
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
      // M3②：既有记录（awaiting/running 等）不被覆盖——仅补发 rejected 事件 + wire（PARAM_MISMATCH 等策略拒）
      const ev: ToolRecord = { ...existing, desktopCallId: req.callId, status: 'rejected', error: { code, message }, finishedAt: new Date().toISOString() }
      void wireSend(ev, 'rejected', { error: { code, message } })
      audit('tool:terminal', ev, { errorCode: code })
      emit(ev)
      return
    }
    const rec: ToolRecord = { id: req.sourceCallId, desktopCallId: req.callId, toolName: req.toolName, title: deps.registry.get(req.toolName)?.title ?? req.toolName,
      status: 'rejected', inputSummary: redactToolArguments(req.arguments), expiresAt: req.expiresAt, arguments_: req.arguments,
      toolVersion: req.toolVersion, statusSent: false, error: { code, message }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
    records.set(rec.id, rec); byCallId.set(req.callId, rec.id)
    void wireSend(rec, 'rejected', { error: { code, message } })   // H1：策略拒也回 wire rejected（spec §3.2 step 13「rejected（deny/策略拒）」）
    audit('tool:terminal', rec, { errorCode: code })
    emit(rec)
  }
  function terminal(rec: ToolRecord, display: 'failed' | 'timeout' | 'cancelled' | 'rejected', err?: { code?: string; message?: string }, cancelSource: 'user' | 'timeout' | 'backend' = 'user', wireStatus?: ToolWireStatus): void {   // M2：扩 'rejected'（shutdown 用）；wireStatus 显式覆盖（M1：执行超时 wire error{TIMEOUT}）
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
  /** 最近公开记录（tool:list，≤limit 条；L2 取舍注记：diff/captureSources/capturePreview 不进 listRecent——tool:list 仅作 hydration 用，capture/diff 交互态由 tool:event 实时推送） */
  function listRecent(limit = 20): PublicToolEvent[] {
    const all = [...records.values()].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    return all.slice(0, limit).map((rec) => ({
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
  /** Task 2 顺序 stub（新发现9）：pickSource/confirmUpload 完整实现在 Task 4——本 task 先抛占位（接口可编译） */
  async function pickSourceStub(_callId: string, _sourceId: string): Promise<void> { throw new ToolServiceError('CAPTURE_STATE_INVALID', 'capture 在 Task 4 落地') }
  async function confirmUploadStub(_callId: string): Promise<void> { throw new ToolServiceError('CAPTURE_STATE_INVALID', 'capture 在 Task 4 落地') }
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
    const d = computeTextDiff(oldText, String(rec.arguments_['content']))
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
        } catch (e) { return reject(req, 'PATH_UNSAFE', '路径不安全') }
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
    // 8 授权判定（D6B-03）
    const decision = tool.permissionMode === 'automatic' ? 'auto' : (req.toolName === 'desktop.file.read' && realPath && isExempt(realPath) ? 'auto' : 'prompt')
    if (decision === 'auto') { await run(rec, tool) }
    else {
      rec.status = 'awaiting_permission'; awaitingQueue.push(rec.id)
      if (awaitingQueue.length === 1) emit(rec)
      // expiresAt 定时器（超时 → timeout + wire cancelled）；已过期（remaining<=0）→ 立即 expire（L2）
      const remaining = req.expiresAt - Date.now()
      if (remaining > 0) timers.set(rec.id, setTimeout(() => expire(rec), remaining))
      else expire(rec)
    }
  }

  return { handleRequest, decide, cancel, listRecent, pickSource: pickSourceStub, confirmUpload: confirmUploadStub, reconnect, shutdown, getRecord }
}
