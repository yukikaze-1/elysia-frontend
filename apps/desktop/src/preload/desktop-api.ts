// apps/desktop/src/preload/desktop-api.ts
import { ipcRenderer } from 'electron'
import { BACKEND_TOKEN_KEY, IpcChannels, PushChannels, type CredentialStatus, type IpcChannelName, type IpcResult } from '@shared/contracts'
import type { AppInfo } from '@shared/contracts'
import type {
  ActivateConversationResult,
  BackendEvent,
  BackendSession,
  CancelGenerationInput,
  ClientRequestRef,
  ConnectionState,
  Conversation,
  ConversationMessagesQuery,
  CreateConversationInput,
  Message,
  MessagePage,
  Page,
  PageQuery,
  RuntimeInfo,
  SendMessageInput
} from '@shared/contracts'
import { parseBackendEvent } from '@shared/schemas'
import { z } from 'zod'
import {
  ActivateConversationResultSchema,
  BackendSessionSchema,
  ClientRequestRefSchema,
  ConnectionStateSchema,
  ConversationSchema,
  EndpointResponseSchema,
  MessagePageSchema,
  MessageSchema,
  PageSchema,
  RuntimeInfoSchema
} from '@shared/schemas'

async function invoke<T>(channel: IpcChannelName): Promise<IpcResult<T>> {
  try {
    return (await ipcRenderer.invoke(channel)) as IpcResult<T>
  } catch {
    throw new Error('[IPC_ERROR] IPC 调用失败')
  }
}

async function invokeWithArgs<T>(channel: IpcChannelName, payload?: unknown): Promise<IpcResult<T>> {
  try {
    return (await (payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload))) as IpcResult<T>
  } catch { throw new Error('[IPC_ERROR] IPC 调用失败') }
}

/**
 * 跨 contextBridge 错误 message 前缀：结构化字段并入 message（Electron contextBridge 只可靠保留 message，
 * own property / instanceof 不保真）。Renderer 用 parsePublicError 反解。
 * 格式：`[code] [backendCode=XX] [retryable=true] [requestId=..] message`
 */
function formatIpcError(error: { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string }): Error {
  const parts = [error.code]
  if (error.backendCode) parts.push(`backendCode=${error.backendCode}`)
  if (typeof error.retryable === 'boolean') parts.push(`retryable=${error.retryable}`)
  if (error.requestId) parts.push(`requestId=${error.requestId}`)
  return new Error(`[${parts.join('] [')}] ${error.message}`)
}

function isAppInfo(v: unknown): v is AppInfo {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as AppInfo).name === 'string' && typeof (v as AppInfo).version === 'string' &&
    typeof (v as AppInfo).platform === 'string'
}

async function getAppInfo(): Promise<AppInfo> {
  const res = await invoke<AppInfo>(IpcChannels.appGetInfo)
  // 完整信封守卫：res 必须先判为对象（非信封值不崩 res.ok）；ok:true 且 data 为 AppInfo；ok:false 带 error{code,message}
  if (res && typeof res === 'object' && res.ok === true && res.data !== undefined && res.data !== null && isAppInfo(res.data)) return res.data
  if (res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
    throw formatIpcError(res.error)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

const STATUS_ENUM = ['unavailable', 'locked', 'empty', 'available'] as const
function isCredentialStatus(v: unknown): v is CredentialStatus {
  return typeof v === 'string' && (STATUS_ENUM as readonly string[]).includes(v)
}

interface CredentialStatusResponse { status: CredentialStatus; key: string }

function unwrapStatus(res: IpcResult<CredentialStatusResponse>): CredentialStatus {
  if (res && typeof res === 'object' && res.ok === true &&
      res.data && typeof res.data === 'object' && isCredentialStatus(res.data.status)) return res.data.status
  if (res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
    throw formatIpcError(res.error)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

// —— chat 面：通用信封解包 + 方法 + 推送订阅 ——

/** 信封解包 + 防御性 data 校验：ok:true → schema.safeParse(data)，失败抛 SCHEMA_VALIDATION_FAILED；
 *  ok:false → throw `[code] message`；畸形信封（ok:true 缺 data / ok:false 缺 error）→ throw。
 *  data 形状由各方法传入的 responseSchema 绑定（镜像 spec §4.1.2 表格；void 命令 z.undefined()）。 */
function unwrap<T>(res: IpcResult<T>, schema: z.ZodType<T>): T {
  if (res && typeof res === 'object' && res.ok === true) {
    if (!('data' in res)) throw new Error('[IPC_ERROR] IPC 返回格式异常')
    const parsed = schema.safeParse(res.data)
    if (!parsed.success) throw new Error('[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败')
    return parsed.data
  }
  if (res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
    throw formatIpcError(res.error)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

/** ConnectionState 纯守卫：ConnectionStateSchema 全字段校验（status 必填 + optional 字段类型），非法返回 false */
function isConnectionState(v: unknown): v is ConnectionState {
  return ConnectionStateSchema.safeParse(v).success
}

/** 会话回放推送载荷：{conversationId, messages}（RealBackend onSessionReplay 桥接） */
interface ReplayPayload {
  conversationId: string
  messages: Message[]
}

function isReplayPayload(v: unknown): v is ReplayPayload {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as ReplayPayload).conversationId === 'string' &&
    Array.isArray((v as ReplayPayload).messages)
}

/** 会话回放逐条过滤（E2：不整批拒绝）：MessageSchema.safeParse 逐条校验，非法条目丢弃 + warn，
 *  合法条目保留；返回仅含合法 Message 的回放载荷（conversationId 原样保留）。 */
function filterReplayMessages(payload: ReplayPayload): ReplayPayload {
  const messages: Message[] = []
  payload.messages.forEach((msg, index) => {
    const parsed = MessageSchema.safeParse(msg)
    if (parsed.success) messages.push(parsed.data)
    else console.warn('cyrene:replay:drop-invalid-message', { conversationId: payload.conversationId, index })
  })
  return { conversationId: payload.conversationId, messages }
}

/** connect 无参：endpoint/token 由 Main 侧 connection-config 持有，renderer 不再传任意 URL */
async function connect(): Promise<BackendSession> {
  return unwrap(await invoke<BackendSession>(IpcChannels.chatConnect), BackendSessionSchema)
}
async function setEndpoint(url: string): Promise<{ endpoint: string }> {
  return unwrap(await invokeWithArgs<{ endpoint: string }>(IpcChannels.chatSetEndpoint, { serverUrl: url }), z.object({ endpoint: z.string() }))
}
async function getEndpoint(): Promise<{ endpoint?: string }> {
  return unwrap(await invoke<{ endpoint?: string }>(IpcChannels.chatGetEndpoint), EndpointResponseSchema)
}
async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return unwrap(await invoke<RuntimeInfo>(IpcChannels.chatGetRuntimeInfo), RuntimeInfoSchema)
}
async function disconnect(): Promise<void> {
  unwrap(await invoke<void>(IpcChannels.chatDisconnect), z.undefined())
}
async function listConversations(input: PageQuery): Promise<Page<Conversation>> {
  return unwrap(await invokeWithArgs<Page<Conversation>>(IpcChannels.chatListConversations, input), PageSchema(ConversationSchema))
}
async function getMessages(input: ConversationMessagesQuery): Promise<MessagePage> {
  return unwrap(await invokeWithArgs<MessagePage>(IpcChannels.chatGetMessages, input), MessagePageSchema)
}
async function send(input: SendMessageInput): Promise<ClientRequestRef> {
  return unwrap(await invokeWithArgs<ClientRequestRef>(IpcChannels.chatSend, input), ClientRequestRefSchema)
}
async function cancel(input: CancelGenerationInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.chatCancel, input), z.undefined())
}
async function activate(id: string): Promise<ActivateConversationResult> {
  return unwrap(await invokeWithArgs<ActivateConversationResult>(IpcChannels.chatActivate, { conversationId: id }), ActivateConversationResultSchema)
}
async function createConversation(input: CreateConversationInput): Promise<Conversation> {
  return unwrap(await invokeWithArgs<Conversation>(IpcChannels.chatCreate, input), ConversationSchema)
}
async function renameConversation(input: { conversationId: string; title: string }): Promise<Conversation> {
  return unwrap(await invokeWithArgs<Conversation>(IpcChannels.chatRename, input), ConversationSchema)
}
async function deleteConversation(id: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.chatDelete, { conversationId: id }), z.undefined())
}
async function getConnectionState(): Promise<ConnectionState> {
  return unwrap(await invoke<ConnectionState>(IpcChannels.chatGetState), ConnectionStateSchema)
}

type ChatEventHandler = (event: BackendEvent) => void
type ChatStateHandler = (state: ConnectionState) => void
type ChatReplayHandler = (payload: ReplayPayload) => void

/** 订阅 chat:event；BackendEvent schema 校验，非法丢弃 + warn；返回取消函数 */
function onChatEvent(handler: ChatEventHandler): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    const parsed = parseBackendEvent(payload)
    if (parsed.success) handler(parsed.data)
    else console.warn('[desktopApi] chat:event 非法载荷已丢弃', parsed.error)
  }
  ipcRenderer.on(PushChannels.event, listener)
  return () => ipcRenderer.removeListener(PushChannels.event, listener)
}

/** 订阅 chat:state；isConnectionState 守卫，非法丢弃 + warn；返回取消函数 */
function onChatState(handler: ChatStateHandler): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    if (isConnectionState(payload)) handler(payload)
    else console.warn('[desktopApi] chat:state 非法载荷已丢弃')
  }
  ipcRenderer.on(PushChannels.state, listener)
  return () => ipcRenderer.removeListener(PushChannels.state, listener)
}

/** 订阅 chat:replay；isReplayPayload 纯守卫（结构），通过后逐条过滤（filterReplayMessages）再达 handler；返回取消函数 */
function onChatReplay(handler: ChatReplayHandler): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    if (isReplayPayload(payload)) handler(filterReplayMessages(payload))
    else console.warn('[desktopApi] chat:replay 非法载荷已丢弃')
  }
  ipcRenderer.on(PushChannels.replay, listener)
  return () => ipcRenderer.removeListener(PushChannels.replay, listener)
}

/** 聊天错误推送载荷：结构化公开字段，与 IpcErrorBody 同形；导出于此供 Renderer 订阅 */
export interface PublicErrorShape {
  code: string
  message: string
  backendCode?: string
  retryable?: boolean
  requestId?: string
}

function isPublicErrorShape(v: unknown): v is PublicErrorShape {
  return !!v && typeof v === 'object' && typeof (v as PublicErrorShape).code === 'string' && typeof (v as PublicErrorShape).message === 'string'
}

/** 订阅 chat:error；isPublicErrorShape 守卫，非法丢弃；返回取消函数 */
function onChatError(handler: (err: PublicErrorShape) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    if (isPublicErrorShape(payload)) handler(payload)
    else console.warn('[desktopApi] chat:error 非法载荷已丢弃')
  }
  ipcRenderer.on(PushChannels.error, listener)
  return () => ipcRenderer.removeListener(PushChannels.error, listener)
}

export const desktopApi = {
  getAppInfo,
  getCredentialStatus: async (): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsGetStatus)),
  setBackendToken: async (token: string): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsSet, { key: BACKEND_TOKEN_KEY, value: token })),
  clearBackendToken: async (): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsClear, { key: BACKEND_TOKEN_KEY })),
  // —— chat 面 ——
  connect,
  setEndpoint,
  getEndpoint,
  getRuntimeInfo,
  disconnect,
  listConversations,
  getMessages,
  send,
  cancel,
  activate,
  createConversation,
  renameConversation,
  deleteConversation,
  getConnectionState,
  onChatEvent,
  onChatState,
  onChatReplay,
  onChatError
}

export type DesktopApi = typeof desktopApi
