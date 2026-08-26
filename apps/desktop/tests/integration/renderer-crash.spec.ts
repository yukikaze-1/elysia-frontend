// tests/integration/renderer-crash.spec.ts
// Task 6（阶段 7 批次 B）：真实 Electron 集成——Renderer 崩溃 → crashMarker 写入 + reload + 审计 renderer:crash。
// 触发：webContents.forcefullyCrashRenderer()。
//
// ⚠️ 偏离 brief 的断言形态（已在 report 详述，P0 runtime 发现）：brief 断言「崩溃 reload 后新页面读 getLastCrash
//   第一次返回 marker / 第二次 null」。实测**不可行**——`webContents.forcefullyCrashRenderer()` 后 Playwright 的 Page
//   绑定的 CDP target 永久死亡（page.evaluate → "Target crashed"），reload 在**同一 BrowserWindow**（webContents.reload()）
//   上进行，Playwright 不触发 `window` 事件（无新 target 可供 _onPage 挂载），故 firstWindow()/windows() 均返回那个
//   已崩的 Page，永远无法 re-attach。这是 Playwright/Electron 的结构性限制。
//
// 可行的观测窗口 = **CDP session**（page.context().newCDPSession(page)）——它绕过 Playwright 的 JS-evaluate 包装，
//   直接对 reload 后的 renderer 执行上下文发 Runtime.evaluate，实测对 reloaded renderer 全功能（能读 DOM、能 invoke getLastCrash）。
//   实测：崩溃 reload 后 reloaded renderer 的 App.vue 于挂载读 getLastCrash **消费掉 marker**（一次性单用）——
//   故 getLastCrash() 观测值为 null（banner 已先读），marker 的「写入+一次性」语义由 audit 落盘 renderer:crash + banner 文本佐证。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import type { ElectronApplication, Page, CDPSession } from 'playwright'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
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

describe('Renderer 崩溃 → crashMarker + reload + renderer:crash 审计', () => {
  it('崩溃 reload 后 renderer:crash 审计落盘 + banner 已呈现（marker 一次性被消费）', async () => {
    // 触发渲染进程崩溃（Main 的 render-process-gone handler 写 marker + reload）
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()
    })
    // Poll：等 CDP 能对 reloaded renderer 读到 banner（标志 reload 完成 + App.vue 挂载 + getLastCrash 已读消费）
    await expect
      .poll(
        async () => {
          try {
            const banner = await cdpEval('document.querySelector(".cy-crash-banner")?.textContent')
            return typeof banner === 'string'
          } catch {
            return false // CDP 在 reload 完成前抛 Protocol error (Target crashed)
          }
        },
        { timeout: 15000, interval: 500 }
      )
      .toBe(true)
    // banner 已呈现——证明 reload 完成、New renderer 挂载、getLastCrash 读到 marker（并已消费）
    const bannerText = await cdpEval('document.querySelector(".cy-crash-banner")?.textContent')
    expect(bannerText).toContain('页面已重启')
    // getLastCrash 一次性：banner 挂载时已读清 → 现在是 null（单用语义）
    expect(await cdpEval('window.desktopApi.getLastCrash()')).toBeNull()
    // 审计落盘 renderer:crash（marker 写入的旁证——崩溃真实发生且被 Main 捕获）
    const auditDir = join(userData, 'Cyrene', 'audit')
    const files = existsSync(auditDir) ? readdirSync(auditDir).filter((f) => f.endsWith('.jsonl')) : []
    expect(files.length).toBeGreaterThan(0)
    const auditContent = files.map((f) => readFileSync(join(auditDir, f), 'utf-8')).join('\n')
    expect(auditContent).toContain('"type":"renderer:crash"')
  })
})
