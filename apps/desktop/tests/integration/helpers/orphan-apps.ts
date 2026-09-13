// tests/integration/helpers/orphan-apps.ts
// 集成套件遗留测试应用（孤儿 Electron 进程）的识别与回收。
//
// 背景（2026-09-10 定位）：集成套件中断（Ctrl-C / 超时 kill）时 launchApp 启动的测试应用不会退出，
// 它会带着 `--user-data-dir=<tmp>/cy-int-ud-XXXX` 长期驻留，并占住整套子进程（main + gpu + utility +
// renderer，实测一个实例约 375MB）。这些孤儿跨运行累积，与后续运行争抢 CPU/GPU，使 electron-live2d
// 这类「启动/连接后首次交互」的重型 spec 在每个 8s 等待预算上偶发超时——而每个文件单独跑都是绿的。
//
// 前提修正（2026-09-12）：本文件原先写着「CI 用一次性 runner，因此该机制只在开发者本机出现」——
// **迁到自建 runner 后该前提失效**：3 个 runner 实例跑在**同一台机器、同一个进程表**上，集成 job 并发时
// 后启动的 job 会把先启动 job **正在使用的**应用当成孤儿杀掉。故本轮加了 `OWNER_SWITCH` 所有者门
// （判据见该常量的注释），并保留全部原有越权纪律。
//
// 纪律（越权即事故）：
//  1. 只认「本套件自己造出来的」进程签名——user-data-dir 前缀 `cy-int-ud-` 来自 launchApp 的
//     mkdtempSync，`pnpm dev`（真实 userData）与用户真实应用都不匹配；
//  2. 只认 Playwright `_electron.launch` 注入的调试开关（`--inspect=0` / `--remote-debugging-port=0`），
//     进一步排除误伤；
//  3. 只有「进程表可读」时才动手；平台不支持或查询失败时**什么都不做**（只报告），绝不猜测；
//  4. 返回结构化结果，调用方负责输出——本模块不写 console，便于单测。
import { execFileSync } from 'node:child_process'
import { readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** launchApp 的临时 userData 前缀（mkdtempSync(join(tmpdir(), 'cy-int-ud-'))） */
export const ORPHAN_USER_DATA_PREFIX = 'cy-int-ud-'
/** Playwright _electron.launch 注入的调试开关，测试应用必带 */
const DEBUG_SWITCHES = ['--inspect=0', '--remote-debugging-port=0']
/**
 * launchApp 注入的**所有者标记**，值为拉起该应用的 vitest 进程 pid。
 *
 * 为什么必须有它（2026-09-12 实测事故，自建 runner 引入）：识别判据（`cy-int-ud-` 临时 userData /
 * 仓库路径 + 调试开关）描述的是「本套件造出来的进程」，而**不区分是哪一次运行**。开发者本机同一时刻
 * 只跑一份套件，所以过去够用；但 CI 迁到自建 runner 后，**同一台机器上有 3 个 runner 实例**，
 * 集成 job 并发时后启动的那个会把先启动 job **正在使用的**应用当成「上次运行遗留」杀掉：
 *   shard 2/3 的 globalSetup 13:37:34.518 回收 main=943529（6 进程）
 *   shard 1/3 同一 pid 的 `generation-stall-recovery` beforeAll 13:37:34.680 报
 *   `locator.click: Target page, context or browser has been closed`（相隔 160ms，只有 1 例）。
 * 有了所有者标记，回收器就能区分「孤儿」与「别的 job 正在用的应用」：**所有者进程还活着 ⇒ 跳过**。
 */
export const OWNER_SWITCH = '--cyrene-test-owner-pid='

/** 进程表的一行（只保留识别所需字段） */
export interface ProcessEntry {
  pid: number
  /** 父进程 id（0 = 无父进程） */
  ppid: number
  /** 可执行文件路径（Windows 用 Win32_Process.ExecutablePath，Linux 用 /proc/<pid>/exe） */
  executable: string
  commandLine: string
}

export interface ScanResult {
  /** 成功读到进程表？false 时调用方必须放弃回收（只报告） */
  readable: boolean
  /** 平台不支持或无可用查询工具时的说明 */
  unavailableReason?: string
  entries: ProcessEntry[]
}

/** 从命令行提取 `--user-data-dir=<值>`（Electron 开关，值可带引号） */
export function userDataDirOf(commandLine: string): string | undefined {
  const match = /--user-data-dir=(?:"([^"]*)"|(\S*))/i.exec(commandLine)
  return match ? (match[1] ?? match[2]) : undefined
}

/** 从命令行提取所有者标记里的 pid（见 OWNER_SWITCH；没有标记时返回 undefined） */
export function ownerPidOf(commandLine: string): number | undefined {
  const match = /--cyrene-test-owner-pid=(\d+)/.exec(commandLine)
  if (!match) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** 所有者存活判定（可注入以便单测；默认用 signal 0 探测） */
export type IsProcessAlive = (pid: number) => boolean

/** 默认存活判定：`kill(pid, 0)` 不抛即活着。
 *  EPERM 说明进程存在但不属于当前用户——**算活着**（宁可漏收孤儿，也不误杀别人正在用的应用）。
 *  旧进程被 kill 后若尚未被父进程 wait 掉会是 zombie，signal 0 仍返回成功 ⇒ 同样算活着：
 *  这份保守方向是对的，真正的孤儿下一轮（所有者已彻底消失）仍会被回收。 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 是否 Electron 可执行文件（Windows `electron.exe` / Linux `electron`），排除同名的 node 脚本。
 *
 * 2026-09-13：把原先内联在 `carriesTestAppSignature` 里的这条判据提取为具名谓词——因为
 * `ScanResult.electronCount` 的注释写的是「进程表里所有 **electron** 进程数量」，实现却是
 * `table.entries.length`（**全部**进程）。Windows 侧无感（CIM 查询已按 `Name='electron.exe'` 过滤），
 * 但 Linux 侧走 `/proc` 全表，于是每轮 CI 都打印
 * 「检测到 43 个非本套件的 Electron 进程，未做处理」——**误报**（那 43 个是机器上的任何进程）。
 * 危害不是行为（该字段只用在这条 warn 与该 warn 的判据上），而是**稀释真实孤儿场景的可信度**：
 * 真出现孤儿时，运维看到的是同一句已经被训练成忽略的告警。
 */
export function isElectronProcess(entry: ProcessEntry): boolean {
  const executable = entry.executable.replace(/\\/g, '/').toLowerCase()
  return /(^|\/)electron(\.exe)?$/.test(executable)
}

/**
 * 判定一条进程记录是否携带「本套件测试应用」的签名。
 *
 * 关键实测事实（2026-09-10 真机采样，两条命令行的差异决定本函数的形状）：
 *   main    : "<exe>" "--inspect=0" "--remote-debugging-port=0" "<repo>/apps/desktop"
 *   renderer: "<exe>" --type=renderer --user-data-dir="<tmp>/cy-int-ud-HmxGhg/Cyrene" --standard-schemes=cyrene
 * 即 `--inspect=0` 只在 main 进程上、`cy-int-ud-` 临时 userData 只在子进程上，且**子进程命令行里
 * 完全没有仓库路径**。因此两个信号各自成判据，不能要求二者同时成立：
 *   信号一（main）：仓库 app 目录 + Playwright 调试开关——单独看开关会误伤其他 Electron 应用。
 *   信号二（子进程）：`cy-int-ud-` 临时 userData 目录段——该前缀只有 launchApp 的 mkdtemp 会产生，
 *                    本身就是充分判据（`pnpm dev` 用真实 userData，不匹配）。
 * 实例级聚合见 scanOrphanTestApps（沿 ppid 回到 main，整体回收）。
 */
export function carriesTestAppSignature(entry: ProcessEntry, root: string): boolean {
  // 必须是 Electron 二进制（Windows electron.exe / Linux electron），排除同名 node 脚本
  if (!isElectronProcess(entry)) return false
  // 信号二：launchApp 的 mkdtemp 临时 userData（路径分隔符统一后按目录段前缀匹配）
  const dataDir = userDataDirOf(entry.commandLine)
  if (dataDir && dataDir.replace(/\\/g, '/').toLowerCase().split('/').some((segment) => segment.startsWith(ORPHAN_USER_DATA_PREFIX.toLowerCase()))) {
    return true
  }
  // 信号一：仓库 app 目录 + Playwright _electron.launch 调试开关
  const rootNormalized = root.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
  if (!entry.commandLine.replace(/\\/g, '/').toLowerCase().includes(rootNormalized)) return false
  return DEBUG_SWITCHES.some((flag) => entry.commandLine.includes(flag))
}

/** 兼容入口：单进程判据 */
export function isOrphanTestApp(entry: ProcessEntry, root: string): boolean {
  return carriesTestAppSignature(entry, root)
}

/** 沿 ppid 链回溯到「同一个测试应用的 main 进程」；链断（父已退出）时返回起点 */
export function resolveMainPid(entry: ProcessEntry, entries: ProcessEntry[]): number {
  const byPid = new Map(entries.map((candidate) => [candidate.pid, candidate]))
  const visited = new Set<number>([entry.pid])
  let current = entry
  while (true) {
    const parent = byPid.get(current.ppid)
    if (!parent || visited.has(parent.pid)) return current.pid
    // main 进程带调试开关且没有 --type=；子进程一律带 --type=
    if (!parent.commandLine.includes('--type=')) return parent.pid
    visited.add(parent.pid)
    current = parent
  }
}

/** 收集一个进程的全部后代（含自身），用于兜底清理已失去父进程的残留子进程 */
export function descendantsOf(pid: number, entries: ProcessEntry[]): number[] {
  const children = new Map<number, number[]>()
  for (const entry of entries) {
    const list = children.get(entry.ppid)
    if (list) list.push(entry.pid)
    else children.set(entry.ppid, [entry.pid])
  }
  const collected: number[] = []
  const queue = [pid]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    collected.push(current)
    queue.push(...(children.get(current) ?? []))
  }
  return collected
}

/** 平台进程表查询：Windows 走 CIM，Linux 走 /proc。失败一律返回 readable:false。 */
export function readProcessTable(): ScanResult {
  if (process.platform === 'win32') return readProcessTableWindows()
  if (process.platform === 'linux') return readProcessTableLinux()
  return { readable: false, unavailableReason: `不支持的平台 ${process.platform}`, entries: [] }
}

/** 分隔符用 NUL 插入：命令行本身含空格/引号/竖线，只有 NUL 不可能出现 */
function readProcessTableWindows(): ScanResult {
  const script = [
    "$nul = [string][char]0",
    "$rows = @(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" -ErrorAction Stop | ForEach-Object {",
    '  $_.ProcessId.ToString() + $nul + $_.ParentProcessId.ToString() + $nul + $_.ExecutablePath + $nul + $_.CommandLine',
    '})',
    '$rows -join "`n"'
  ].join('\n')
  try {
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    })
    return { readable: true, entries: parseRows(stdout) }
  } catch (error) {
    return { readable: false, unavailableReason: `Win32_Process 查询失败：${(error as Error).message}`, entries: [] }
  }
}

function readProcessTableLinux(): ScanResult {
  const entries: ProcessEntry[] = []
  let pids: string[]
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch (error) {
    return { readable: false, unavailableReason: `/proc 不可读：${(error as Error).message}`, entries: [] }
  }
  for (const name of pids) {
    try {
      // cmdline 用 NUL 分隔 argv；过滤掉空段后按空格拼接（仅用于签名匹配）
      const commandLine = readFileSync(join('/proc', name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ')
      if (!commandLine) continue
      let executable = ''
      // 2026-09-12 修复（**实测：这一行曾让自建 Linux runner 必然 OOM，且只在"Linux 上跑着大体积可执行文件"时暴露**）：
      // `/proc/<pid>/exe` 是**符号链接**，而 `readFileSync` 会顺着链接把**整个可执行文件**当 UTF-8 读进来。
      // 实测数据（Ubuntu 自建 runner，2026-09-12）：该机跑着多个 Google Chrome，每个进程的 exe 指向
      // 281,881,848 字节（269MB）的 /opt/google/chrome/chrome，全机各进程 exe 体量合计约 **8.7GB**；
      // 读进来还要 `split('\0')` 展开成上千万片段，于是 vitest 主进程**在收集阶段**就
      // `FATAL ERROR: Reached heap limit`（4GB 打满；把堆放到 8GB 也只是涨到 9GB 再崩，说明是无界增长）。
      // 托管 runner 上只有 node/git/xvfb 这类小二进制，故此前从未暴露——**这个缺陷只对自建 runner
      // 与"开着 Chrome/Electron 的开发者桌面"生效**，而这两者恰恰是本仓库集成套件的目标运行环境。
      // 正确做法是读**链接目标路径**（readlink）而不是文件内容；大小写/分隔符归一等匹配细节仍由调用方
      // `carriesTestAppSignature` 负责。已删除的可执行文件其 readlink 结果为 `<path> (deleted)`，
      // 不匹配 electron 签名——与修复前的行为一致（原先同样匹配不到）。
      try { executable = readlinkSync(join('/proc', name, 'exe')) } catch { /* 权限不足/进程已退出：留空即不匹配 */ }
      entries.push({ pid: Number(name), ppid: ppidOfLinux(name), executable, commandLine })
    } catch { /* 进程在枚举期间退出：跳过 */ }
  }
  return { readable: true, entries }
}

/** /proc/<pid>/stat 的字段 4 是 ppid；comm 可能含空格与括号，从最后一个 ')' 之后切分 */
function ppidOfLinux(pid: string): number {
  try {
    const stat = readFileSync(join('/proc', pid, 'stat'), 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    return Number(tail[1]) || 0 // tail[0] = state, tail[1] = ppid
  } catch {
    return 0
  }
}

function parseRows(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, ppid, executable, commandLine] = line.split('\0')
    if (!pid || !executable || !commandLine) continue
    const parsed = Number(pid)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) continue
    entries.push({ pid: parsed, ppid: Number(ppid) || 0, executable, commandLine })
  }
  return entries
}

export interface OrphanApp {
  /** 测试应用的 main 进程 pid（回收单位） */
  pid: number
  /** 该应用当前可见的全部进程（含 main），按 pid 升序 */
  pids: number[]
  /** 触发识别的签名进程（main 或某个子进程） */
  matchedPid: number
  commandLine: string
}

export interface OrphanScan {
  /** 是否具备回收能力（进程表可读且平台受支持） */
  canReclaim: boolean
  reason?: string
  orphans: OrphanApp[]
  /** 进程表里所有 electron 进程数量（诊断用：区分「没有孤儿」与「根本读不到」）。
   *  2026-09-13 前实测为 `table.entries.length`（Linux 上=机器上全部进程数），见 isElectronProcess 注释。 */
  electronCount: number
  /** 因「所有者进程仍存活」而**主动跳过**的应用数（并发运行的另一个集成 job 正在用它，2026-09-12） */
  liveOwned: number
}

/**
 * 扫描当前进程表，按「测试应用实例」聚合出遗留进程。
 *
 * 聚合方式：先找带签名的进程，再沿 ppid 回到 main 进程，最后把该 main 的后代一并纳入——
 * 因为 app.close() 只终止 main，子进程由 Electron 自行清理；直接杀子进程会触发
 * Chromium 的崩溃恢复重建，反而留下更多进程。
 *
 * **所有者门（2026-09-12）**：回到 main 后读它的 `--cyrene-test-owner-pid=`（见 OWNER_SWITCH）。
 * 所有者进程仍存活 ⇒ 这是**另一个正在运行的套件**的应用，**不计入孤儿**。没有标记（老进程/别的来源）
 * 时按原有语义处理（视为孤儿）——判据不比以前更宽。
 */
export function scanOrphanTestApps(
  root: string,
  table: ScanResult = readProcessTable(),
  isAlive: IsProcessAlive = processAlive
): OrphanScan {
  if (!table.readable) {
    return { canReclaim: false, reason: table.unavailableReason ?? '进程表不可读', orphans: [], electronCount: 0, liveOwned: 0 }
  }
  const byPid = new Map(table.entries.map((candidate) => [candidate.pid, candidate]))
  const byMainPid = new Map<number, OrphanApp>()
  let liveOwned = 0
  const liveOwnedMains = new Set<number>()
  for (const entry of table.entries) {
    if (!carriesTestAppSignature(entry, root)) continue
    const mainPid = resolveMainPid(entry, table.entries)
    const mainEntry = byPid.get(mainPid)
    const ownerPid = mainEntry ? ownerPidOf(mainEntry.commandLine) : undefined
    if (ownerPid !== undefined && isAlive(ownerPid)) {
      // 同一个实例的多个签名进程只计一次
      if (!liveOwnedMains.has(mainPid)) { liveOwnedMains.add(mainPid); liveOwned += 1 }
      byMainPid.delete(mainPid)
      continue
    }
    const existing = byMainPid.get(mainPid)
    if (existing) {
      // 同一实例的多个签名进程：并集它们的进程树
      for (const pid of descendantsOf(entry.pid, table.entries)) if (!existing.pids.includes(pid)) existing.pids.push(pid)
      continue
    }
    byMainPid.set(mainPid, {
      pid: mainPid,
      pids: descendantsOf(mainPid, table.entries).sort((left, right) => left - right),
      matchedPid: entry.pid,
      commandLine: entry.commandLine
    })
  }
  return {
    canReclaim: true,
    orphans: [...byMainPid.values()].sort((left, right) => left.pid - right.pid),
    electronCount: table.entries.filter(isElectronProcess).length,
    liveOwned
  }
}

export interface ReclaimResult extends OrphanScan {
  killed: number[]
  failed: Array<{ pid: number; error: string }>
}

/** 结束进程（默认 process.kill；单测注入以便断言失败路径） */
export type KillProcess = (pid: number) => void

/** 回收遗留应用：只杀识别出的实例进程树，main 优先。
 *  只读扫描 + 只对匹配项下手；任何单个进程失败都只记录，不中断其余回收。
 *  `isAlive` 透传给扫描阶段的所有者门（并发运行的应用不算孤儿）。 */
export function reclaimOrphanTestApps(
  root: string,
  table: ScanResult = readProcessTable(),
  kill: KillProcess = (pid) => process.kill(pid, 'SIGTERM'),
  isAlive: IsProcessAlive = processAlive
): ReclaimResult {
  const scan = scanOrphanTestApps(root, table, isAlive)
  const killed: number[] = []
  const failed: Array<{ pid: number; error: string }> = []
  if (!scan.canReclaim) return { ...scan, killed, failed }
  for (const orphan of scan.orphans) {
    // main 先死：子进程随之退出；再补杀仍可见的残留子进程
    for (const pid of [orphan.pid, ...orphan.pids.filter((pid) => pid !== orphan.pid)]) {
      try {
        kill(pid)
        killed.push(pid)
      } catch (error) {
        failed.push({ pid, error: (error as Error).message })
      }
    }
  }
  return { ...scan, killed, failed }
}
