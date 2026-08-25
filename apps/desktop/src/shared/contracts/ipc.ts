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
  attachmentsCheck: 'attachments:check',                 // 阶段 3 G3：媒体状态分类（重签后 Range-0 探测）
  chatQueryHistory: 'chat:query-history',                // 阶段 3 G4：聊天历史统一查询（scope/query/localDate/category/分页）
  chatGetMessageContext: 'chat:get-message-context',     // 阶段 3 G4：来源跳转上下文窗口
  chatListStickers: 'chat:list-stickers',                // 阶段 3 G4：内置表情包清单（StickerManifest）
  modelsListProfiles: 'models:list-profiles',            // 阶段 4 批次 A：模型服务 Profile 清单
  modelsSaveProfile: 'models:save-profile',              // 阶段 4 批次 A：自定义 Profile 保存（apiKey 一次性）
  modelsDeleteProfile: 'models:delete-profile',          // 阶段 4 批次 A：删除 Profile
  modelsTestProfile: 'models:test-profile',              // 阶段 4 批次 A：Profile 连通性/可用性测试
  modelsActivateProfile: 'models:activate-profile',      // 阶段 4 批次 A：激活 Profile（switch_model）
  modelsGetActiveSelection: 'models:get-active-selection', // 阶段 4 批次 A：当前激活选择
  ttsListVoices: 'tts:list-voices',                      // 阶段 4 批次 A：TTS 声音清单
  ttsPreview: 'tts:preview',                             // 阶段 4 批次 A：TTS 预览（生成音频）
  ttsSetVoice: 'tts:set-voice',                          // 阶段 4 批次 A：TTS 声音切换
  voiceStartRecord: 'voice:start-record',                // 阶段 4 批次 B：普通录音启动（invoke）
  voiceStopRecord: 'voice:stop-record',                  // 阶段 4 批次 B：普通录音停止（invoke）
  voiceCommit: 'voice:commit',                           // 阶段 4 批次 B：录音确认发送（invoke，await ack）
  voiceDiscard: 'voice:discard',                         // 阶段 4 批次 B：录音丢弃（invoke）
  voiceStartRealtime: 'voice:start-realtime',            // 阶段 4 批次 B：实时会话启动（invoke）
  voiceStopRealtime: 'voice:stop-realtime',              // 阶段 4 批次 B：实时会话停止（invoke）
  voiceCancelRealtime: 'voice:cancel-realtime',          // 阶段 4 批次 B：实时会话取消（invoke）
  voiceStartDictation: 'voice:start-dictation',          // 阶段 4 批次 B：输入法转写启动（invoke）
  voiceStopDictation: 'voice:stop-dictation',            // 阶段 4 批次 B：输入法转写停止（invoke）
  voiceCancelDictation: 'voice:cancel-dictation',        // 阶段 4 批次 B：输入法转写取消（invoke）
  voiceAudioChunk: 'voice:audio-chunk',                  // 阶段 4 批次 B：音频二进制上行（单向 send，ipcMain.on 不 invoke，D-P18）
  audioCancel: 'audio:cancel',                           // 阶段 4 批次 B：TTS 播放取消（invoke）
  settingsLoad: 'settings:load',                         // 阶段 4 批次 B：设置装载（invoke）
  settingsSave: 'settings:save',                         // 阶段 4 批次 B：设置保存（invoke，patch merge）
  live2dListModels: 'live2d:list-models',                // 阶段 5 批次 A：Live2D 模型摘要清单（invoke）
  toolDecide: 'tool:decide',                              // 阶段 6 批次 B：权限决策（allow_once/deny，invoke）
  toolCancel: 'tool:cancel',                              // 阶段 6 批次 B：取消工具调用（invoke）
  toolList: 'tool:list',                                  // 阶段 6 批次 B：工具公开事件清单（invoke）
  toolPickSource: 'tool:pick-source',                     // 阶段 6 批次 B：屏幕捕获源选择（invoke）
  toolConfirmUpload: 'tool:confirm-upload',               // 阶段 6 批次 B：捕获预览确认上传（invoke）
  toolGrantDirectory: 'tool:grant-directory',             // 阶段 6 批次 C（D6C-12）：目录授权创建（invoke）
  toolGrants: 'tool:grants',                              // 阶段 6 批次 C（D6C-12）：授权清单（invoke）
  toolGrantRevoke: 'tool:grant-revoke',                   // 阶段 6 批次 C（D6C-12）：撤销授权（invoke）
  toolHistory: 'tool:history',                            // 阶段 6 批次 C（D6C-12）：审批历史回读（invoke）
  diagnosticsState: 'diagnostics:state',                  // 阶段 7 批次 A：诊断状态（invoke）
  diagnosticsDevModeSet: 'diagnostics:dev-mode-set',      // 阶段 7 批次 A：开发者模式开关（invoke，幂等）
  diagnosticsOpenLogDir: 'diagnostics:open-log-dir',      // 阶段 7 批次 A：打开日志目录（invoke）
  diagnosticsClearLogs: 'diagnostics:clear-logs',         // 阶段 7 批次 A：清理日志（invoke）
  diagnosticsExport: 'diagnostics:export',                 // 阶段 7 批次 A：导出脱敏诊断包（invoke）
  diagnosticsLastCrash: 'diagnostics:last-crash',    // 阶段 7 批次 B：读取最近 Renderer 崩溃 marker（invoke，一次性——读后清空）
} as const
export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels]

/** Main → Renderer 主动推送通道(PushChannels)：不入 IpcChannels（非命令，无 invoke 语义） */
export const PushChannels = {
  event: 'chat:event', state: 'chat:state', replay: 'chat:replay', error: 'chat:error',
  toolEvent: 'tool:event',                                // 阶段 6 批次 B：工具公开事件推送（M2 契约：推送入 PushChannels）
  diagnosticsDevEvent: 'diagnostics:dev-event',           // 阶段 7 批次 A：开发者模式协议事件推送（下行）
  rendererCrash: 'renderer:crash',   // 阶段 7 批次 B：Renderer 崩溃推送占位（不实际发送——Render 已死收不到；实际走 getLastCrash invoke）
} as const

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
