// src/main/diagnostics/diagnostics-service.ts
// 阶段 7 批次 A（spec §6.3/§6.4）：诊断服务骨架——getState/setDevMode/dispose + devTap
// （协议事件 → {ts,type,preview} ring 200 FIFO + 100ms 节流 push + devMode 门控 + 回调体异常隔离）。
// Task 3 交付边界：openLogDir/clearLogs/exportPackage 由 Task 4 补齐（本 task 不在接口中——避免桩，F-05）。
// 装配注入（F-08 定案）：后端事件源经 deps 传入、service 构造期即 subscribe（无 attachAdapter 方法）；
// devTap 回调体 try/catch 异常隔离（R2-3/安全 LOW①——real emit 无兜底，devTap 抛错即断聊天事件流）。
import { readdirSync, statSync } from 'fs'
import { readdir, readFile, realpath, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { defaultDialogService, type DialogPort } from '../native-ui/dialog-service'   // 原生保存对话框统一入口（silent 测试模式不弹窗；harness 下另有固定临时路径分支）
import { atomicWriteFile } from '../credentials/atomic-write'
import { auditFilesToDelete } from './audit'
import { buildExportPayload, readTailLines, tailLinesAligned } from './export-payload'
import type { ExportLogFile } from './export-payload'
import type { Auditor } from './audit'
import type { FileWriter } from './file-writer'
import type { Logger } from './logger'
import type { MessageSanitizer } from './sanitize'
import { redactSensitiveValues } from './redact'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { BackendEventSourcePort } from '../transport/backend-ports'
import type { BackendEvent } from '@shared/contracts/events'
import type { DiagnosticsExportResult } from '@shared/contracts/diagnostics'
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

/** 导出：日志每文件尾读取上限（D7A-08：5MiB/文件，行对齐） */
const EXPORT_LOG_TAIL_MAX = 5 * 1024 * 1024
/** 导出：审计段总上限（D7A-08：超 15MiB 截尾保最新端） */
const EXPORT_AUDIT_TAIL_MAX = 15 * 1024 * 1024
/** 导出：日志文件数上限（D7A-08：≤3 旋转文件——app.log+.1+.2） */
const EXPORT_LOG_FILES_MAX = 3
/** 导出（harness 落盘文件名——集成/冒烟断言点） */
const EXPORT_HARNESS_FILE = 'cyrene-diagnose-test.json'
/** 审计日期文件名（30 天窗口过滤——与 audit.ts AUDIT_DATE_RE 同形；此层直读全量不用 readAuditEvents 的过滤） */
const AUDIT_NAME_RE = /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/

export interface DiagnosticsService {
  getState(): DiagnosticsState
  setDevMode(enabled: boolean): void
  dispose(): void
  /** 打开日志目录（系统文件管理器）——deps.openPath 注入（默认 shell.openPath） */
  openLogDir(): Promise<void>
  /** 清空日志（logWriter.clear + 审计 diagnostics:logs-cleared + lastCleanup 回显） */
  clearLogs(): Promise<void>
  /** 脱敏诊断导出（收集/组包/落盘/审计——harness 落 temp，正常态经保存对话框） */
  exportPackage(): Promise<DiagnosticsExportResult>
}

/** F-C1（D7A-08 manifest 上下文溯源字段）：装配层注入的 app 信息（app.getVersion/isPackaged/process.versions+/config.mode） */
export interface DiagnosticsAppInfo {
  appName: string
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  os: string
  packaged: boolean
  mode: string
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

/** 导出日志收集：*.log 按 mtime 取最新 ≤3 文件，每文件 readTailLines 5MiB（行对齐）；
 *  truncated = 文件数超上限 或 任一选中文件超 5MiB（尾读丢失旧内容）。读取失败（竞态已删）跳过不阻塞。 */
async function collectLogFiles(deps: { logs: string; logger: Logger }): Promise<{ files: ExportLogFile[]; truncated: boolean }> {
  let names: string[]
  try { names = await readdir(deps.logs) } catch { return { files: [], truncated: false } }
  const withStat = await Promise.all(
    names
      .filter((n) => LOG_FILE_NAME_RE.test(n))
      .map(async (n) => {
        try { const s = await stat(join(deps.logs, n)); return { name: n, mtimeMs: s.mtimeMs, sizeBytes: s.size } }
        catch { return undefined }
      }),
  )
  const all = withStat.filter((f): f is { name: string; mtimeMs: number; sizeBytes: number } => f !== undefined)
  const truncatedCount = all.length > EXPORT_LOG_FILES_MAX
  // 最新 3 个轮转文件（mtime 降序取 3）→ payload 内按文件名升序（app.log → .1 → .2 可读序）
  const selected = all
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, EXPORT_LOG_FILES_MAX)
    .sort((a, b) => (a.name > b.name ? 1 : -1))
  const files: ExportLogFile[] = []
  let maxTailExceeded = false
  for (const f of selected) {
    if (f.sizeBytes > EXPORT_LOG_TAIL_MAX) maxTailExceeded = true // 尾读只覆盖尾 5MiB → 旧内容不入包
    try {
      files.push({ name: f.name, lines: await readTailLines(join(deps.logs, f.name), EXPORT_LOG_TAIL_MAX) })
    } catch (err) {
      deps.logger.warn('diagnostics:export-skip-file', { name: f.name, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { files, truncated: truncatedCount || maxTailExceeded }
}

/** 导出审计收集：直读 audit-*.jsonl 30 天窗口内全量（不用 readAuditEvents——导出必须含全部审计类型），
 *  总长超 15MiB 截尾保最新端（truncatedAudit）。 */
async function collectAuditLines(auditDir: string, today: Date, logger: Logger): Promise<{ lines: string[]; truncatedAudit: boolean }> {
  let names: string[]
  try { names = await readdir(auditDir) } catch { return { lines: [], truncatedAudit: false } }
  const dateNames = names.filter((n) => AUDIT_NAME_RE.test(n))
  const toDelete = new Set(auditFilesToDelete(dateNames, AUDIT_RETENTION_DAYS, today))
  const keep = dateNames.filter((n) => !toDelete.has(n)).sort() // 文件名序 = 日期序（chrono）
  const allLines: string[] = []
  for (const n of keep) {
    try {
      const text = await readFile(join(auditDir, n), 'utf8')
      const ls = text.split('\n')
      if (ls.length > 0 && ls[ls.length - 1] === '') ls.pop()
      allLines.push(...ls)
    } catch (err) {
      logger.warn('diagnostics:export-skip-audit', { name: n, message: err instanceof Error ? err.message : String(err) })
    }
  }
  const t = tailLinesAligned(allLines, EXPORT_AUDIT_TAIL_MAX)
  return { lines: t.lines, truncatedAudit: t.dropped }
}

export function createDiagnosticsService(deps: {
  dirs: { logs: string; audit: string; temp: string }
  logger: Logger
  auditor: Auditor
  logWriter: FileWriter
  sanitize: MessageSanitizer
  events: BackendEventSourcePort         // 事件源（spec §6.3 deps 注入式——装配时序：组合根先建适配器后建 service；无 attachAdapter 方法——符合性 F-08 定案）；本服务只用 subscribe 一项能力
  openPath?: (dir: string) => Promise<string>   // 默认 shell.openPath；测试注入（openLogDir 消费）
  dialogs?: DialogPort                           // 原生保存对话框（诊断包导出）；缺省取统一入口单例
  getMainWindow?: () => BrowserWindow | undefined  // 导出保存对话框父窗（Task 5 接线；缺省/undefined → 无父对话框）
  getConnectionSummary: () => { origin?: string; status?: string; protocolVersion?: string }
  onDevEvent?: (ev: DiagnosticsDevEvent) => void        // push 出口（Task 5 接线 webContents.send）
  onDevModeChange?: (enabled: boolean) => void          // 副作用出口（Task 5 接线 openDevTools/closeDevTools——spec §6.4）
  appInfo: () => DiagnosticsAppInfo                     // F-C1（Task 5 收口）：导出 manifest 上下文字段（D7A-08）
  now?: () => number                                     // 测试注入
}): DiagnosticsService {
  let devMode = false // D7A-05：会话态（Main 内存；不写 settings.json——重启恢复禁用）
  let dropped = 0 // 推送节流丢弃计数（ring 全量保留；随 state.eventDropped 返回）
  let lastPushAt = -Infinity
  let lastCleanup: DiagnosticsState['lastCleanup'] = null // 清日志结果（clearLogs 赋值；Task 4）
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

  const unsubscribe = deps.events.subscribe(devTap) // 构造期订阅（F-08：事件源经 deps 注入；dispose 退订）

  /** 审计 fail-open（C1 同口：审计失败不改变操作结果——fire-and-forget + 失败仅日志） */
  const auditFailOpen = (event: Parameters<Auditor['audit']>[0]): void => {
    void deps.auditor.audit(event).catch((err) =>
      deps.logger.warn('diagnostics:audit-write-failed', { message: err instanceof Error ? err.message : String(err) }))
  }

  const setDevMode = (enabled: boolean): void => {
    if (enabled === devMode) return // 幂等：同值 no-op 不重复审计（spec §6.2 错误面）
    devMode = enabled
    deps.onDevModeChange?.(enabled) // 副作用出口（Task 5 接线 openDevTools/closeDevTools）
    // 审计 dev:mode-changed（ts 必填——AuditEvent 形状以 audit.ts 为准；fail-open）
    auditFailOpen({ ts: new Date(now()).toISOString(), type: 'dev:mode-changed', summary: `开发者模式已${enabled ? '开启' : '关闭'}` })
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
    async openLogDir(): Promise<void> {
      // 默认 shell.openPath（Main 侧系统文件管理器）；测试注入 deps.openPath
      const open = deps.openPath ?? ((dir: string) => shell.openPath(dir))
      const msg = await open(deps.dirs.logs)
      if (msg && msg.length > 0) deps.logger.warn('diagnostics:open-logs-failed', { message: msg })
    },
    async clearLogs(): Promise<void> {
      const r = await deps.logWriter.clear() // 串行队列语义在 FileWriter 内（clear 与 append 不绕过）
      lastCleanup = { removedFiles: r.removedFiles, freedBytes: r.freedBytes }
      auditFailOpen({
        ts: new Date(now()).toISOString(),
        type: 'diagnostics:logs-cleared',
        summary: `日志已清理（移除 ${r.removedFiles} 个轮转文件，释放 ${r.freedBytes} 字节）`,
      })
    },
    async exportPackage(): Promise<DiagnosticsExportResult> {
      try {
        // ① 收集：日志尾读（≤3 文件 × 5MiB 行对齐）+ 审计直读（30 天窗口全量，超 15MiB 截尾保最新端）
        const logs = await collectLogFiles({ logs: deps.dirs.logs, logger: deps.logger })
        const auditColl = await collectAuditLines(deps.dirs.audit, new Date(now()), deps.logger)
        // ② 组包（逐行二次脱敏在 build 内——D7A-09；manifest 上下文溯源字段经 appInfo 注入——F-C1/D7A-08）
        const info = deps.appInfo()
        const exportedAt = new Date(now()).toISOString()
        const payload = buildExportPayload(
          {
            manifest: {
              schemaVersion: 1,
              generatedAt: exportedAt,
              exportedAt,
              appName: info.appName,
              appVersion: info.appVersion,
              electron: info.electron,
              chrome: info.chrome,
              node: info.node,
              platform: info.platform,
              arch: info.arch,
              os: info.os,
              packaged: info.packaged,
              mode: info.mode,
            },
            summary: deps.getConnectionSummary(),
            logFiles: logs.files,
            auditLines: auditColl.lines,
            truncatedLog: logs.truncated,
            truncatedAudit: auditColl.truncatedAudit,
          },
          { sanitize },
        )
        const json = JSON.stringify(payload, null, 2)
        // ③ 落盘：harness（CYRENE_TEST_HARNESS=1）→ dirs.temp 固定名；正常 → 保存对话框（win 可缺省无父）
        let targetPath: string
        if (process.env.CYRENE_TEST_HARNESS === '1') {
          targetPath = join(deps.dirs.temp, EXPORT_HARNESS_FILE)
        } else {
          const win = deps.getMainWindow?.()
          const opts = {
            defaultPath: `cyrene-diagnose-${stampFileName(new Date(now()))}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          }
          const r = await (deps.dialogs ?? defaultDialogService()).showSaveDialog(win, opts)
          if (r.canceled || !r.filePath) return { cancelled: true }
          targetPath = r.filePath
        }
        const sizeBytes = Buffer.byteLength(json, 'utf8')
        // 原子写（凭据同族先例）：safeRoot = 目标父目录自身（对话框任意用户目录也满足父目录包含性——准确性 H-4）
        await atomicWriteFile(targetPath, json, { safeRoot: await realpath(dirname(targetPath)) })
        // ④ 审计 diagnostics:exported（ts 必填、无路径——披露只含大小/截断；fail-open）
        auditFailOpen({
          ts: new Date(now()).toISOString(),
          type: 'diagnostics:exported',
          summary: `诊断包已导出（${sizeBytes} 字节${payload.manifest.truncated ? '，部分数据截断' : ''}）`,
        })
        // ⑤ 结果回显：displayPath 为实际路径（R2-7 不 sanitize——用户对话框自选路径；sanitize 仅 displayDir 形态）
        return {
          cancelled: false,
          displayPath: targetPath,
          sizeBytes,
          truncatedLog: payload.manifest.truncatedLog,
          truncatedAudit: payload.manifest.truncatedAudit,
        }
      } catch (err) {
        // fail-closed：writeFile/收集异常 → CyreneError（不产出半成品文件）
        deps.logger.error('diagnostics:export-failed', { message: err instanceof Error ? err.message : String(err) })
        throw new CyreneError(CyreneErrorCode.UNKNOWN, '诊断导出失败', err)
      }
    },
    dispose: () => { unsubscribe() },
  }
}

/** 对话框默认文件名时间戳：YYYYMMDD-HHmmss（本地时间） */
function stampFileName(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
