import { constants } from 'fs'
import { lstat, open, realpath } from 'fs/promises'
import { relative, isAbsolute, sep } from 'path'
import type { FileHandle } from 'fs/promises'

export class SafeOpenError extends Error {
  constructor(message: string) { super(message); this.name = 'SafeOpenError' }
}
export class SafeOpenConflictError extends SafeOpenError {}

export interface SafeOpenOptions {
  mode: 'create' | 'existing'
  purpose: 'append' | 'read'
  safeRoot: string
  onConflict?: 'fallback' | 'error'
}
export interface SafeOpenResult { fd: FileHandle; created: boolean }

/** 平台差异抽象（决策 A1）：Windows 语义可注入，Linux 单测覆盖两条分支 */
export interface SafeOpenPlatform {
  readonly kind: 'posix' | 'windows'
  readonly createFlags: number        // O_CREAT|O_EXCL|O_WRONLY（posix 追加 O_NOFOLLOW）
  readonly existingReadFlags: number  // O_RDONLY（posix 追加 O_NOFOLLOW|O_NONBLOCK）
  readonly existingWriteFlags: number // O_WRONLY|O_APPEND（posix 追加 O_NOFOLLOW|O_NONBLOCK）
  readonly preOpenLstat: boolean      // windows：open 前 lstat 拒 symlink（无 O_NOFOLLOW）
  readonly checkModeMask: boolean     // posix：existing 校验权限位；windows 跳过（NTFS 合成）
}

export const posixPlatform: SafeOpenPlatform = {
  kind: 'posix',
  createFlags: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
  existingReadFlags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  existingWriteFlags: constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  preOpenLstat: false,
  checkModeMask: true
}

export const windowsPlatform: SafeOpenPlatform = {
  kind: 'windows',
  createFlags: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  existingReadFlags: constants.O_RDONLY,
  existingWriteFlags: constants.O_WRONLY | constants.O_APPEND,
  preOpenLstat: true,
  checkModeMask: false
}

export function defaultSafeOpenPlatform(): SafeOpenPlatform {
  return process.platform === 'win32' ? windowsPlatform : posixPlatform
}

async function assertContained(filePath: string, safeRoot: string): Promise<void> {
  // 两侧都 realpath（Windows CI tmpdir 返回 8.3 短名、realpath 解析长名，relative 误判逃逸的根因修复）
  const [safe, real] = await Promise.all([realpath(safeRoot), realpath(filePath)])
    .catch(() => { throw new SafeOpenError(`${filePath} 无法解析真实路径`) })
  const rel = relative(safe, real)
  // C-13（#28 复核）：Windows 跨盘符时 relative 返回绝对路径（startsWith('..')/includes('..') 均 false 会放行）——
  // 补 isAbsolute(rel) 判定，一致收口（与 corrupt-isolation.ts 同款）。
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new SafeOpenError(`${filePath} 逃逸安全根`)
}

/** pre-open lstat（windows）：ENOENT 按模式分流、symlink 拒、其他转安全错误 */
async function preOpenCheck(filePath: string, mode: SafeOpenOptions['mode']): Promise<void> {
  let st
  try {
    st = await lstat(filePath)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (mode === 'create') return // create+ENOENT：放行进入 O_CREAT|O_EXCL
      throw e // existing+ENOENT：原样抛原始 errno（不得包 SafeOpenError，readFile 据此判「文件不存在」）
    }
    throw new SafeOpenError(`${filePath} 无法检查`)
  }
  if (st.isSymbolicLink()) throw new SafeOpenError(`${filePath} 为符号链接`)
}

export async function openSafeFile(filePath: string, opts: SafeOpenOptions, platform: SafeOpenPlatform = defaultSafeOpenPlatform()): Promise<SafeOpenResult> {
  const onConflict = opts.onConflict ?? 'fallback'
  if (platform.preOpenLstat) await preOpenCheck(filePath, opts.mode)
  const flags = opts.mode === 'create'
    ? platform.createFlags
    : opts.purpose === 'read' ? platform.existingReadFlags : platform.existingWriteFlags
  let fd: FileHandle
  let created = false
  try {
    if (opts.mode === 'create') {
      try {
        fd = await open(filePath, flags, 0o600)
        created = true
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          if (onConflict === 'error') throw new SafeOpenConflictError(`${filePath} 已存在`)
          fd = await open(filePath, opts.purpose === 'read' ? platform.existingReadFlags : platform.existingWriteFlags)
        } else throw new SafeOpenError(`${filePath} 打开失败（可能是符号链接）`)
      }
    } else {
      fd = await open(filePath, flags)
    }
  } catch (e: unknown) {
    if (e instanceof SafeOpenError) throw e
    if (opts.mode === 'existing' && (e as NodeJS.ErrnoException).code === 'ENOENT') throw e // 保留 ENOENT
    throw new SafeOpenError(`${filePath} 打开失败`)
  }
  try {
    const st = await fd.stat()
    if (!st.isFile()) throw new SafeOpenError(`${filePath} 非普通文件`) // 统一不变量：拒 FIFO/socket/目录/device
    if (created) await fd.chmod(0o600) // 兜底修正 umask
    else if (platform.checkModeMask) {
      const mask = opts.purpose === 'read' ? 0o400 : 0o600
      if ((st.mode & mask) !== mask || (st.mode & 0o077) !== 0) {
        throw new SafeOpenError(`${filePath} 权限不正确（需 ${opts.purpose === 'read' ? '0400' : '0600'}，无 group/other 位）`)
      }
    }
    await assertContained(filePath, opts.safeRoot)
    return { fd, created }
  } catch (e: unknown) {
    await fd.close().catch(() => {})
    throw e
  }
}
