// src/main/persistence/corrupt-isolation.ts —— Task 5: 缓存损坏统一层骨架。
// 契约：M-3 复用真实 Logger 接口；M-4/HIGH-1 `.corrupt-<tag>-<ts>` 隔离 + pruneCorrupt 有界保留（只留最新一份）。
// 纪律：isolate 隔离保留现场（rename 后原文件消失，后续写入不污染）；countDiagnostic 计数（调用方不再重复计）。
// 跨平台修正：pruneCorrupt 用 node:path 的 dirname/basename 替代 brief 的 lastIndexOf('/')（后者在 Windows 反斜杠路径下失效）。
import { rename, readdir, unlink } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { dirname, basename, join, relative, isAbsolute } from 'node:path'
import type { Logger } from '../diagnostics/logger'

export interface CorruptIsolationOpts {
  logger: Logger
  countDiagnostic(code: string): void
}
export interface CorruptIsolation {
  isolate(file: string, tag: string, safeRoot?: string): Promise<string>
  dropInvalid(code: string): void
  /** HIGH-1（安全 MED-4 修法）：有界保留——下次成功 load() 时清同 tag 旧 `.corrupt-*`（只留最新一份）。deleteOld=true 时调用 */
  pruneCorrupt(file: string, tag: string): Promise<void>
}
function nowIso(): string { return new Date().toISOString().replace(/[:.]/g, '-') }
async function assertContained(file: string, safeRoot: string): Promise<void> {
  // C-13：原用 real.startsWith(safeRoot) 会把 /tmp/foo 判作在 /tmp/foobar 内（同前缀兄弟目录误判）。
  // 对齐 safe-open.ts 的成熟实现：两侧都 realpath，用 relative(safeRootDir, fileReal) 判定，
  // rel 不以 '..' 起始且不含 '..' 段才视为包含——消除同前缀兄弟误判（防御纵深，不改变主路径行为）。
  const [safe, real] = await Promise.all([realpath(safeRoot), realpath(file)])
    .catch(() => { throw new Error(`isolate 目标无法解析真实路径: ${file}`) })
  const rel = relative(safe, real)
  // C-13（#28 复核）：Windows 跨盘符时 path.relative 返回绝对路径（如 relative('C:\\safe','D:\\outside') =
  // 'D:\\outside'），startsWith('..')/includes('..') 均 false —— 会放行越根路径。补 isAbsolute(rel) 判定：
  // 相对结果若仍是绝对路径即跨盘符/越根，拒。
  if (isAbsolute(rel) || rel.startsWith('..') || rel.includes('..') || rel === '') throw new Error(`isolate 目标逃逸安全根: ${file}`)
}
export function createCorruptIsolation(deps: CorruptIsolationOpts): CorruptIsolation {
  return {
    async isolate(file, tag, safeRoot) {
      if (safeRoot) await assertContained(file, safeRoot)  // 安全 MED-3：safeRoot 必传则校验
      const dest = `${file}.corrupt-${tag}-${nowIso()}`
      // H-11b（2026-09-11）：隔离失败**必须上抛**，不能吞。
      // 此前是 `await rename(file, dest).catch(() => {})`，于是「改名失败（AV/备份代理/只读目录）
      // → 原文件仍在磁盘上 → 调用方内存态被清空 → 下一次击键无痕覆写」这条静默数据销毁路径成立。
      // 现由调用方据此进入降级态并拒绝一切写入，保现场。
      try {
        await rename(file, dest)
      } catch (err) {
        // ENOENT = 读与改名之间文件已消失：无物可保留、也无物可覆写 → 视为隔离完成
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      deps.countDiagnostic('persistence:corrupt-isolated')
      return dest
    },
    dropInvalid(code) { deps.countDiagnostic(code) },
    async pruneCorrupt(file, tag) {
      // HIGH-1 修法：清同 tag 旧 `.corrupt-<tag>-<ts>`，只留最新一份（本次 isolate 的 dest 除外）。
      // 跨平台修正：用 path.dirname/basename 定位目录与基名（brief 的 lastIndexOf('/') 在 Windows 反斜杠路径下失效）。
      const dir = dirname(file)
      const base = basename(file)
      const prefix = `${base}.corrupt-${tag}-`
      try {
        const entries = await readdir(dir)
        const targets = entries.filter((n) => n.startsWith(prefix)).sort()  // ts 字典序 ≈ 时间序
        for (const n of targets.slice(0, -1)) await unlink(join(dir, n)).catch(() => {})  // 留最新
      } catch { /* 目录不存在：no-op */ }
    }
  }
}
