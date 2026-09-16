// src/main/ipc/tool-handlers.ts
// 阶段 6 批次 B（Task 6）+ 批次 C（Task 6）：tool 九通道 handler 装配（spec A-5/B-4/D6C-12）。
// 全部经 createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提）+ registerHandler（可信 sender/arity 守卫）；
// tool:event 推送不入此——Main 装配直接 webContents.send(PushChannels.toolEvent)（M2 契约）。
// 注册器参数可注入（测试传收集器；真实装配传 registry.registerHandler，签名 (channel, executor, arity)）。
import { z } from 'zod'
import { registerHandler } from './registry'
import { createIpcHandler } from './executor'
import { IpcChannels } from '@shared/contracts/ipc'
import {
  PermissionDecisionSchema, ToolCancelSchema, ToolPickSourceSchema, ToolConfirmUploadSchema, ToolListResponseSchema,
  GrantDirectorySchema, GrantDirectoryResponseSchema, GrantListResponseSchema, GrantRevokeSchema, HistoryResponseSchema, ToolHistoryQuerySchema
} from '@shared/schemas/ipc-response'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { ToolService } from '../tools/tool-service'
import { ToolServiceError } from '../tools/tool-execution-contract'
import type { GrantStore } from '../tools/grant-store'
import type { HistoryEntry } from '../tools/tool-history'

export function registerToolHandlers(
  deps: {
    tools: ToolService
    sanitize: MessageSanitizer
    grants: GrantStore                 // 批次 C（D6C-12）：目录授权仓库（toolGrants/toolGrantRevoke 数据源）
    history: (dir: string, opts: { limit?: number }) => HistoryEntry[] | Promise<HistoryEntry[]>   // 审批历史回读（readAuditEvents 同步/异步两向兼容，tool-history.ts 头注）
    auditDir: string                   // 审计目录（history 首参）
  },
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
  // —— 批次 C（D6C-12）：目录授权 + 审批历史四通道 ——
  register(IpcChannels.toolGrantDirectory, createIpcHandler(GrantDirectorySchema, GrantDirectoryResponseSchema, async (input) => {
    const executed = await deps.tools.grantDirectory(input.callId, input.ttlMs)   // FINAL-LOW：executed 回传（F-1 miss → false 供 UI 提示）
    return { executed }
  }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolGrants, createIpcHandler(z.object({}).strict(), GrantListResponseSchema, async () => deps.grants.list(), { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolGrantRevoke, createIpcHandler(GrantRevokeSchema, z.undefined(), async (input) => {
    if (!deps.grants.list().some((g) => g.id === input.id)) throw new ToolServiceError('GRANT_NOT_FOUND', '授权不存在')   // V-28：未知 → 拒绝；已撤销 → revoke 内部 no-op
    await deps.grants.revoke(input.id)   // 2026-09-16 审计 P2：撤销 fail-closed——落盘失败会抛 GRANT_REVOKE_NOT_PERSISTED（不再静默失效）
  }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolHistory, createIpcHandler(ToolHistoryQuerySchema, HistoryResponseSchema, async (input) =>
    deps.history(deps.auditDir, { limit: input.limit }), { sanitize: deps.sanitize }), 1)
}
