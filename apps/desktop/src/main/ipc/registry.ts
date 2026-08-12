import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannelName, IpcResult } from '@shared/contracts'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { getTrustedDevOrigins, isAppRendererUrl } from '../config/trusted-renderer-origin'

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

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
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
