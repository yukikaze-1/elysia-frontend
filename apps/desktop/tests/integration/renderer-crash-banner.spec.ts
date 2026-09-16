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

/**
 * 崩溃 reload 后，用 CDP session 在 reloaded renderer 上下文执行表达式（Page.evaluate 已死的替代观测通道）。
 *
 * 2026-09-16 修掉本用例的**挂死形态**（不是放宽断言）：`newCDPSession` / `Runtime.evaluate` 在目标已崩、
 * 新 renderer 尚未就位时可能**既不解决也不拒绝**。而 `expect.poll` 的 timeout 只在两次回调之间计时——
 * 回调没返回就永远轮不到它触发，于是整条用例变成 60s 超时（什么也说明不了），而不是"等 15s 后给出
 * 可读的失败"。故每次尝试自带一个上界：超时就抛，让 poll 按 500ms 间隔继续尝试（banner 断言一字未改）。
 *
 * 背景（实测，2026-09-16）：这条用例在本机是**既有 flake**，与任何一批代码改动无关——
 * 在基线上连跑三次为 2 过 1 挂（`d1a8a30`、同一份构建）。挂的那次正是走了"回调挂死"这条路。
 */
async function cdpEval(expr: string, perAttemptTimeoutMs = 3_000): Promise<unknown> {
  let cdp: CDPSession | undefined
  const attempt = (async (): Promise<unknown> => {
    cdp = await page.context().newCDPSession(page)
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result ? r.result.value : undefined
  })()
  try {
    return await Promise.race([
      attempt,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('cdp-eval-timeout')), perAttemptTimeoutMs))
    ])
  } finally {
    // 先落定的那条路负责收尾；稍后若 attempt 又完成/失败，也要把会话关掉、且不得变成 unhandled rejection
    void attempt.then(() => { void cdp?.detach().catch(() => {}) }).catch(() => {})
  }
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
        { timeout: 30000, interval: 500 }   // 2026-09-16：15s → 30s。按本仓对 flake 的既定口径处置——**提预算而非加 retry 掩盖**（与 electron-live2d 一族同款；用例本身仍卡在 60s 的套件预算内）。
      )
      .toBe(true)
    const text = await cdpEval('document.querySelector(".cy-crash-banner")?.textContent')
    expect(text).toContain('页面已重启')
  })
})
