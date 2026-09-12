// src/main/config/runtime-environment.ts
// Silent Test Window Mode（测试静默窗口模式）的**唯一**判据与解析点。
//
// 为什么单独成模块：自动化测试期间「窗口该不该出现在宿主桌面上」是**运行期环境**问题，不是
// 某个窗口、某段 IPC、某个服务的局部问题。若把判据散成 `process.env.CYRENE_TEST_MODE === '1'`
// 满仓 if，则每新增一个 show()/focus()/setAlwaysOnTop() 调用点都会重新引入一次泄漏机会。
// 因此本模块只做一件事：把环境变量**解析一次**成一个不可变对象，供
// `windows/window-presentation.ts`、`native-ui/dialog-service.ts` 等边界消费。
//
// 变量语义（刻意不依赖 NODE_ENV——Electron/Vite/Playwright 各自的 NODE_ENV 语义不稳定）：
//   CYRENE_TEST_HARNESS=1    本进程由自动化测试 harness 启动（集成套件 / Stage H runner /
//                            verify:artifact 启动冒烟）。这是**既有**标记，仓库里已有先例：
//                            appData 隔离门（app/test-app-data.ts）与调试开关放行门
//                            （index.ts rejectForbiddenDebugSwitches 的 allowRandomPort）。
//   CYRENE_WINDOW_MODE=…     显式指定窗口呈现模式，取值 `silent` | `visible`。
//
// 判定规则（fail-closed）：
//   ① 显式 silent + 有 harness 标记            → silent
//   ② 显式 visible（任意环境）                 → visible
//   ③ 未显式指定 + 有 harness 标记（默认）      → **silent**（自动化测试默认不打扰桌面）
//   ④ 未显式指定 + 无 harness（pnpm dev/生产）  → visible
//   ⑤ 显式 silent 但**无** harness 标记         → visible（降级；绝不因误设环境变量让正式应用隐身）
//
// 规则 ③ 是本轮整改的核心：默认值本身就是「静默」，而不是靠每个测试脚本记得设变量。
// 规则 ⑤ 是本模块的安全边界：silent 只能由明确的测试 harness 触发，dev / 打包产物 / 安装版
// 无论环境里有什么残留变量都不会静默启动。

import type { AppMode } from './env'

export const WINDOW_MODE_ENV = 'CYRENE_WINDOW_MODE'
export const TEST_HARNESS_ENV = 'CYRENE_TEST_HARNESS'

/** 窗口呈现模式：silent = 不显示/不抢焦点/不进任务栏；visible = 完全按调用方配置（现有行为） */
export type WindowMode = 'silent' | 'visible'

/**
 * 模式来源（诊断/证据用，不参与行为分支）：
 * - `env`                   调用方显式指定
 * - `harness-default`       未指定，因处于测试 harness 而取默认 silent
 * - `default`               dev/生产默认 visible
 * - `rejected-not-harness`  要求了 silent 但没有 harness 标记 → 已降级为 visible
 */
export type WindowModeSource = 'env' | 'harness-default' | 'default' | 'rejected-not-harness'

export interface RuntimeEnvironment {
  /** 构建模式（electron-vite `--mode`，经 `__APP_MODE__` 注入） */
  readonly mode: AppMode
  /** 本进程是否由自动化测试 harness 显式启动（CYRENE_TEST_HARNESS=1） */
  readonly isTestHarness: boolean
  readonly windowMode: WindowMode
  readonly windowModeSource: WindowModeSource
  /** 统一窗口呈现边界的判据：所有 show/focus/alwaysOnTop/taskbar 差异都只看这一项 */
  readonly isSilentWindowMode: boolean
  /** 显式可见的测试运行（人工观察 Electron 窗口时用；`pnpm test:integration:visible`） */
  readonly isVisibleTestMode: boolean
}

type EnvLike = Record<string, string | undefined>

/** 解析显式模式；无法识别的取值一律视为「未指定」（拼错不该改变行为，更不该让窗口隐身） */
export function parseWindowMode(raw: string | undefined): WindowMode | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  return value === 'silent' || value === 'visible' ? value : undefined
}

/** 测试 harness 标记的唯一读取点（与 app/test-app-data.ts 同源语义：值必须为字符串 '1'） */
export function isTestHarnessEnv(env: EnvLike): boolean {
  return env[TEST_HARNESS_ENV] === '1'
}

export function resolveRuntimeEnvironment(input: {
  env: EnvLike
  /** 构建模式；缺省时按 production 处理（`__APP_MODE__` 未注入的场景：单测、脚本） */
  mode?: string
}): RuntimeEnvironment {
  const isTestHarness = isTestHarnessEnv(input.env)
  const requested = parseWindowMode(input.env[WINDOW_MODE_ENV])

  let windowMode: WindowMode
  let windowModeSource: WindowModeSource
  if (requested === 'silent' && !isTestHarness) {
    windowMode = 'visible'
    windowModeSource = 'rejected-not-harness'
  } else if (requested !== undefined) {
    windowMode = requested
    windowModeSource = 'env'
  } else if (isTestHarness) {
    windowMode = 'silent'
    windowModeSource = 'harness-default'
  } else {
    windowMode = 'visible'
    windowModeSource = 'default'
  }

  return {
    mode: normalizeBuildMode(input.mode),
    isTestHarness,
    windowMode,
    windowModeSource,
    isSilentWindowMode: windowMode === 'silent',
    isVisibleTestMode: isTestHarness && windowMode === 'visible',
  }
}

function normalizeBuildMode(raw: string | undefined): AppMode {
  return raw === 'development' || raw === 'test' ? raw : 'production'
}

/** 构建期注入的 `__APP_MODE__`（electron.vite.config.ts 的 define；单测/脚本下不存在） */
function buildMode(): string {
  return typeof __APP_MODE__ === 'string' ? __APP_MODE__ : 'production'
}

let cached: RuntimeEnvironment | undefined

/**
 * 进程级单例：环境变量在进程生命周期内不变，解析一次即可（避免每次建窗重新读 env 造成
 * 「同一进程内模式漂移」这种最难排查的不一致）。
 */
export function runtimeEnvironment(): RuntimeEnvironment {
  cached ??= resolveRuntimeEnvironment({ env: process.env, mode: buildMode() })
  return cached
}

/** 仅测试用：清缓存，使下一处调用按当前 process.env 重新解析 */
export function resetRuntimeEnvironmentForTest(): void {
  cached = undefined
}
