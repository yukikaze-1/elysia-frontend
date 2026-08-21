// src/main/ipc/diagnostics-handlers.ts
// 阶段 7 批次 A（Task 5，spec §6.2）：诊断 IPC 五 invoke 通道 handler 装配。
// 全部经 createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提）+ registerHandler（可信 sender/arity 守卫）；
// `diagnostics:dev-event` 为 Main→Renderer 下行 push——不入本模块（装配直接 webContents.send(PushChannels.diagnosticsDevEvent)，M2 契约）。
import { IpcChannels } from '@shared/contracts/ipc'
import { DiagnosticsExportResultSchema, DiagnosticsStateSchema } from '@shared/schemas/ipc-response'
import { z } from 'zod'
import { diagnosticsClearLogsSchema, diagnosticsDevModeSetSchema, diagnosticsExportSchema, diagnosticsOpenLogDirSchema, diagnosticsStateSchema } from './channels'
import { createIpcHandler } from './executor'
import { registerHandler } from './registry'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import type { DiagnosticsService } from '../diagnostics/diagnostics-service'

export function registerDiagnosticsHandlers(deps: {
  service: DiagnosticsService
  sanitize: MessageSanitizer
  logger: Logger
}): void {
  const { service, sanitize, logger } = deps
  registerHandler(IpcChannels.diagnosticsState,
    createIpcHandler(diagnosticsStateSchema, DiagnosticsStateSchema, () => service.getState(), { sanitize, channel: IpcChannels.diagnosticsState, logger }), 0)
  registerHandler(IpcChannels.diagnosticsDevModeSet,
    createIpcHandler(diagnosticsDevModeSetSchema, z.undefined(), (req) => { service.setDevMode(req.enabled) }, { sanitize, channel: IpcChannels.diagnosticsDevModeSet, logger }), 1)
  registerHandler(IpcChannels.diagnosticsOpenLogDir,
    createIpcHandler(diagnosticsOpenLogDirSchema, z.undefined(), () => service.openLogDir(), { sanitize, channel: IpcChannels.diagnosticsOpenLogDir, logger }), 0)
  registerHandler(IpcChannels.diagnosticsClearLogs,
    createIpcHandler(diagnosticsClearLogsSchema, z.undefined(), () => service.clearLogs(), { sanitize, channel: IpcChannels.diagnosticsClearLogs, logger }), 0)
  registerHandler(IpcChannels.diagnosticsExport,
    createIpcHandler(diagnosticsExportSchema, DiagnosticsExportResultSchema, () => service.exportPackage(), { sanitize, channel: IpcChannels.diagnosticsExport, logger }), 0)
}
