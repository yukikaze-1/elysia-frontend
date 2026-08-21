import { z } from 'zod'
import { isKeyAllowed, type ActivateModelProfileCommand, type CredentialStatus, type ModelProfileTestCommand, type SetTtsVoiceCommand, type TtsPreviewCommand, type UpsertModelProfileCommand } from '@shared/contracts'
import { EndpointResponseSchema, RuntimeInfoSchema, CacheMessagesInputSchema, OpenExternalInputSchema, PersistSessionInputSchema, PersistSessionResultSchema, SessionPersistenceStateSchema, SettingsPatchSchema } from '@shared/schemas'

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
// 响应 schema:共享定义在 shared/schemas/ipc-response,此处别名保持 chat-handlers 引用兼容(M3)
export const endpointResponseSchema = EndpointResponseSchema
export const runtimeInfoResponseSchema = RuntimeInfoSchema
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
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().positive().optional()
})
export const chatRenameSchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().min(1).max(200)   // D7A-13：标题 200 上界（无界字段补值）
})
export const chatActivateSchema = z.object({
  conversationId: z.string().min(1)
})
export const chatListConversationsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional()
})
export const chatCreateSchema = z.object({
  title: z.string().max(200).optional()   // D7A-13：标题 200 上界（无界字段补值）
})
export const chatCancelSchema = z.object({
  generationId: z.string().min(1)
})
export const chatDeleteSchema = z.object({
  conversationId: z.string().min(1)
})
export const chatGetStateSchema = z.undefined()

// —— 阶段 3 G2 持久化四通道 request schema（响应 schema 别名引用共享定义，与既有 chat* 模式一致）——
export const chatHydratePersistenceSchema = z.undefined()
export const chatPersistSessionSchema = PersistSessionInputSchema
export const chatCacheMessagesSchema = CacheMessagesInputSchema
export const chatOpenExternalSchema = OpenExternalInputSchema
// 响应 schema：共享定义在 shared/schemas/ipc-response，别名保持引用兼容
export const sessionPersistenceStateResponseSchema = SessionPersistenceStateSchema
export const persistSessionResultResponseSchema = PersistSessionResultSchema

// —— attachments 命令 request schema（spec §4.2/§4.5；响应 schema 在 shared/schemas/ipc-response）——
export const UploadFileDescriptorSchema = z.object({
  localId: z.string().min(1),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  source: z.enum(['picker', 'drag_drop', 'paste']),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']).optional(),
  path: z.string().max(1024).optional(),   // D7A-13：attachment 路径 1024 上界（无界字段补值）
  bytes: z.instanceof(Uint8Array).optional()
}).refine((d) => (d.path !== undefined) !== (d.bytes !== undefined), { message: 'path/bytes 二选一' })

export const attachmentsValidateSchema = z.object({ files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
export const attachmentsUploadSchema = z.object({ uploadId: z.string().min(1), files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
export const attachmentsCancelSchema = z.object({ uploadId: z.string().min(1) })
export const attachmentsCheckSchema = z.object({ attachmentId: z.string().min(1) })

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

// —— 阶段 7 批次 A 诊断命令 request schema（响应 schema 在 shared/schemas/ipc-response Diagnostics*）——
export const diagnosticsStateSchema = z.undefined()
export const diagnosticsDevModeSetSchema = z.object({ enabled: z.boolean() })
export const diagnosticsOpenLogDirSchema = z.undefined()
export const diagnosticsClearLogsSchema = z.undefined()
export const diagnosticsExportSchema = z.undefined()
