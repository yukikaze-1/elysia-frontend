import { constants } from 'fs'
import { realpath, rename, unlink } from 'fs/promises'
import { basename, dirname, join, relative } from 'path'
import { openSafeFile, SafeOpenConflictError } from '../persistence/safe-open'

const isPosix = process.platform !== 'win32'

async function assertParentContained(filePath: string, safeRoot: string): Promise<string> {
  const dir = dirname(filePath)
  // 两侧都 realpath（Windows 下 tmpdir 可能返回 8.3 短名而 realpath 解析为长名，relative 会误判逃逸）：
  // safeRoot 若不归一化，relative(短名, 长名) 产生 `..` → 假阳性拒绝。归一化后同形式比较。
  const [safe, real] = await Promise.all([realpath(safeRoot), realpath(dir)])
    .catch(() => { throw new Error('父目录无法解析') })
  const rel = relative(safe, real)
  if (rel.startsWith('..') || rel.includes('..')) throw new Error(`父目录逃逸安全根（${real}）`)
  return real
}

/**
 * 原子替换写（多 key 凭据文件整文件改写，崩溃/中断不截断）：
 * 同目录 temp O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW 0o600 → fchmod 兜底 → 写 + fsync(fd) → rename 覆盖
 * → POSIX fsync(dir)（Windows 跳过，记录平台差异）。写前父目录 realpath 包含性复核。
 * EEXIST = 陈旧 temp（单实例无并发写者）→ unlink 重试一次（仍 EEXIST → 抛），不留永久砖。
 */
export async function atomicWriteFile(filePath: string, data: string, opts: { safeRoot: string }): Promise<void> {
  await assertParentContained(filePath, opts.safeRoot)
  const dir = dirname(filePath)
  const tmp = join(dir, `${basename(filePath)}.tmp`)

  const writeTemp = async (): Promise<void> => {
    const { fd } = await openSafeFile(tmp, { mode: 'create', purpose: 'append', safeRoot: opts.safeRoot, onConflict: 'error' })
    try {
      await fd.writeFile(data, 'utf8')
      await fd.sync()
    } finally {
      await fd.close()
    }
  }

  try {
    await writeTemp()
  } catch (e: unknown) {
    if (e instanceof SafeOpenConflictError) {
      await unlink(tmp).catch(() => {}) // 陈旧 temp：unlink 重试一次
      await writeTemp()
    } else throw e
  }

  await rename(tmp, filePath)

  if (isPosix) {
    const dirFd = await import('fs/promises').then((m) => m.open(dir, constants.O_RDONLY | constants.O_DIRECTORY))
    try { await dirFd.sync() } finally { await dirFd.close() }
  }
}
