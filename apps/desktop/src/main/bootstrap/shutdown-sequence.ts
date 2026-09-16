// src/main/bootstrap/shutdown-sequence.ts —— 退出编排装配（架构整改 Prompt 2）。
//
// 语义**零变化**，只把装配位置从 `index.ts` 挪到本模块：
//   · 步骤集合与顺序不变：renderer-persist → credentials → adapter → diagnostics；
//   · 超时预算不变（`createShutdownHandler` 缺省 1500ms，shutdown.ts:1）；
//   · fail-open 不变：任一步失败只记 onError，不阻断后续；超时只留痕后放行 quit；
//   · `toolSvc.shutdown()` 的注册**位置不变**——它仍先于本序列注册，因此在 before-quit 上仍先执行。
//
// 关于退出路径的真实次序（Electron 43.3.0 实测，注释在 windows/main-window.ts）：
//   窗口 close（挂 beforeCloseFlush）→ destroy → closed → window-all-closed → before-quit → 退出步骤
// 故 `setBeforeCloseFlush` 由 wire 阶段接好（见 wire.ts）；本模块只管 before-quit 上的有序 flush。
import { app } from 'electron'
import { createShutdownHandler } from '../shutdown'
import type { Infrastructure } from './infrastructure'
import type { ApplicationServices } from './services'

export function installShutdownSequence(infrastructure: Infrastructure, services: ApplicationServices): void {
  const { diagnostics, credentials } = infrastructure
  const { adapter } = services

  const shutdown = createShutdownHandler({
    steps: [
      // H-04：最先 flush Renderer 侧防抖态——它是最容易丢且最贴近用户输入的一批写入
      { name: 'renderer-persist', run: () => services.persistFlush.request() },
      { name: 'credentials', run: () => credentials.close() },
      { name: 'adapter', run: () => adapter.disconnect() },
      { name: 'diagnostics', run: () => diagnostics.closeAll() }
    ],
    quit: () => app.quit(),
    onTimeout: () => {
      // 走统一 fail-open 包装（ts 注入 + write-failed 日志，批次 C 最终 review 收口）
      diagnostics.audit({ type: 'shutdown:timed-out', summary: '退出超时，最后一批写入可能丢失' })
      diagnostics.logger.warn('shutdown:timed-out', { message: '退出超时，最后一批写入可能丢失' })
    },
    onError: (step, err) =>
      diagnostics.logger.error('shutdown:step-failed', { step, message: diagnostics.sanitize(err instanceof Error ? err.message : String(err)) })
  })

  // 工具侧收口与有序 flush 都是 before-quit 监听；注册顺序决定执行顺序，不得调换
  app.on('before-quit', () => services.tools.shutdown())
  app.on('before-quit', shutdown)
}
