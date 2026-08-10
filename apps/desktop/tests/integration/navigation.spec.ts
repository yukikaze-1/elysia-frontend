// tests/integration/navigation.spec.ts
import { describe, expect, it } from 'vitest'
import { launchApp, closeApp } from './helpers/app'

// main 进程内观测数组的类型别名（app.evaluate 回调被序列化，须内联、不可闭包捕获模块作用域）
type ExtSink = { __ext: string[] }

describe('外部链接受控打开', () => {
  it('window.open 外部链接 → shell.openExternal + 不新建窗', async () => {
    const { app, page, userData } = await launchApp()
    try {
      await app.evaluate(({ shell }) => {
        const g = globalThis as unknown as ExtSink
        g.__ext = []
        // monkeypatch：拦截 openExternal，记录 URL（必返 Promise——will-navigate 分支对 openExternal 调 .catch）
        shell.openExternal = (u: string): Promise<void> => { g.__ext.push(u); return Promise.resolve() }
      })
      const winCount0 = app.windows().length
      // 用带路径的外部 URL：Electron 会把裸域名 normalized 成带尾斜杠（details.url='https://example.com/'），
      // 与 toContain 的严格相等不匹配；带路径 URL 不受 normalization 影响，断言稳定
      await page.evaluate(() => { window.open('https://example.com/open') })
      await expect.poll(async () => app.evaluate(() => (globalThis as unknown as ExtSink).__ext)).toContain('https://example.com/open')
      expect(app.windows().length).toBe(winCount0)
    } finally { await closeApp({ app, page, userData }) }
  })
  it('location 导航外部 → 不导航 + shell.openExternal', async () => {
    const { app, page, userData } = await launchApp()
    try {
      await app.evaluate(({ shell }) => {
        const g = globalThis as unknown as ExtSink
        g.__ext = []
        // monkeypatch：拦截 openExternal，记录 URL（必返 Promise——will-navigate 分支对 openExternal 调 .catch）
        shell.openExternal = (u: string): Promise<void> => { g.__ext.push(u); return Promise.resolve() }
      })
      await page.evaluate(() => { location.href = 'https://example.com/page' })
      await expect.poll(async () => app.evaluate(() => (globalThis as unknown as ExtSink).__ext)).toContain('https://example.com/page')
      expect(page.url()).toMatch(/^cyrene:\/\//) // deny：仍在本应用
    } finally { await closeApp({ app, page, userData }) }
  })
})
