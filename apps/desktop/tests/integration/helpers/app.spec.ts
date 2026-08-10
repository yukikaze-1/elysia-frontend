import { describe, expect, it } from 'vitest'
import { closeApp, launchApp } from './app'

describe('launchApp 助手', () => {
  it('能以 --mode test 产物启动并返回主窗（临时 userData 隔离）', async () => {
    const launched = await launchApp()
    try {
      const info = await launched.page.evaluate(() => window.desktopApi.getAppInfo())
      expect(info.name).toBe('Cyrene')
      expect(launched.page.url()).toMatch(/^cyrene:\/\//)
    } finally { await closeApp(launched) }
  })
})
