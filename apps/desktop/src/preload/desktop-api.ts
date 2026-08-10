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
  SendMessageInput
} from '@shared/contracts'
import { parseBackendEvent } from '@shared/schemas'

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
    throw new Error(`[${res.error.code}] ${res.error.message}`)
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
    throw new Error(`[${res.error.code}] ${res.error.message}`)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

// —— chat 面：通用信封解包 + 方法 + 推送订阅 ——

/** 信封解包：ok:true → data（void 方法的 data 为 undefined）；ok:false → throw `[code] message`；畸形 → throw。与 getAppInfo 同模式；data 形状由调用方/守卫负责 */
function unwrap<T>(res: IpcResult<T>): T {
  if (res && typeof res === 'object' && res.ok === true) return res.data
  if (res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
    throw new Error(`[${res.error.code}] ${res.error.message}`)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

const CONNECTION_STATUSES = ['disconnected', 'connecting', 'connected', 'reconnecting', 'error'] as const
function isConnectionState(v: unknown): v is ConnectionState {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as ConnectionState).status === 'string' &&
    (CONNECTION_STATUSES as readonly string[]).includes((v as ConnectionState).status)
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

async function connect(serverUrl: string): Promise<BackendSession> {
  return unwrap(await invokeWithArgs<BackendSession>(IpcChannels.chatConnect, { serverUrl }))
}
async function disconnect(): Promise<void> {
  unwrap(await invoke<void>(IpcChannels.chatDisconnect))
}
async function listConversations(input: PageQuery): Promise<Page<Conversation>> {
  return unwrap(await invokeWithArgs<Page<Conversation>>(IpcChannels.chatListConversations, input))
}
async function getMessages(input: ConversationMessagesQuery): Promise<MessagePage> {
  return unwrap(await invokeWithArgs<MessagePage>(IpcChannels.chatGetMessages, input))
}
async function send(input: SendMessageInput): Promise<ClientRequestRef> {
  return unwrap(await invokeWithArgs<ClientRequestRef>(IpcChannels.chatSend, input))
}
async function cancel(input: CancelGenerationInput): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.chatCancel, input))
}
async function activate(id: string): Promise<ActivateConversationResult> {
  return unwrap(await invokeWithArgs<ActivateConversationResult>(IpcChannels.chatActivate, { conversationId: id }))
}
async function createConversation(input: CreateConversationInput): Promise<Conversation> {
  return unwrap(await invokeWithArgs<Conversation>(IpcChannels.chatCreate, input))
}
async function renameConversation(input: { conversationId: string; title: string }): Promise<Conversation> {
  return unwrap(await invokeWithArgs<Conversation>(IpcChannels.chatRename, input))
}
async function deleteConversation(id: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.chatDelete, { conversationId: id }))
}
async function getConnectionState(): Promise<ConnectionState> {
  return unwrap(await invoke<ConnectionState>(IpcChannels.chatGetState))
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

/** 订阅 chat:replay；isReplayPayload 守卫，非法丢弃 + warn；返回取消函数 */
function onChatReplay(handler: ChatReplayHandler): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    if (isReplayPayload(payload)) handler(payload)
    else console.warn('[desktopApi] chat:replay 非法载荷已丢弃')
  }
  ipcRenderer.on(PushChannels.replay, listener)
  return () => ipcRenderer.removeListener(PushChannels.replay, listener)
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
  onChatReplay
}

export type DesktopApi = typeof desktopApi
