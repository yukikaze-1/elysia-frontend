// tests/integration/silent-window-mode.spec.ts
// Silent Test Window Mode（测试静默窗口模式，2026-09-12）的**窗口行为**集成用例。
//
// 为什么需要它：本仓此前没有任何用例观察过「窗口到底有没有出现在桌面上」——27 个集成 spec
// 一次运行约 55 次 `launchApp`，每次都走 main-window.ts 的 `ready-to-show → show()`（外加 5s 兜底
// 定时器），于是在开发者的 Windows 机器上表现为：测试期间窗口反复弹出、抢走前台焦点、在任务栏闪烁，
// 全屏游戏被反复切出。而所有断言都只关心页面内容，谁也没发现。
//
// 本用例把**呈现行为**本身钉成断言（窗口可见性 / 焦点 / 置顶 / 额外窗口数量 / 隐藏窗口下的
// renderer 语义），并区分两种运行：
//   - 默认（silent）：窗口不得显示、不得抢焦点、不得置顶、不得产生第二个窗口，但 renderer/preload/IPC/
//     键盘输入/rAF 必须逐字可用（这是「静默」不等于「冻结」的证据）；
//   - `pnpm test:integration:visible`：窗口真的显示——人工调试模式，用来看窗口/焦点/任务栏行为。
//     该分支在 silent 运行下 skip（否则会真的在桌面上弹窗，与静默运行的目的相悖）。
import { describe, expect, it } from 'vitest'
import { closeApp, launchApp, suiteWindowMode } from './helpers/app'
import type { ElectronApplication, Page } from 'playwright'

const POLL = { timeout: 5000, interval: 200 }
const VISIBLE_RUN = suiteWindowMode() === 'visible'

interface WindowFacts {
  count: number
  isVisible: boolean
  isFocused: boolean
  isAlwaysOnTop: boolean
  isMinimized: boolean
  devToolsOpened: boolean
  opacity: number
}

/** 从 **Main 进程**读窗口事实（不经 renderer——renderer 看不到 OS 级呈现状态） */
function windowFacts(app: ElectronApplication): Promise<WindowFacts> {
  return app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows()
    const win = all[0]
    return {
      count: all.length,
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
      isAlwaysOnTop: win.isAlwaysOnTop(),
      isMinimized: win.isMinimized(),
      devToolsOpened: win.webContents.isDevToolsOpened(),
      opacity: win.getOpacity(),
    }
  })
}

interface WindowPresentationFacts {
  silent: boolean
  windowMode: string
  windowModeSource: string
  options: { show: boolean; alwaysOnTop: boolean; skipTaskbar: boolean }
  frameKeepAlive: 'pending' | 'unmapped' | 'mapped' | 'none'
}

/** Main 侧探针（仅 harness 装配）：统一建窗层留痕——skipTaskbar 在 Electron 无 getter，只能这样验证 */
function windowPresentation(app: ElectronApplication): Promise<WindowPresentationFacts | null> {
  return app.evaluate(() => {
    const probe = (globalThis as unknown as { __cyreneMainProbe?: { getWindowPresentation(): unknown } }).__cyreneMainProbe
    return (probe?.getWindowPresentation() ?? null) as WindowPresentationFacts | null
  })
}

/** 点连接 → 激活首个会话 → 输入框就绪（对齐 electron-tools.spec.ts 的 connectAndActivateFirst 先例） */
async function connectAndActivateFirst(page: Page): Promise<void> {
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true), POLL).toBe(false)
}

describe('Silent Test Window Mode：测试运行期间的窗口行为', () => {
  it('默认静默：主窗口不显示、不抢焦点、不置顶、不进任务栏，且不产生额外窗口', async () => {
    const launched = await launchApp(undefined, { windowMode: 'silent' })
    try {
      // 出帧保活是异步落定的（订阅挂在 dom-ready 上，无帧时重试，重试耗尽才回退）；
      // 先等它落定，再读窗口事实——否则会读到"过渡态"得出错误结论。
      await expect.poll(
        async () => (await windowPresentation(launched.app))?.frameKeepAlive,
        { timeout: 10_000, interval: 200 },
      ).not.toBe('pending')

      // ready-to-show 与 5s 兜底定时器都在窗口生命周期早期触发；等一小段再读，覆盖"延迟弹出"回归
      await launched.page.waitForTimeout(1200)
      const facts = await windowFacts(launched.app)
      expect(facts.count, '只应有主窗口一个窗口（无 Splash/DevTools/辅助窗口）').toBe(1)
      expect(facts.isFocused, '静默模式下窗口不得持有焦点').toBe(false)
      expect(facts.isAlwaysOnTop, '静默模式下窗口不得置顶').toBe(false)
      expect(facts.devToolsOpened).toBe(false)

      // 统一建窗层的实际生效选项（skipTaskbar 无 getter，只能经留痕验证）
      const presentation = await windowPresentation(launched.app)
      expect(presentation?.silent).toBe(true)
      expect(presentation?.windowMode).toBe('silent')
      expect(presentation?.options).toEqual({ show: false, alwaysOnTop: false, skipTaskbar: true })
      // 出帧保活必须已落到某条路径上（none = 两条都失败，renderer 会被压到 ~1 帧/秒）
      expect(presentation?.frameKeepAlive, '隐藏窗口必须落到一条出帧保活路径').not.toBe('none')

      if (presentation?.frameKeepAlive === 'unmapped') {
        // 首选形态：窗口从未映射——桌面无窗口、无任务栏、无闪烁、也不打扰全屏游戏
        expect(facts.isVisible, 'unmapped 保活形态下窗口绝不映射').toBe(false)
      } else {
        // 回退形态（平台不提供 beginFrameSubscription，或重试耗尽）：窗口被映射但不可见/不激活
        expect(facts.isVisible).toBe(true)
        if (process.platform !== 'linux') expect(facts.opacity, '回退形态必须先置不透明度 0').toBe(0)
      }
    } finally {
      await closeApp(launched)
    }
  })

  it('静默 ≠ 冻结：隐藏窗口下 renderer/preload/IPC/可见性/rAF/键盘输入逐字可用', async () => {
    const launched = await launchApp(undefined, { windowMode: 'silent' })
    const { app, page } = launched
    try {
      // ① 窗口层：**必须按出帧保活形态判定**，不能无条件断言不可见。
      //    2026-09-15 修（代码侧疑点 3）：本行原为无条件的 `expect(isVisible).toBe(false)`，
      //    与上一个用例 `:102-109` 的判据**形式矛盾**——那边写明保活有两条路径，回退形态（平台不提供
      //    beginFrameSubscription 或重试耗尽）下窗口**是被映射的**（`isVisible === true`），
      //    靠 opacity 0 + skipTaskbar 保持不打扰。静默模式只有这两种形态，故两个 spec 不可能同时全绿；
      //    「窗口会不会被映射」不是本用例要验的东西，本用例验的是**隐藏/不映射之后 renderer 是否仍然活着**。
      //    现在与 :102-109 用**同一判据**（同一份 presentation 留痕），两种形态下各自成立。
      //
      //    顺序承重：保活是**异步**落定的（订阅挂在 dom-ready，无帧时重试，重试耗尽才回退）⇒ 必须
      //    **先等它定下来、再读 presentation**。反过来读会拿到 `'pending'`，被 `!== 'unmapped'` 判成
      //    回退形态而误报（本轮实测踩到：拿到 pending → 断言 isVisible=true 失败）。
      await expect.poll(
        async () => (await windowPresentation(app))?.frameKeepAlive,
        { timeout: 10_000, interval: 200 },
      ).not.toBe('pending')
      const presentation = await windowPresentation(app)
      const facts0 = await windowFacts(app)
      if (presentation?.frameKeepAlive === 'unmapped') {
        expect(facts0.isVisible, 'unmapped 保活形态下窗口绝不映射').toBe(false)
      } else {
        expect(facts0.isVisible, '回退保活形态下窗口被映射（靠不透明度 0 保持不打扰）').toBe(true)
        if (process.platform !== 'linux') expect(facts0.opacity, '回退形态必须先置不透明度 0').toBe(0)
      }

      // ② 文档可见性：Chromium 对"从未显示过"的窗口不置 hidden —— 应用的渲染门（CyLive2DPanel 的
      //    documentVisible）因此保持活跃，Live2D 等渲染回路不会被静默模式停掉。
      const doc = await page.evaluate(() => ({ hidden: document.hidden, state: document.visibilityState }))
      expect(doc.hidden).toBe(false)
      expect(doc.state).toBe('visible')

      // ③ rAF 速率：这是静默模式**最容易悄悄坏掉**的一项——隐藏窗口默认被 Chromium 压到约 1 帧/秒
      //    （2026-09-12 实测：静默启动后 600ms 内 0 次 rAF 回调），Live2D 渲染环/滚动跟随/reduce-motion
      //    等全部建在 rAF 上。统一建窗层的出帧保活（window-presentation.ts）必须把它恢复到正常帧率。
      const ticks = await page.evaluate(() => new Promise<number>((resolve) => {
        let n = 0
        setTimeout(() => resolve(n), 1000)
        const step = (): void => { n += 1; if (n < 100000) requestAnimationFrame(step) }
        requestAnimationFrame(step)
      }))
      expect(ticks, 'rAF 被压到后台节流档（~1 帧/秒）→ renderer 渲染回路停摆').toBeGreaterThan(20)

      // ④ preload/IPC：桥接面与主进程往返正常
      const info = await page.evaluate(() => window.desktopApi.getAppInfo())
      expect(info.name).toBe('Cyrene')

      // ⑤ Playwright 定位与元素可见性判定不受窗口隐藏影响
      await expect.poll(() => page.locator('textarea[aria-label="消息输入框"]').count(), POLL).toBeGreaterThan(0)

      // ⑥ 键盘输入与 DOM 焦点（任务书列为隐藏窗口的高风险项）：真点击 + 真键盘事件
      await connectAndActivateFirst(page)
      const input = page.getByLabel('消息输入框')
      await input.click()
      await page.keyboard.type('静默窗口键盘输入')
      await expect.poll(() => input.inputValue(), POLL).toBe('静默窗口键盘输入')
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')).toBe('消息输入框')
    } finally {
      await closeApp(launched)
    }
  })

  it.skipIf(VISIBLE_RUN)('静默：开发者模式开关不会创建 detached DevTools 窗口', async () => {
    const launched = await launchApp(undefined, { windowMode: 'silent' })
    const { app, page } = launched
    try {
      await page.evaluate(() => window.desktopApi.diagnosticsDevModeSet(true))
      await page.waitForTimeout(600)   // detached DevTools 落地需要一点时间；不等待会得到假通过
      const facts = await windowFacts(app)
      expect(facts.count, 'DevTools detached 是第二个受管窗口，静默模式下不得创建').toBe(1)
      expect(facts.devToolsOpened).toBe(false)
      expect(facts.isFocused).toBe(false)
      // 状态侧仍按真实语义翻转（静默只改变 OS 呈现，不改业务/服务状态）
      await expect.poll(async () => (await page.evaluate(() => window.desktopApi.diagnosticsState())).devMode, POLL).toBe(true)
      await page.evaluate(() => window.desktopApi.diagnosticsDevModeSet(false))
    } finally {
      await closeApp(launched)
    }
  })

  it.skipIf(!VISIBLE_RUN)('可视化调试模式（test:integration:visible）：窗口真的显示', async () => {
    const launched = await launchApp(undefined, { windowMode: 'visible' })
    try {
      await expect.poll(async () => (await windowFacts(launched.app)).isVisible, POLL).toBe(true)
      const facts = await windowFacts(launched.app)
      expect(facts.isAlwaysOnTop, '应用从不主动置顶——可视化模式下也必须保持 false').toBe(false)
      expect((await windowPresentation(launched.app))?.silent).toBe(false)
      // 页面仍照常工作（可视化模式只改呈现，不改语义）
      const info = await launched.page.evaluate(() => window.desktopApi.getAppInfo())
      expect(info.name).toBe('Cyrene')
    } finally {
      await closeApp(launched)
    }
  })
})
