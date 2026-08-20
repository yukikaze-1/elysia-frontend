// src/main/tools/tool-history.ts
// 阶段 6 批次 C（D6C-08）：审批历史只读回读——audit JSONL 逐行 parse，过滤 tool:* / grant:*。
// 同步实现（brief 修正）：spec 用例不经 await 直取数组（Step 1 测试即契约）；上限 HISTORY_MAX 行 × ≤7 文件，读面有界；
// Task 6 handler 可直接 return（ipcMain.handle 接受同步返回值）或 await（对数组 await 为 no-op），两向兼容。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const HISTORY_DAYS = 7        // F-4：天数边界（readdir 按文件名倒序取最近 N 天）
export const HISTORY_MAX = 200       // 合并结果总量上限（逐文件流式读满即停）

const AUDIT_DATE_RE = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export interface HistoryEntry {
  ts: string; type: string; callId?: string; toolId?: string; status?: string
  permissionDecision?: string; permissionGrantId?: string; backendIdentity?: string
  riskLevel?: string; cancelSource?: string; errorCode?: string; summary?: string
  toolName?: string   // 契约 F-5：AuditEvent 扩展后回读携带
}

export function readAuditEvents(dir: string, opts: { limit?: number; days?: number } = {}): HistoryEntry[] {
  const limit = Math.min(opts.limit ?? HISTORY_MAX, HISTORY_MAX)
  const days = opts.days ?? HISTORY_DAYS
  let files: string[]
  try { files = readdirSync(dir).filter((f) => AUDIT_DATE_RE.test(f)).sort().reverse() }   // 文件名倒序（日期新→旧）
  catch { return [] }   // 目录不存在 → 空态（不阻塞设置页，fail-open）
  const cutoff = Date.now() - days * 86_400_000
  const entries: HistoryEntry[] = []
  for (const file of files) {
    if (entries.length >= limit) break
    const [, y, m, d] = file.match(AUDIT_DATE_RE)!
    const dayMs = new Date(`${y}-${m}-${d}T00:00:00Z`).getTime()
    if (dayMs < cutoff) continue   // 超 HISTORY_DAYS 边界
    let text: string
    try { text = readFileSync(join(dir, file), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (entries.length >= limit) break
      if (!line.trim()) continue
      let raw: Record<string, unknown>
      try { raw = JSON.parse(line) as Record<string, unknown> } catch { continue }   // 损坏行跳过不崩溃
      if (typeof raw.type !== 'string' || !(raw.type.startsWith('tool:') || raw.type.startsWith('grant:'))) continue
      entries.push({
        ts: typeof raw.ts === 'string' ? raw.ts : '', type: raw.type,
        callId: str(raw.callId), toolId: str(raw.toolId), status: str(raw.status),
        permissionDecision: str(raw.permissionDecision), permissionGrantId: str(raw.permissionGrantId),
        backendIdentity: str(raw.backendIdentity), riskLevel: str(raw.riskLevel),
        cancelSource: str(raw.cancelSource), errorCode: str(raw.errorCode), summary: str(raw.summary),
        toolName: str(raw.toolName),
      })
    }
  }
  return entries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit)   // ts 倒序
}
function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined }
