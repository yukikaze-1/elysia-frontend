// src/main/ipc/tool-handlers.ts
// 阶段 6 批次 B（Task 6）：tool 五通道 handler 装配（spec A-5/B-4）。
// 全部经 createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提）+ registerHandler（可信 sender/arity 守卫）；
// tool:event 推送不入此——Main 装配直接 webContents.send(PushChannels.toolEvent)（M2 契约）。
// 注册器参数可注入（测试传收集器；真实装配传 registry.registerHandler，签名 (channel, executor, arity)）。
import { z } from 'zod'
import { registerHandler } from './registry'
import { createIpcHandler } from './executor'
import { IpcChannels } from '@shared/contracts/ipc'
import {
  PermissionDecisionSchema, ToolCancelSchema, ToolPickSourceSchema, ToolConfirmUploadSchema, ToolListResponseSchema
} from '@shared/schemas/ipc-response'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { ToolService } from '../tools/tool-service'

export function registerToolHandlers(
  deps: { tools: ToolService; sanitize: MessageSanitizer },
  register: typeof registerHandler = registerHandler,
): void {
  register(IpcChannels.toolDecide, createIpcHandler(PermissionDecisionSchema, z.undefined(), async (input) => {
    await deps.tools.decide(input.callId, input.decision)
  }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolCancel, createIpcHandler(ToolCancelSchema, z.undefined(), async (input) => { await deps.tools.cancel(input.callId) }, { sanitize: deps.sanitize }), 1)
  // toolList：arity 1（preload 恒带 {} 载荷 invoke——registry 精确匹配 arity，modelsListProfiles 同款惯例）；
  // 请求 schema z.object({}).strict() 仅接受空对象，响应 ToolListResponseSchema 严格镜像 PublicToolEvent[]
  register(IpcChannels.toolList, createIpcHandler(z.object({}).strict(), ToolListResponseSchema, async () => deps.tools.listRecent(20), { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolPickSource, createIpcHandler(ToolPickSourceSchema, z.undefined(), async (input) => { await deps.tools.pickSource(input.callId, input.sourceId) }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolConfirmUpload, createIpcHandler(ToolConfirmUploadSchema, z.undefined(), async (input) => { await deps.tools.confirmUpload(input.callId) }, { sanitize: deps.sanitize }), 1)
}
