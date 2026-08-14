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
  chatGetRuntimeInfo: 'chat:get-runtime-info',
  chatHydratePersistence: 'chat:hydrate-persistence',   // 启动水合：草稿+锚点+会话列表+消息快照
  chatPersistSession: 'chat:persist-session',           // 草稿+滚动锚点 upsert（防抖/切会话 flush）
  chatCacheMessages: 'chat:cache-messages',             // 已确认消息快照增量推送
  appOpenExternal: 'app:open-external',                  // Markdown 外部链接（http/https 白名单）
  attachmentsValidate: 'attachments:validate',           // 阶段 3 G3：附件校验（数量/大小/类型/路径/敏感范围）
  attachmentsUpload: 'attachments:upload',               // 阶段 3 G3：批量 multipart 上传（batch 原子）
  attachmentsCancel: 'attachments:cancel',               // 阶段 3 G3：上传取消（AbortController）
  attachmentsCheck: 'attachments:check'                  // 阶段 3 G3：媒体状态分类（重签后 Range-0 探测）
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
  clientRequestId?: string
  retryAfterMs?: number
  idempotencyDurable?: boolean
}

/** IPC 结果信封：ok:true 带 data；ok:false 带公开错误 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorBody }

/** 单条 IPC 消息大小上限（docs/07 §6.3）：新持久化/外部链接通道的出参装箱预算与入参校验统一以它为准 */
export const MAX_IPC_MESSAGE_BYTES = 4 * 1024 * 1024
