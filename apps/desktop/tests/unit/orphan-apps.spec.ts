// tests/unit/orphan-apps.spec.ts
// 集成套件遗留进程识别与回收（helpers/orphan-apps）：只认本套件签名，按「应用实例」聚合进程树，
// 进程表不可读时放弃回收而非猜测。该判据决定「杀谁」，因此正反例都要钉住。
//
// 真机实测事实（2026-09-10 采样，构成本文件全部夹具的基础）：
//   main    : electron.exe "<repo>/apps/desktop" --inspect=0 --remote-debugging-port=0
//   gpu     : electron.exe --type=gpu-process --user-data-dir="<tmp>/cy-int-ud-HmxGhg/Cyrene" ...
//   utility : electron.exe --type=utility --user-data-dir=...（含 cy-int-ud-）
//   renderer: electron.exe --type=renderer --user-data-dir="<tmp>/cy-int-ud-HmxGhg/Cyrene" ...
// 即**签名分处两个进程**：调试开关只在 main，临时 userData 只在子进程。早期只看单进程的判据
// 因此只匹配到子进程（杀它会触发 Chromium 崩溃恢复重建），必须沿 ppid 回到 main 整体回收。
import { describe, expect, it } from 'vitest'
import { readlinkSync } from 'node:fs'
import {
  ORPHAN_USER_DATA_PREFIX,
  carriesTestAppSignature,
  descendantsOf,
  readProcessTable,
  reclaimOrphanTestApps,
  resolveMainPid,
  scanOrphanTestApps,
  userDataDirOf,
  type ProcessEntry,
  type ScanResult
} from '../integration/helpers/orphan-apps'

const ROOT = 'C:\\Users\\dev\\Desktop\\elysia-frontend\\apps\\desktop'
const EXE = 'C:\\Users\\dev\\AppData\\Local\\pnpm\\electron\\43.3.0\\electron.exe'
const UD = 'C:\\Users\\dev\\AppData\\Local\\Temp\\cy-int-ud-HmxGhg'

function entry(overrides: Partial<ProcessEntry> & { commandLine: string }): ProcessEntry {
  return { pid: 1000, ppid: 0, executable: EXE, ...overrides }
}

/** 真机形态的一个完整测试应用实例（main + gpu + utility + renderer） */
const INSTANCE: ProcessEntry[] = [
  entry({ pid: 83404, ppid: 7088, commandLine: `"${EXE}"  "--inspect=0" "--remote-debugging-port=0" "${ROOT}"` }),
  entry({ pid: 81528, ppid: 83404, commandLine: `"${EXE}" --type=gpu-process --user-data-dir="${UD}\\Cyrene" --gpu-preferences=UAAAAAAA` }),
  entry({ pid: 81208, ppid: 83404, commandLine: `"${EXE}" --type=utility --utility-sub-type=network.mojom.NetworkService --user-data-dir="${UD}\\Cyrene" --lang=zh-CN` }),
  entry({ pid: 83432, ppid: 83404, commandLine: `"${EXE}" --type=renderer --user-data-dir="${UD}\\Cyrene" --standard-schemes=cyrene` })
]

const table = (entries: ProcessEntry[]): ScanResult => ({ readable: true, entries })

describe('遗留测试应用识别', () => {
  it('userDataDirOf 解析带引号与不带引号的 --user-data-dir', () => {
    expect(userDataDirOf('--user-data-dir=/tmp/cy-int-ud-Abc --inspect=0')).toBe('/tmp/cy-int-ud-Abc')
    expect(userDataDirOf('--user-data-dir="C:\\Temp\\cy-int-ud-Abc"')).toBe('C:\\Temp\\cy-int-ud-Abc')
    expect(userDataDirOf('--foo=bar')).toBeUndefined()
  })

  it('真机 main 进程（仅调试开关）与子进程（仅临时 userData）都携带签名', () => {
    expect(carriesTestAppSignature(INSTANCE[0], ROOT)).toBe(true)
    expect(carriesTestAppSignature(INSTANCE[1], ROOT)).toBe(true)
    expect(carriesTestAppSignature(INSTANCE[3], ROOT)).toBe(true)
  })

  it('认 Linux 形态（electron 二进制、/tmp 下的 cy-int-ud- 临时目录）', () => {
    const linux = entry({
      executable: '/repo/node_modules/electron/dist/electron',
      commandLine: '/repo/node_modules/electron/dist/electron /repo/apps/desktop --inspect=0 --remote-debugging-port=0 --user-data-dir=/tmp/cy-int-ud-lcYCQ1'
    })
    expect(carriesTestAppSignature(linux, '/repo/apps/desktop')).toBe(true)
  })

  it('放行：pnpm dev 的 Electron（真实 userData，不是 cy-int-ud- 临时目录）', () => {
    expect(carriesTestAppSignature(entry({ commandLine: `"${EXE}" ${ROOT} --inspect=5858` }), ROOT)).toBe(false)
  })

  // 注意信号二的判据边界：`cy-int-ud-` 临时 userData 单独成立即命中（不加仓库路径条件），
  // 因为 Electron 子进程命令行里**没有**仓库路径（真机采样），而该前缀只有 launchApp 的
  // mkdtemp 会生成——「别的项目恰好也叫 cy-int-ud-」在本仓库语境下不构成现实风险。
  it('命中：带 cy-int-ud- 临时 userData 的任意 Electron（子进程只能靠这个信号）', () => {
    const other = entry({
      executable: 'C:\\Other\\electron.exe',
      commandLine: 'C:\\Other\\electron.exe --type=renderer --user-data-dir=C:\\Temp\\cy-int-ud-XYZ\\Cyrene'
    })
    expect(carriesTestAppSignature(other, ROOT)).toBe(true)
  })

  it('放行：非本仓库 app 目录且无该临时目录的 Electron', () => {
    const other = entry({
      executable: 'C:\\Other\\electron.exe',
      commandLine: 'C:\\Other\\electron.exe C:\\Other\\my-app --inspect=0'
    })
    expect(carriesTestAppSignature(other, ROOT)).toBe(false)
  })

  it('放行：本仓库 app 目录但两个信号都没有的 Electron（不是本套件拉起的）', () => {
    expect(carriesTestAppSignature(entry({ commandLine: `"${EXE}" ${ROOT}` }), ROOT)).toBe(false)
    expect(carriesTestAppSignature(entry({ commandLine: `"${EXE}" ${ROOT} --user-data-dir=C:\\Temp\\normal-dir` }), ROOT)).toBe(false)
  })

  it('放行：带调试开关但不在本仓库 app 目录的 Electron（例如别的 Electron 项目）', () => {
    const other = entry({
      executable: 'C:\\Other\\electron.exe',
      commandLine: 'C:\\Other\\electron.exe C:\\Other\\my-app --inspect=0 --remote-debugging-port=0'
    })
    expect(carriesTestAppSignature(other, ROOT)).toBe(false)
  })

  it('放行：非 electron 可执行文件（例如 electron-vite 的 node 进程）', () => {
    const vite = entry({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: `node.exe ${ROOT}\\node_modules\\electron-vite\\bin.js --inspect=0 --user-data-dir=/tmp/cy-int-ud-Abc`
    })
    expect(carriesTestAppSignature(vite, ROOT)).toBe(false)
  })

  it('放行：cy-int-ud- 只出现在非 userData 参数里时不误判', () => {
    expect(carriesTestAppSignature(entry({ commandLine: `"${EXE}" ${ROOT} --log-file=/tmp/cy-int-ud-Abc.log` }), ROOT)).toBe(false)
  })

  it('前缀常量与 launchApp 的 mkdtemp 前缀一致', () => {
    expect(ORPHAN_USER_DATA_PREFIX).toBe('cy-int-ud-')
  })
})

describe('进程树回溯与聚合', () => {
  it('子进程沿 ppid 回到 main（main 无 --type=）', () => {
    expect(resolveMainPid(INSTANCE[1], INSTANCE)).toBe(83404)
    expect(resolveMainPid(INSTANCE[3], INSTANCE)).toBe(83404)
    expect(resolveMainPid(INSTANCE[0], INSTANCE)).toBe(83404)
  })

  it('父进程已退出（链断）时返回起点，不越界回溯', () => {
    const orphanChild = entry({ pid: 900, ppid: 12345, commandLine: `"${EXE}" --type=renderer --user-data-dir="${UD}\\Cyrene"` })
    expect(resolveMainPid(orphanChild, [orphanChild])).toBe(900)
    // ppid 指向进程表里的无关进程时同样在断点停下（该进程不在表中 → 返回起点）
    expect(resolveMainPid(orphanChild, [orphanChild, entry({ pid: 12345, commandLine: '"C:\\Other\\app.exe"' })])).toBe(12345)
  })

  it('descendantsOf 收集整棵子树且不因环而死循环', () => {
    expect(descendantsOf(83404, INSTANCE)).toEqual([83404, 81528, 81208, 83432])
    const cyclic = [entry({ pid: 1, ppid: 2, commandLine: 'a' }), entry({ pid: 2, ppid: 1, commandLine: 'b' })]
    expect(descendantsOf(1, cyclic).sort()).toEqual([1, 2])
  })

  it('一个实例的多个签名进程聚合成 1 条孤儿记录，回收单位是 main', () => {
    const scan = scanOrphanTestApps(ROOT, table(INSTANCE))
    expect(scan.canReclaim).toBe(true)
    expect(scan.electronCount).toBe(4)
    expect(scan.orphans).toHaveLength(1)
    expect(scan.orphans[0].pid).toBe(83404)
    // 由 main 出发收集整棵树，与命中了几个签名进程无关
    expect(scan.orphans[0].pids).toEqual([81208, 81528, 83404, 83432])
  })

  it('两个遗留实例各自成条，按 main pid 排序', () => {
    const second = [
      entry({ pid: 86696, ppid: 7088, commandLine: `"${EXE}" --inspect=0 --remote-debugging-port=0 "${ROOT}"` }),
      entry({ pid: 78656, ppid: 86696, commandLine: `"${EXE}" --type=gpu-process --user-data-dir="C:\\Temp\\cy-int-ud-lcYCQ1\\Cyrene"` })
    ]
    const scan = scanOrphanTestApps(ROOT, table([...INSTANCE, ...second]))
    expect(scan.orphans.map((orphan) => orphan.pid)).toEqual([83404, 86696])
  })
})

describe('遗留测试应用回收', () => {
  it('进程表不可读时不做任何事，并给出原因（不猜测、不误杀）', () => {
    const unreadable: ScanResult = { readable: false, unavailableReason: '不支持的平台 aix', entries: [] }
    const scan = scanOrphanTestApps(ROOT, unreadable)
    expect(scan.canReclaim).toBe(false)
    expect(scan.reason).toBe('不支持的平台 aix')
    expect(scan.orphans).toEqual([])

    const result = reclaimOrphanTestApps(ROOT, unreadable)
    expect(result.canReclaim).toBe(false)
    expect(result.killed).toEqual([])
    expect(result.failed).toEqual([])
  })

  it('回收整棵实例进程树（main 优先），单个失败不影响其余并如实报告', () => {
    const attempted: number[] = []
    const result = reclaimOrphanTestApps(ROOT, table(INSTANCE), (pid) => {
      attempted.push(pid)
      if (pid === 81528) throw new Error('EPERM: operation not permitted')
    })
    expect(attempted).toEqual([83404, 81208, 81528, 83432])
    expect(result.killed).toEqual([83404, 81208, 83432])
    expect(result.failed).toEqual([{ pid: 81528, error: 'EPERM: operation not permitted' }])
  })

  it('没有匹配进程时不调用杀进程，也不误报回收数', () => {
    const attempted: number[] = []
    const unrelated = entry({ commandLine: `"${EXE}" ${ROOT}` })
    const result = reclaimOrphanTestApps(ROOT, table([unrelated]), (pid) => attempted.push(pid))
    expect(attempted).toEqual([])
    expect(result.killed).toEqual([])
    expect(result.orphans).toEqual([])
    expect(result.electronCount).toBe(1)
  })

  it('无子进程的孤立 main 也能被回收（回收集合只含它自己）', () => {
    const attempted: number[] = []
    const result = reclaimOrphanTestApps(
      ROOT,
      table([entry({ pid: 3000, commandLine: `"${EXE}" ${ROOT} --inspect=0` })]),
      (pid) => attempted.push(pid)
    )
    expect(attempted).toEqual([3000])
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0].pids).toEqual([3000])
  })
})

// —— 真机进程表读取（2026-09-12 OOM 事故回归）——
//
// 事故链（自建 Ubuntu runner 上稳定复现；托管 runner 与 Windows 宿主均不复现）：
//   `readProcessTableLinux()` 原先用 `readFileSync('/proc/<pid>/exe', 'utf8')` 取可执行文件路径，
//   而 `/proc/<pid>/exe` 是**符号链接**——读文件会顺着链接把**整个可执行文件**当 UTF-8 读进来。
//   该机跑着多个 Google Chrome（每个 exe = 281,881,848 字节，269MB），全机各进程 exe 体量合计约 8.7GB；
//   读进来还要 `split('\0')` 展开成上千万片段 ⇒ vitest 主进程**在收集阶段**就
//   `FATAL ERROR: Reached heap limit`（4GB 打满；把堆放宽到 8GB 也只是涨到 9GB 再崩，说明是无界增长）。
//   托管 runner 上只有 node/git/xvfb 这类小二进制，故该缺陷长期未被发现——它**只对「Linux 上跑着
//   大体积可执行文件」的机器生效**，而那恰好是自建 runner 与开发者桌面的常见形态。
//
// 判据两条：① 与 `readlinkSync` 逐字一致（等价性锚点）；② 长度 < PATH_MAX 且不含 NUL
//（二进制内容必然含大量 NUL）。**判别力已实测**：在跑着 Chrome 的那台 Linux 上跑本用例——
// 修复后 21 tests 全绿；把该行回退成 `readFileSync(..., 'utf8')` 后，本用例**直接以
// `FATAL ERROR: Reached heap limit` 收场**（连断言都执行不到），即缺陷不会静默通过。
describe('进程表读取（Linux /proc 语义）', () => {
  it.skipIf(process.platform !== 'linux')('executable 取的是链接目标路径，而不是被链接文件的内容（2026-09-12 OOM 回归）', () => {
    const scanned = readProcessTable()
    expect(scanned.readable).toBe(true)
    const self = scanned.entries.find((candidate) => candidate.pid === process.pid)
    expect(self, '进程表里应包含测试进程自身').toBeTruthy()
    expect(self!.executable).toBe(readlinkSync(`/proc/${process.pid}/exe`))
    expect(self!.executable.length).toBeLessThan(4096)
    expect(self!.executable).not.toContain('\0')
  })
})
