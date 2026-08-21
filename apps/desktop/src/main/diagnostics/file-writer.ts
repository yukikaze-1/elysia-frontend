import { realpath, rename, unlink } from 'fs/promises'
import { join } from 'path'
import type { FileHandle } from 'fs/promises'
import { openSafeFile } from '../persistence/safe-open'

export interface FileWriterOptions {
  dir: string
  baseName: string
  mode: 'rotate' | 'daily'
  maxSizeBytes?: number
  maxFiles?: number
  retentionDays?: number
  sync?: boolean
  /** 异步批量模式的定时 flush 间隔(ms)。不设则不启用——但长运行场景日志仅退出才落盘，崩溃丢全部日志（spec §5.4 定时 flush）。sync:true 每写已 fsync，忽略此项。 */
  flushIntervalMs?: number
}
export interface FileWriter {
  append(line: string): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
  /** 清空：主文件截断归零（fd 保持打开）+ 轮转历史移除（rotate 模式）。返回移除文件数与释放字节数。 */
  clear(): Promise<{ removedFiles: number; freedBytes: number }>
}

export function rotateTargets(current: string, maxFiles: number): { moves: Array<{ from: string; to: string }>; drop: string | null } {
  const moves: Array<{ from: string; to: string }> = []
  const drop = maxFiles > 1 ? `${current}.${maxFiles - 1}` : null
  for (let i = maxFiles - 1; i >= 2; i--) moves.push({ from: `${current}.${i - 1}`, to: `${current}.${i}` })
  if (maxFiles > 1) moves.push({ from: current, to: `${current}.1` })
  return { moves, drop }
}

/** 本地日期 YYYY-MM-DD（Date 月份 0 基） */
export function todayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function dailyPath(dir: string, baseName: string, date: Date): string {
  return join(dir, `${baseName}-${todayKey(date)}.jsonl`)
}

export function createFileWriter(opts: FileWriterOptions): FileWriter {
  const sync = opts.sync ?? false
  let fd: FileHandle | null = null
  let safeRoot: string | null = null
  let closed = false
  let daily = todayKey(new Date())
  let batch: string[] = []
  let flushing: Promise<void> = Promise.resolve()

  const targetPath = (): string =>
    opts.mode === 'rotate' ? join(opts.dir, `${opts.baseName}.log`) : dailyPath(opts.dir, opts.baseName, new Date())

  async function ensureOpen(): Promise<FileHandle> {
    if (fd) return fd
    if (!safeRoot) safeRoot = await realpath(opts.dir)
    const r = await openSafeFile(targetPath(), { mode: 'create', purpose: 'append', safeRoot, onConflict: 'fallback' })
    fd = r.fd
    return fd
  }

  const maybeRotate = async (): Promise<void> => {
    if (opts.mode !== 'rotate' || !fd || !opts.maxSizeBytes) return
    const st = await fd.stat()
    if (st.size <= opts.maxSizeBytes) return
    const current = join(opts.dir, `${opts.baseName}.log`)
    const { moves, drop } = rotateTargets(current, opts.maxFiles ?? 3)
    await fd.close()
    fd = null
    if (drop) await unlink(drop).catch(() => {})
    for (const m of moves) await rename(m.from, m.to).catch(() => {})
    // 轮转后立即重开新 app.log——当前文件恒存在（否则最后一次 append 触发轮转后 app.log 缺失，测试/后续 append 都受影响）
    fd = (await openSafeFile(current, { mode: 'create', purpose: 'append', safeRoot: safeRoot as string, onConflict: 'fallback' })).fd
  }

  const drain = async (): Promise<void> => {
    if (batch.length === 0) return
    const lines = batch
    batch = []
    const f = await ensureOpen()
    await f.writeFile(lines.join('\n') + '\n', 'utf8')
    if (sync) await f.sync()
    await maybeRotate()
  }

  const flushOnce = async (): Promise<void> => { await drain(); if (fd) await fd.sync() }

  // 定时 flush（spec §5.4：日志批量异步 + 定时 flush + 退出 flush）：unref 不阻止进程退出，
  // 崩溃/强杀时已落盘内容保留，退出时 close() 做最终排空。
  let timer: NodeJS.Timeout | null = null
  if (opts.flushIntervalMs && !sync) {
    timer = setInterval(() => { flushing = flushing.then(flushOnce, flushOnce) }, opts.flushIntervalMs)
    timer.unref()
  }

  return {
    async append(line: string): Promise<void> {
      if (opts.mode === 'daily') {
        const now = todayKey(new Date())
        if (now !== daily) {
          daily = now
          if (fd) { const f = fd; fd = null; await f.close().catch(() => {}) }
        }
      }
      if (sync) {
        const f = await ensureOpen()
        await f.writeFile(line + '\n', 'utf8')
        await f.sync()
        await maybeRotate()
        return
      }
      batch.push(line)
      return
    },
    async flush(): Promise<void> {
      // 串行化并发 flush（轮转/换日不得与在途写交错）
      flushing = flushing.then(flushOnce, flushOnce)
      await flushing
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      if (timer) { clearInterval(timer); timer = null }
      await this.flush()
      if (fd) { const f = fd; fd = null; await f.close().catch(() => {}) }
    },
    async clear(): Promise<{ removedFiles: number; freedBytes: number }> {
      // ① 快照 clear 调用时点的批次整批丢弃——不落盘（若放回队列会于 truncate 后被下次 flush 复活）；
      //    此后并发 append 落入新批次（clear 与 append 同串行队列——调后写行不随本次清空丢失）
      batch = []
      let removedFiles = 0
      let freedBytes = 0
      const run = async (): Promise<void> => {
        // ② 截断主文件后关 fd 复位（truncate 保留 fd 的陈旧文件偏移，继续写会产生 NUL 空洞；
        //    与 maybeRotate 的 close+reopen 同型：下次 ensureOpen 经 EEXIST 走 O_APPEND 句柄，位置恒在 EOF）
        if (fd) {
          const f = fd
          const st = await f.stat()
          freedBytes = st.size
          await f.truncate(0)
          fd = null
          await f.close().catch(() => {})
        }
        if (opts.mode === 'rotate') {
          // ③ 轮转历史全量移除（rotateTargets 的 drop 路径同口径——尽力而为，ENOENT/不可删忽略计数仅记成功项）
          for (let i = 1; i < (opts.maxFiles ?? 3); i++) {
            try { await unlink(join(opts.dir, `${opts.baseName}.log.${i}`)); removedFiles++ } catch { /* 不存在/不可删 */ }
          }
        }
      }
      // 入既有 flushing 串行队列（与 append/flush/close/定时 flush 同队列——不绕过；队列前缀任务先完成后才清空）
      flushing = flushing.then(run, run)
      await flushing
      return { removedFiles, freedBytes }
    }
  }
}
