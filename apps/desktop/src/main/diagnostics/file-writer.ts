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
}
export interface FileWriter {
  append(line: string): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
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
      await this.flush()
      if (fd) { const f = fd; fd = null; await f.close().catch(() => {}) }
    }
  }
}
