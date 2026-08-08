/** IPC 通道常量：Preload 与 Main 共用，无 Electron 依赖 */
export const IpcChannels = { appGetInfo: 'app:get-info' } as const
export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels]

/** IPC 错误体：只含公开信息，不泄漏堆栈/路径 */
export interface IpcErrorBody {
  code: string
  message: string
}

/** IPC 结果信封：ok:true 带 data；ok:false 带公开错误 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorBody }
