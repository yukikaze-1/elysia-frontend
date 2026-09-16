// src/main/bootstrap/test-probe.ts —— Main 侧测试探针（架构整改 Prompt 2）。
//
// M10（阶段 6 批次 B）：集成测试需要断言 Main 内部状态（wire 上的 lastToolStatus、工具记录、
// 窗口呈现证据、对话框调用记录），而这些状态没有 IPC 出口——**刻意没有**：它们不该成为产品面。
// 故仅在 `CYRENE_TEST_HARNESS=1` 时把只读快照挂到 `globalThis.__cyreneMainProbe`。
//
// 纪律（与整改前逐条一致）：探针只读、不改变任何服务行为、不在打包正式运行中出现
// （`CYRENE_TEST_HARNESS` 在打包态已被 `pre-ready.ts` 归一化抹掉，除非显式二开）。
import type { MockBackend } from '../transport/mock-backend'
import { lastWindowPresentation } from '../windows/window-presentation'
import { dialogInvocations, type DialogInvocation } from '../native-ui/dialog-service'
import type { ApplicationServices } from './services'

export interface MainProbe {
  getLastToolStatus(): unknown
  getToolRecords(): unknown[]
  getWindowPresentation(): ReturnType<typeof lastWindowPresentation>
  getDialogInvocations(): readonly DialogInvocation[]
}

/** harness 门控装配（非 harness 环境为 no-op）。必须在 toolSvc 构造之后调用。 */
export function installTestProbe(services: ApplicationServices): void {
  if (process.env.CYRENE_TEST_HARNESS !== '1') return
  const { adapter } = services
  const probe = globalThis as unknown as { __cyreneMainProbe: MainProbe }
  probe.__cyreneMainProbe = {
    getLastToolStatus: () => (adapter as MockBackend).lastToolStatus ?? null,
    getToolRecords: () => [...services.tools.listRecent(50)],
    // 2026-09-12 追加窗口呈现证据：skipTaskbar 在 Electron 无 getter，故由统一建窗层留痕供集成断言
    getWindowPresentation: () => lastWindowPresentation(),
    // 对话框调用记录使「是否触发 dialog / 参数是否正确」在 silent 下仍可验证（不再弹原生窗口）
    getDialogInvocations: () => dialogInvocations()
  }
}
