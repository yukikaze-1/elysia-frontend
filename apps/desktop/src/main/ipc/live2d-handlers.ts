// apps/desktop/src/main/ipc/live2d-handlers.ts
// 阶段 5 批次 A（A3，spec D5A-07）：live2d:list-models 通道装配。
// createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提 + sanitize 错误脱敏）+ registerHandler（可信 sender/arity 0 守卫）。
import { IpcChannels } from '@shared/contracts'
import { Live2DListResponseSchema } from '@shared/schemas'
import { createIpcHandler } from './executor'
import { registerHandler } from './registry'
import { live2dListModelsSchema } from './channels'
import type { Live2DModelRegistry } from '../live2d/model-registry'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'

export function registerLive2dHandlers(deps: { registry: Live2DModelRegistry; sanitize: MessageSanitizer; logger: Logger }): void {
  // 响应 = registry.listInstalledModels()（摘要数组）；reason 字段已在上游脱敏为枚举码（missing_file/size_mismatch/hash_mismatch），
  // 摘要不含任何敏感路径；error 消息经 sanitize 统一脱敏（path 掩码），channel/logger 入结构化日志。
  registerHandler(
    IpcChannels.live2dListModels,
    createIpcHandler(live2dListModelsSchema, Live2DListResponseSchema, () => deps.registry.listInstalledModels(), { sanitize: deps.sanitize, channel: IpcChannels.live2dListModels, logger: deps.logger }),
    0
  )
}
