import type { BackendSession, ConversationMessagesQuery, ConnectionState, RuntimeInfo } from '@shared/contracts/backend'
import type { BackendAdapter } from '../transport/backend-adapter'
import type { CreateConversationInput, PageQuery } from '@shared/contracts/conversation'
import type { BackendEvent } from '@shared/contracts/events'
import type { Message, SendMessageInput } from '@shared/contracts/message'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { PushChannels } from '@shared/contracts/ipc'
import type { ConnectionConfig } from '../connection/connection-config'
import { safeAudit } from '../diagnostics/safe-audit'
import type { AuditEvent } from '../diagnostics/audit'

export interface ChatServiceDeps {
  adapter: BackendAdapter
  send: (channel: string, payload: unknown) => void   // webContents.send 包装(PushChannels)
  getToken: () => string | undefined | Promise<string | undefined>   // 凭据读取(async;装配用 store.getCredential(key).then(t=>t??undefined),R1)
  requireToken?: boolean
  connectionConfig: ConnectionConfig   // endpoint 规范化 + token-origin 绑定（connect 校验/设置都经它）
  packaged?: boolean                   // 装配信息（getRuntimeInfo 展示用）
  audit?: (event: Omit<AuditEvent, 'ts'>) => void   // 连接生命周期审计（C2;fail-open,safeAudit 调用）
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
    async connect(): Promise<BackendSession> {
      try {
        const endpoint = deps.connectionConfig.getEndpoint()
        if (deps.requireToken !== false) {
          if (!endpoint) throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '请先设置后端地址')
          const binding = await deps.connectionConfig.getTokenBinding()
          if (binding?.origin !== endpoint.origin) throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '后端 Token 未设置或与当前地址不匹配')
          const token = await deps.getToken()
          if (!token) throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '后端 Token 未设置')
          const session = await adapter.connect({ serverUrl: endpoint.baseUrl, token })
          pushState(adapter.getConnectionState())
          safeAudit(deps.audit, { type: 'connection:connect', status: 'connected', summary: 'mode=real' })   // C2:real 分支写死（requireToken 在分支内已收窄，表达式触发 TS2367）
          return session
        }
        const session = await adapter.connect({ serverUrl: 'mock://local' })
        pushState(adapter.getConnectionState())
        safeAudit(deps.audit, { type: 'connection:connect', status: 'connected', summary: 'mode=mock' })   // C2:mock 分支写死（同上）
        return session
      } catch (e) {
        // C2:code 归一化——非 CyreneError 用 message 兜底;safeAudit fail-open,审计失败不影响 rethrow
        safeAudit(deps.audit, { type: 'connection:connect', status: 'failed', summary: `code=${e instanceof Error ? (e as { code?: string }).code ?? String(e.message) : String(e)}` })
        throw e
      }
    },
    /** 设置后端地址：经 connection-config 规范化 + 校验（origin 变化自动清 token 绑定）;endpoint(origin/baseUrl) 变化时联动取消旧连接(D14) */
    async setEndpoint(rawUrl: string): Promise<{ endpoint: string }> {
      const before = deps.connectionConfig.getEndpoint()
      const e = await deps.connectionConfig.setEndpoint(rawUrl)
      if (before && (e.origin !== before.origin || e.baseUrl !== before.baseUrl)) {
        await deps.adapter.disconnect()   // D14:旧 WS/REST 取消,面板新地址与真实连接一致
      }
      return { endpoint: e.baseUrl }
    },
    getEndpoint(): { endpoint?: string } {
      const e = deps.connectionConfig.getEndpoint()
      return { endpoint: e?.baseUrl }
    },
    getRuntimeInfo(): RuntimeInfo {
      return { mode: deps.requireToken !== false ? 'real' : 'mock', packaged: deps.packaged ?? false }
    },
    async disconnect(): Promise<void> {
      await adapter.disconnect()
      pushState(adapter.getConnectionState())
      // C2:disconnect 内无 requireToken 收窄,表达式可保留（与 connect 分支内写死不同）
      safeAudit(deps.audit, { type: 'connection:disconnect', summary: `mode=${deps.requireToken !== false ? 'real' : 'mock'}` })
    },
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
