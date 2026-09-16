// src/main/bootstrap/register-ipc.ts —— IPC 注册阶段（架构整改 Prompt 2）。
//
// 本阶段**只**把已经构造好的服务接到通道上，不构造任何服务、不做跨服务接线。
//
// 通道面本身没有任何变化：注册细节仍在 `ipc/handlers.ts` 的 `registerHandlers` 里（那里本来就
// 有清晰的结构），本模块只负责把 infrastructure/services 两个上下文对象翻译成它的 deps 形状。
// 之所以单列一个薄模块，是为了让 `main()` 的骨架能读出"这一步是注册通道"，而不是把它藏进
// 另一个大函数里。
//
// 前置约束（与整改前一致，不得重排）：
// - 必须在窗口创建**之前**完成：Renderer load 后立刻会 invoke，缺 handler 会直接失败；
//   `registerHandler` 对重复通道抛错，故本阶段只能执行一次。
// - 必须在 persistFlush 构造之后（其 ack 通道由本阶段注册）。
import { registerHandlers } from '../ipc/handlers'
import type { Infrastructure } from './infrastructure'
import type { ApplicationServices } from './services'

export function registerApplicationIpc(infrastructure: Infrastructure, services: ApplicationServices): void {
  const { credentials, connectionConfig, diagnostics } = infrastructure
  const { chat, sessionStore, characterDrafts, attachments, backend, settings, live2d, tools, grants, characters, persistFlush } = services
  registerHandlers({
    credentials,
    logger: diagnostics.logger,
    chat,
    connectionConfig,
    sessionStore,
    characterDrafts,
    attachments,
    // 各 handler 只拿到自己领域的端口视图（voice 12 方法 / model 9 方法），不再拿到聚合面
    models: { backend: backend.model, media: attachments.media },
    settings: { svc: settings },
    voice: { backend: backend.voice, media: attachments.media },
    live2d: { registry: live2d },
    tools,
    grants,
    auditDir: diagnostics.auditDir,
    diagnostics: services.diagnostics,
    characters: { service: characters },
    persistFlush,
    audit: (event) => diagnostics.audit(event)
  })
}
