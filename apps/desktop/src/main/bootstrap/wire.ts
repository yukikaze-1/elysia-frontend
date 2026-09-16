// src/main/bootstrap/wire.ts —— 跨服务接线阶段（架构整改 Prompt 2）。
//
// 本阶段的唯一职责是**接线**：把已经构造好的服务互相关联起来（回调、订阅、跨服务事件桥、
// 退出钩子）。它**不构造任何对象**——这是本批把「构造」与「接线」分开的关键约束：
// 一旦这里开始 new 东西，`main()` 的骨架就又会退化成一团装配细节。
//
// 整改前这里对应四处可变容器（`chatBridge` / `toolBridge` / `mediaBridge` / `fileRefsHolder`）
// 加若干就地闭包。现在全部收敛成下面两个调用：后端回调 + 退出钩子。
import type { ConnectionState } from '@shared/contracts/backend'
import { buildBackendErrorHandlers } from '../chat/backend-error-handlers'
import { setBeforeCloseFlush } from '../windows/main-window'
import { installBackendCallbacks, sendToMainWindow } from './transport'
import type { Transport } from './transport'
import type { Infrastructure } from './infrastructure'
import type { ApplicationServices } from './services'

export function wireApplicationServices(
  infrastructure: Infrastructure,
  transport: Transport,
  services: ApplicationServices
): void {
  const { diagnostics } = infrastructure
  // 只取连接视图（错误处理器要读 serverVersion/protocolVersion 现场）——本阶段不需要聚合面
  const { connection } = services.backend

  // 协议告警/后端错误可见化：onProtocolWarning → 脱敏 warn 日志（不记正文/Token/原始帧）；
  // onError → error 日志 + 推 chat:error 给 Renderer（连接面板展示）+ 审计。
  // getBuild 读连接现场——适配器已构造完成，无需整改前的自引用晚绑定。
  const errorHandlers = buildBackendErrorHandlers({
    logger: diagnostics.logger,
    sanitize: diagnostics.sanitize,
    send: (channel, payload) => sendToMainWindow(channel, payload),
    mode: transport.useMock ? 'mock' : 'real',
    getBuild: () => ({
      serverVersion: connection.getConnectionState().serverVersion,
      protocolVersion: connection.getConnectionState().protocolVersion
    }),
    audit: (event) => diagnostics.audit(event) // C2:连接错误审计（fail-open；包箭头避免丢 this）
  })

  installBackendCallbacks(transport, {
    onConnectionStateChange: (state) => onConnectionStateChange(state, services),
    onSessionReplay: (conversationId, messages, usage) => services.chat.pushReplay(conversationId, messages, usage),
    onProtocolWarning: (warning) => errorHandlers.onProtocolWarning(warning),
    onError: (error) => errorHandlers.onError(error),
    // P4-B：TTS 音频 sink（media 已装配）。返回 undefined → real-backend 告警丢弃（TTS_MEDIA_SINK_MISSING）
    ttsMedia: () => ({ putTtsAudio: (id, bytes, mime) => services.attachments.media.putTtsAudio(id, bytes, mime) }),
    onToolRequest: (req) => { void services.tools.handleRequest(req) }
  })

  // H-04：退出前请求 Renderer flush。挂在窗口级 `close` 上（真实退出路径的 close 严格早于
  // closed/before-quit，而 before-quit 时 getMainWindow() 已为 null ⇒ 只挂 before-quit 的 flush
  // 在生产恒空转，见 main-window.ts 的 close 处理器注释）。必须在建窗之前接好。
  setBeforeCloseFlush(() => services.persistFlush.request())

  // 刻意**不**在这里补一条首帧 `chat.pushState(adapter.getConnectionState())`：
  // · 不需要 —— ChatService 的每个公开入口自己就会推一次（connect / disconnect，chat-service.ts:60/65/99）；
  // · 无接收者 —— 本函数跑在**建窗之前**，`send` 经 `getMainWindow()` 取窗口，此刻恒为 null 而被丢弃；
  // · 有害 —— 一旦将来把建窗提前，它会凭空多出一条 `disconnected` 快照。
  // 整改前也没有它（HEAD 只有连接状态回调那一条路径）。
}

/**
 * 连接状态变化的三段联动（顺序与整改前逐条一致）：
 * ① 递增角色连接世代（FE-B：角色服务维护独立世代，断线/重连都作废缓存）；
 * ② 推 chat:state 给 Renderer；
 * ③ 重连成功（connected）→ 工具服务重发未确认终态 + 清 selected-set（A-8/D6B-11；首次连接无记录为 no-op）。
 */
function onConnectionStateChange(state: ConnectionState, services: ApplicationServices): void {
  services.bumpCharacterEpoch()
  services.chat.pushState(state)
  if (state.status === 'connected') void services.tools.reconnect()
}
