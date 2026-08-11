/** IPC 通道常量：Preload 与 Main 共用，无 Electron 依赖 */
export const IpcChannels = {
  appGetInfo: 'app:get-info',
  credentialsGetStatus: 'credentials:get-status',
  credentialsSet: 'credentials:set',
  credentialsClear: 'credentials:clear',
  chatConnect: 'chat:connect',
  chatDisconnect: 'chat:disconnect',
  chatListConversations: 'chat:list-conversations',
  chatGetMessages: 'chat:get-messages',
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatActivate: 'chat:activate',
  chatCreate: 'chat:create',
  chatRename: 'chat:rename',
  chatDelete: 'chat:delete',
  chatGetState: 'chat:get-state',
  chatSetEndpoint: 'chat:set-endpoint',
  chatGetEndpoint: 'chat:get-endpoint',
  chatGetRuntimeInfo: 'chat:get-runtime-info'
} as const
export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels]

/** Main → Renderer 主动推送通道(PushChannels)：不入 IpcChannels（非命令，无 invoke 语义） */
export const PushChannels = { event: 'chat:event', state: 'chat:state', replay: 'chat:replay', error: 'chat:error' } as const

/** IPC 错误体：只含公开信息，不泄漏堆栈/路径；结构化字段跨 contextBridge 经 message 前缀保真 */
export interface IpcErrorBody {
  code: string
  message: string
  backendCode?: string
  retryable?: boolean
  requestId?: string
}

/** IPC 结果信封：ok:true 带 data；ok:false 带公开错误 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorBody }
