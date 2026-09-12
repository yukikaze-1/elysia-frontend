// apps/desktop/src/main/app/lifecycle.ts
import { app } from 'electron'
import { lstatSync, mkdirSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { tmpdir } from 'node:os'
import { resolveTestAppDataOverride } from './test-app-data'

export interface AppIdentity {
  baseCreated: boolean
  /** setPath('userData', base) 是否成功——失败（base 破损为文件/symlink）时 main() 据此弹框 */
  setPathOk: boolean
}

/**
 * userData 目录「风味」（2026-09-12 开发环境隔离审计）。
 *
 * 此前开发态与打包产物共用 `%APPDATA%\Cyrene`，后果是**开发运行会直接改写正式版数据**：
 * 连接凭据/Token、`settings.json`、会话与草稿、Live2D 模型安装目录、日志与审计全部同仓。
 * 本机同时开发多个 Electron 项目时这更危险——任一项目的 dev 进程都可能写到用户真实在用的那份数据上。
 *
 * 因此开发态固定加 `-Dev` 后缀，形成：
 *   - 未打包 development（`pnpm dev`）：`<appData>/Cyrene-Dev`
 *   - 打包 production：`<appData>/Cyrene`（不变，用户正式数据路径零改动）
 *   - `--mode test`：`<appData>/Cyrene`（不加后缀）——集成 harness 已由 `CYRENE_TEST_APP_DATA`
 *     显式覆写 appData 到 mkdtemp 临时目录（test + harness + 未打包三重门，见 test-app-data.ts），
 *     其隔离强度高于后缀，且 tests/integration/helpers/app.ts 逐用例断言 `<tmp>/Cyrene`；
 *     再加一层后缀只会让两处口径分叉而无收益。
 */
export type AppDataFlavor = 'default' | 'dev'

/** 非打包 development 恒 dev 风味；test/production 一律 default（判据收敛在此，调用方不得自行推导） */
export function resolveAppDataFlavor(mode: string, isPackaged: boolean): AppDataFlavor {
  return !isPackaged && mode === 'development' ? 'dev' : 'default'
}

let appDataFlavor: AppDataFlavor = 'default'

/**
 * 设定本次进程的 userData 风味。**必须在 expectedUserDataBase() / installAppIdentity() 之前调用**
 * （main() 在 applyTestAppDataOverride 旁统一调用）。默认 'default' 使未显式设定的环境
 * （单测、脚本）落到生产同名路径，不会意外读到 `-Dev` 目录。
 */
export function setAppDataFlavor(flavor: AppDataFlavor): void {
  appDataFlavor = flavor
}

/** 仅测试用：把模块级风味复位，避免同一 vitest worker 内跨用例串味 */
export function resetAppDataFlavorForTest(): void {
  appDataFlavor = 'default'
}

export function expectedUserDataBase(): string {
  const base = join(app.getPath('appData'), 'Cyrene')
  return appDataFlavor === 'dev' ? `${base}-Dev` : base
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * test harness 在 installAppIdentity() 之前显式改写 Electron appData。
 *
 * 这是 Windows 集成测试隔离的权威入口：环境变量 APPDATA/XDG_CONFIG_HOME/HOME 只适合
 * Node CLI，不能作为 Electron app.getPath('appData') 的安全边界。覆写目录必须已由测试
 * 助手创建、为系统临时目录下的真实子目录且位于默认 appData 之外；setPath 后立即读回，任何偏差均
 * fail-closed，绝不继续启动并落到真实 `%APPDATA%/Cyrene`。
 */
export function applyTestAppDataOverride(mode: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const requested = resolveTestAppDataOverride({ env, packaged: app.isPackaged, mode })
  if (requested === undefined) return undefined

  let st: ReturnType<typeof lstatSync>
  try { st = lstatSync(requested) }
  catch { throw new Error('测试 appData 覆盖目录不存在或不可访问') }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error('测试 appData 覆盖必须是非符号链接目录')
  }

  const defaultAppData = app.getPath('appData')
  const testAppData = realpathSync(requested)
  const tempRoot = realpathSync(tmpdir())
  if (samePath(testAppData, tempRoot) || !isInsideOrEqual(tempRoot, testAppData)) {
    throw new Error('测试 appData 覆盖必须位于系统临时目录的独立子目录内')
  }
  if (isInsideOrEqual(defaultAppData, testAppData)) {
    throw new Error('测试 appData 覆盖不得位于系统默认 appData 内')
  }

  app.setPath('appData', testAppData)
  const applied = realpathSync(app.getPath('appData'))
  if (!samePath(applied, testAppData)) {
    throw new Error('测试 appData 覆盖读回不一致')
  }
  return testAppData
}

/**
 * 应用身份安装：目录准备 + `app.setName` + `app.setPath('userData')`。
 *
 * **调用顺序是安全不变式**：必须在 `app.requestSingleInstanceLock()` 之前完成（main() 即如此）。
 * Electron 的单实例锁派生自 `userData` 路径，先锁后 setPath 会让两套身份（如 dev 与打包产物、
 * 或本机另一套 Electron 项目）互相认成同一实例而直接 exit(0)。本项目 `setName` 后的名字是
 * 全局共享的 "Cyrene"（诊断导出与窗口标题口径依赖它），身份唯一性因此由 userData 路径承担。
 */
export function installAppIdentity(): AppIdentity {
  let baseCreated = false
  let setPathOk = true
  const base = expectedUserDataBase()
  // appData 父目录创建失败 = 致命（Electron Chromium init 也会挂）——上抛，main() failStart 统一处理
  try {
    mkdirSync(join(app.getPath('appData')), { recursive: true, mode: 0o700 })
  } catch {
    throw new Error(`无法创建应用数据父目录 ${app.getPath('appData')}`)
  }
  try {
    mkdirSync(base, { mode: 0o700 })
    baseCreated = true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`无法创建应用数据目录 ${base}`)
    }
    // EEXIST：区分"既有目录"与"破损（文件/symlink）"——文件/symlink 应使 setPathOk=false（main() 据此弹框）
    try {
      const st = lstatSync(base)
      if (!st.isDirectory()) setPathOk = false
    } catch {
      setPathOk = false // lstat 失败（破损）同样视为异常
    }
  }
  app.setName('Cyrene')
  try {
    app.setPath('userData', base)
  } catch {
    // setPath 失败（base 破损为文件/symlink）：标记，main() 据 setPathOk 弹框
    setPathOk = false
  }
  return { baseCreated, setPathOk }
}
