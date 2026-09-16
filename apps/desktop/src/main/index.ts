// apps/desktop/src/main/index.ts —— Main 组合根（Composition Root）。
//
// 本文件只体现**应用生命周期阶段**，不体现每个服务的构造细节（架构整改 Prompt 2）。
// 读 `main()` 即应看懂：Electron pre-ready 准备 → ready 边界 → 基础设施 → 后端适配器 →
// 应用服务 → 跨服务接线 → IPC 注册 → 退出编排 → 窗口启动。每一步的实现在 `bootstrap/` 对应模块。
//
// 阶段与顺序约束（逐条注释在各模块头注，此处只列骨架）：
//   1. prepareElectronRuntime      harness 归一化 / 调试门 / command line / GPU 回退 /
//                                  test appData / appData 风味 / cyrene:// scheme / 应用身份 /
//                                  单实例锁 / `await app.whenReady()`
//   2. createInfrastructure        appUserModelId / userData 读回断言 / 生产菜单 / userData 子目录 /
//                                  diagnostics / 崩溃与进程级兜底 / 凭据 / 连接配置
//   3. createTransport             后端适配器选择与构造（Real/Mock + mock 夹具 env 桥）
//   4. createApplicationServices   设置/授权/工具/角色/会话/草稿/附件/媒体/Live2D/诊断/退出 flush
//   5. wireApplicationServices     后端回调 → chat/media/tool；窗口 close 上的退出 flush
//   6. registerApplicationIpc      通道注册（通道面不变）
//   7. installShutdownSequence     before-quit 有序 flush（工具收口先于有序步骤）
//   8. installTestProbe            harness 门控的只读探针（非 harness 为 no-op）
//   9. startApplication            协议供给 → 启动痕 → markAppStarted → 建主窗
//
// **本文件不得**：构造具体服务、注册具体 handler、出现可变桥容器/持有者、放宽任何启动门禁。
import { app } from 'electron'
import { resolveBackendMode } from './config/backend-mode'
import type { BackendConnectionPort } from './transport/backend-ports'
import { createRuntimeShell, prepareElectronRuntime, type RuntimeShell } from './bootstrap/pre-ready'
import { createInfrastructure } from './bootstrap/infrastructure'
import { createTransport } from './bootstrap/transport'
import { createApplicationServices } from './bootstrap/services'
import { wireApplicationServices } from './bootstrap/wire'
import { registerApplicationIpc } from './bootstrap/register-ipc'
import { installShutdownSequence } from './bootstrap/shutdown-sequence'
import { installTestProbe } from './bootstrap/test-probe'
import { startApplication } from './bootstrap/start-application'
import { focusOrDefer } from './windows/main-window'

/**
 * 运行期壳在模块作用域持有，**只为了顶层 `main().catch` 也能用它收尾**——那正是整改前
 * `void main().catch((e) => fatal(e.message))` 的形态（`fatal` 当时也是模块级的）。
 * 它在 `main()` 第一行被赋值，赋值前后都没有 Electron 副作用；`ensure()` 幂等。
 */
let shell: RuntimeShell | undefined

async function main(): Promise<void> {
  // 运行期壳必须先于 ready 存在：安全门命中、身份失败与运行期未捕获异常都要有唯一 fatal 出口
  try {
    shell = createRuntimeShell()
  } catch {
    app.exit(1) // 连错误出口都建不起来：只剩退出
    return
  }

  const preReady = await prepareElectronRuntime(shell)
  if (preReady.abort) return

  // 后端形态只解析一次：infrastructure（dev 默认 endpoint 门控）与 transport 共用同一结果
  const useMock = resolveBackendMode(app.isPackaged, process.env) === 'mock'

  // 此处失败即 fatal + return：与整改前逐字一致（诊断尚未装配，closeAll 为 no-op）
  const infraResult = await createInfrastructure({ runtime: preReady.runtime, shell, useMock })
  if (!infraResult.ok) {
    shell.fatal(infraResult.message)
    return
  }
  const infrastructure = infraResult.infrastructure

  try {
    const transport = createTransport({ useMock })
    // 只取连接视图做"当前激活会话"探针——组合根不直接把聚合面交给任何服务（见 backend-capability-ports.spec.ts）
    const connection: BackendConnectionPort = transport.adapter
    const services = await createApplicationServices({
      infrastructure,
      transport,
      // SessionStore 的「当前激活会话」读探针：chat 服务就位后的惰性只读入口（见 services.ts）
      probe: { activeConversationId: () => connection.getConnectionState().activeConversationId }
    })

    wireApplicationServices(infrastructure, transport, services)
    registerApplicationIpc(infrastructure, services)
    installShutdownSequence(infrastructure, services)
    installTestProbe(services)

    await startApplication({ infrastructure, services })
  } catch (e) {
    // catch 刻意不 return：整改前同样如此——`activate` / `window-all-closed` 在失败路径上仍然注册
    shell.fatal(`启动失败：${e instanceof Error ? e.message : '未知错误'}`)
  }

  app.on('activate', () => focusOrDefer())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

void main().catch((e) => {
  // 与整改前同款收尾（`void main().catch(e => fatal(...))`）：弹「无法启动」框 + closeAll + exit(1)。
  // 壳已建立 ⇒ 走 shell.fatal；壳未建立（连 createRuntimeShell 都失败）⇒ 只剩退出。
  if (!shell) { app.exit(1); return }
  shell.fatal(e instanceof Error ? e.message : '未知错误')
})
