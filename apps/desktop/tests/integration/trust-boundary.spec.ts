// tests/integration/trust-boundary.spec.ts
import { describe, expect, it } from 'vitest'
import { serveRenderer, chromium } from './helpers/app'

describe('普通浏览器信任边界', () => {
  it('普通 chromium 加载产物 Renderer → desktopApi undefined', async () => {
    const server = await serveRenderer()
    // AppArmor userns 沙箱受限环境(CI)需禁用 chromium 沙箱；开发机同样兼容
    const browser = await chromium.launch({ args: ['--no-sandbox'] })
    const page = await browser.newPage()
    try {
      await page.goto(server.url)
      expect(await page.evaluate(() => typeof (window as any).desktopApi)).toBe('undefined')
    } finally {
      await browser.close()
      await server.close()
    }
  })
})
