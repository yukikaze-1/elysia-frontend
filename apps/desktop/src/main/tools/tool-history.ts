// src/main/tools/tool-history.ts
// 阶段 6 批次 C（D6C-08）：审批历史只读回读——audit JSONL 逐行 parse，过滤 tool:* / grant:*。
// 同步实现（brief 修正）：spec 用例不经 await 直取数组（Step 1 测试即契约）；上限 HISTORY_MAX 行 × ≤7 文件，读面有界；
// Task 6 handler 可直接 return（ipcMain.handle 接受同步返回值）或 await（对数组 await 为 no-op），两向兼容。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryEntry } from '@shared/contracts/tool'   // Task 6 类型镜像：契约类型上移 shared，preload/renderer 共用
export type { HistoryEntry }

// F-4：天数边界——读面「审批历史在设置页看最近 7 天」是产品语义；存面（audit-*.jsonl 磁盘保留 30 天、
// diagnostics-service.ts AUDIT_RETENTION_DAYS=30）是审计合规。两者目的不同，不拉平（7D D7D-02）。
export const HISTORY_DAYS = 7
// 合并结果总量上限（逐文件流式读满即停）
export const HISTORY_MAX = 200

const AUDIT_DATE_RE = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export function readAuditEvents(dir: string, opts: { limit?: number; days?: number } = {}, logger?: { warn(msg: string, extra?: Record<string, unknown>): void }): HistoryEntry[] {
  const limit = Math.min(opts.limit ?? HISTORY_MAX, HISTORY_MAX)
  const days = opts.days ?? HISTORY_DAYS
  let files: string[]
  try { files = readdirSync(dir).filter((f) => AUDIT_DATE_RE.test(f)).sort().reverse() }   // 文件名倒序（日期新→旧）
  catch { return [] }   // 目录不存在 → 空态（不阻塞设置页，fail-open）
  const cutoff = Date.now() - days * 86_400_000
  /** 保序插入缓冲：文件内按**时间倒序**取（新→旧），整批取满后再按 ts 倒序输出。
   *
   *  **为什么要缓冲（2026-09-15 修，代码侧疑点 2）**：原实现「读满 `limit` 即停」+ 末尾 ts 倒序切片
   *  ⇒ 当日文件里**从头**（=当天最早）收集到 `limit` 条就停，再排序只是把这 N 条陈旧条目内部排好序。
   *  结果：设置页审批历史显示的是「当日最早的 200 条」而不是「最近的 200 条」——跨天尚可（文件名倒序，
   *  新的一天先读），**单日超过 200 条时完全错**。
   *
   *  现在的形状：逐文件（文件名倒序 = 日期新→旧）、文件内**逐行倒序**（当天新→旧）收集，
   *  `limit` 只束缚**总量**；末尾的 ts 倒序排序因此对「保留下来的就是最新 N 条」这一步是幂等的。
   *  代价：单文件会整份读入（原先也是 `readFileSync` 整份读，只是提前 return）——读面仍有界（≤7 文件）。 */
  const newestFirst: HistoryEntry[] = []
  let stopped = false
  for (const file of files) {
    if (stopped) break
    const [, y, m, d] = file.match(AUDIT_DATE_RE)!
    const dayMs = new Date(`${y}-${m}-${d}T00:00:00Z`).getTime()
    if (dayMs < cutoff) continue   // 超 HISTORY_DAYS 边界
    let text: string
    try { text = readFileSync(join(dir, file), 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (newestFirst.length >= limit) { stopped = true; break }   // 取满即停：此时手里的已是最新 N 条
      const line = lines[i]
      if (!line.trim()) continue
      let raw: Record<string, unknown>
      try { raw = JSON.parse(line) as Record<string, unknown> } catch {
        logger?.warn('history:broken-line', { file })   // spec §3.4：损坏行跳过不崩溃（logger.warn）
        continue
      }
      if (typeof raw.type !== 'string' || !(raw.type.startsWith('tool:') || raw.type.startsWith('grant:'))) continue
      newestFirst.push({
        ts: typeof raw.ts === 'string' ? raw.ts : '', type: raw.type,
        callId: str(raw.callId), toolId: str(raw.toolId), status: str(raw.status),
        permissionDecision: str(raw.permissionDecision), permissionGrantId: str(raw.permissionGrantId),
        backendIdentity: str(raw.backendIdentity), riskLevel: str(raw.riskLevel),
        cancelSource: str(raw.cancelSource), errorCode: str(raw.errorCode), summary: str(raw.summary),
        toolName: str(raw.toolName),
      })
    }
  }
  return newestFirst.sort((a, b) => b.ts.localeCompare(a.ts))   // ts 倒序（保留的就是最新 N 条，排序不改成员）
}
function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined }
