// tests/unit/global-setup.ts
// 单元套件的全局钩子（vitest globalSetup：整个套件只跑一次）。
//
// 职责：回收本仓库测试命名空间下遗留的临时目录（P2-6 / L-28）。
//
// 为什么单元套件也需要它：实测 $TEMP 下累积的 **6,720 个 `cy*` 目录 / 22.6 MB** 里，
// 绝大多数来自**单元** spec——它们反复 `mkdtempSync` 却根本没有清理代码
// （如 `credential-store.spec.ts`、`settings-service.spec.ts`、`safe-open.spec.ts`）。
// 集成套件那 103 个 `cy-int-ud-*`（评审只看到了这部分）反而是少数。
//
// 与集成套件的分工：这里**只回收目录，不碰任何进程**。回收进程是集成套件 global-setup 的职责
// （它认得自己启动的 Electron 签名）；单元运行不该去杀别的进程。
// 目录侧的并发保护由 reclaimTestTempDirs 的「10 分钟年龄阈值」承担：
// 比这更新的目录可能是另一个正在运行的套件（或另一个项目）的在途目录，一律不碰。
import { reclaimTestTempDirs } from '../helpers/temp-dirs'

export default function setup(): void {
  const result = reclaimTestTempDirs()

  if (result.removed.length > 0) {
    console.warn(`[temp-dirs] 回收 ${result.removed.length} 个上次运行遗留的测试临时目录（扫描 ${result.scanned} 个命中前缀的目录）`)
  }
  if (result.failed.length > 0) {
    // 删除失败只报告：占用中的目录下次运行再收，绝不让它影响测试结论
    console.warn(`[temp-dirs] ${result.failed.length} 个目录回收失败（下次运行会重试）：${result.failed.map((f) => f.error).join('; ')}`)
  }
  if (result.skippedInUse.length > 0) {
    console.warn(`[temp-dirs] 跳过 ${result.skippedInUse.length} 个被活进程引用的目录`)
  }
}
