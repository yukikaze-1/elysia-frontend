import * as fs from 'node:fs'
import * as path from 'node:path'
import os from 'node:os'

export class PolicyError extends Error {
  constructor(public code: 'PATH_UNSAFE', message: string) { super(message) }
}

/** 路径黑名单默认集（D6B-02：realpath 后段边界匹配；exactFile=精确文件项；pathSeg=路径段精确项） */
export interface BlacklistEntry { root: string; exactFile?: boolean; pathSeg?: boolean }
export const PATH_BLACKLIST_DEFAULTS: BlacklistEntry[] = [
  { root: '/etc' }, { root: '/usr' }, { root: '/bin' }, { root: '/sbin' }, { root: '/boot' },
  { root: '/lib' }, { root: '/lib64' }, { root: '/proc' }, { root: '/sys' }, { root: '/dev' },
  { root: '/root' }, { root: '/run' }, { root: '/var' }, { root: '/lost+found' }, { root: '/snap' },
  { root: '/opt' }, { root: '/tmp' },
  { root: '~/.ssh' }, { root: '~/.config' }, { root: '~/.gnupg' }, { root: '~/.password-store' },
  { root: '~/.aws' }, { root: '~/.npm' }, { root: '~/.cache' }, { root: '~/.local' },
  { root: '~/.mozilla' }, { root: '~/.netrc', exactFile: true }, { root: '~/.bash_history', exactFile: true },
  { root: '~/.Xauthority', exactFile: true }, { root: '~/.pki' }, { root: '~/.git-credentials', exactFile: true },
  { root: '.env', exactFile: true }, { root: '.pypirc', exactFile: true }, { root: '.dockercfg', exactFile: true },
  { root: '.kube/config', pathSeg: true },
  // Windows（大小写不敏感由 normalized lower 比较保证；8.3 短名 canonicalize 见 normalizeToolPath）
  { root: 'C:\\Windows' }, { root: 'C:\\Program Files' }, { root: 'C:\\Program Files (x86)' },
  { root: 'C:\\ProgramData' }, { root: 'C:\\System Volume Information' }, { root: 'C:\\$Recycle.Bin' },
  { root: '~\\AppData' }, { root: '~\\AppData\\Local\\Temp' },
]

export type PolicyPlatform = 'posix' | 'windows'

function pathResolver(platform: PolicyPlatform): path.PlatformPath {
  return platform === 'windows' ? path.win32 : path.posix
}

export function isPathBlacklisted(
  normalized: string,
  blacklist: BlacklistEntry[] = PATH_BLACKLIST_DEFAULTS,
  opts: { currentHome?: string; platform?: PolicyPlatform } = {},
): boolean {
  const platform = opts.platform ?? (process.platform === 'win32' ? 'windows' : 'posix')
  const resolver = pathResolver(platform)
  const sep = resolver.sep
  const home = opts.currentHome ?? os.homedir()
  const lower = platform === 'windows' ? normalized.toLowerCase() : normalized
  for (const entry of blacklist) {
    let root = entry.root
    if (root.startsWith('~')) root = resolver.join(home, root.slice(1))
    const r = platform === 'windows' ? root.toLowerCase() : root
    if (entry.exactFile) {
      if (lower === r || resolver.basename(lower) === r) return true
      continue
    }
    if (entry.pathSeg) {
      // **/.kube/config 语义：任一路径段序列匹配（L5）
      const pathSeg = resolver.normalize(r)
      if (lower === pathSeg || lower.endsWith(sep + pathSeg) || lower.includes(sep + pathSeg + sep)) return true
      continue
    }
    // 段边界前缀（等于 root 或以 root+分隔符开头）
    if (lower === r || lower.startsWith(r + sep)) return true
  }
  // /home/* 排除当前用户（POSIX）
  if (platform !== 'windows') {
    const h = home.replace(/\/+$/, '')
    const m = lower.match(/^\/home\/[^/]+(?:\/|$)/)
    if (m && !(lower === h || lower.startsWith(h + sep))) return true
  }
  return false
}

/** Compare a canonical path against an allowed root using the selected platform's separator/case rules. */
export function isPathWithinRoot(realPath: string, root: string, platform: PolicyPlatform): boolean {
  const resolver = pathResolver(platform)
  const candidate = resolver.normalize(realPath)
  const normalizedRoot = resolver.normalize(root)
  const candidateForCompare = platform === 'windows' ? candidate.toLowerCase() : candidate
  const rootForCompare = platform === 'windows' ? normalizedRoot.toLowerCase() : normalizedRoot
  const relative = resolver.relative(rootForCompare, candidateForCompare)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${resolver.sep}`) && !resolver.isAbsolute(relative))
}

export interface NormalizeOpts { platform?: PolicyPlatform; realPath?: (p: string) => string }

/** full realpath（含父链；新建写场景 dirname realpath + basename 拼接，H-3）；Windows 保留名/ADS/\\?\ 拒 */
export function normalizeToolPath(rawPath: string, opts: NormalizeOpts = {}): { realPath: string; exists: boolean } {
  const realPathFn = opts.realPath ?? ((p: string) => fs.realpathSync.native(p))
  const platform = opts.platform ?? (process.platform === 'win32' ? 'windows' : 'posix')
  // A-9/新发现3/M7：POSIX 主机上 path 是 posix——Windows 语义必须用 path.win32（resolve/dirname/basename/join 全用）
  const resolver = pathResolver(platform)
  if (!rawPath || rawPath.length === 0) throw new PolicyError('PATH_UNSAFE', 'empty path')
  if (platform === 'windows') {
    const lower = rawPath.toLowerCase()
    if (lower.startsWith('\\\\.\\') || lower.startsWith('\\\\?\\')) throw new PolicyError('PATH_UNSAFE', 'device path')
    if (lower.startsWith('\\\\')) throw new PolicyError('PATH_UNSAFE', 'UNC 网络共享默认拒')
    if (resolver.basename(rawPath).includes(':')) throw new PolicyError('PATH_UNSAFE', 'ADS path')
    const base = resolver.basename(rawPath).split('.')[0].toUpperCase()
    if (/^(CON|NUL|PRN|AUX|COM[1-9]|LPT[1-9])$/.test(base)) throw new PolicyError('PATH_UNSAFE', 'reserved name')
  }
  let realPath: string
  try {
    realPath = realPathFn(resolver.resolve(rawPath))
  } catch (err) {
    // M2（review 跟进）：仅目标不存在（ENOENT/ENOTDIR——新建写场景）走父目录回退；
    // 其余失败（EACCES 末级 symlink 目标不可遍历/ELOOP 等）→ PATH_UNSAFE（H-3 逃逸即拒，防未解析路径绕过黑名单）
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new PolicyError('PATH_UNSAFE', 'unresolvable path')
    const dir = resolver.dirname(resolver.resolve(rawPath))
    try { realPath = resolver.join(realPathFn(dir), resolver.basename(resolver.resolve(rawPath))) }
    catch { throw new PolicyError('PATH_UNSAFE', 'unresolvable parent') }
  }
  return { realPath, exists: fs.existsSync(realPath) }
}

export function isDomainAllowed(url: string, allowedOrigin: string): boolean {
  try { return new URL(url).origin === new URL(allowedOrigin).origin }
  catch { return false }
}

/** 风险等级（与 `RegisteredTool.localRisk`、审计 `riskLevel` 同一枚举） */
export type RiskLevel = 'safe' | 'medium' | 'high'

const RISK_ORDER: Record<RiskLevel, number> = { safe: 0, medium: 1, high: 2 }

/**
 * D4-1（2026-09-15 裁决「补代码」）：把 wire 上报的风险值归一为本地风险枚举。
 *
 * **未知/畸形取值一律归 `high`**（不是忽略、也不是 `safe`）：外部输入畸形时按最严处理，
 * 对齐仓库约束「未知或畸形的外部输入显式失败，不得静默降级」。`undefined`/空串 = 后端未上报。
 */
export function normalizeReportedRisk(raw: unknown): RiskLevel | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (raw === 'safe' || raw === 'medium' || raw === 'high') return raw
  return 'high'
}

export interface LocalRiskInput {
  /** 注册表静态等级（本地定义，doc 04 §2） */
  base: RiskLevel
  /** 后端 `tool.request.riskLevel` 上报值（原始 unknown；非枚举值按 high 处理） */
  reported?: unknown
  /** 该工具的实际参数（**重算输入**：路径类工具的风险取决于目标路径） */
  args?: Record<string, unknown>
  /** 参数已规范化后的真实路径（决策链 step 5 产物；缺省表示非路径工具或未解析） */
  realPath?: string
  /** 路径是否命中黑名单（黑名单优先级最高，命中即 high） */
  blacklisted?: boolean
  /** 生效的预授权目录（沙盒）——路径落在其中时为受控低风险 */
  sandboxRoots?: readonly string[]
  /** 平台（沙盒包含性比较用） */
  platform?: PolicyPlatform
}

/**
 * 本地风险重算（D4-1 落地形状）。doc 04 §7.4 口径：**只能不低于后端上报值，绝不因为后端说低就降低**。
 *
 * 规则（顺序即优先级，全部单调不降）：
 * 1. 黑名单命中 → `high`（与 §7.4「黑名单永远压过一切」一致）；
 * 2. 取 `base` 与归一后的后端上报值的**较大者**（本地风险覆盖后端风险，doc 08 §…「本地风险覆盖后端风险」）；
 * 3. **参数升级（仅路径类工具）**——风险不再只看工具名：
 *    - 写操作的目标是**已存在文件**（覆盖既有内容）→ 至少 `high`（覆盖比新建破坏性更大）；
 *    - 读/写目标落在**生效的沙盒目录**内且非黑名单 → 记为受控（不升级；`sandboxRoots` 为空即不生效）；
 *    - 其余路径类调用保持 `base` 与上报值的较大者。
 *
 * 说明：本函数是**纯函数**，不读盘、不抛错；调用方（`tool-service` 决策链）负责把真实路径与黑名单结论传进来。
 */
export function computeLocalRisk(input: LocalRiskInput): RiskLevel {
  if (input.blacklisted) return 'high'
  const reported = normalizeReportedRisk(input.reported)
  const floor = reported ? (RISK_ORDER[reported] > RISK_ORDER[input.base] ? reported : input.base) : input.base
  // 参数级升级：仅对已解析出真实路径的路径类工具生效
  if (input.realPath && input.args && Object.prototype.hasOwnProperty.call(input.args, 'content')) {
    // 写工具：目标已存在 ⇒ 覆盖既有内容（工具名不区分新建/覆盖，参数才区分）
    return 'high'
  }
  return floor
}

/**
 * 沙盒目录层（D4-15 裁决「补代码」）——F-06 拍板值 `sandboxDirectories` 为空集，故**无任何路径落在沙盒内**：
 * 本函数在空列表下恒返回 `false`，与「零预授权」的既有行为一致（不产生新的自动执行路径）。
 * 提供实现的意义在于：① 命中判据唯一化（段边界 + 平台大小写语义，不再由调用方各写一遍 `startsWith`）；
 * ② 空集语义可测；③ 将来配置预授权目录时**唯一**入口已经过黑名单与 realpath 复核。
 *
 * 注意：`path` 必须是 `normalizeToolPath` 的 realpath 产物，且调用方**必须先判黑名单**——黑名单压过沙盒。
 */
export function isPathWithinSandbox(realPath: string, sandboxRoots: readonly string[], platform: PolicyPlatform): boolean {
  for (const root of sandboxRoots) {
    if (!root) continue
    if (isPathWithinRoot(realPath, root, platform)) return true
  }
  return false
}
