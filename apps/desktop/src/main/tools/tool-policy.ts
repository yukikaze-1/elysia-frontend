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

const SEP = path.sep

export function isPathBlacklisted(
  normalized: string,
  blacklist: BlacklistEntry[] = PATH_BLACKLIST_DEFAULTS,
  opts: { currentHome?: string } = {},
): boolean {
  const home = opts.currentHome ?? os.homedir()
  const lower = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  for (const entry of blacklist) {
    let root = entry.root
    if (root.startsWith('~')) root = path.join(home, root.slice(1))
    const r = process.platform === 'win32' ? root.toLowerCase() : root
    if (entry.exactFile) {
      if (lower === r || path.basename(lower) === r) return true
      continue
    }
    if (entry.pathSeg) {
      // **/.kube/config 语义：任一路径段序列匹配（L5）
      if (lower === r || lower.endsWith(SEP + r) || lower.includes(SEP + r + SEP)) return true
      continue
    }
    // 段边界前缀（等于 root 或以 root+分隔符开头）
    if (lower === r || lower.startsWith(r + SEP)) return true
  }
  // /home/* 排除当前用户（POSIX）
  if (process.platform !== 'win32') {
    const h = home.replace(/\/+$/, '')
    const m = lower.match(/^\/home\/[^/]+(?:\/|$)/)
    if (m && !(lower === h || lower.startsWith(h + SEP))) return true
  }
  return false
}

export interface NormalizeOpts { platform?: 'posix' | 'windows'; realPath?: (p: string) => string }

/** full realpath（含父链；新建写场景 dirname realpath + basename 拼接，H-3）；Windows 保留名/ADS/\\?\ 拒 */
export function normalizeToolPath(rawPath: string, opts: NormalizeOpts = {}): { realPath: string; exists: boolean } {
  const realPathFn = opts.realPath ?? ((p: string) => fs.realpathSync.native(p))
  const platform = opts.platform ?? (process.platform === 'win32' ? 'windows' : 'posix')
  // A-9/新发现3/M7：POSIX 主机上 path 是 posix——Windows 语义必须用 path.win32（resolve/dirname/basename/join 全用）
  const resolver = platform === 'windows' ? path.win32 : path
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
