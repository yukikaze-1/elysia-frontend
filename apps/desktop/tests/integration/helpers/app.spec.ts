// tests/integration/helpers/app.spec.ts
// launchApp 助手自检：临时 appData/userData/sessionData 隔离门确实生效（docs/19）。
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { closeApp, launchApp } from './app'

/** 与 helpers/app.ts 的 comparablePath 同口径（Windows 大小写不敏感） */
function comparable(path: string): string {
  const real = realpathSync(path)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

describe('launchApp 助手', () => {
  it('能以 --mode test 产物启动并返回主窗（临时 userData 隔离）', async () => {
    const launched = await launchApp()
    try {
      const info = await launched.page.evaluate(() => window.desktopApi.getAppInfo())
      expect(info.name).toBe('Cyrene')
      expect(launched.page.url()).toMatch(/^cyrene:\/\//)
    } finally { await closeApp(launched) }
  })

  // docs/19 §6：会话态（HTTP 缓存/Cookies/Service Worker）落在 sessionData 下。若它不随 userData 隔离，
  // 多项目并行开发就会共用同一份会话缓存——单看 userData 断言是发现不了的，故单独钉一条。
  it('sessionData 也在隔离根内（不漂到真实用户目录）', async () => {
    const launched = await launchApp()
    try {
      const paths = await launched.app.evaluate(({ app }) => ({
        appData: app.getPath('appData'),
        userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData')
      }))
      const root = comparable(launched.userData)
      expect(comparable(paths.appData)).toBe(root)
      expect(comparable(paths.userData)).toBe(comparable(join(launched.userData, 'Cyrene')))
      // sessionData 必须在临时隔离根之内（Electron 默认在 userData 下；Linux 等平台可能同级）
      expect(comparable(paths.sessionData).startsWith(root)).toBe(true)
      // 精确判据：不得落在临时隔离根之外（本用例是隔离门的最后一道报警）
      expect(comparable(paths.sessionData).startsWith(comparable(paths.appData))).toBe(true)
    } finally { await closeApp(launched) }
  })
})
