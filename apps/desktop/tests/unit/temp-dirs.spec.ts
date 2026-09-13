// tests/unit/temp-dirs.spec.ts
// P2-6 / L-28（2026-09-11）：测试临时目录回收。
//
// 实测背景（远超评审所记）：本机 $TEMP 累积 **6,720 个 `cy*` 目录 / 22.6 MB**，最早 2026-06-23、
// 分布在 40+ 前缀上；成因是**多数 spec 没有清理代码**（如 `credential-store.spec.ts` 每次
// `mkdtempSync` 却全文件无 `rmSync`/`afterEach`）。故修法是集中回收 + 防漂移门禁，而不是逐个 spec 补。
//
// 本文件的两类断言：
//   ① 回收逻辑本身的行为（含全部安全纪律：不用通配、不跟随符号链接、在用目录必跳过、太新必跳过、
//      单条失败不中断、不可读时什么都不做）；
//   ② **防漂移**：扫描全部测试源码里出现过的 mkdtemp 前缀，任何一个不在允许表里就红——
//      这是让「允许表」不会像 ipc-security 的硬编码白名单那样悄悄过期的那道门禁。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_MIN_AGE_MS,
  TEST_TEMP_PREFIXES,
  normalizePathForCompare,
  reclaimTestTempDirs,
  userDataDirsFromCommandLines
} from '../helpers/temp-dirs'

const TESTS_ROOT = fileURLToPath(new URL('../', import.meta.url))
const OLD = 60 * 60 * 1000   // 1 小时前（早于默认 10 分钟阈值）

let sandbox = ''
/** 本 spec 自己创建的临时目录必须全部登记并清理——本门禁要防的正是「测试泄漏临时目录」 */
let outside = ''
afterEach(() => {
  for (const dir of [sandbox, outside]) {
    if (dir) { rmSync(dir, { recursive: true, force: true }) }
  }
  sandbox = ''
  outside = ''
})

/** 造一个隔离的「临时目录根」+ 若干子目录，全部回溯到 1 小时前 */
function makeSandbox(names: string[]): { root: string; paths: Record<string, string> } {
  sandbox = mkdtempSync(join(tmpdir(), 'cy-tmpdirs-sandbox-'))
  const paths: Record<string, string> = {}
  for (const name of names) {
    const p = join(sandbox, name)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'f.txt'), 'x')
    const old = new Date(Date.now() - OLD)
    utimesSync(p, old, old)
    paths[name] = p
  }
  return { root: sandbox, paths }
}

describe('reclaimTestTempDirs 行为（P2-6）', () => {
  it('命中允许表前缀的旧目录被回收，未命中的原样保留（不用通配）', () => {
    const { root } = makeSandbox(['cy-creds-abc123', 'cy-settings-def456', 'my-other-app-tmp', 'electron-cache'])
    const result = reclaimTestTempDirs({ tmpRoot: root, prefixes: ['cy-creds-', 'cy-settings-'], minAgeMs: 60_000, now: Date.now() })

    expect(result.removed.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['cy-creds-abc123', 'cy-settings-def456'])
    const left = readdirSync(root).sort()
    expect(left, '非本仓库命名空间的目录绝不能被删').toEqual(['electron-cache', 'my-other-app-tmp'])
  })

  it('目录过新 → 跳过（防误删并发运行中的另一个套件）', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'cy-tmpdirs-sandbox-'))
    const fresh = join(sandbox, 'cy-creds-fresh')
    mkdirSync(fresh, { recursive: true })   // mtime = 现在

    const result = reclaimTestTempDirs({ tmpRoot: sandbox, prefixes: ['cy-creds-'], now: Date.now() })

    expect(result.removed).toEqual([])
    expect(result.skippedRecent).toEqual([fresh])
    expect(readdirSync(sandbox)).toEqual(['cy-creds-fresh'])
  })

  it('被活进程引用的目录跳过——**含子路径引用**（Electron 子进程写 <dir>/Cyrene）', () => {
    const { root, paths } = makeSandbox(['cy-int-ud-inuse', 'cy-int-ud-orphan'])
    const inUse = [`${paths['cy-int-ud-inuse']}\\Cyrene`, `${paths['cy-int-ud-inuse']}/Cyrene/Local Storage`]

    const result = reclaimTestTempDirs({ tmpRoot: root, prefixes: ['cy-int-ud-'], inUsePaths: inUse, minAgeMs: 60_000, now: Date.now() })

    expect(result.skippedInUse).toEqual([paths['cy-int-ud-inuse']])
    expect(result.removed).toEqual([paths['cy-int-ud-orphan']])
    expect(readdirSync(root), '在用的那个目录必须还在').toEqual(['cy-int-ud-inuse'])
  })

  it('符号链接不跟随（即使名字命中前缀）——避免顺着链接删到别处', () => {
    sandbox = mkdtempSync(join(tmpdir(), 'cy-tmpdirs-sandbox-'))
    // 链接目标同样登记在沙箱清单里（本 spec 自己也不能泄漏临时目录——它正是本门禁要防的事）
    outside = mkdtempSync(join(tmpdir(), 'cy-outside-target-'))
    writeFileSync(join(outside, 'important.txt'), 'keep me')
    const link = join(sandbox, 'cy-creds-link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return   // 平台不允许创建链接（缺权限）：跳过本用例而非假绿（outside 由 afterEach 清理）
    }

    const result = reclaimTestTempDirs({ tmpRoot: sandbox, prefixes: ['cy-creds-'], minAgeMs: 0, now: Date.now() + OLD })

    expect(result.removed, '链接本身不得被回收').toEqual([])
    expect(readFileSync(join(outside, 'important.txt'), 'utf8'), '链接目标必须完好').toBe('keep me')
  })

  it('只处理临时根的直接子目录：嵌套目录不递归回收', () => {
    const { root } = makeSandbox(['cy-creds-outer'])
    const nested = join(root, 'cy-creds-outer', 'cy-creds-inner')
    mkdirSync(nested)
    // 注意顺序：创建子目录会**更新父目录 mtime**，故必须在建完嵌套之后再把父目录回溯（否则父目录被判「过新」）
    const old = new Date(Date.now() - OLD)
    utimesSync(nested, old, old)
    utimesSync(join(root, 'cy-creds-outer'), old, old)

    const result = reclaimTestTempDirs({ tmpRoot: root, prefixes: ['cy-creds-'], minAgeMs: 60_000, now: Date.now() })

    expect(result.scanned, '只扫一层：内层不计入 scanned').toBe(1)
    expect(result.removed).toEqual([join(root, 'cy-creds-outer')])
  })

  it('单条删除失败只记录，不抛出也不中断其余回收', () => {
    const { root } = makeSandbox(['cy-creds-a', 'cy-creds-b'])
    const remove = vi.fn((path: string) => {
      if (path.endsWith('cy-creds-a')) throw new Error('EBUSY: 被占用')
      rmSync(path, { recursive: true, force: true })
    })

    const result = reclaimTestTempDirs({ tmpRoot: root, prefixes: ['cy-creds-'], minAgeMs: 60_000, now: Date.now(), remove })

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].error).toContain('EBUSY')
    expect(result.removed.map((p) => p.split(/[\\/]/).pop())).toEqual(['cy-creds-b'])
  })

  it('临时根不可读 → 什么都不做（不抛、不误报）', () => {
    const result = reclaimTestTempDirs({
      tmpRoot: 'C:/definitely/not/here',
      prefixes: TEST_TEMP_PREFIXES,
      readdir: () => { throw new Error('ENOENT') }
    })
    expect(result).toEqual({ scanned: 0, removed: [], skippedInUse: [], skippedRecent: [], failed: [] })
  })

  it('默认阈值是 10 分钟（足够大以避开并发套件，又足够小让泄漏在下一次运行被清）', () => {
    expect(DEFAULT_MIN_AGE_MS).toBe(10 * 60 * 1000)
  })
})

describe('辅助函数', () => {
  it('normalizePathForCompare 统一分隔符与结尾斜杠（Windows 下另做小写归一）', () => {
    expect(normalizePathForCompare('C:\\Users\\x\\tmp\\')).toBe(process.platform === 'win32' ? 'c:/users/x/tmp' : 'C:/Users/x/tmp')
    expect(normalizePathForCompare('/tmp/a//')).toBe('/tmp/a')
  })

  it('userDataDirsFromCommandLines 提取带引号与不带引号的两种写法', () => {
    const dirs = userDataDirsFromCommandLines([
      '"exe" --type=renderer --user-data-dir="C:\\tmp\\cy-int-ud-A/Cyrene" --x',
      'exe --inspect=0 --user-data-dir=/tmp/cy-int-ud-B',
      'exe 无该开关'
    ])
    expect(dirs).toEqual(['C:\\tmp\\cy-int-ud-A/Cyrene', '/tmp/cy-int-ud-B'])
  })
})

describe('防漂移：允许表必须覆盖测试源码里出现的所有 mkdtemp 前缀（P2-6 门禁）', () => {
  /** 递归收集测试源码（.ts），跳过本模块自身与快照/夹具目录 */
  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === '__snapshots__') continue
        collectSourceFiles(path, out)
        continue
      }
      if (entry.name.endsWith('.ts')) out.push(path)
    }
    return out
  }

  // 显式超时（2026-09-13）：本用例要遍历整个 tests/ 树读每个文件，是纯 I/O 扫描；
  // 全套并行跑（250+ 文件同时抢磁盘）时实测 6.6s > 默认 5000ms 而**超时失败**（单跑仅 88ms）。
  // 断言一字未改，只给这个扫描用例留出预算——超时不是判别力，是环境噪声。
  it('每个 mkdtemp 前缀都在 TEST_TEMP_PREFIXES 里登记（新前缀必须来登记，否则本用例变红）', () => {
    const files = collectSourceFiles(TESTS_ROOT).filter((f) => !f.endsWith('temp-dirs.ts'))
    const discovered = new Map<string, string>()   // prefix → 首个出处
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/mkdtemp(?:Sync)?\(\s*(?:join\(\s*tmpdir\(\)\s*,\s*)?'([^']+)'/g)) {
        const prefix = match[1]
        if (!discovered.has(prefix)) discovered.set(prefix, file.slice(TESTS_ROOT.length).replace(/\\/g, '/'))
      }
    }

    // 解析器退化哨兵：扫不到任何前缀说明正则/遍历坏了，那时下面的断言会恒真
    expect(discovered.size, '未扫到任何 mkdtemp 前缀——解析器或遍历已失效，本门禁失去判别力').toBeGreaterThan(20)

    const unregistered = [...discovered.entries()]
      .filter(([prefix]) => !TEST_TEMP_PREFIXES.includes(prefix))
      .map(([prefix, where]) => `${prefix}（${where}）`)
    expect(unregistered, `以下 mkdtemp 前缀未登记到 TEST_TEMP_PREFIXES，会被永久泄漏在 $TEMP：\n${unregistered.join('\n')}`).toEqual([])
  }, 30_000)

  it('允许表里没有已无人使用的前缀（防反向漂移：删了 spec 却留着条目）', () => {
    const files = collectSourceFiles(TESTS_ROOT).filter((f) => !f.endsWith('temp-dirs.ts'))
    const used = new Set<string>()
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/mkdtemp(?:Sync)?\(\s*(?:join\(\s*tmpdir\(\)\s*,\s*)?'([^']+)'/g)) used.add(match[1])
    }
    // 允许表可能含「暂时无人使用但已登记的」条目：这些由本用例点名，便于清理
    const stale = TEST_TEMP_PREFIXES.filter((prefix) => !used.has(prefix))
    expect(stale, `TEST_TEMP_PREFIXES 中已无对应 mkdtemp 调用的条目（可删除）：\n${stale.join('\n')}`).toEqual([])
  })
})
