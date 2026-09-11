import { constants } from 'fs'
import { randomUUID } from 'node:crypto'
import { readdir, realpath, rename, stat, unlink } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { openSafeFile, SafeOpenConflictError } from '../persistence/safe-open'

const isPosix = process.platform !== 'win32'

/**
 * 陈旧 temp 的回收阈值（H-11a，2026-09-11）。
 *
 * 临时名改成带 UUID 后不再有「同名 temp 相撞」的问题，但**崩溃遗留的 temp 也不会再被下一次写
 * 顺手复用/清掉**——若不管，就把「写冲突」换成了「孤儿文件累积」（与本仓库已踩过的临时目录
 * 泄漏同类）。故每次写前顺手回收同一文件的陈旧 temp。
 *
 * 阈值取 1 小时：单次写从 open 到 rename 只有毫秒级，1 小时前的 temp 不可能是**在途**写入；
 * 且应用有单实例锁（同一 userData 只有一个进程），跨进程并发写不存在。回收是尽力而为、失败即忽略。
 */
const STALE_TEMP_MS = 60 * 60 * 1000

async function assertParentContained(filePath: string, safeRoot: string): Promise<string> {
  const dir = dirname(filePath)
  // 两侧都 realpath（Windows 下 tmpdir 可能返回 8.3 短名而 realpath 解析为长名，relative 会误判逃逸）：
  // safeRoot 若不归一化，relative(短名, 长名) 产生 `..` → 假阳性拒绝。归一化后同形式比较。
  const [safe, real] = await Promise.all([realpath(safeRoot), realpath(dir)])
    .catch(() => { throw new Error('父目录无法解析') })
  const rel = relative(safe, real)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`父目录逃逸安全根（${real}）`)
  return real
}

/** 回收同一文件的陈旧 temp（尽力而为：任何失败都不影响本次写入） */
async function sweepStaleTemps(dir: string, fileBase: string): Promise<void> {
  const prefix = `${fileBase}.`
  try {
    const names = await readdir(dir)
    const now = Date.now()
    for (const name of names) {
      if (name === fileBase || !name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const p = join(dir, name)
      try {
        const st = await stat(p)
        if (!st.isFile()) continue
        if (now - st.mtimeMs < STALE_TEMP_MS) continue
        await unlink(p)
      } catch { /* 单个失败忽略 */ }
    }
  } catch { /* 目录不可读 → 忽略 */ }
}

/**
 * 按目标路径串行化（H-11a，2026-09-11）。
 *
 * **这是本模块在 Windows 上的关键修复，比临时名更重要。** 本轮实测：20 个并发
 * `atomicWriteFile` 写同一路径，Windows 上 **5 个以 `EPERM: operation not permitted, rename`
 * 失败**——因为 Windows 的 MoveFile 无法替换一个正被他人打开的句柄，争用发生在**目标文件**上，
 * 而**不是**临时文件上。因此「把临时名改成 UUID」并不能修好并发写（每个写者本就有独立 temp 也一样红），
 * 真正需要的是把同一路径的写排队。
 *
 * 放在本模块而不是各调用方，是因为生产里已有 6 个调用点（session-store 的 drafts/cache、
 * credential-store、settings-service、character-draft-store、tool-executors 的 file.write、
 * diagnostics-service 的导出），其中多个可并发写同一路径；「原子写」这个承诺本身就该自带并发安全，
 * 否则每个调用方都得自己记得排队——正是本缺陷的成因。
 *
 * 键用 realpath 后的父目录 + 文件名（Windows 下再小写，路径大小写不敏感），使别名/短名指向同一队列。
 * 队列排空后删除条目，避免 Map 无界增长。
 */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * 原子替换写（多 key 凭据文件整文件改写，崩溃/中断不截断）：
 * 同目录 temp O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW 0o600 → fchmod 兜底（opts.mode 存在时按原文件权限回设，M2——覆盖写不静默改权限）→ 写 + fsync(fd) → rename 覆盖
 * → POSIX fsync(dir)（Windows 跳过，记录平台差异）。写前父目录 realpath 包含性复核。
 *
 * **临时名带 UUID（H-11a）**：原为固定的 `${basename}.tmp`，两个并发写者共用同一个临时文件——
 * A 的 rename 会把 B 尚未 rename 的 temp 搬走，B 的 rename 随即 ENOENT。现每次写用独立 temp；
 * EEXIST 重试保留为 UUID 相撞的兜底（实际已不可达）。真正的并发安全由上面的按路径队列提供。
 */
export async function atomicWriteFile(filePath: string, data: string, opts: { safeRoot: string; mode?: number }): Promise<void> {
  const realDir = await assertParentContained(filePath, opts.safeRoot)
  const key = isPosix ? join(realDir, basename(filePath)) : join(realDir, basename(filePath)).toLowerCase()

  const prev = writeQueues.get(key) ?? Promise.resolve()
  // then(op, op) 两个参数：前任失败不得毒化本次（也不得让后续排队者永久卡死）
  const run = prev.then(() => writeNow(), () => writeNow())
  const tail = run.then(() => {}, () => {})
  writeQueues.set(key, tail)
  void tail.then(() => { if (writeQueues.get(key) === tail) writeQueues.delete(key) })
  return run

  async function writeNow(): Promise<void> {
    const dir = dirname(filePath)
    const fileBase = basename(filePath)
    await sweepStaleTemps(dir, fileBase)
    const tmp = join(dir, `${fileBase}.${randomUUID()}.tmp`)

    const writeTemp = async (): Promise<void> => {
      const { fd } = await openSafeFile(tmp, { mode: 'create', purpose: 'append', safeRoot: opts.safeRoot, onConflict: 'error' })
      try {
        if (opts.mode !== undefined && isPosix) await fd.chmod(opts.mode)   // M2：覆盖写保留原文件权限（新文件保持 0o600 安全默认）
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

    try {
      await rename(tmp, filePath)
    } catch (e) {
      await unlink(tmp).catch(() => {})   // 失败路径不留孤儿 temp（UUID 化后不会被下次写顺手清掉）
      throw e
    }

    if (isPosix) {
      const dirFd = await import('fs/promises').then((m) => m.open(dir, constants.O_RDONLY | constants.O_DIRECTORY))
      try { await dirFd.sync() } finally { await dirFd.close() }
    }
  }
}
