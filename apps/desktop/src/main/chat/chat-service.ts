import type { BackendSession, ConversationMessagesQuery, ConnectionState } from '@shared/contracts/backend'
import type { BackendAdapter } from '../transport/backend-adapter'
import type { CreateConversationInput, PageQuery } from '@shared/contracts/conversation'
import type { BackendEvent } from '@shared/contracts/events'
import type { Message, SendMessageInput } from '@shared/contracts/message'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { PushChannels } from '@shared/contracts/ipc'

export interface ChatServiceDeps {
  adapter: BackendAdapter
  send: (channel: string, payload: unknown) => void   // webContents.send 包装(PushChannels)
  getToken: () => string | undefined | Promise<string | undefined>   // 凭据读取(async;装配用 store.getCredential(key).then(t=>t??undefined),R1)
  requireToken?: boolean
}

export type ChatService = ReturnType<typeof createChatService>

/**
 * Chat 服务:持有 BackendAdapter + webContents.send 桥,是 Main 侧 chat 领域能力的唯一入口。
 * - 领域事件 → chat:event;连接状态变化 → chat:state;
 * - onConnectionStateChange 的接线在装配方(adapter 构造时桥到 pushState);connect/disconnect 后此处也主动推一次(快照兜底)。
 */
export function createChatService(deps: ChatServiceDeps) {
  const { adapter } = deps
  const unsub = adapter.subscribe((event: BackendEvent) => deps.send(PushChannels.event, event))

  const pushState = (s: ConnectionState) => deps.send(PushChannels.state, s)

  return {
    async connect(input: { serverUrl: string }): Promise<BackendSession> {
      let token: string | undefined
      if (deps.requireToken !== false) {
        token = await deps.getToken()
        if (!token) throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '后端 Token 未设置')
      }
      const session = await adapter.connect({ serverUrl: input.serverUrl, token })
      pushState(adapter.getConnectionState())
      return session
    },
    async disconnect(): Promise<void> { await adapter.disconnect(); pushState(adapter.getConnectionState()) },
    listConversations: (input: PageQuery) => adapter.listConversations(input),
    getMessages: (input: ConversationMessagesQuery) => adapter.getConversationMessages(input),
    send: (input: SendMessageInput) => adapter.sendMessage(input),
    cancel: (input: { generationId: string }) => adapter.cancelGeneration(input),
    activate: (id: string) => adapter.activateConversation(id),
    createConversation: (input: CreateConversationInput) => adapter.createConversation(input),
    renameConversation: (input: { conversationId: string; title: string }) => adapter.renameConversation(input.conversationId, input.title),
    deleteConversation: (id: string) => adapter.deleteConversation(id),
    getConnectionState: () => adapter.getConnectionState(),
    /** 连接状态变化主动推送(adapter.onConnectionStateChange 由装配方桥到此处) */
    pushState,
    /** 会话历史回放推送(chat:replay);由装配方在 adapter 支持 onSessionReplay(RealBackend)时桥到此处,P1-1 */
    pushReplay(conversationId: string, messages: Message[]): void {
      deps.send(PushChannels.replay, { conversationId, messages })
    },
    dispose(): void { unsub?.() }
  }
}
