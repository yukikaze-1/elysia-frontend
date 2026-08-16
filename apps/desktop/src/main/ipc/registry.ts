import { BrowserWindow, ipcMain } from 'electron'
import type { IpcChannelName, IpcResult } from '@shared/contracts'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { getTrustedDevOrigins, isAppRendererUrl } from '../config/trusted-renderer-origin'
import type { ZodType } from 'zod'

let mainWindow: BrowserWindow | null = null
const registered = new Set<IpcChannelName>()

export function setMainWindow(win: BrowserWindow | null): void { mainWindow = win }
export function getMainWindow(): BrowserWindow | null { return mainWindow }

/** 可测纯守卫（P2-01）：win null/销毁、sender 不匹配、senderFrame 非 mainFrame、发送 frame URL 不受信 → 拒绝 */
export function isTrustedSenderFor(
  win: { isDestroyed(): boolean; webContents: { mainFrame: unknown } } | null,
  event: { sender: unknown; senderFrame: { url: string } | null },
  trusted: ReadonlySet<string>
): boolean {
  if (!win || win.isDestroyed()) return false
  if (!event.senderFrame) return false
  if (event.sender !== win.webContents) return false
  if (event.senderFrame !== win.webContents.mainFrame) return false
  return isAppRendererUrl(event.senderFrame.url, trusted)
}

/** 结构宽化：同时接受 IpcMainEvent（ipcMain.on 单向）与 IpcMainInvokeEvent（ipcMain.handle invoke） */
function isTrustedSender(event: { sender: unknown; senderFrame: { url: string } | null }): boolean {
  return isTrustedSenderFor(mainWindow, event, getTrustedDevOrigins())
}

export function registerHandler(
  channel: IpcChannelName,
  executor: (raw: unknown) => Promise<IpcResult<unknown>>,
  arity: 0 | 1 = 0
): void {
  if (registered.has(channel)) {
    throw new CyreneError(CyreneErrorCode.UNKNOWN, `重复注册 IPC 通道 ${channel}`)
  }
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) return { ok: false, error: { code: 'UNKNOWN', message: '拒绝' } }
    if (args.length !== arity) return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: '参数校验失败' } }
    return executor(args.length > 0 ? args[0] : undefined)
  })
  registered.add(channel) // handle 绑定成功后标记——绑定失败不污染 registered，后续可重试
}

/**
 * 单向通道（P4-B D-P18：voice:audio-chunk 等二进制上行，fire-and-forget 非 invoke）：
 * 复用同一 trusted-sender 守卫 + registered 集合（防与 registerHandler 通道名冲突）；payload 经 schema 校验，
 * 非法静默丢弃 + warn（单向无响应面，不向 sender 回报）。arity 固定 1（payload 缺省 undefined 不触发 handler）。
 */
export function registerOneWayHandler<T>(
  channel: IpcChannelName,
  schema: ZodType<T>,
  handler: (data: T) => void,
  opts: { logger?: { warn(code: string, fields?: Record<string, string | number | boolean>): void } } = {}
): void {
  if (registered.has(channel)) {
    throw new CyreneError(CyreneErrorCode.UNKNOWN, `重复注册 IPC 通道 ${channel}`)
  }
  ipcMain.on(channel, (event, payload) => {
    if (!isTrustedSender(event)) return
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      opts.logger?.warn('ipc:oneway-invalid', { channel })
      return
    }
    handler(parsed.data)
  })
  registered.add(channel) // 绑定成功后标记
}
