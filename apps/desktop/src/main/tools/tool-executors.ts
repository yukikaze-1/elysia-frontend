// src/main/tools/tool-executors.ts（Task 3：file.select / file.read / file.write 执行器；Task 4：screen.capture 枚举面，上传由 tool-service 子状态机）
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { dialog } from 'electron'
import { atomicWriteFile } from '../credentials/atomic-write'      // A-13：原子写复用（fsync + 安全写）
import { computeTextDiff, detectTextFormat, normalizeToFormat } from './text-diff'
import { normalizeToolPath, isPathBlacklisted } from './tool-policy'
import { FILE_READ_MAX_BYTES, MAX_WRITE_CONTENT_BYTES, RESULT_INLINE_BYTES, TEXT_FILE_FILTERS, THUMBNAIL_DATA_URL_MAX } from './tool-service'
import type { ToolRecord, ToolServiceDeps } from './tool-service'
import type { ToolAttachment } from '@shared/contracts/tool'       // 新发现7：类型 import 补齐

export interface ExecResult { output: Record<string, unknown>; summary: string; attachments?: ToolAttachment[]; attachmentCount?: number; captureSession?: boolean }   // captureSession：capture 枚举完成 → 子状态机接管（A-2）
export class ToolExecError extends Error { constructor(public code: string, message: string) { super(message) } }

/** Wayland 会话判定（与 tool-service 的 isWaylandSession 同语义、独立实现免循环依赖；deps.isWayland 注入优先，A-4/L1） */
function isWaylandEnv(): boolean {
  const t = process.env.XDG_SESSION_TYPE?.toLowerCase()
  return t === 'wayland' || (!!process.env.WAYLAND_DISPLAY && t !== 'x11')
}

export function createExecutors(deps: ToolServiceDeps): { execute(rec: ToolRecord, realPath?: string): Promise<ExecResult> } {
  async function select(rec: ToolRecord): Promise<ExecResult> {
    const picker = deps.pickFile ?? (async (o) => {
      const r = await dialog.showOpenDialog({ title: o.title, filters: o.filters, properties: ['openFile'] })
      return r.canceled || r.filePaths.length === 0 ? { canceled: true } : { canceled: false, path: r.filePaths[0] }
    })
    const r = await picker({ title: rec.title, filters: [TEXT_FILE_FILTERS] })
    if (r.canceled || !r.path) return { output: { cancelled: true }, summary: '用户取消选择' }
    // 黑名单复核（M-7/L10/H9）：命中 → 伪装取消；allowRoots 与服务层同口径（/tmp 黑名单经注入放宽）
    const norm = normalizeToolPath(r.path, { platform: deps.platform })
    const blacklisted = isPathBlacklisted(norm.realPath) && !(deps.allowRoots ?? []).some(root => norm.realPath === root || norm.realPath.startsWith(root + '/'))
    if (blacklisted) {
      return { output: { cancelled: true, reason: 'PATH_BLOCKLISTED' }, summary: '用户取消选择' }
    }
    const st = fs.statSync(norm.realPath)
    // M-1（批次最终 review）：哈希受 FILE_READ_MAX_BYTES 上限——超大文件不做同步整读哈希（防 Main 事件循环阻塞）；
    // 超限省略 hash 字段（指纹仅辅助，路径/大小已够后端语义；不阻塞选择）
    const hash = st.size <= FILE_READ_MAX_BYTES ? createHash('sha256').update(fs.readFileSync(norm.realPath)).digest('hex') : undefined
    deps.selectedAdd?.(norm.realPath)   // selected-set 回调（A-14：tool-service 注入写闭包；可选防未接线；写入 normalize 后路径，与豁免检查同口径）
    return { output: { cancelled: false, path: norm.realPath, name: path.basename(norm.realPath), size: st.size, mtimeMs: st.mtimeMs, ...(hash !== undefined ? { hash } : {}) }, summary: `已选择 ${path.basename(norm.realPath)}` }
  }
  async function readFile(rec: ToolRecord, realPath?: string): Promise<ExecResult> {
    const p = realPath ?? String(rec.arguments_['path'])
    const st = fs.statSync(p)
    if (st.size > FILE_READ_MAX_BYTES) throw new ToolExecError('FILE_TOO_LARGE', '文件超过 2 MiB 上限')
    const buf = fs.readFileSync(p)
    // TOCTOU：open 后 fstat 复核（安全打开——实际打开由调用方 normalizeToolPath 语义保证；此处 size 复核）
    if (buf.byteLength !== st.size) throw new ToolExecError('FILE_CONFLICT', '文件在读取期间变化')
    if (buf.subarray(0, 8192).includes(0)) throw new ToolExecError('FILE_IS_BINARY', '二进制文件')
    if (buf[0] === 0xff && buf[1] === 0xfe || buf[0] === 0xfe && buf[1] === 0xff) throw new ToolExecError('FILE_IS_BINARY', 'UTF-16 不支持')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) }
    catch { throw new ToolExecError('FILE_IS_BINARY', '非 UTF-8 文本') }
    const hash = createHash('sha256').update(buf).digest('hex')
    const base = { path: p, name: path.basename(p), size: st.size, hash, charset: 'utf-8' }
    if (buf.byteLength <= RESULT_INLINE_BYTES) {
      return { output: { ...base, content: text }, summary: `读取 ${path.basename(p)}（${st.size} 字节）` }
    }
    const attachment = await deps.uploadAttachment(rec.desktopCallId!, buf, 'text/plain', path.basename(p))
    const truncated = text.slice(0, 2000)
    return { output: { ...base, truncated: true }, summary: `读取 ${path.basename(p)}（${st.size} 字节，已截断）\n${truncated}`, attachments: [attachment], attachmentCount: 1 }   // B-2①：summary 含「已截断」
  }
  async function writeFile(rec: ToolRecord, realPath?: string): Promise<ExecResult> {
    const p = realPath ?? String(rec.arguments_['path'])
    const content = String(rec.arguments_['content'])
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_CONTENT_BYTES) throw new ToolExecError('CONTENT_TOO_LARGE', '内容超过 2 MiB 上限')
    const exists = fs.existsSync(p)
    // D6C-10（facts 修正）：授权时文件不存在（preReadForDiff 置 isNewFile）、执行前被创建 → 拒绝覆盖（原文件保持）
    if (exists && rec.diff?.isNewFile) throw new ToolExecError('FILE_CONFLICT', '文件已被创建，未覆盖')
    let oldText = ''
    if (exists) {
      const buf = fs.readFileSync(p)
      if (buf.byteLength > FILE_READ_MAX_BYTES) throw new ToolExecError('FILE_TOO_LARGE', '目标文件超过 2 MiB')
      // ignoreBOM:true——TextDecoder 缺省会剥 BOM，format 探测（hasBom）需见原始 BOM（D6B-19/L-2）
      try { oldText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf) }
      catch { throw new ToolExecError('FILE_IS_BINARY', '目标文件非 UTF-8 文本，拒绝覆盖') }
    }
    const fmt = exists ? detectTextFormat(oldText) : { hasBom: false, eol: 'lf' as const, endsWithNewline: false }
    const normalized = normalizeToFormat(content, fmt)
    // 写前哈希检查（A-1）：基于授权前预读 hash（rec.oldHash）；无预读时以当前内容为基准（防御路径）
    if (exists && rec.oldHash) {
      const nowHash = createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      if (nowHash !== rec.oldHash) throw new ToolExecError('FILE_CONFLICT', '文件已被修改，未覆盖')
    }
    // 原子替换（A-13/完整 L2/H10/M2）：复用 atomicWriteFile——签名 (filePath, data, { safeRoot, mode? })
    // data 传字符串（非 Buffer）；safeRoot 传目标父目录；覆盖场景透传原文件 mode（保留权限，M2）
    const origMode = exists && process.platform !== 'win32' ? fs.statSync(p).mode & 0o777 : undefined
    await atomicWriteFile(p, normalized, { safeRoot: path.dirname(p), mode: origMode })
    const outHash = createHash('sha256').update(normalized).digest('hex')
    const diffText = exists ? oldText.replace(/^﻿/, '') : ''   // L1：diff 用去 BOM 串（format 探测仍用原串）
    const diff = computeTextDiff(diffText, content)                // 新文件 diffText='' → 全新增（L2 统一行数口径）
    return { output: { path: p, size: Buffer.byteLength(normalized), hash: outHash, bytesWritten: Buffer.byteLength(normalized) },
      summary: `${exists ? '覆盖' : '新建'} ${path.basename(p)}（Diff：+${diff.added} -${diff.removed}）` }
  }
  /** capture 枚举面（A-2/完整 H3④）；上传由 tool-service 子状态机完成——枚举完成返回 captureSession，服务层转 awaiting_pick */
  async function capture(_rec: ToolRecord): Promise<ExecResult> {
    if (deps.isWayland === undefined ? isWaylandEnv() : deps.isWayland) throw new ToolExecError('CAPTURE_UNAVAILABLE', '当前桌面环境不支持屏幕捕获')
    const enumerate = deps.enumerateSources ?? (async () => {
      const { desktopCapturer } = await import('electron')
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 240 } })
      return sources.map(s => ({ sourceId: s.id, sourceName: s.name, thumbnailDataUrl: s.thumbnail.toDataURL() }))
    })
    const all = await enumerate()                                            // M4：单次调用（dropped 从同组计算）
    const sources = all.filter(s => s.thumbnailDataUrl.length <= THUMBNAIL_DATA_URL_MAX)  // 缩略图 ≤64KiB 丢弃（L-5/B5）
    const dropped = all.length - sources.length
    return { output: { sources: sources.map(s => ({ sourceId: s.sourceId, sourceName: s.sourceName, thumbnailDataUrl: s.thumbnailDataUrl })), dropped }, summary: `已枚举 ${sources.length} 个源，等待选择`, captureSession: true }
  }
  return {
    async execute(rec, realPath) {
      switch (rec.toolName) {
        case 'desktop.file.select': return select(rec)
        case 'desktop.file.read': return readFile(rec, realPath)
        case 'desktop.file.write': return writeFile(rec, realPath)
        case 'desktop.screen.capture': return capture(rec)
        default: throw new ToolExecError('CAPABILITY_UNAVAILABLE', '未知执行器')
      }
    },
  }
}
// selected-set 回调：ToolServiceDeps.selectedAdd 由 tool-service 在 createExecutors({ ...deps, selectedAdd: 写闭包 }) 注入（A-14）；本文件只消费（deps.selectedAdd?.()）
