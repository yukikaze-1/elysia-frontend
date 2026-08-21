// src/main/diagnostics/export-payload.ts
// 阶段 7 批次 A（Task 4，spec §6.5/D7A-02/08/09/10）：诊断导出 payload 纯函数——
// readTailLines（行对齐尾部读取）+ tailLinesAligned（整集合截尾保最新端）+ buildExportPayload
// （逐行 sanitize+redact 二次脱敏 / >1MiB 行整行丢弃打标记 / 截断标志 / 双段 sha256）。
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { realpath } from 'node:fs/promises'
import { openSafeFile } from '../persistence/safe-open'
import { redactSensitiveValues } from './redact'
import type { MessageSanitizer } from './sanitize'

/** 超长单行阈值（>1MiB 整行丢弃——防 token 残段/超大行入包；安全复核①） */
export const EXPORT_MAX_LINE_BYTES = 1024 * 1024
/** 超长行丢弃处的位置标记（整行替换——行对齐保持，解析器不脱行） */
export const EXPORT_LINE_TOO_LONG = '<line-too-long-truncated>'

/** 导出一段（审计段）整集合截尾：从尾部累积不超过 maxBytes 的完整行（新端保留），返回丢弃标志 */
export function tailLinesAligned(lines: readonly string[], maxBytes: number): { lines: string[]; dropped: boolean } {
  let total = 0
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = Buffer.byteLength(lines[i], 'utf8') + 1 // +1 = 行分隔符
    if (total + n > maxBytes) break
    total += n
    start = i
  }
  return { lines: lines.slice(start), dropped: start > 0 }
}

/**
 * 行对齐尾部读取（spec §6.5/D7A-08）：只读文件尾部 maxBytes——
 * open + fstat + read(start=max(0,size-maxBytes)) → 按 \n 切 →
 * 首段若为截断中间行（起始偏移非 0 且前一字节非换行）则丢 → 尾随换行空段丢。
 * 安全路径：openSafeFile（existing+read——拒符号链接/非普通文件/权限位异常/逃逸 safeRoot）。
 * >1MiB 行的整行丢弃在 buildExportPayload 层（计数可观测——本函数返回 string[] 契约）。
 */
export async function readTailLines(file: string, maxBytes: number): Promise<string[]> {
  const safeRoot = await realpath(dirname(file)).catch(() => dirname(file))
  const { fd } = await openSafeFile(file, { mode: 'existing', purpose: 'read', safeRoot, onConflict: 'fallback' })
  try {
    const st = await fd.stat()
    const size = st.size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.allocUnsafe(size - start)
    let bytesRead = 0
    while (bytesRead < buf.length) {
      const r = await fd.read(buf, bytesRead, buf.length - bytesRead, start + bytesRead)
      if (r.bytesRead <= 0) break // EOF 提前（正常读完）
      bytesRead += r.bytesRead
    }
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop() // 尾随换行空段
    // 行对齐：起始偏移非 0 且起始前一字节非 '\n' → 首段为截断中间行 → 丢（回读 1 字节探针）
    if (start > 0 && lines.length > 0) {
      const probe = Buffer.allocUnsafe(1)
      const r = await fd.read(probe, 0, 1, start - 1)
      if (r.bytesRead === 0 || probe[0] !== 0x0a) lines.shift()
    }
    return lines
  } finally {
    await fd.close()
  }
}

export interface ExportManifestInput {
  schemaVersion: 1
  generatedAt?: string
  // D7A-08/F-C1（Task 4 review MED，Task 5 收口）：manifest 上下文溯源字段（装配层 appInfo 注入——
  // appName/version/electron/chrome/node/platform/arch/os/exportedAt/packaged/mode；缺失不落键、字符串经双净化）
  appName?: string
  appVersion?: string
  platform?: string
  electron?: string
  chrome?: string
  node?: string
  arch?: string
  os?: string
  exportedAt?: string
  packaged?: boolean
  mode?: string
}
export interface ExportLogFile { name: string; lines: string[] }
export type ExportSummary = Record<string, unknown>

export interface ExportPayloadInput {
  manifest: ExportManifestInput
  summary: ExportSummary
  logFiles: ExportLogFile[]
  auditLines: string[]
  /** 日志段截断（尾读超限/文件数超限等——collection 层计算） */
  truncatedLog: boolean
  truncatedAudit: boolean
}

export interface ExportPayloadDoc {
  schemaVersion: 1
  manifest: {
    schemaVersion: 1
    truncated: boolean
    truncatedLog: boolean
    truncatedAudit: boolean
    /** >1MiB 整行丢弃计数（log+audit 合计） */
    droppedLines: number
    logSha256: string
    auditSha256: string
    // D7A-08/F-C1：上下文溯源字段（可选——装配注入 appInfo 后经此落包；字符串双净化、缺失不落键）
    generatedAt?: string
    exportedAt?: string
    appName?: string
    appVersion?: string
    platform?: string
    electron?: string
    chrome?: string
    node?: string
    arch?: string
    os?: string
    packaged?: boolean
    mode?: string
  }
  summary: ExportSummary
  logFiles: ExportLogFile[]
  audit: string[]
  /** sha256(JSON.stringify(净化后 logFiles 段))——确定性（JSON.stringify 键序稳定） */
  logSha256: string
  auditSha256: string
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 逐行净化：>1MiB 整行丢弃（标记替换 + 计数）；其余 sanitize→redact 双净化 */
function cleanLines(lines: readonly string[], sanitize: MessageSanitizer): { lines: string[]; dropped: number } {
  const out: string[] = []
  let dropped = 0
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > EXPORT_MAX_LINE_BYTES) {
      out.push(EXPORT_LINE_TOO_LONG)
      dropped++
      continue
    }
    out.push(redactSensitiveValues(sanitize(line)))
  }
  return { lines: out, dropped }
}

/**
 * 组包（D7A-02 单 JSON）：逐行二次脱敏 → 双段 sha256（node:crypto）→ manifest 标志
 * （schemaVersion:1 / truncated 聚合 / droppedLines / 双段 sha——与本 doc 顶层 keys 同值，兼容双读面）。
 * sanitize 缺省恒等（root 相关净化由 service 注入——纯函数自行以注入形态脱敏）。
 */
export function buildExportPayload(input: ExportPayloadInput, opts?: { sanitize?: MessageSanitizer }): ExportPayloadDoc {
  const sanitize = opts?.sanitize ?? ((s: string) => s)
  let logDropped = 0
  const logFiles: ExportLogFile[] = input.logFiles.map((f) => {
    const cleaned = cleanLines(f.lines, sanitize)
    logDropped += cleaned.dropped
    return { name: redactSensitiveValues(sanitize(f.name)), lines: cleaned.lines }
  })
  const audit = cleanLines(input.auditLines, sanitize)
  const summary: ExportSummary = {}
  for (const [k, v] of Object.entries(input.summary)) {
    summary[k] = typeof v === 'string' ? redactSensitiveValues(sanitize(v)) : v
  }
  // 段内超长行丢弃计入对应段截断标志（D7A-09：>1MiB 行丢弃亦为「数据不完整」）
  const effectiveTruncatedLog = input.truncatedLog || logDropped > 0
  const effectiveTruncatedAudit = input.truncatedAudit || audit.dropped > 0
  const logSha256 = sha256Hex(JSON.stringify(logFiles))
  const auditSha256 = sha256Hex(JSON.stringify(audit.lines))
  // D7A-08/F-C1：上下文溯源字段逐项透传（字符串经 sanitize+redact 双净化；undefined 不落键——JSON.stringify 省略）
  const man = input.manifest
  const ctxText = (v?: string): string | undefined => (v === undefined ? undefined : redactSensitiveValues(sanitize(v)))
  return {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      truncated: effectiveTruncatedLog || effectiveTruncatedAudit,
      truncatedLog: effectiveTruncatedLog,
      truncatedAudit: effectiveTruncatedAudit,
      droppedLines: logDropped + audit.dropped,
      logSha256,
      auditSha256,
      generatedAt: ctxText(man.generatedAt),
      exportedAt: ctxText(man.exportedAt),
      appName: ctxText(man.appName),
      appVersion: ctxText(man.appVersion),
      electron: ctxText(man.electron),
      chrome: ctxText(man.chrome),
      node: ctxText(man.node),
      platform: ctxText(man.platform),
      arch: ctxText(man.arch),
      os: ctxText(man.os),
      packaged: man.packaged,
      mode: ctxText(man.mode),
    },
    summary,
    logFiles,
    audit: audit.lines,
    logSha256,
    auditSha256,
  }
}
