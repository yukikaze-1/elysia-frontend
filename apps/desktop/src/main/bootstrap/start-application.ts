// src/main/bootstrap/start-application.ts —— 窗口/协议启动阶段（架构整改 Prompt 2）。
//
// 本阶段是启动序列的最后一相：注册 `cyrene://` 协议供给 → 留启动痕 → `markAppStarted` → 建主窗。
// 顺序即正确性（与整改前逐条一致）：
//   · `registerCyreneProtocolHandler` 必须在建窗之前：打包/直启形态下窗口加载的就是
//     `cyrene://renderer/index.html`，handler 未就位 ⇒ 404 空白窗；
//   · `markAppStarted()` 必须在建窗之前：它是 `focusOrDefer`（second-instance / activate）
//     建立窗口的闸门——早于此的 second-instance 只登记待决聚焦，由建窗时消费；
//   · 启动痕（`app:user-data-ready` / `protocol:registered` / `app:started` / `window:runtime-mode` /
//     `gpu:runtime-mode`）在整改前是 main() 里的顺序证据，此处保持同样的相对位置。
import { app } from 'electron'
import { join } from 'path'
import { registerCyreneProtocolHandler } from '../protocol'
import { createLive2dResolver } from '../protocol/handler'
import { shouldUseViteDevServer } from '../config'
import { runtimeEnvironment } from '../config/runtime-environment'
import { ensureMainWindow, markAppStarted } from '../windows/main-window'
import type { Infrastructure } from './infrastructure'
import type { ApplicationServices } from './services'

export interface StartupDeps {
  infrastructure: Infrastructure
  services: ApplicationServices
}

/**
 * 建主窗并完成启动。
 *
 * 必须在 `installShutdownSequence` 之后调用（退出编排要能覆盖启动期之后的任何时刻），
 * 且必须在 `registerApplicationIpc` 之后（Renderer load 后立刻 invoke）。
 */
export async function startApplication(deps: StartupDeps): Promise<void> {
  const { infrastructure, services } = deps
  const { config, diagnostics, dirs, runtime } = infrastructure

  diagnostics.logger.info('app:user-data-ready', {
    baseCreated: runtime.baseCreated,
    config: dirs.config,
    logs: dirs.logs,
    audit: dirs.audit
  })

  // G3：媒体分支需 dev/prod 都注册——dev 页面在 Vite http，媒体 URL 在 cyrene://（spec §3.1）。
  // P1-5：dev（shouldUseViteDevServer）省略 rendererRoot——媒体分支不依赖它，避免 out/renderer 未构建时 realpath 抛错。
  await registerCyreneProtocolHandler({
    ...(!shouldUseViteDevServer(app.isPackaged, process.env) ? { rendererRoot: join(__dirname, '../renderer') } : {}),
    resolveMedia: (mediaType, id, request) => services.attachments.media.stream(mediaType, id, request),
    // 阶段 5 批次 A（A4）：live2d 供给分派——registered/available 门禁 + fail-closed verify（首命中 await 全量 hash）
    // + containment/白名单 + mime/no-store + dev CORS（受信 dev Origin 成功与错误响应均回补 ACAO）。
    resolveLive2d: createLive2dResolver(services.live2d)
  })
  diagnostics.logger.info('protocol:registered')
  diagnostics.logger.info('app:started', { mode: config.mode, packaged: app.isPackaged })

  // 窗口呈现模式落日志（每次启动一条）：自动化运行是否静默、由哪个来源决定，现场可查、无需推断。
  const windowEnv = runtimeEnvironment()
  diagnostics.logger.info('window:runtime-mode', {
    mode: windowEnv.windowMode,
    source: windowEnv.windowModeSource,
    harness: windowEnv.isTestHarness
  })
  // GPU 回退决策留痕（与窗口模式同址）：现场要能一眼看出"这次为什么用了软件渲染"。
  diagnostics.logger.info('gpu:runtime-mode', {
    disabled: runtime.gpuDecision.disableHardwareAcceleration,
    mode: runtime.gpuDecision.gpuMode,
    source: runtime.gpuDecision.gpuModeSource,
    platform: process.platform
  })

  markAppStarted()
  ensureMainWindow(loadErrorSink(infrastructure), {
    // D7A-04：F12 门 getter（打包态仅 devMode 会话态时注册）
    isDevMode: () => services.diagnostics.getState().devMode
  })
}

/** 窗口加载失败落诊断（handler 缺失 → 404 空白窗的唯一可见线索） */
function loadErrorSink(infrastructure: Infrastructure): (err: unknown) => void {
  const { logger, sanitize } = infrastructure.diagnostics
  return (err) => logger.error('window:load-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) })
}
