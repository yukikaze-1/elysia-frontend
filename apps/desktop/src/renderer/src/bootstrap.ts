// src/renderer/src/bootstrap.ts
// P0-01:Renderer 启动水合编排——push 与启动 snapshot 用同一 applyChatState 消费;
// 启动代次守卫(epoch)防迟到 snapshot 覆盖已收到的新 push(D1,不改 ConnectionState 契约)。
// G2(P1-1/P2-2):先 hydratePersistence 水合 draft/cache,再取连接 snapshot——disconnected 分支离线水合,
// connected 分支缓存不进入 messageStore(只作内存储备,由 initializeConnected+activate 覆盖)。
import type { BackendEvent, ConnectionState, Conversation, Live2DDirectiveEvent, SessionPersistenceState } from '@shared/contracts'
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
  // P4-B：voiceStore 独立订阅（D-P10）/断线 reset（Important-2）；settingsStore 启动水合（fail-open 不阻塞）
  voice: { init(): void; reset(): void }
  settings: { hydrate(): void }
  // 批次 C（C3）：live2dStore handleDirective——live2d.directive 与消息流同通道（onChatEvent）到达，经
  // applyEvent 分发路径旁路到 Live2D 消费（不产生消息副作用）。live2d 为可选（未接线/未初始化时 no-op）。
  live2d?: { handleDirective(e: Live2DDirectiveEvent): void }
  // 阶段 6 批次 B（Task 7）：toolStore——tool.* 事件旁路（判别键 event，代码 H5；stores 注入模式，
  // 与 live2d.directive 旁路同款——消息 store 不依赖工具框架）+ generation.started 清终态接线（M6）。
  tools?: { init(): void; applyBackendEvent(e: BackendEvent): void; clearForGeneration(): void }
}

export function createRendererBootstrap(api: DesktopApiLike, stores: BootstrapStores): { register(): void } {
  let stateEpoch = 0
  let prevStatus: ConnectionState['status'] = 'disconnected'
  const applyChatState = (s: ConnectionState): void => {
    const leavingConnected = prevStatus === 'connected' && s.status !== 'connected'
    prevStatus = s.status
    stores.connection.setState(s)
    stores.message.handleConnectionStateChange(s)
    if (s.status === 'connected') {
      void stores.conversation.onConnected(s.connectionId)
      if (s.activeConversationId) void stores.conversation.onActiveConversationAppeared(s.activeConversationId)
    } else if (leavingConnected) {
      // Important-2：连接离开 connected → 停采集 + 取消语音会话 + 清态 + 停 TTS（voiceStore.reset 幂等）
      void stores.voice.reset()
    }
  }
  const register = (): void => {
    api.onChatEvent((e) => {
      // 批次 C（C3）：live2d.directive 与消息流同通道（preload parseBackendEvent 已收得）——在 applyEvent 分发
      // 路径旁路到 live2dStore.handleDirective（live2d 未接线时照常落到 messageStore.applyEvent 的默认忽略）。
      // 刻意不放进 messageStore.applyEvent 内部：消息 store 不依赖 Live2D 框架模块（避免无关单测被
      // Live2DCubismCore 全局缺失拖挂）。
      if (stores.live2d && e && typeof e === 'object' && (e as { event?: unknown }).event === 'live2d.directive') {
        stores.live2d.handleDirective(e as Live2DDirectiveEvent)
        return
      }
      if (e && typeof e === 'object') {
        const kind = (e as { event?: unknown }).event
        // 阶段 6 批次 B（Task 7）：tool 事件旁路到 toolStore（判别键 event，代码 H5；live2d 旁路先例）。
        // 工具事件完全由 toolStore 消费，不产生消息副作用；tools 未接线时照常落 messageStore 默认忽略。
        if (kind === 'tool.request' || kind === 'tool.started' || kind === 'tool.completed') {
          if (stores.tools) { stores.tools.applyBackendEvent(e as BackendEvent); return }
        } else if (kind === 'generation.started') {
          // 完整 M6：generation.started 先于 applyEvent 清工具实时区终态（A9 只清终态，awaiting 跨代保留）；
          // 消息 store 仍需消费 generation.started（本事件自带 conversationId），此处只做旁路钩子不 return。
          stores.tools?.clearForGeneration()
        }
      }
      stores.message.applyEvent(e)
    })
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
    // P4-B：settings 水合 + voice 独立订阅（D-P10，与 messageStore 订阅并存，voice 事件互不干扰）。
    // 均不阻塞启动：settings.hydrate 内部 fail-open；voice.init 返回退订（常驻订阅，不持有）。
    void stores.settings.hydrate()
    stores.voice.init()
    // 阶段 6 批次 B（Task 7）：toolStore 常驻订阅 tool:event（与 voiceStore.init 同款位置；可选，未接线 no-op）
    stores.tools?.init()
  }
  return { register }
}
