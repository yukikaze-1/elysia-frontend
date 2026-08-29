// tests/integration/trust-boundary.spec.ts
import { describe, expect, it } from 'vitest'
import { PushChannels } from '@shared/contracts'
import { serveRenderer, chromium, launchApp, closeApp } from './helpers/app'

describe('普通浏览器信任边界', () => {
  it('普通 chromium 加载产物 Renderer → desktopApi undefined', async () => {
    const server = await serveRenderer()
    // AppArmor userns 沙箱受限环境(CI)需禁用 chromium 沙箱；开发机同样兼容
    const browser = await chromium.launch({ args: ['--no-sandbox'] })
    const page = await browser.newPage()
    try {
      await page.goto(server.url)
      expect(await page.evaluate(() => typeof (window as unknown as { desktopApi?: unknown }).desktopApi)).toBe('undefined')
    } finally {
      await browser.close()
      await server.close()
    }
  })
})

// I6:chat:error 纯 push 消费——renderer 经 onChatError 收到 Main 推送并写入 connectionStore。
// 偏离记录:launchApp 恒 mock,MockBackend 无 onError 选项,无法经真实后端触发 onError 路径;
// onProtocolWarning/onError 回调接线在 Task 5 单元层覆盖。此处经 Main 侧直接 send(PushChannels.error)
// 注入一条结构化错误,验证 preload 订阅通道可用 + 跨边界 payload 保真 + 应用自身接线
// (onChatError → connectionStore.setError → CyConnectionPanel 渲染 .cy-conn-error)。
describe('chat:error 纯 push 消费(I6)', () => {
  it('Main 注入 chat:error → renderer onChatError 收到并写入 connectionStore', async () => {
    const launched = await launchApp()
    try {
      const { app, page } = launched
      // 订阅通道可用 + 注册测试捕获 handler(与应用自身接线并存,同一 channel 多 listener 互不干扰)
      const subOk = await page.evaluate(() => {
        const w = window as unknown as { __chatError?: unknown }
        w.__chatError = undefined
        window.desktopApi.onChatError((err) => { w.__chatError = err })
        return typeof window.desktopApi.onChatError === 'function'
      })
      expect(subOk).toBe(true)

      const payload = { code: 'IT_INJECTED_ERROR', message: '集成测试注入的聊天错误', retryable: true, requestId: 'it-chat-error-1' }
      // Main 侧直接 send(PushChannels.error) 注入(替代真实后端触发;payload 经 preload isPublicErrorShape 校验后送达)
      await app.evaluate(({ BrowserWindow }, arg) => {
        const wc = BrowserWindow.getAllWindows()
          .find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('cyrene://'))
          ?.webContents
        if (!wc) throw new Error('找不到主窗口 webContents')
        wc.send(arg.channel, arg.payload)
      }, { channel: PushChannels.error, payload })

      // 跨边界保真:捕获 handler 收到与注入完全一致的 payload
      await expect.poll(async () => page.evaluate(() => (window as unknown as { __chatError?: unknown }).__chatError), { timeout: 5000 }).toEqual(payload)
      // 写入 connectionStore:应用自身 onChatError 接线 → setError → CyConnectionPanel 渲染错误文案
      // UII-QQ：错误文案在连接入口 popover 内——先点徽标展开再断言（入口变更，能力不删）。
      // UII-QQ 设置页批次：错误框含可执行提示行 → 断言放宽为 toContain（消息本体必须完整渲染，强度不降）
      await page.getByRole('button', { name: /REAL|MOCK/ }).click()
      await expect.poll(async () => page.evaluate(() => document.querySelector('.cy-conn-error')?.textContent?.trim() ?? null), { timeout: 5000 }).toContain(payload.message)
    } finally {
      await closeApp(launched)
    }
  })
})
