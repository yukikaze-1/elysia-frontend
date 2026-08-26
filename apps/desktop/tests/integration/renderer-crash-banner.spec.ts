// tests/integration/renderer-crash-banner.spec.ts
// Task 6（阶段 7 批次 B）：真实 Electron 集成——Renderer 崩溃 → reload 后 CyRendererCrashBanner 呈现。
// 同 renderer-crash.spec 3a 启动：launchApp 恒 mock + webContents.forcefullyCrashRenderer() 触发。
//
// ⚠️ 偏离 brief 的断言形态（p 0 runtime 发现，见 renderer-crash.spec 头注）：Playwright Page.evaluate 在
//   forcefullyCrashRenderer 后永久死亡（"Target crashed"），reload 在**同一 BrowserWindow**进行、无新 `window` 事件。
//   唯一可行的观测 = **CDP session**（page.context().newCDPSession(page)），对 reloaded renderer 执行上下文直接发
//   Runtime.evaluate。banner 是 reload 后新 renderer 在 onMounted 读 getLastCrash 显示——实测该路径全功能：
//   CDP 能读到 .cy-crash-banner 文本「页面已重启，进行中的回复可能中断」。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import type { ElectronApplication, Page, CDPSession } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

let app: ElectronApplication
let page: Page
let userData: string

beforeAll(async () => {
  ({ app, page, userData } = await launchApp())
})
afterAll(async () => {
  await closeApp({ app, page, userData })
})

/** 崩溃 reload 后，用 CDP session 在 reloaded renderer 上下文执行表达式（Page.evaluate 已死的替代观测通道） */
async function cdpEval(expr: string): Promise<unknown> {
  const cdp: CDPSession = await page.context().newCDPSession(page)
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  await cdp.detach()
  return r.result ? r.result.value : undefined
}

describe('Renderer 崩溃 → reload 后 banner 呈现', () => {
  it('崩溃 reload 后 crash banner 可见且含「页面已重启」', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()
    })
    // Poll：等 CDP 能对 reloaded renderer 读到 .cy-crash-banner（reload 完成 + App.vue 挂载 + banner 读 marker 呈现）
    await expect
      .poll(
        async () => {
          try {
            const count = await cdpEval('document.querySelectorAll(".cy-crash-banner").length')
            return typeof count === 'number' && count > 0
          } catch {
            return false // CDP 在 reload 完成前抛 Protocol error (Target crashed)
          }
        },
        { timeout: 15000, interval: 500 }
      )
      .toBe(true)
    const text = await cdpEval('document.querySelector(".cy-crash-banner")?.textContent')
    expect(text).toContain('页面已重启')
  })
})
