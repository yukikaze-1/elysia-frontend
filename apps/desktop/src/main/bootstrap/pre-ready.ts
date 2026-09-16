// src/main/bootstrap/pre-ready.ts —— Electron 运行期初始化第一阶段（架构整改 Prompt 2）。
//
// 本模块的全部内容都必须在 `app.whenReady()` **之前**完成，且其中多条是**顺序即正确性**：
//
//   harness 归一化 → 调试开关门 → command line switches → GPU 回退判定
//     → （ready 不变量）test appData 覆写 → appData 风味 → cyrene:// scheme → 应用身份 → 单实例锁
//     → await app.whenReady()
//
// 抽成模块的目的不是"让 index.ts 变短"，而是让**这一阶段的边界可被审查**：凡不满足
// "必须在 ready 前"的构造（业务服务、持久化装载、IPC handler）都不属于这里。
//
// 返回值：`abort` 表示本次启动必须终止（安全门命中、身份安装抛错、或非持锁实例），
// 调用方**不得**继续执行后续阶段。`whenReady()` 留在本函数内，是因为它与单实例锁的先后
// 本身就是约束（第二实例已在锁处 exit(0)，只有持锁主实例才等到 ready）。
import { app } from 'electron'
import {
  applyTestAppDataOverride,
  installAppIdentity,
  resolveAppDataFlavor,
  setAppDataFlavor
} from '../app/lifecycle'
import { focusOrDefer } from '../windows/main-window'
import { normalizeHarnessEnv } from '../config/runtime-environment'
import { resolveGpuDecision, type GpuDecision } from '../config/gpu-mode'
import { findForbiddenDebugLaunch } from '../config/debug-switches'
import { registerCyreneScheme } from '../protocol'
import { createFatalShutdown } from '../shutdown'
import { defaultDialogService, type DialogPort } from '../native-ui/dialog-service'

/** 必须在 ready 前完成、且 ready 之后仍要读取的启动决策 */
export interface ElectronRuntime {
  /** `__APP_MODE__` 归一后的构建模式（test appData 门与 appData 风味共用同一判据） */
  appMode: string
  /** test harness 显式覆写的 appData（未覆写为 undefined）——现场留痕用 */
  testAppData: string | undefined
  /** 身份安装结果：userData 基准目录是否由本次启动创建 */
  baseCreated: boolean
  /** setPath('userData') 是否成功；false 时 ready 后必须 fail-start（见 infrastructure.ts） */
  setPathOk: boolean
  /** GPU 回退决策——ready 后写日志用（开关本身已在本阶段 append） */
  gpuDecision: GpuDecision
}

/**
 * 运行期壳：整个启动序列共用的**唯一** fatal 出口与原生对话框入口。
 *
 * 为什么两者必须同址且早于 ready：
 * ① `fatal` 在 ready 之前就会被安全门使用（`rejectForbiddenDebugSwitches`），故它必须在本阶段就存在。
 * ② 对话框实例必须**迟于 harness 归一化**创建：`dialog-service.ts` 的 `createDialogService()`
 *    默认参数会解析 `runtimeEnvironment()` 的进程级单例（`config/runtime-environment.ts:155` 的
 *    `cached ??=`），而原实现在模块作用域（旧 `index.ts:66`）就调用了它——即打包态残留
 *    `CYRENE_TEST_HARNESS=1` 时，静默窗口模式会在归一化**之前**被记忆，归一化抹掉环境变量也救不回来。
 *    现在统一在归一化之后取 `defaultDialogService()`（进程级单例，全仓仍只有一个实例）。
 *
 * `closeAll` 由 infrastructure 在 diagnostics 装配后注入（此前为 no-op——那时确实没有诊断要关）；
 * 无论 closeAll 是否挂起，`fatal` 都保证 `exit(1)`（复用 `createFatalShutdown` 的超时赛跑）。
 *
 * `fatal` / `fatalRuntime` 的区别只在提示框标题：启动期用「无法启动」，运行期未捕获异常用
 * 「发生错误」——标题差异是有意的，不是漏改（运行期崩溃说「无法启动」会误导用户）。
 */
export interface RuntimeShell {
  /** 归一化之后调用一次：建立本进程唯一的对话框入口（重复调用为 no-op） */
  ensureDialogs(): DialogPort
  /** diagnostics 装配后注入（幂等；未装配时 closeAll 为 no-op） */
  setCloseAll(closeAll: () => Promise<void>): void
  /** 启动期 fatal（标题「无法启动」）：弹框 + closeAll + exit(1) */
  fatal(message: string): void
  /** 运行期未捕获异常 fatal（标题「发生错误」）：同上，仅标题不同 */
  fatalRuntime(message: string): void
}

export type PreReadyResult = { abort: true } | { abort: false; runtime: ElectronRuntime; shell: RuntimeShell }

export function createRuntimeShell(): RuntimeShell {
  let closeAll: (() => Promise<void>) | undefined
  // 用 `defaultDialogService()`（进程级单例）而不是自建一个实例：整改前全仓只有一个对话框入口，
  // `windows/main-window.ts` 等处的其它调用点也走这个单例。若此处自建，就会出现**两个** DialogPort，
  // 而"先建的那个记住了归一化前的环境"这一缺陷会从 index.ts 转移到别处。首次调用仍在本函数内、
  // 即仍在 harness 归一化之后（见 prepareElectronRuntime）。
  const ensureDialogs = (): DialogPort => defaultDialogService()
  const report = (title: string, message: string): void => {
    // 安全门/身份失败路径也必须有原生提示（silent 测试模式下 showErrorBox 改走 stderr）。
    // 复用 `createFatalShutdown`：closeAll 挂起时它无条件 exit(1)——不在本模块重造这段超时赛跑。
    createFatalShutdown({
      showError: (m) => ensureDialogs().showErrorBox(title, m),
      closeAll: () => closeAll?.() ?? Promise.resolve(), // 读在调用时（diagnostics 就位后才有值）
      exit: (c) => app.exit(c)
    })(message)
  }
  return {
    ensureDialogs,
    setCloseAll: (fn) => { closeAll = fn },
    fatal: (message) => report('Cyrene 无法启动', message),
    fatalRuntime: (message) => report('Cyrene 发生错误', message)
  }
}

/**
 * 打包态 harness 标记的归一化（2026-09-16 审计 P2「CYRENE_TEST_HARNESS 在打包态同权放行」）。
 *
 * 修复前：`CYRENE_TEST_HARNESS=1` 在**打包产物**里与未打包态同权，而它一句话就能做到四件事——
 * ① 放行 CDP 随机调试端口（`--remote-debugging-port=0`；`--inspect` 那半已被 fuse 关掉，CDP 这半没有）；
 * ② 默认静默窗口（正式应用隐身）；③ 原生对话框静默自动取消；④ 诊断导出不经保存框直写固定文件。
 * 这些语义只该属于**自动化运行**，而"进程是打包产物 + 环境里有这个变量"证明不了这一点：用户 shell、
 * 启动器、上一次冒烟都会留下它。对照 `app/test-app-data.ts` 的同类门（那里要求未打包）即可看出不一致。
 *
 * 处置：打包态必须另有显式二开 `CYRENE_PACKAGED_HARNESS=1`（唯一该设它的是
 * `scripts/verify-artifact.cjs`——它必须用 Playwright 驱动打包产物）。未获承认时**就地抹掉标记**
 * （规则与纯函数在 `config/runtime-environment.ts`），于是全部五个读取点（调试门、测试探针装配、
 * `runtimeEnvironment()` 的窗口模式、`dialog-service`、`diagnostics-service`）一次性回到正式语义。
 *
 * **必须早于 `rejectForbiddenDebugSwitches()`**（后者读同一个变量）。
 * 未打包（dev / `--mode test` / 集成套件 / Stage H runner）语义完全不变：那时它本来就是真的。
 */
function normalizeHarnessForPackagedRun(): void {
  if (normalizeHarnessEnv(process.env, app.isPackaged)) {
    // 留痕：现场要能看出"这次为什么没进静默/harness 语义"，而不是靠推断（与 window:runtime-mode 同址风格）
    console.error('[startup] 打包态未获二开（CYRENE_PACKAGED_HARNESS=1）⇒ 忽略残留的 CYRENE_TEST_HARNESS')
  }
}

/**
 * Chromium 的 CDP 端口在 whenReady 前已绑定，门必须同步生效。
 * 命中即 `fatal` + 返回 true，调用方停止后续执行（不落到 scheme/身份副作用）。
 */
function rejectForbiddenDebugSwitches(fatal: (message: string) => void): boolean {
  const getSwitch = (n: string): { present: boolean; value: string } => ({
    present: app.commandLine.hasSwitch(n),
    value: app.commandLine.getSwitchValue(n)
  })
  // 仅测试 harness（verify:artifact 冒烟显式设 CYRENE_TEST_HARNESS=1）放行 =0 随机端口；
  // 开发态与打包态统一执行门禁，避免 dev 启动参数绕过"任何构建恒关"基线。
  const allowRandomPort = process.env['CYRENE_TEST_HARNESS'] === '1'
  const violation = findForbiddenDebugLaunch(process.argv, getSwitch, process.env['NODE_OPTIONS'], allowRandomPort)
  if (violation === 'switch') {
    fatal('远程调试/调试开关被禁用')
    return true
  }
  // NODE_OPTIONS 纯 env 通道（argv/commandLine 均不含它）：Electron main 是 Node，单 env 即开 inspector。
  if (violation === 'node_options') {
    fatal('NODE_OPTIONS 含调试开关被禁用')
    return true
  }
  return false
}

/**
 * userData 身份链：test appData 覆写 → appData 风味 → cyrene:// scheme → 应用身份 → 单实例锁。
 *
 * 顺序不可重排（原 `main()` 内注释逐条保留）：
 * - 集成测试 appData 隔离必须早于身份安装与任何 userData 落盘。Windows Electron 43 不保证
 *   APPDATA env 能改写 `app.getPath('appData')`，故使用显式 test-only setPath 门。
 * - `pnpm dev`（未打包 development）落到 `<appData>/Cyrene-Dev`，与打包产物的 `<appData>/Cyrene`
 *   彻底分仓；**必须在 `installAppIdentity()`（进而 `requestSingleInstanceLock()`）之前**设定：
 *   单实例锁派生自 userData 路径，顺序颠倒会让 dev 与正式版互相顶掉。
 * - `registerCyreneScheme()` 必须在 app ready 前（scheme 需先注册为 privileged，且只能注册一次）。
 *
 * 返回 null 表示启动必须终止（身份安装抛错，已交 fatal）。
 */
function installUserDataIdentity(
  fatal: (message: string) => void
): { appMode: string; testAppData: string | undefined; baseCreated: boolean; setPathOk: boolean } | null {
  try {
    const appMode = typeof __APP_MODE__ === 'string' ? __APP_MODE__ : 'production'
    const testAppData = applyTestAppDataOverride(appMode)
    setAppDataFlavor(resolveAppDataFlavor(appMode, app.isPackaged))
    registerCyreneScheme() // app ready 前
    const { baseCreated, setPathOk } = installAppIdentity()
    return { appMode, testAppData, baseCreated, setPathOk }
  } catch (e) {
    fatal(e instanceof Error ? e.message : '未知错误')
    return null
  }
}

export async function prepareElectronRuntime(shell: RuntimeShell): Promise<PreReadyResult> {
  normalizeHarnessForPackagedRun() // 必须最先：下面的调试门与后续所有 harness 读取点都看归一化后的值
  // harness 归一化之后立刻建立对话框入口：早于本行没有任何读取点，晚于本行则窗口模式单例已被污染
  shell.ensureDialogs()
  if (rejectForbiddenDebugSwitches((message) => shell.fatal(message))) return { abort: true }

  // 阶段 7 批次 C（Task 5 性能测量）：精确内存信息——Chromium 默认 performance.memory 为近似值，
  // enable-precise-memory-info 让 usedJSHeapSize 接近真实（性能测量断言用）。必须在 app ready 前设置。
  app.commandLine.appendSwitch('enable-precise-memory-info')

  // 2026-09-16 审计 P2 / 立项：**Linux 无 GPU 时的硬件加速回退**——必须在 app ready 前生效。
  // 无 DRI 的 Mesa 软件光栅器会在 GPU 进程里确定性段错误，Chromium 重试耗尽后直接杀掉整个应用；
  // 而 `--disable-gpu` 此前只在测试脚手架与 `verify-artifact` 里，产品侧零命中。
  // 判定点单列在 config/gpu-mode.ts（**不并进 runtime-environment.ts**：那会把 node:fs 拖进
  // window-presentation 的依赖图，2026-09-16 实测会让 renderer-crash 集成用例稳定失败）。
  const gpuDecision = resolveGpuDecision({ env: process.env })
  if (gpuDecision.disableHardwareAcceleration) app.commandLine.appendSwitch('disable-gpu')

  const identity = installUserDataIdentity((message) => shell.fatal(message))
  if (identity === null) return { abort: true }

  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return { abort: true }
  }
  app.on('second-instance', () => focusOrDefer())

  await app.whenReady()

  return {
    abort: false,
    shell,
    runtime: {
      appMode: identity.appMode,
      testAppData: identity.testAppData,
      baseCreated: identity.baseCreated,
      setPathOk: identity.setPathOk,
      gpuDecision
    }
  }
}
