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

export function expectedUserDataBase(): string {
  return join(app.getPath('appData'), 'Cyrene')
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
