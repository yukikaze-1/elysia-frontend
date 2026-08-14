// src/renderer/src/bootstrap.ts
// P0-01:Renderer 启动水合编排——push 与启动 snapshot 用同一 applyChatState 消费;
// 启动代次守卫(epoch)防迟到 snapshot 覆盖已收到的新 push(D1,不改 ConnectionState 契约)。
// G2(P1-1/P2-2):先 hydratePersistence 水合 draft/cache,再取连接 snapshot——disconnected 分支离线水合,
// connected 分支缓存不进入 messageStore(只作内存储备,由 initializeConnected+activate 覆盖)。
import type { ConnectionState, Conversation, SessionPersistenceState } from '@shared/contracts'
import type { PublicError } from './utils/public-error'
import type { DesktopApiLike } from './stores/desktop-api.types'

export interface BootstrapStores {
  connection: { setState(s: ConnectionState): void; setError(e: PublicError): void }
  message: { applyEvent(e: unknown): void; handleConnectionStateChange(s: ConnectionState): void; loadReplay(conversationId: string, messages: unknown[]): void }
  conversation: {
    onConnected(connectionId?: string): Promise<void>
    onActiveConversationAppeared(activeId: string): Promise<void>
    setOfflineCache(conversations: Conversation[]): void
    activateLocal(id: string): Promise<void>
  }
  draft: { hydrate(state: SessionPersistenceState): void }
  cache: { hydrate(state: SessionPersistenceState): void }
}

export function createRendererBootstrap(api: DesktopApiLike, stores: BootstrapStores): { register(): void } {
  let stateEpoch = 0
  const applyChatState = (s: ConnectionState): void => {
    stores.connection.setState(s)
    stores.message.handleConnectionStateChange(s)
    if (s.status === 'connected') {
      void stores.conversation.onConnected(s.connectionId)
      if (s.activeConversationId) void stores.conversation.onActiveConversationAppeared(s.activeConversationId)
    }
  }
  const register = (): void => {
    api.onChatEvent((e) => stores.message.applyEvent(e))
    api.onChatState((s) => { stateEpoch++; applyChatState(s) })
    api.onChatReplay(({ conversationId, messages }) => stores.message.loadReplay(conversationId, messages))
    api.onChatError((err) => stores.connection.setError(err))
    // 启动水合：先 hydratePersistence（draft/cache store），再取连接 snapshot 判离线/在线分支。
    // epoch 守卫保留：epoch 变化即期间收到 push → 丢弃迟到 snapshot 的应用（applyChatState 之外的分支仍执行，P2-2 离线水合只依赖状态）。
    const captured = stateEpoch
    void api.hydratePersistence().then((state) => {
      stores.draft.hydrate(state)
      stores.cache.hydrate(state)
      return api.getConnectionState().then((snapshot) => {
        if (stateEpoch === captured) applyChatState(snapshot)
        if (snapshot.status === 'disconnected') {
          // 离线水合（P2-2 只发生在 disconnected 分支；connected 分支缓存不进入 messageStore）
          stores.conversation.setOfflineCache(state.conversations)
          const ids = new Set(state.conversations.map((c) => c.id))
          const target = state.lastActiveConversationId && ids.has(state.lastActiveConversationId)
            ? state.lastActiveConversationId
            : state.conversations[0]?.id
          if (target) void stores.conversation.activateLocal(target) // P1-1：绕过 api.activate/getMessages 载入快照
        }
      }).catch((e) => {
        stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
      })
    }).catch((e) => {
      // 持久化水合失败 fail-open：不影响启动，随后连接建立由后端全量调和
      stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
    })
  }
  return { register }
}
