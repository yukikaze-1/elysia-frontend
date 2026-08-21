// src/main/diagnostics/diagnostics-service.ts
// 阶段 7 批次 A（spec §6.3/§6.4）：诊断服务骨架——getState/setDevMode/dispose + devTap
// （协议事件 → {ts,type,preview} ring 200 FIFO + 100ms 节流 push + devMode 门控 + 回调体异常隔离）。
// Task 3 交付边界：openLogDir/clearLogs/exportPackage 由 Task 4 补齐（本 task 不在接口中——避免桩，F-05）。
// 装配注入（F-08 定案）：adapter 经 deps 传入、service 构造期即 subscribe（无 attachAdapter 方法）；
// devTap 回调体 try/catch 异常隔离（R2-3/安全 LOW①——real emit 无兜底，devTap 抛错即断聊天事件流）。
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { Auditor } from './audit'
import type { FileWriter } from './file-writer'
import type { Logger } from './logger'
import type { MessageSanitizer } from './sanitize'
import { redactSensitiveValues } from './redact'
import type { BackendAdapter } from '../transport/backend-adapter'
import type { BackendEvent } from '@shared/contracts/events'
import { DIAGNOSTICS_PREVIEW_MAX, type DiagnosticsDevEvent, type DiagnosticsState } from '@shared/contracts/diagnostics'

/** dev-event ring 容量（D7A-15：ring 200 FIFO——Main 侧全量保留；推送层另有 100ms 节流） */
const RING_SIZE = 200
/** 推送节流窗口（ms，D7A-15/安全 M-5）：距上次推送 ≤ 窗口的事件仅入 ring 不推送，dropped 累计随 state 返回） */
const PUSH_THROTTLE_MS = 100
/** 日志保留（轮转份数：app.log + .1 + .2 共 3 份，getState 展示「5MB×3」——契约字段沿用 retentionDays 命名） */
const LOG_RETENTION_FILES = 3
/** 审计保留天数（与 createDiagnostics 装配值同源 30 天） */
const AUDIT_RETENTION_DAYS = 30
/** 日志文件名形态（app.log / app.log.1 / app.log.2） */
const LOG_FILE_NAME_RE = /\.log(?:\.\d+)?$/
/** preview 元数据字段白名单（D7A-15/安全复核：绝不含 text/content/arguments 序列化——原始内容/参数
 *  永不进 Renderer）。仅标识/枚举/计数类字段；文本类事件以派生 textLen/contentLen 计数呈现（「长度计数」口径）。 */
const PREVIEW_FIELDS = [
  'generationId', 'messageId', 'responseId', 'conversationId',
  'segmentId', 'segmentIndex', 'channel', 'kind',
  'model', 'emotion', 'finishReason', 'service', 'voice', 'ok', 'success', 'reason', 'errorType', 'durationMs',
  'streamId', 'turnId', 'sessionId', 'recordingId', 'seq', 'priority',
  'runtime', 'callId', 'sourceCallId', 'toolName', 'toolVersion', 'requestId', 'expiresAt',
  'expression', 'motion',
] as const

export interface DiagnosticsService {
  getState(): DiagnosticsState
  setDevMode(enabled: boolean): void
  dispose(): void
  // Task 4 补齐（FileWriter.clear 就位后——避免 NOT_IMPLEMENTED 桩）：
  // openLogDir(): void / clearLogs(): Promise<void> / exportPackage(): Promise<DiagnosticsExportResult>
}

/** 日志目录文件清单 + 总大小（sync——getState 为同步接口；目录缺失/权限异常 → 空清单兜底，不阻塞展示面） */
function readLogDirInfo(dir: string): { logSizeBytes: number; logFiles: DiagnosticsState['logFiles'] } {
  try {
    const names = readdirSync(dir)
    const files = names
      .filter((n) => LOG_FILE_NAME_RE.test(n))
      .map((n) => {
        try {
          const st = statSync(join(dir, n))
          return { name: n, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() }
        } catch { return undefined }
      })
      .filter((f): f is { name: string; sizeBytes: number; modifiedAt: string } => f !== undefined)
      .sort((a, b) => (a.name > b.name ? 1 : -1))
    return { logSizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0), logFiles: files }
  } catch {
    return { logSizeBytes: 0, logFiles: [] }
  }
}

export function createDiagnosticsService(deps: {
  dirs: { logs: string; audit: string; temp: string }
  logger: Logger
  auditor: Auditor
  logWriter: FileWriter
  sanitize: MessageSanitizer
  adapter: BackendAdapter            // 事件源（spec §6.3 deps 注入式——装配时序：index.ts 先 adapter 后 service；无 attachAdapter 方法——符合性 F-08 定案）
  openPath?: (dir: string) => Promise<string>   // 默认 shell.openPath；测试注入（Task 4 openLogDir 消费）
  getConnectionSummary: () => { origin?: string; status?: string; protocolVersion?: string }
  onDevEvent?: (ev: DiagnosticsDevEvent) => void        // push 出口（Task 5 接线 webContents.send）
  onDevModeChange?: (enabled: boolean) => void          // 副作用出口（Task 5 接线 openDevTools/closeDevTools——spec §6.4）
  now?: () => number                                     // 测试注入
}): DiagnosticsService {
  let devMode = false // D7A-05：会话态（Main 内存；不写 settings.json——重启恢复禁用）
  let dropped = 0 // 推送节流丢弃计数（ring 全量保留；随 state.eventDropped 返回）
  let lastPushAt = -Infinity
  const lastCleanup: DiagnosticsState['lastCleanup'] = null // Task 4 clearLogs 结果回显（届时改 let 并赋值）
  const ring: DiagnosticsDevEvent[] = []
  const now = deps.now ?? (() => Date.now())
  const sanitize = deps.sanitize

  /** preview：白名单字段拼接 → sanitize + redact 双净化 → 截断 ≤200 含尾标（先截 199 再补「…」） */
  const makePreview = (ev: BackendEvent): string => {
    const rec = ev as unknown as Record<string, unknown>
    const parts: string[] = []
    for (const field of PREVIEW_FIELDS) {
      const v = rec[field]
      // 白名单外字段（text/content/arguments 等）经此永不进入预览（宁缺毋滥——安全复核 M-5）
      if (typeof v === 'string' || typeof v === 'number') parts.push(`${field}=${v}`)
    }
    // 派生长度计数（零正文）：敏感正文只呈现长度，绝不呈现内容
    if (typeof rec.text === 'string') parts.push(`textLen=${rec.text.length}`)
    if (typeof rec.content === 'string') parts.push(`contentLen=${rec.content.length}`)
    const cleaned = redactSensitiveValues(sanitize(parts.join(';')))
    return cleaned.length >= DIAGNOSTICS_PREVIEW_MAX
      ? cleaned.slice(0, DIAGNOSTICS_PREVIEW_MAX - 1) + '…'
      : cleaned
  }

  /** 推送节流：距上次推送 ≤ PUSH_THROTTLE_MS 则 dropped++ 不推（ring 全量保留） */
  const enqueuePush = (entry: DiagnosticsDevEvent): void => {
    const t = now()
    if (t - lastPushAt < PUSH_THROTTLE_MS) { dropped++; return }
    lastPushAt = t
    deps.onDevEvent?.(entry)
  }

  /** 协议事件 tap：仅 devMode=true 时入 ring + 推送（门控——关闭即停，完整性 MED）；回调体异常隔离（M-6） */
  const devTap = (ev: BackendEvent): void => {
    try {
      if (!devMode) return
      const entry: DiagnosticsDevEvent = { ts: new Date(now()).toISOString(), type: ev.event, preview: makePreview(ev) }
      ring.push(entry)
      if (ring.length > RING_SIZE) ring.shift() // 200 FIFO
      enqueuePush(entry)
    } catch (err) {
      deps.logger.warn('diagnostics:dev-event-error', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  const unsubscribe = deps.adapter.subscribe(devTap) // 构造期订阅（F-08：事件源经 deps 注入；dispose 退订）

  const setDevMode = (enabled: boolean): void => {
    if (enabled === devMode) return // 幂等：同值 no-op 不重复审计（spec §6.2 错误面）
    devMode = enabled
    deps.onDevModeChange?.(enabled) // 副作用出口（Task 5 接线 openDevTools/closeDevTools）
    // 审计 dev:mode-changed（ts 必填——AuditEvent 形状以 audit.ts 为准；fail-open：fire-and-forget + 失败仅日志）
    void deps.auditor.audit({
      ts: new Date(now()).toISOString(),
      type: 'dev:mode-changed',
      summary: `开发者模式已${enabled ? '开启' : '关闭'}`,
    }).catch((err) => deps.logger.warn('diagnostics:audit-write-failed', { message: err instanceof Error ? err.message : String(err) }))
  }

  return {
    getState: (): DiagnosticsState => {
      const info = readLogDirInfo(deps.dirs.logs)
      return {
        devMode,
        // displayDir 为 sanitize 后展示形态——绝对路径不上行（安全复核 M-2；打开/清理用 Main 内部 dirs）
        displayDir: sanitize(deps.dirs.logs),
        logSizeBytes: info.logSizeBytes,
        logFiles: info.logFiles,
        retentionDays: LOG_RETENTION_FILES,
        auditRetentionDays: AUDIT_RETENTION_DAYS,
        eventDropped: dropped,
        lastCleanup,
      }
    },
    setDevMode,
    dispose: () => { unsubscribe() },
  }
}
