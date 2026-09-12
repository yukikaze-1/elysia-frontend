// tests/unit/verify-sensitive-e2e.spec.ts
// M-34（review 2026-09-11 P2-10）：`verify-sensitive.spec.ts` 只 import core 纯函数，**脚本本身从不被执行**——
// 56 条 ALLOWLIST、`git ls-files` 外调、两个退出码（0 干净 / 1 违规）均无测试；「禁止用通配锚定批量放行」
// 只是 verify-sensitive.mjs:15 的一句注释。本文件补上这两条腿。
//
// ── ① 端到端：spawn 真实脚本，断言两个退出码 ──
// 夹具 = 系统临时目录里另建一个 git 仓库，用 `GIT_DIR`/`GIT_WORK_TREE` 把脚本自己的
// `git rev-parse --show-toplevel`（verify-sensitive.mjs:281）指过去。于是**脚本本体零改动**被真正执行，
// 且不会顺带扫描 1185 个真实跟踪文件（那会让用例随仓库增长变慢并读到无关违规）。
//
// 夹具内容不能为空：脚本第 3 步是 fail-loud（锚定段本轮未命中任何行 → 报错，:368），而锚定命中要求
// 「该行的黑名单命中被条目放行」。所以夹具按**真实文件的真实命中行**重建——对每个 allowlist 路径，
// 只写入该文件当前真正产生黑名单命中的行（用 core 的 scanSecretsInText 现算，不 hard-code）。
// 由此得到一个由构造保证的干净树：命中的行恰被同一批条目放行（真实树本身全绿，故没有需要排除的违规行）。
// 夹具建好后先在**夹具副本**上真跑一次自检（必须是干净的），坏夹具会当场红，不会退化成假绿。
//
// ── ② allowlist 数据断言：直接钉真实 56 条 ──
// 只钉既有纪律（verify-sensitive.mjs:15），不发明新策略；实测到的既有广度问题在用例注记里如实记录，
// **不静默改扫描器**（见 describe 内注记）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SECRET_BLACKLIST,
  scanSecretsInText,
  isRuleExcludedForPath,
  isExcludedPath,
  isSelfExcludedFile,
  allowlistEntryFor,
  allowlistEntryMatches
} from '../../scripts/verify-sensitive-core.mjs'

const execFileP = promisify(execFile)

const DESKTOP_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))   // apps/desktop/tests/unit → 仓库根
const SCRIPT = fileURLToPath(new URL('../../scripts/verify-sensitive.mjs', import.meta.url))

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWLIST 字面量提取（夹具重建 + 数据断言共用）
// ─────────────────────────────────────────────────────────────────────────────

interface AllowlistEntry { path: string; anchor: RegExp; reason: string; rules?: string[] }
interface Hit { name: string; line: number; text: string }

/**
 * 从**脚本源码**取出 `const ALLOWLIST = [ … ]` 的字面量并求值。
 * 为何不 import 脚本：`verify-sensitive.mjs` 顶层带副作用（`git ls-files` + `process.exit`），
 * import 它会直接结束测试进程——这正是 M-34 所说「脚本自陈不走单测」的成因。
 * 为何不逐字段正则解析：anchor 是 RegExp 字面量，逐字段解析既脆又可能静默漏条目；整段字面量求值不会漏。
 */
function loadRealAllowlist(): AllowlistEntry[] {
  const src = readFileSync(SCRIPT, 'utf8')
  const marker = 'const ALLOWLIST = ['
  const start = src.indexOf(marker)
  if (start < 0) throw new Error(`未在脚本里找到 ${marker}（脚本结构已变，本测试的取值方式需同步）`)
  const end = src.indexOf('\n]', start)
  if (end < 0) throw new Error('未找到 ALLOWLIST 字面量结尾 "\\n]"（脚本结构已变）')
  const literal = src.slice(start + marker.length - 1, end + 2)
  const value: unknown = (0, eval)(literal)   // 只求值本仓源码里的字面量，见上方注记
  if (!Array.isArray(value) || value.length === 0) throw new Error('ALLOWLIST 求值结果不是非空数组')
  for (const e of value) {
    if (!(e?.anchor instanceof RegExp) || typeof e.path !== 'string') throw new Error(`条目形态异常：${JSON.stringify(e)}`)
  }
  return value as AllowlistEntry[]
}

const ALLOWLIST = loadRealAllowlist()
const ALLOWLIST_PATHS = [...new Set(ALLOWLIST.map((e) => e.path))].sort()
/** 脚本第 1 步的 allowlist 自检（:296-322）在本仓全部通过，故这里就是脚本的 allowlistByPath */
const ALLOWLIST_BY_PATH = new Map<string, AllowlistEntry[]>(
  ALLOWLIST_PATHS.map((rel) => [rel, ALLOWLIST.filter((e) => e.path === rel)])
)

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：按真实命中行重建（只含被放行的行）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对某文件算出「脚本口径的命中」：整文件排除/自排除跳过，再按规则去除 RULE_FILE_EXCLUSIONS。
 * 与 verify-sensitive.mjs:334-348 同口径（core 的纯函数 + 同一过滤表达式）。
 */
function hitsOf(content: string, rel: string): Hit[] {
  return scanSecretsInText(content, SECRET_BLACKLIST).filter((h) => !isRuleExcludedForPath(h.name, rel))
}

function survivingHits(rel: string): Hit[] {
  if (isExcludedPath(rel) || isSelfExcludedFile(rel)) return []
  return hitsOf(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel)
}

/** 该文件当前**未被任何条目放行**的命中 = 脚本会在 stderr 报出的违规（真实树必须为空） */
function violationHits(rel: string): Hit[] {
  const entries = ALLOWLIST_BY_PATH.get(rel) ?? []
  return survivingHits(rel).filter((h) => allowlistEntryFor(entries, h.text, h.name) === null)
}

/** 单条目放行的命中（行号去重：同条目同一行多规则只算一次，与 allowlistEntryFor 的「一行一命中」语义一致） */
function hitsForEntry(e: AllowlistEntry): Hit[] {
  const seen = new Set<number>()
  return survivingHits(e.path).filter((h) => {
    if (seen.has(h.line) || !allowlistEntryMatches(e, h.text, h.name)) return false
    seen.add(h.line)
    return true
  })
}

/** 夹具内容：allowlist 路径 → 该文件真实被放行的行（按行号升序，保持脚本行序） */
const MIRROR = new Map<string, string[]>(
  ALLOWLIST_PATHS.map((rel) => {
    const entries = ALLOWLIST_BY_PATH.get(rel) ?? []
    return [rel, survivingHits(rel)
      .filter((h) => allowlistEntryFor(entries, h.text, h.name) !== null)
      .sort((a, b) => a.line - b.line)
      .map((h) => h.text)]
  })
)

const FIXTURE = mkdtempSync(join(tmpdir(), 'cyvs-'))

/** 脚本自排除清单指名的文件（夹具里放其副本，使夹具内部也能真跑脚本本体；core 是它的相对 import 依赖） */
const SCRIPT_FILES = [
  'apps/desktop/scripts/verify-sensitive.mjs',
  'apps/desktop/scripts/verify-sensitive-core.mjs',
  'apps/desktop/scripts/verify-sensitive-core.d.mts',
  'apps/desktop/tests/unit/verify-sensitive.spec.ts'
]

/** 在夹具仓库执行 git（夹具搭建用） */
function git(args: string[]): string {
  return execFileSync('git', ['-C', FIXTURE, ...args], { encoding: 'utf8' })
}

function trackedPaths(): string[] {
  return git(['-c', 'core.quotepath=false', 'ls-files', '-z']).split('\0').filter(Boolean)
}

interface CliResult { code: number; stdout: string; stderr: string }

/** spawn 指定脚本，用 GIT_DIR/GIT_WORK_TREE 把它的仓库根指到夹具（并清掉宿主可能带的 git 变量） */
async function runScript(scriptPath: string, extraArgs: string[] = []): Promise<CliResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  env.GIT_DIR = join(FIXTURE, '.git')
  env.GIT_WORK_TREE = FIXTURE
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      scriptPath,
      ...extraArgs
    ], { env, cwd: DESKTOP_ROOT, maxBuffer: 8 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** 失败时带上脚本输出，避免只剩一个裸 exit code */
function describeResult(r: CliResult): string {
  return `exit=${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`
}

/** 夹具内实际扫描到的命中数（读回夹具文件现算，不猜测——去重写入会改变每行的命中条数） */
function fixtureHitCount(): number {
  let n = 0
  for (const rel of ALLOWLIST_PATHS) {
    const abs = join(FIXTURE, rel)
    if (!existsSync(abs)) continue
    n += hitsOf(readFileSync(abs, 'utf8'), rel).length
  }
  return n
}

/** 夹具里会被脚本计入「扫描 N 文件」的文件数（跟踪清单去掉整文件排除/自排除） */
function fixtureScannedCount(): number {
  return trackedPaths().filter((rel) => !isExcludedPath(rel) && !isSelfExcludedFile(rel)).length
}

beforeAll(() => {
  for (const rel of [...SCRIPT_FILES, ...ALLOWLIST_PATHS]) {
    const dst = join(FIXTURE, rel)
    mkdirSync(dirname(dst), { recursive: true })
    if (SCRIPT_FILES.includes(rel)) copyFileSync(join(REPO_ROOT, rel), dst)
    else writeFileSync(dst, MIRROR.get(rel)!.length ? MIRROR.get(rel)!.join('\n') + '\n' : '')
  }
  git(['init', '-q'])
  git(['config', 'user.email', 'gate@test.invalid'])
  git(['config', 'user.name', 'gate-fixture'])
  // 夹具是字节精确的副本，关掉行尾转换（否则 Windows 上每次 add 都刷 CRLF 警告，且内容会被改写）
  git(['config', 'core.autocrlf', 'false'])
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'fixture: real allowlisted lines only'])
})

afterAll(() => {
  try { rmSync(FIXTURE, { recursive: true, force: true }) } catch { /* 尽力 */ }
})

describe('verify-sensitive 脚本端到端（M-34：真实 spawn，夹具 git 仓库）', () => {
  it('夹具前置：跟踪清单覆盖全部 allowlist 路径，夹具副本自检必须是干净树', async () => {
    // ① 夹具完整性：每个 allowlist 路径都在跟踪清单里（否则脚本第 1 步就 fail-loud，
    //    那是「夹具没满足前置条件」而不是「脚本有缺陷」）
    const tracked = trackedPaths()
    for (const rel of ALLOWLIST_PATHS) expect(tracked, `夹具缺 ${rel}`).toContain(rel)
    // ② 提取自检：56 条 / 24 个唯一 path 是真实值（verify-sensitive.mjs:38 的 249→56 重算结论）。
    //    故意硬编码：allowlist 增删必须在此留下一次 review 痕迹，而不是让夹具静默跟着变。
    expect(ALLOWLIST).toHaveLength(56)
    expect(ALLOWLIST_PATHS).toHaveLength(24)
    // ③ 夹具副本自检：坏夹具在这里就红，后面两条断言才有意义
    const self = await runScript(join(FIXTURE, 'apps/desktop/scripts/verify-sensitive.mjs'), ['--include-untracked'])
    expect(self.code, `夹具副本自检必须干净：${describeResult(self)}`).toBe(0)
    // 夹具的 24 个空文件（无命中）也要被扫到——文件数断言顺带证明「扫描面 = 夹具跟踪面」
    expect(self.stdout, describeResult(self)).toContain(`allowlist 放行 ${fixtureHitCount()} 行`)
  })

  it('干净树 → 退出码 0；扫描面/放行数来自 git ls-files 外调结果（非空跑）', async () => {
    const r = await runScript(SCRIPT)
    expect(r.code, `干净树必须 exit 0：${describeResult(r)}`).toBe(0)
    // 只说 exit 0 不够：脚本若因任何原因提前 `process.exit(0)`（或 ls-files 返回空）照样是绿的。
    // 摘要（verify-sensitive.mjs:385）钉住「确实读了夹具文件、且扫描面来自 git ls-files 外调结果」。
    expect(r.stdout, describeResult(r)).toContain(`扫描 ${fixtureScannedCount()} 文件`)
    expect(r.stdout, describeResult(r)).toContain(`allowlist 放行 ${fixtureHitCount()} 行`)
    expect(r.stdout, describeResult(r)).toContain(`黑名单 ${SECRET_BLACKLIST.length} 规则`)
    // 全部 56 条锚定段都命中（fail-loud 腿的反面）：24 个文件里 23 个写了内容、脚本无任何 fail-loud 报告
    expect(r.stderr, describeResult(r)).not.toContain('allowlist 锚定段未命中')
    expect(r.stderr, describeResult(r)).not.toContain('读取失败')
  })

  it('植入秘密 → 退出码 1，且 stderr 指名该文件与规则（检出腿可判别）', async () => {
    writeFileSync(join(FIXTURE, 'planted-secret.txt'), 'AGENT_ACCESS_TOKEN=cyrene-planted-secret-value\n')
    git(['add', '-A'])
    const r = await runScript(SCRIPT)
    // 先还原夹具（本用例是唯一弄脏夹具的用例）
    git(['rm', '-q', '--cached', 'planted-secret.txt'])
    rmSync(join(FIXTURE, 'planted-secret.txt'))
    expect(existsSync(join(FIXTURE, 'planted-secret.txt'))).toBe(false)

    expect(r.code, `植入秘密必须非零退出：${describeResult(r)}`).toBe(1)
    expect(r.stderr, describeResult(r)).toContain('planted-secret.txt')
    expect(r.stderr, describeResult(r)).toContain('agent-access-token-assign')
    expect(r.stderr, describeResult(r)).toContain('verify:sensitive 失败')
    // 违规只应来自植入文件：若脚本改成「见一个违规就整体 exit 1 且不再逐行报告」，
    // 上面三条可能仍绿，但下面这条会红（脚本一旦开始把被放行的行也当违规，这里就会冒出文件名）。
    expect(r.stderr, describeResult(r)).not.toContain('docs/')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// allowlist anchor 广度（数据断言，运行在**真实 56 条**上）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「锚是否指向具体内容」：锚的正则源码里必须含字面量片段。
 * 逐字符扫，跳过三类**非字面量**语法——`\x` 转义、`[...]` 字符类、`{n,m}` 量词
 * （`{40,}` 里的数字不是字面量：这是本函数第一版实测踩到的坑，它把 `[A-Za-z0-9+/]{40,}` 判成了有字面量）。
 * 剩下的内容才算锚真正区分的文本；纯字符类/量词构成的锚对命中行不做任何区分。
 */
function hasLiteralAnchor(source: string): boolean {
  let inClass = false
  let literal = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') { i++; continue }          // 转义序列不是字面量（\d、\+ 等）
    if (ch === '[') { inClass = true; continue }
    if (ch === ']') { inClass = false; continue }
    if (ch === '{') {                           // 量词 {n} / {n,} / {n,m} 整体跳过
      const close = source.indexOf('}', i)
      if (close > i) { i = close; continue }
    }
    if (inClass) continue
    literal += ch
  }
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(literal)
}

describe('verify-sensitive allowlist anchor 广度（真实 56 条数据断言，M-34）', () => {
  // 纪律出处：verify-sensitive.mjs:15「禁止用通配锚定批量放行」。此前它只是注释——本 describe 把它变成断言。
  // 只钉既有纪律，不发明新策略（阈值一律取「0 违规」或实测精确集合，不写「允许 N 条」那种假门禁）。
  const GENERIC_ANCHORS = ALLOWLIST.filter((e) => !hasLiteralAnchor(e.anchor.source))

  it('纯通配锚条目集合被钉死（新增即红）——注记：现有 4 条是真实欠账，不是合格线', () => {
    // 实测 4 条（全部 `rules: ['base64-long-string']` 类别级条目，锚 = /[A-Za-z0-9+/]{40,}/）：
    //   docs/superpowers/plans/2026-08-20-phase6-tools-batchb-main-exec-ui.md   放行 1 行
    //   docs/archive/plans/2026-08-09-phase1-trusted-services.md                放行 1 行
    //   apps/desktop/src/main/tools/env-bridge.ts                              放行 1 行
    //   apps/desktop/tests/unit/redact.spec.ts                                 放行 1 行
    // 它们并非无防护：rules 域把豁免限死在 base64-long-string，同文件的 Bearer/JWT 行仍会红（R2-1）。
    // 但它们的锚不指向任何具体内容——该文件未来新增的**任何像秘密的 40+ 长串**都会被静默放行，无需人工核对。
    // 按 verify-sensitive.mjs:15 的纪律，这 4 条本身就是待收窄项；本用例只负责让集合**可见**且不得扩大
    // （P2-10「allowlist 无 anchor 广度防御」要的就是这个）。收窄它们属扫描器变更，不在本任务范围内。
    expect(GENERIC_ANCHORS.map((e) => e.path).sort()).toEqual([
      'apps/desktop/src/main/tools/env-bridge.ts',
      'apps/desktop/tests/unit/redact.spec.ts',
      'docs/archive/plans/2026-08-09-phase1-trusted-services.md',
      'docs/superpowers/plans/2026-08-20-phase6-tools-batchb-main-exec-ui.md'
    ])
    for (const e of GENERIC_ANCHORS) {
      // 通配锚必须至少被 rules 域限死（否则它对**所有**规则批量放行）
      expect(e.rules, `${e.path} 的通配锚必须有 rules 域`).toEqual(['base64-long-string'])
      // 且理由必须写明是「逐文件人工核对」这一类别级依据（防有人把精确条目偷偷换成通配锚）
      expect(e.reason, `${e.path} 的通配锚理由`).toContain('人工核对')
    }
    // 逐条放行广度被钉死（= 实测值）：任何变化都必须重新人工核对
    expect(GENERIC_ANCHORS.map((e) => `${e.path}:${hitsForEntry(e).length}`).sort()).toEqual([
      'apps/desktop/src/main/tools/env-bridge.ts:1',
      'apps/desktop/tests/unit/redact.spec.ts:1',
      'docs/archive/plans/2026-08-09-phase1-trusted-services.md:1',
      'docs/superpowers/plans/2026-08-20-phase6-tools-batchb-main-exec-ui.md:1'
    ])
    // reason 里记的行数与实测一致（reason 是人工核对记录，不能与事实脱节）
    for (const e of GENERIC_ANCHORS.filter((x) => hitsForEntry(x).length > 1)) {
      expect(e.reason, `${e.path} 的 reason 行数需与实测一致`).toContain(`命中本文件 ${hitsForEntry(e).length} 行`)
    }
  })

  it('放行多行的条目必须显式限定 rules 域（R2-1）', () => {
    const offenders: string[] = []
    for (const e of ALLOWLIST) {
      const lines = hitsForEntry(e).length
      // 一个锚放行同文件多行 + 无 rules 域 = 最危险的批量放行形态：它会顺带放行同文件
      // Bearer/JWT/sk- 的真命中（真实 token 普遍 ≥40 字符，正落在这类通用锚上）
      if (lines > 1 && !(Array.isArray(e.rules) && e.rules.length > 0)) {
        offenders.push(`${e.path} ^/${e.anchor.source}/ 放行 ${lines} 行且无 rules 域`)
      }
    }
    // 实测（2026-09-11，真实树）：无一违规——所有放行 >1 行的条目都带 rules 域。
    expect(offenders, '多行锚必须用 rules 限定规则域').toEqual([])
  })

  it('真实树与脚本同口径：无未放行命中（退出码 0 的成因），且 56 条锚全部命中到行', () => {
    // ① 与脚本第 4 步同口径：任何未被条目放行的命中都会让 `pnpm verify:sensitive` exit 1。
    //    在单测里把它变成一条**可计数**断言（P2-10 要的「prefer countable signals」）。
    const violations = ALLOWLIST_PATHS.flatMap((rel) => violationHits(rel).map((v) => `${rel}:${v.line} ${v.name}`))
    expect(violations, '真实树出现未放行命中（脚本会红）').toEqual([])
    // ② 与脚本第 3 步同口径：任何锚放行 0 行 = fail-loud 报错（内容漂移）。
    const dead = ALLOWLIST.filter((e) => hitsForEntry(e).length === 0).map((e) => `${e.path} ^/${e.anchor.source}/`)
    expect(dead, '锚定段放行 0 行的条目（真实树上必红）').toEqual([])
    // ③ 放行面规模 = 真实树上 63 次命中行 + 脚本自跑摘要同值（2026-09-11 实测；本仓 verify:sensitive exit 0）。
    //    这条同时钉住「测试与真实脚本对同一批行给出同一答案」。
    const realAllowed = ALLOWLIST_PATHS.reduce((n, rel) => {
      const entries = ALLOWLIST_BY_PATH.get(rel) ?? []
      return n + survivingHits(rel).filter((h) => allowlistEntryFor(entries, h.text, h.name) !== null).length
    }, 0)
    expect(realAllowed).toBe(63)
    // ④ 反向哨兵：一条与放行无关的行不应被任何条目放行（防止锚被写成 /.*/ 之类恒真）
    const entries = ALLOWLIST_BY_PATH.get(ALLOWLIST[0].path) ?? []
    expect(allowlistEntryFor(entries, '完全无关的一行：这条行不该被任何 allowlist 条目放行', 'bearer-token')).toBe(null)
  })
})
