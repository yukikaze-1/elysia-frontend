// tests/integration/global-setup.ts
// 集成套件全局钩子（vitest globalSetup：整个套件只跑一次，不是每个测试文件一次）。
//
// 职责：回收上次中断运行遗留的测试应用（孤儿 Electron 进程）。
// 为什么必须在「任何测试启动之前」而不是 per-file：孤儿与后续运行争抢 CPU/GPU，使 electron-live2d
// 这类重型 spec 的「启动后首次交互」8s 等待预算偶发不够。此刻任何测试都还没启动，因此匹配到的一定是
// 遗留进程。判据与越权纪律见 helpers/orphan-apps.ts 头部说明。
import { join } from 'node:path'
import { reclaimOrphanTestApps } from './helpers/orphan-apps'

// 不复用 helpers/app.ts 的 ROOT：那个模块会顺带 require('electron') 解析二进制路径，
// 对「只读进程表」的钩子是不必要的外部依赖。
const ROOT = join(__dirname, '../..') // apps/desktop（global-setup.ts → tests → apps/desktop）

export default function setup(): void {
  const result = reclaimOrphanTestApps(ROOT)

  if (!result.canReclaim) {
    // 平台不支持 / 进程表不可读：明确报告「未执行」，绝不静默当作通过
    console.warn(`[orphan-apps] 未执行遗留进程回收（${result.reason}）；若集成测试偶发超时请手工确认无残留 electron 进程`)
  } else if (result.orphans.length > 0) {
    const detail = result.orphans.map((orphan) => `main=${orphan.pid}（${orphan.pids.length} 进程）`).join(', ')
    console.warn(`[orphan-apps] 回收 ${result.orphans.length} 个上次运行遗留的测试应用：${detail}`)
    for (const failure of result.failed) console.warn(`[orphan-apps] pid=${failure.pid} 回收失败：${failure.error}`)
  } else if (result.electronCount > 0) {
    // 有 Electron 在跑但不是测试应用（例如 pnpm dev）：只报告，不动手
    console.warn(`[orphan-apps] 检测到 ${result.electronCount} 个非本套件的 Electron 进程，未做处理`)
  }
}
