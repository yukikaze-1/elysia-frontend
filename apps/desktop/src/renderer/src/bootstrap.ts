// src/renderer/src/bootstrap.ts
// P0-01:Renderer 启动水合编排——push 与启动 snapshot 用同一 applyChatState 消费;
// 启动代次守卫(epoch)防迟到 snapshot 覆盖已收到的新 push(D1,不改 ConnectionState 契约)。
import type { ConnectionState } from '@shared/contracts'
import type { PublicError } from './utils/public-error'
import type { DesktopApiLike } from './stores/desktop-api.types'

export interface BootstrapStores {
  connection: { setState(s: ConnectionState): void; setError(e: PublicError): void }
  message: { applyEvent(e: unknown): void; handleConnectionStateChange(s: ConnectionState): void; loadReplay(conversationId: string, messages: unknown[]): void }
  conversation: { onConnected(connectionId?: string): Promise<void>; onActiveConversationAppeared(activeId: string): Promise<void> }
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
    // 启动 snapshot 水合：先注册订阅（epoch 从 0 起），再拉当前状态；epoch 变化即期间收到 push → 丢弃迟到 snapshot
    const captured = stateEpoch
    void api.getConnectionState().then((snapshot) => {
      if (stateEpoch === captured) applyChatState(snapshot)
    }).catch((e) => {
      stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
      // snapshot 失败进公开错误/诊断路径，不清凭据、不制造断开（清单 §4.3 #4）
    })
  }
  return { register }
}
