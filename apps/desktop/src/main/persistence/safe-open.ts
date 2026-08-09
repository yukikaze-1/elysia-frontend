import { constants } from 'fs'
import { lstat, open, realpath } from 'fs/promises'
import { relative } from 'path'
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

const isPosix = process.platform !== 'win32'

async function assertContained(filePath: string, safeRoot: string): Promise<void> {
  const real = await realpath(filePath).catch(() => { throw new SafeOpenError(`${filePath} 无法解析真实路径`) })
  const rel = relative(safeRoot, real)
  if (rel.startsWith('..') || rel.includes('..')) throw new SafeOpenError(`${filePath} 逃逸安全根`)
}

/**
 * 文件形态安全打开（地基 spec §5.2 step 5）：
 * create+append = O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW + fchmod 0600（首建）；
 * existing+append 复核 (mode&0o600)===0o600 && (mode&0o077)===0；existing+read 复核 (mode&0o400)===0o400。
 * 打开后 realpath 包含性复核。POSIX 用 O_NOFOLLOW 拦最后一段；Windows 无该常量 → lstat 拒 symlink + realpath。
 */
export async function openSafeFile(filePath: string, opts: SafeOpenOptions): Promise<SafeOpenResult> {
  const onConflict = opts.onConflict ?? 'fallback'
  if (isPosix) {
    const flags = opts.mode === 'create'
      ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
      : opts.purpose === 'read'
        ? constants.O_RDONLY | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
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
            fd = await open(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
          } else throw new SafeOpenError(`${filePath} 打开失败（可能是符号链接）`)
        }
      } else {
        fd = await open(filePath, flags)
      }
    } catch (e: unknown) {
      if (e instanceof SafeOpenError) throw e
      if (opts.mode === 'existing' && (e as NodeJS.ErrnoException).code === 'ENOENT') throw e // 保留 ENOENT：调用方（credential-store readFile）据此判「文件不存在」
      throw new SafeOpenError(`${filePath} 打开失败`)
    }
    try {
      if (created) await fd.chmod(0o600) // 兜底修正 umask（open mode 参数已被掩，fchmod 直接到 inode）
      else {
        const st = await fd.stat()
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
  // Windows：无 O_NOFOLLOW——lstat 拒 symlink + open + realpath 包含性（不校验 mode，NTFS 合成值）
  const st = await lstat(filePath).catch(() => { throw new SafeOpenError(`${filePath} 无法检查`) })
  if (st.isSymbolicLink()) throw new SafeOpenError(`${filePath} 为符号链接`)
  const flags = opts.mode === 'create'
    ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    : opts.purpose === 'read' ? constants.O_RDONLY : constants.O_WRONLY | constants.O_APPEND
  let created = false
  let fd: FileHandle
  try {
    if (opts.mode === 'create') {
      try { fd = await open(filePath, flags, 0o600); created = true }
      catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          if (onConflict === 'error') throw new SafeOpenConflictError(`${filePath} 已存在`)
          fd = await open(filePath, opts.purpose === 'read' ? constants.O_RDONLY : constants.O_WRONLY | constants.O_APPEND)
        } else throw new SafeOpenError(`${filePath} 打开失败`)
      }
    } else fd = await open(filePath, flags)
  } catch (e: unknown) {
    if (e instanceof SafeOpenError) throw e
    if (opts.mode === 'existing' && (e as NodeJS.ErrnoException).code === 'ENOENT') throw e // 保留 ENOENT（同 POSIX 分支）
    throw new SafeOpenError(`${filePath} 打开失败`)
  }
  try { await assertContained(filePath, opts.safeRoot); return { fd, created } }
  catch (e: unknown) { await fd.close().catch(() => {}); throw e }
}
