// src/main/tools/tool-executors.ts（Task 3：file.select / file.read / file.write 执行器；Task 4：screen.capture 枚举面，上传由 tool-service 子状态机）
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defaultDialogService } from '../native-ui/dialog-service'   // 原生选择器统一入口（silent 测试模式不弹窗，见其头注）
import { atomicWriteFile } from '../credentials/atomic-write'      // A-13：原子写复用（fsync + 安全写）
import { computeTextDiff, detectTextFormat, normalizeToFormat } from './text-diff'
import { normalizeToolPath, isPathBlacklisted, isPathWithinRoot } from './tool-policy'
import { identityChangedReason } from './file-identity'
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

/**
 * A2（2026-09-16 审计 P2）：副作用检查点。
 *
 * 修复前：取消/执行超时只改记录状态并回 wire（用户已经看到「已取消」/「超时」），执行器却照旧把文件写下去、
 * 把大文件传上去——"用户以为已取消的操作实际完成"。现在每条执行带一个 AbortSignal，执行器在**每个副作用之前**
 * 查一次；信号已到即抛 `ABORTED`（服务层此时已是终态，不会再改状态，也不会把它当成用户可见错误）。
 *
 * 边界：检查点是离散的。**已经在途的那一次系统调用不可撤回**（例如已进入 `atomicWriteFile` 内部）——
 * 这一点写在 `tool-service.run()` 的注记里，不谎称"取消必然无副作用"。
 */
function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolExecError('ABORTED', '执行已中止')
}
/**
 * A4（2026-09-16 审计 P2 TOCTOU）：执行前复核授权时的文件身份。
 *
 * 授权（决策链 step 5）与执行是两个时刻，中间路径可被换链：把已授权的文件换成指向别处的符号链接、
 * 或换成另一个文件 ⇒「批准的是 A、读/写的是 B」。修复前的"TOCTOU 复核"只比对了 size（同尺寸替换照样通过）。
 * `rec.fileIdentity` 为空表示授权时该路径没有可复核身份（不存在/文件系统不报 dev·ino）⇒ 本复核不适用，
 * 由既有 `isNewFile`/`FILE_CONFLICT` 判据覆盖，两者不重叠。
 */
function assertPathIdentityUnchanged(rec: ToolRecord, p: string): void {
  const reason = identityChangedReason(p, rec.fileIdentity)
  if (reason === 'symlink') throw new ToolExecError('PATH_UNSAFE', '目标在授权后被改为符号链接，已拒绝')
  if (reason === 'gone') throw new ToolExecError('FILE_CONFLICT', '目标文件在授权后消失，已拒绝')
  if (reason === 'replaced') throw new ToolExecError('FILE_CONFLICT', '目标文件在授权后被替换，已拒绝')
}

export function createExecutors(deps: ToolServiceDeps): { execute(rec: ToolRecord, realPath?: string, signal?: AbortSignal): Promise<ExecResult> } {
  async function select(rec: ToolRecord, signal?: AbortSignal): Promise<ExecResult> {
    assertNotAborted(signal)
    const picker = deps.pickFile ?? (async (o) => {
      const r = await defaultDialogService().showOpenDialog(undefined, { title: o.title, filters: o.filters, properties: ['openFile'] })
      return r.canceled || r.filePaths.length === 0 ? { canceled: true } : { canceled: false, path: r.filePaths[0] }
    })
    const r = await picker({ title: rec.title, filters: [TEXT_FILE_FILTERS] })
    assertNotAborted(signal)   // A2：原生选择器不可中断，但它**返回后**的选择登记可以被放弃
    if (r.canceled || !r.path) return { output: { cancelled: true }, summary: '用户取消选择' }
    // 黑名单复核（M-7/L10/H9）：命中 → 伪装取消；allowRoots 与服务层同口径（/tmp 黑名单经注入放宽）
    const norm = normalizeToolPath(r.path, { platform: deps.platform })
    const blacklisted = isPathBlacklisted(norm.realPath, undefined, { platform: deps.platform })
      && !(deps.allowRoots ?? []).some(root => isPathWithinRoot(norm.realPath, root, deps.platform))
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
  async function readFile(rec: ToolRecord, realPath?: string, signal?: AbortSignal): Promise<ExecResult> {
    const p = realPath ?? String(rec.arguments_['path'])
    assertNotAborted(signal)
    assertPathIdentityUnchanged(rec, p)   // A4：读之前复核"还是不是被授权的那一个文件"
    const st = fs.statSync(p)
    if (st.size > FILE_READ_MAX_BYTES) throw new ToolExecError('FILE_TOO_LARGE', '文件超过 2 MiB 上限')
    const buf = fs.readFileSync(p)
    // size 复核（早于 A4 的身份复核）：读完之后文件若又变了，至少这里能发现长度不符
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
    assertNotAborted(signal)   // A2：上传是副作用——服务层已回 wire「已取消/超时」时不得再传
    const attachment = await deps.uploadAttachment(rec.desktopCallId!, buf, 'text/plain', path.basename(p))
    const truncated = text.slice(0, 2000)
    return { output: { ...base, truncated: true }, summary: `读取 ${path.basename(p)}（${st.size} 字节，已截断）\n${truncated}`, attachments: [attachment], attachmentCount: 1 }   // B-2①：summary 含「已截断」
  }
  async function writeFile(rec: ToolRecord, realPath?: string, signal?: AbortSignal): Promise<ExecResult> {
    const p = realPath ?? String(rec.arguments_['path'])
    assertNotAborted(signal)
    assertPathIdentityUnchanged(rec, p)   // A4：覆盖前复核——批准的是这一个文件，不能被换成另一个
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
    assertNotAborted(signal)   // A2：写盘是副作用——这是最后一个能放弃的点（越过后不可撤回）
    await atomicWriteFile(p, normalized, { safeRoot: path.dirname(p), mode: origMode })
    const outHash = createHash('sha256').update(normalized).digest('hex')
    const diffText = exists ? oldText.replace(/^﻿/, '') : ''   // L1：diff 用去 BOM 串（format 探测仍用原串）
    const diff = computeTextDiff(diffText, content)                // 新文件 diffText='' → 全新增（L2 统一行数口径）
    return { output: { path: p, size: Buffer.byteLength(normalized), hash: outHash, bytesWritten: Buffer.byteLength(normalized) },
      summary: `${exists ? '覆盖' : '新建'} ${path.basename(p)}（Diff：+${diff.added} -${diff.removed}）` }
  }
  /** capture 枚举面（A-2/完整 H3④）；上传由 tool-service 子状态机完成——枚举完成返回 captureSession，服务层转 awaiting_pick */
  async function capture(_rec: ToolRecord, signal?: AbortSignal): Promise<ExecResult> {
    assertNotAborted(signal)
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
    async execute(rec, realPath, signal) {
      switch (rec.toolName) {
        case 'desktop.file.select': return select(rec, signal)
        case 'desktop.file.read': return readFile(rec, realPath, signal)
        case 'desktop.file.write': return writeFile(rec, realPath, signal)
        case 'desktop.screen.capture': return capture(rec, signal)
        default: throw new ToolExecError('CAPABILITY_UNAVAILABLE', '未知执行器')
      }
    },
  }
}
// selected-set 回调：ToolServiceDeps.selectedAdd 由 tool-service 在 createExecutors({ ...deps, selectedAdd: 写闭包 }) 注入（A-14）；本文件只消费（deps.selectedAdd?.()）
