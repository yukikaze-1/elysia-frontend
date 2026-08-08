import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannelName, IpcResult } from '@shared/contracts'
import { CyreneError, CyreneErrorCode } from '@shared/errors'

let mainWindow: BrowserWindow | null = null
const registered = new Set<IpcChannelName>()

export function setMainWindow(win: BrowserWindow | null): void { mainWindow = win }
export function getMainWindow(): BrowserWindow | null { return mainWindow }

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (!event.senderFrame) return false
  return event.sender === mainWindow.webContents
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
