import { z } from 'zod'
import { isKeyAllowed, MAX_IPC_MESSAGE_BYTES, type ActivateModelProfileCommand, type CredentialStatus, type ModelProfileTestCommand, type SetTtsVoiceCommand, type TtsPreviewCommand, type UpsertModelProfileCommand } from '@shared/contracts'
import { CacheMessagesInputSchema, OpenExternalInputSchema, PersistSessionInputSchema, SettingsPatchSchema, CreateConversationInputSchema } from '@shared/schemas'

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string()
})

export const credentialStatusSchema: z.ZodType<{ status: CredentialStatus; key: string }> = z.object({
  status: z.enum(['unavailable', 'locked', 'empty', 'available']),
  key: z.string().refine(isKeyAllowed)
})
export const credentialsSetSchema = z.object({
  key: z.string().refine(isKeyAllowed),
  value: z.string().min(1).max(4096)
})
export const credentialsClearSchema = z.object({
  key: z.string().refine(isKeyAllowed)
})

// —— chat 命令 request schema(P0 精确字段;响应校验用 z.unknown() 信封,阶段 7 细化)——
export const chatConnectSchema = z.undefined()   // 无参:endpoint/token 由 connection-config 持有,connect 不再传 URL
export const chatSetEndpointSchema = z.object({ serverUrl: z.string().min(1).max(4096) })
export const chatGetEndpointSchema = z.undefined()
export const chatGetRuntimeInfoSchema = z.undefined()
export const chatSendSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().max(65_536),      // D7A-13：消息正文 64KiB 上界（无界字段补值；MAX_IPC_MESSAGE_BYTES 预算内）
  clientRequestId: z.string().min(1),
  attachments: z.array(z.object({
    attachmentId: z.string().min(1),
    kind: z.enum(['image', 'video', 'audio', 'file', 'link']),
    mime: z.string().min(1)
  })).optional(),
  stickerId: z.string().optional()   // 阶段 3 G4：贴图消息发送（D8）
})
export const chatGetMessagesSchema = z.object({
  conversationId: z.string().min(1),
  before: z.string().max(256).optional(),
  after: z.string().max(256).optional(),
  // S9（2026-09-15）：`limit` 此前无上界 ⇒ 对端可要一个超大页，让 Main 整份拉取 + JSON.parse + schema 校验。
  // 与同文件族既有口径对齐（chatQueryHistorySchema.limit ≤100 / ToolHistoryQuerySchema.limit ≤200）。
  limit: z.number().int().positive().max(200).optional()
})
export const chatRenameSchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().min(1).max(200)   // D7A-13：标题 200 上界（无界字段补值）
})
export const chatActivateSchema = z.object({
  conversationId: z.string().min(1)
})
export const chatListConversationsSchema = z.object({
  cursor: z.string().max(256).optional(),   // S9：游标同样给上界（后端游标是短串）
  limit: z.number().int().positive().max(200).optional()   // S9：同上
})
export const chatCreateSchema = CreateConversationInputSchema
export const chatCancelSchema = z.object({
  generationId: z.string().min(1)
})
export const chatDeleteSchema = z.object({
  conversationId: z.string().min(1)
})
export const chatGetStateSchema = z.undefined()

// —— 阶段 3 G2 持久化四通道 request schema ——
export const chatHydratePersistenceSchema = z.undefined()
export const chatPersistSessionSchema = PersistSessionInputSchema
export const chatCacheMessagesSchema = CacheMessagesInputSchema
export const chatOpenExternalSchema = OpenExternalInputSchema

// —— attachments 命令 request schema（spec §4.2/§4.5；响应 schema 在 shared/schemas/ipc-response）——
export const UploadFileDescriptorSchema = z.object({
  localId: z.string().min(1),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  source: z.enum(['picker', 'drag_drop', 'paste']),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']).optional(),
  // S5-B2（2026-09-15）：**path 已从 IPC 面移除**，改为 Main 签发的不可猜 fileRef（见 file-ref.ts）。
  // 对端再也无法在本通道上命名主机路径——它能做的只有「引用 Main 登记过的文件」。
  fileRef: z.string().min(1).max(128).optional(),
  // S4（2026-09-15）：`bytes` 此前无任何长度上界，而所有限额都用**对端自报**的 `size` 判定 ⇒ 等于没有上限。
  // 上界取**全局 IPC 不变量**（`MAX_IPC_MESSAGE_BYTES` = 4 MiB，doc 07 §6.3）：通道预算不得比它更宽
  // （`ipc-budget-declaration.spec.ts` 会红）。这条只约束 `bytes` 分支（粘贴型，载荷真的过 IPC）；
  // `fileRef` 分支**载荷为空**（Main 自己按 token 读盘），其单文件上限仍按 kind（10/20/50 MiB）在 handler 复核。
  bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength <= MAX_IPC_MESSAGE_BYTES, { message: '粘贴的文件超过 IPC 载荷上限' }).optional()
}).refine((d) => (d.fileRef !== undefined) !== (d.bytes !== undefined), { message: 'fileRef/bytes 二选一' })

export const attachmentsValidateSchema = z.object({ files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
export const attachmentsUploadSchema = z.object({ uploadId: z.string().min(1), files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
export const attachmentsCancelSchema = z.object({ uploadId: z.string().min(1) })
export const attachmentsCheckSchema = z.object({ attachmentId: z.string().min(1) })

// —— S5-B2：preload 把 webUtils.getPathForFile 的产物登记换 token（唯一铸造点；Main 才是信任锚）——
// 入参是路径字符串：这条通道只被 preload 调用，且即便对端直调也无收益——它登记什么，就只能引用什么，
// 而引用之后 realpath/userData/黑名单/大小/魔数复核逐条照旧（本通道不构成新的放行面）。
export const fileRefsRegisterSchema = z.object({ path: z.string().min(1).max(4096) })


// —— chat 历史查看器/表情 request schema（spec §4.3；响应 schema 在 shared/schemas/ipc-response）——
export const chatQueryHistorySchema = z.object({
  scope: z.union([
    z.object({ type: z.literal('conversation'), conversationId: z.string().min(1) }),
    z.object({ type: z.literal('all_conversations') })
  ]),
  query: z.string().max(512).optional(),   // D7A-13：搜索 query 512 上界（无界字段补值）
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timeZone: z.string().min(1),
  category: z.enum(['all', 'image_video', 'sticker', 'file', 'audio', 'link']),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100)
})
export const chatGetMessageContextSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  before: z.number().int().positive().optional(),
  after: z.number().int().positive().optional()
})
export const chatListStickersSchema = z.undefined()

// —— 阶段 4 批次 A 模型服务/TTS 命令 request schema（spec §4.6；响应 schema 在 shared/schemas/ipc-response；apiKey 仅存在于请求侧，出参永不含凭据）——
export const modelsListProfilesSchema = z.object({ type: z.enum(['llm', 'stt', 'tts']).optional() })
export const modelsSaveProfileSchema: z.ZodType<UpsertModelProfileCommand> = z.object({
  type: z.enum(['llm', 'stt', 'tts']), name: z.string().min(1).max(200),
  baseUrl: z.string().max(2048).optional(), apiKey: z.string().max(8192).optional(),
  apiKeyEnv: z.string().max(200).optional(), models: z.array(z.string().max(200)).max(50).optional(),
  executionLocation: z.enum(['backend', 'desktop', 'local_worker']).optional(),
  capabilities: z.array(z.string().max(100)).max(50).optional(), makeActive: z.boolean().optional()
})
export const modelsDeleteProfileSchema = z.object({ service: z.enum(['llm', 'stt', 'tts']), name: z.string().min(1).max(200) })
export const modelsTestProfileSchema: z.ZodType<ModelProfileTestCommand> = z.object({
  service: z.enum(['llm', 'stt', 'tts']), provider: z.string().min(1).max(200), model: z.string().min(1).max(200),
  level: z.enum(['connectivity', 'usable']), baseUrl: z.string().max(2048).optional(), apiKey: z.string().max(8192).optional()
})
export const modelsActivateProfileSchema: z.ZodType<ActivateModelProfileCommand> = z.object({
  profileId: z.string().min(1).max(512), service: z.enum(['llm', 'stt', 'tts'])
})
export const modelsGetActiveSelectionSchema = z.undefined()
export const ttsListVoicesSchema = z.undefined()
export const ttsPreviewSchema: z.ZodType<TtsPreviewCommand> = z.object({ voiceId: z.string().max(200).optional() })
export const ttsSetVoiceSchema: z.ZodType<SetTtsVoiceCommand> = z.object({ voice: z.string().min(1).max(200) })

// —— 阶段 4 批次 B 设置命令 request schema（响应 schema 在 shared/schemas/ipc-response SettingsStateSchema；save 入参=SettingsPatchSchema）——
export const settingsLoadSchema = z.undefined()
export const settingsSaveSchema = SettingsPatchSchema

// —— 阶段 4 批次 B 语音命令 request schema（spec §5.4 方法集；严格镜像 contracts/voice.ts 输入形状；响应 schema 由 voice-handlers 内联）——
export const voiceStartRecordSchema = z.object({ recordingId: z.string().min(1) })
export const voiceStopRecordSchema = z.object({ recordingId: z.string().min(1) })
export const voiceCommitSchema = z.object({
  recordingId: z.string().min(1),
  text: z.string().max(10_240),       // D7A-13：转写提交文本 10KiB 上界（无界字段补值；未识别空文本允许）
  conversationId: z.string().min(1),
  clientRequestId: z.string().min(1),
  clientMessageId: z.string().min(1)
})
export const voiceDiscardSchema = z.object({ recordingId: z.string().min(1) })
export const voiceStartRealtimeSchema = z.object({
  sessionId: z.string().min(1),
  conversationId: z.string().min(1).optional()
})
export const voiceStopRealtimeSchema = z.object({ sessionId: z.string().min(1) })
export const voiceCancelRealtimeSchema = z.object({ sessionId: z.string().min(1) })
export const voiceStartDictationSchema = z.object({
  clientRequestId: z.string().min(1),
  sttProfileId: z.string().optional()     // 缺省 → dictation.start 不带 → 全局活动 STT（D-P14）
})
export const voiceStopDictationSchema = z.object({ clientRequestId: z.string().min(1) })
export const voiceCancelDictationSchema = z.object({ clientRequestId: z.string().min(1) })
/** 音频二进制上行（单向 send 通道）：bytes 必须为真实 Uint8Array；1MiB 运行期上限在 voice-handlers 处校验（schema 只查类型） */
export const voiceAudioChunkSchema = z.object({ bytes: z.instanceof(Uint8Array) })
export const audioCancelSchema = z.object({ streamId: z.number().int() })

// —— 阶段 5 批次 A Live2D 命令 request schema（spec D5A-07；响应 schema 在 shared/schemas/ipc-response Live2DListResponseSchema）——
export const live2dListModelsSchema = z.undefined()
/**
 * dev 形态模型文件读取请求（2026-09-10）。
 * modelId 与协议通道 live2d-path.ts 同纪律：ASCII slug 且非 `.`/`..`——闸门的 registered 判定
 * （listInstalledModels 精确匹配 id）已能挡住遍历，此处按协议层同款前置收窄，属纵深而非唯一防线。
 * relPath 只做长度/字符下限收窄；containment + integrity 白名单判定归 registry.resolveModelFile。
 */
export const live2dReadModelFileSchema = z.object({
  modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).refine((s) => s !== '.' && s !== '..'),
  relPath: z.string().min(1).max(1024).refine((s) => !s.includes('\0'))
})

// —— 阶段 7 批次 A 诊断命令 request schema（响应 schema 在 shared/schemas/ipc-response Diagnostics*）——
export const diagnosticsStateSchema = z.undefined()
export const diagnosticsDevModeSetSchema = z.object({ enabled: z.boolean() })
export const diagnosticsOpenLogDirSchema = z.undefined()
export const diagnosticsClearLogsSchema = z.undefined()
export const diagnosticsExportSchema = z.undefined()
