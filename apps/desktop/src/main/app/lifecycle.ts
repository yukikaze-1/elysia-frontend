// apps/desktop/src/main/app/lifecycle.ts
import { app } from 'electron'
import { lstatSync, mkdirSync } from 'fs'
import { join } from 'path'

export interface AppIdentity {
  baseCreated: boolean
  /** setPath('userData', base) 是否成功——失败（base 破损为文件/symlink）时 main() 据此弹框 */
  setPathOk: boolean
}

export function expectedUserDataBase(): string {
  return join(app.getPath('appData'), 'Cyrene')
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
