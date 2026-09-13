// tests/helpers/temp-dirs.ts
// 测试临时目录的识别与回收（P2-6 / L-28，2026-09-11）。
//
// 背景（本轮实测，远超评审所记）：评审判定「集成套件泄漏临时 userData 目录」，实测 `cy-int-ud-*`
// 确有泄漏，但真正的大头在**单元测试**——本机 $TEMP 下累积 **6,720 个 `cy*` 目录 / 22.6 MB**，
// 最早 2026-06-23（约两个半月），分布在 40+ 个前缀上（`cy-creds-` 2576、`cy-settings-` 1430、
// `cy-atomic-` 762…）。成因不是「清理失败」，而是**多数 spec 根本没有清理代码**：
// 例如 `credential-store.spec.ts` 的 `makeStore()` 每次调用 `mkdtempSync` 却全文件无 `rmSync`/`afterEach`。
//
// 因此修法刻意**不是**逐个 spec 补 `afterEach`（22 个文件、必然再漏），而是集中回收 + 防漂移门禁：
//   ① 本模块在套件启动时回收「属于本仓库测试命名空间」的临时目录（单元与集成共用）；
//   ② `tests/unit/temp-dirs.spec.ts` 有一条**防漂移**用例：扫描全部测试源码里出现过的 mkdtemp 前缀，
//      任何一个不在本模块的允许表里就变红——新 spec 用新前缀时必须来登记，列表不可能悄悄过期。
//
// 与 `orphan-apps.ts` 的分工：那边回收**进程**（中断遗留的 Electron），这边回收**目录**。
// 两者都在套件启动前跑，顺序为先进程后目录（进程放开句柄后目录才删得掉）。
//
// 安全纪律（越权即事故，逐条对应实现里的检查）：
//   1. 只处理**系统临时目录的直接子目录**——不递归、不跟随符号链接；
//   2. 名字必须命中允许表（本仓库测试命名空间）；
//   3. 被任何活进程引用的目录一律跳过（`--user-data-dir=` 指向它）——正在跑的应用绝不碰；
//   4. 太新的目录跳过（默认 10 分钟）——防误删并发运行中的另一个套件的在途目录；
//   5. 删除失败只记录，不抛出、不中断后续回收。
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 本仓库测试临时目录的命名空间允许表。
 *
 * 为什么是**显式列表**而不是 `cy*` 通配：通配会连带命中机器上其它人或其它工具的临时目录，
 * 而回收是破坏性操作。显式列表 + 防漂移用例（见文件头 ②）既安全又不会过期。
 */
export const TEST_TEMP_PREFIXES: readonly string[] = [
  'cy-atomic-',
  'cy-atomic-out-',
  'cy-contract-gate-',
  'cy-corrupt-',
  'cy-creds-',
  'cy-creds-2s-',
  'cy-creds-cl-',
  'cy-creds-drain-',
  'cy-creds-mk-',
  'cy-creds-win-',
  'cy-creds-win2-',
  'cy-devform-master-',
  'cy-devform-ud-',
  'cy-escape-out-',
  'cy-export-',
  'cy-f1-out-',
  'cy-font-',
  'cy-fw-',
  'cy-fw-b-',
  'cy-fw-c-',
  'cy-fw-d-',
  'cy-fw-r-',
  'cy-fw-t-',
  'cy-h11b-',
  'cy-h11b2-',
  'cy-hist-',
  'cy-int-ud-',
  'cy-l2d-master-',
  'cy-l2d-ud-',
  'cy-live2d-',
  'cy-live2d-symlink-probe-',
  'cy-other-',
  'cy-outside-',
  'cy-outside-target-',
  'cy-protocol-symlink-probe-',
  'cy-safe-open-',
  'cy-safe-open-symlink-probe-',
  'cy-settings-',
  'cy-settings-tools-',
  'cy-table-',
  'cy-tail-',
  'cy-tmpdirs-sandbox-',
  'cy-tools-',
  'cy-xss-',
  'cyrene-character-drafts-',
  'cyrene-character-outside-',
  'cyrene-character-safe-',
  'cyrene-diag-',
  'cyrene-exec-',
  'cyrene-exec-symlink-probe-',
  'cyrene-h11b-',
  'cyrene-h11b2-',
  'cyrene-h11b3-',
  'cyrene-h11b4-',
  'cyrene-h11b4-root-',
  'cyrene-live2d-install-',
  'cyrene-session-',
  'cyrene-session2-',
  'cyrene-session3-',
  'cyrene-session4-',
  'cyrene-session5-',
  'cyrene-stage-h-appdata-',
  'cyrene-symlink-probe-',
  'cyrene-test-',
  'cyrene-tgt-',
  'cyrene-tgt2-',
  // P2-10：verify-sensitive 端到端用例（真跑扫描脚本）的 fixture 根。
  // 该 spec 自己会清理，但按本门禁的规矩新前缀必须登记——否则一旦它的清理漏了，
  // 目录会在 $TEMP 里永久留下而无人发现（这正是本表存在的理由）。
  'cyvs-'
]

/** 并发运行保护：比这更新的目录视为「可能有人正在用」，不回收 */
export const DEFAULT_MIN_AGE_MS = 10 * 60 * 1000

export interface TempReclaimResult {
  /** 临时目录下扫描到的直接子目录总数（诊断用：区分「没有可回收」与「根本没扫到」） */
  scanned: number
  removed: string[]
  /** 被活进程引用而跳过 */
  skippedInUse: string[]
  /** 太新而跳过 */
  skippedRecent: string[]
  failed: Array<{ path: string; error: string }>
}

export interface ReclaimOptions {
  tmpRoot?: string
  prefixes?: readonly string[]
  /** 活进程引用的路径（调用方从进程表提取；比较时两侧归一化大小写与分隔符） */
  inUsePaths?: Iterable<string>
  now?: number
  minAgeMs?: number
  /** 以下三个为可注入接缝（单测用） */
  readdir?: (path: string) => string[]
  remove?: (path: string) => void
}

/** 路径归一化：统一分隔符 + Windows 下小写（大小写不敏感） */
export function normalizePathForCompare(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** 从进程命令行集合里提取 `--user-data-dir=` 的取值（回收目录时用来避开在用的） */
export function userDataDirsFromCommandLines(commandLines: Iterable<string>): string[] {
  const found: string[] = []
  for (const commandLine of commandLines) {
    const match = /--user-data-dir=(?:"([^"]*)"|(\S*))/i.exec(commandLine)
    const value = match ? (match[1] ?? match[2]) : undefined
    if (value) found.push(value)
  }
  return found
}

/**
 * 回收本仓库测试命名空间下、且判定为「已无人使用」的临时目录。
 *
 * 注意 `inUsePaths` 的比较包含**父目录包含关系**：Electron 子进程的 userData 常写作
 * `<tmp>/cy-int-ud-XXX/Cyrene`，而回收对象是 `<tmp>/cy-int-ud-XXX`。只看全等会把在用的目录当成孤儿删掉。
 */
export function reclaimTestTempDirs(options: ReclaimOptions = {}): TempReclaimResult {
  const tmpRoot = options.tmpRoot ?? tmpdir()
  const prefixes = options.prefixes ?? TEST_TEMP_PREFIXES
  const now = options.now ?? Date.now()
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS
  const readdir = options.readdir ?? ((path: string) => readdirSync(path))
  const remove = options.remove ?? ((path: string) => { rmSync(path, { recursive: true, force: true }) })

  const inUse = [...(options.inUsePaths ?? [])].map(normalizePathForCompare)
  const result: TempReclaimResult = { scanned: 0, removed: [], skippedInUse: [], skippedRecent: [], failed: [] }

  let names: string[]
  try { names = readdir(tmpRoot) } catch { return result }   // 临时目录不可读：什么都不做

  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue
    const path = join(tmpRoot, name)
    result.scanned += 1

    // 纪律 1：必须是**普通目录**，且不是符号链接（避免顺着链接删到别处）
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    } catch { continue }   // 枚举期间消失

    // 纪律 3：有活进程引用（自身或其子路径）则跳过
    const normalized = normalizePathForCompare(resolve(path))
    if (inUse.some((used) => used === normalized || used.startsWith(`${normalized}/`))) {
      result.skippedInUse.push(path)
      continue
    }

    // 纪律 4：太新则跳过（并发运行的另一个套件可能正在用）
    try {
      if (now - statSync(path).mtimeMs < minAgeMs) { result.skippedRecent.push(path); continue }
    } catch { continue }

    // 纪律 5：单条失败不影响其余
    try {
      remove(path)
      result.removed.push(path)
    } catch (error) {
      result.failed.push({ path, error: (error as Error).message })
    }
  }
  return result
}
