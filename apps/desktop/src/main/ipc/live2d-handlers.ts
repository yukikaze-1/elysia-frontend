// apps/desktop/src/main/ipc/live2d-handlers.ts
// 阶段 5 批次 A（A3，spec D5A-07）：live2d:list-models 通道装配。
// 2026-09-10：新增 live2d:read-model-file——dev 形态（Vite dev server 供给页面）模型文件字节供给。
// createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提 + sanitize 错误脱敏）+ registerHandler（可信 sender/arity 守卫）。
import { readFile } from 'node:fs/promises'
import { IpcChannels } from '@shared/contracts'
import { Live2DListResponseSchema, Live2dModelFileResultSchema } from '@shared/schemas'
import { createIpcHandler } from './executor'
import { registerHandler } from './registry'
import { live2dListModelsSchema, live2dReadModelFileSchema } from './channels'
import { gateLive2dFile, gateHttpFailure } from '../live2d/serve-gate'
import { mimeOf } from '../protocol/mime'
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
  // dev 形态模型文件字节供给（2026-09-10）。恒注册——它不授予额外能力：打包形态下 Renderer 本就能同源
  // fetch 同一批字节（页面 origin 即 cyrene://renderer），本通道只是把等价读取搬到 dev 可用的传输上。
  // 门禁与协议通道共用 serve-gate.ts 同一实现，故两条通道不可能分叉出绕过入口。
  // 只回字节与 mime：绝对路径留在 Main（resolveModelFile 的返回值不出本进程）。
  registerHandler(
    IpcChannels.live2dReadModelFile,
    createIpcHandler(
      live2dReadModelFileSchema,
      Live2dModelFileResultSchema,
      async ({ modelId, relPath }) => {
        const gate = await gateLive2dFile(deps.registry, modelId, relPath)
        if (gate.kind !== 'ok') return { ok: false as const, status: gateHttpFailure(gate.kind).status }
        // 闸门已确认 absPath 为普通文件且经 realpath containment；此处只处理读取竞态（读前被删/权限变更）
        const buf = await readFile(gate.absPath).catch(() => null)
        if (!buf) return { ok: false as const, status: 404 }
        return { ok: true as const, bytes: new Uint8Array(buf), mime: mimeOf(gate.absPath) ?? 'application/octet-stream' }
      },
      { sanitize: deps.sanitize, channel: IpcChannels.live2dReadModelFile, logger: deps.logger }
    ),
    1
  )
}
