import { constants } from 'fs'
import { mkdirSync } from 'fs'
import { chmod, lstat, mkdir, open, realpath } from 'fs/promises'
import { join, relative } from 'path'

export interface UserDataDirs {
  config: string
  appCache: string
  logs: string
  audit: string
  temp: string
  models: string
  sandbox: string
}

export class UserDataDirError extends Error {
  constructor(message: string) { super(message); this.name = 'UserDataDirError' }
}

const LEAF_NAMES = ['config', 'app-cache', 'logs', 'audit', 'temp', 'models', 'sandbox'] as const

const isPosix = process.platform !== 'win32'
const hasFdAnchor = process.platform === 'linux' || process.platform === 'darwin'

async function assertSafeLeaf(path: string, safeRoot: string): Promise<void> {
  // lstat 否定判定：非目录（含 symlink/FIFO/设备）→ 拒绝
  let st
  let created = false
  try { st = await lstat(path) } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // mkdir EEXIST（lstat 后并发创建）→ 视为既有继续，不判致命（与 base 同纪律）
      await mkdir(path, { mode: 0o700 }).catch(() => { /* EEXIST 忽略，下面 lstat 复核 */ })
      created = true
      st = await lstat(path).catch(() => { throw new UserDataDirError(`无法检查新建子目录 ${path}`) })
    } else throw new UserDataDirError(`无法检查 userData 子目录 ${path}`)
  }
  if (!st.isDirectory()) throw new UserDataDirError(`${path} 不是目录或为符号链接`)
  if (isPosix) {
    // POSIX：O_NOFOLLOW|O_DIRECTORY 原子复核（Windows 无这些常量，flags=NaN 会拒——跳过该步，用 lstat+realpath）
    // 新建叶子先路径 chmod 修正 umask（restrictive umask 下 open(O_RDONLY|O_DIRECTORY) 会 EACCES 被误报为符号链接）——与 base 同款
    if (created) await chmod(path, 0o700).catch(() => {})
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY).catch(() => {
      throw new UserDataDirError(`${path} 打开失败（可能是符号链接）`)
    })
    try {
      const fs = await fd.stat()
      if (!fs.isDirectory()) throw new UserDataDirError(`${path} 非真实目录`)
      // 完整规则：owner rwx 齐全 + 无 group/other（只查 group/other 位会放行 0300/0400/0600 不可用 mode）
      if (!created && ((fs.mode & 0o700) !== 0o700 || (fs.mode & 0o077) !== 0)) {
        throw new UserDataDirError(`${path} 权限不正确，请执行 chmod 700`)
      }
      const real = await realpath(path)
      const rel = relative(safeRoot, real)
      if (rel.startsWith('..') || rel.includes('..')) throw new UserDataDirError(`${path} 逃逸 userData 根`)
      await fd.chmod(0o700) // 新建目录修正 umask；既有已过 0700 检查则幂等
    } finally {
      await fd.close()
    }
  } else {
    const real = await realpath(path)
    const rel = relative(safeRoot, real)
    if (rel.startsWith('..') || rel.includes('..')) throw new UserDataDirError(`${path} 逃逸 userData 根`)
  }
}

export async function ensureUserDataDirs(base: string, options?: { baseCreated?: boolean }): Promise<UserDataDirs> {
  // base：lstat 否定判定 + mkdir（非 recursive 由调用方 installAppIdentity 预建，此处幂等）
  let baseSt
  let localCreated = false
  try { baseSt = await lstat(base) } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      try { mkdirSync(base, { mode: 0o700 }) } catch { throw new UserDataDirError(`无法创建 userData 根 ${base}`) }
      localCreated = true
      baseSt = await lstat(base)
    } else throw new UserDataDirError(`无法检查 userData 根 ${base}`)
  }
  if (!baseSt.isDirectory()) throw new UserDataDirError(`${base} 不是目录或为符号链接`)
  const createdThisRun = options?.baseCreated || localCreated

  // safeRoot：Linux/macOS 用 fd 锚点，Windows 用 realpath(base)
  let safeRoot: string
  if (isPosix && hasFdAnchor) {
    // createdThisRun 且 POSIX：先路径 chmod（刚创建的 base 不会被人换链，安全），避免 0o000 umask 下 open EACCES 使 fchmod 不可达
    if (createdThisRun) await chmod(base, 0o700).catch(() => {})
    const fd = await open(base, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY).catch(() => {
      throw new UserDataDirError(`${base} 打开失败（可能是符号链接）`)
    })
    try {
      const fs = await fd.stat()
      if (!fs.isDirectory()) throw new UserDataDirError(`${base} 非真实目录`)
      // 完整规则：owner rwx 齐全 + 无 group/other；createdThisRun（本次新建）时跳过，fchmod 修正 umask
      if (!createdThisRun && ((fs.mode & 0o700) !== 0o700 || (fs.mode & 0o077) !== 0)) {
        throw new UserDataDirError(`${base} 权限不正确，请执行 chmod 700`)
      }
      if (isPosix && createdThisRun) await fd.chmod(0o700)
      // fd 锚点：Linux /proc/self/fd，macOS /dev/fd；解析失败或解析回 fd 自身（fdescfs 不解析到真实路径）→ 回退 realpath(base)
      const fdPath = process.platform === 'darwin' ? `/dev/fd/${fd.fd}` : `/proc/self/fd/${fd.fd}`
      safeRoot = await realpath(fdPath).then(
        (r) => (r.startsWith('/dev/fd/') || r.startsWith('/proc/self/fd/') ? realpath(base) : r),
        () => realpath(base)
      )
    } finally {
      await fd.close()
    }
  } else {
    safeRoot = await realpath(base)
  }

  const out = {} as UserDataDirs
  for (const name of LEAF_NAMES) {
    const p = join(base, name)
    await assertSafeLeaf(p, safeRoot)
    ;(out as unknown as Record<string, string>)[name === 'app-cache' ? 'appCache' : name] = p
  }
  return out
}
