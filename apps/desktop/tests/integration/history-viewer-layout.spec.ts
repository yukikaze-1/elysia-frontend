// tests/integration/history-viewer-layout.spec.ts
// FE-S3-RUN2-P1-01：历史查看器面板被结果撑高 → 加载更多不可达。真实 Electron 布局 + 点击集成测试。
// 阶段 7 批次 C Task 2（虚拟化）：history-viewer 改扁平虚拟行（groupedItems → rows + computeWindow），
// 断言从「全量 DOM count」改为「虚拟列表语义」——可视行有界、分组 header 仍在、锚点 data 层偏移 ≤1px、
// loadMore 后新页行经虚拟窗口重算可达。夹具：CYRENE_MOCK_HISTORY_LARGE=120 大 seed。
// 纪律：locator.click() 真点击，禁 force/DOM .click()/直调 store（清单 §3.5）。
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { closeApp, launchApp, type LaunchedApp } from './helpers/app'

async function launchWithSize(w: number, h: number): Promise<LaunchedApp> {
  const launched = await launchApp(undefined, { env: { CYRENE_MOCK_HISTORY_LARGE: '120' } })
  // app.evaluate 回调在主进程执行，闭包不可达——尺寸经第二参显式传入（trust-boundary.spec.ts 同款）
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h)
  }, { w, h } as const)
  await launched.page.waitForFunction(([ww, hh]) => window.innerWidth === ww && window.innerHeight === hh, [w, h] as const)
  return launched
}

const POLL = { timeout: 5000, interval: 200 } // 对齐套件先例（trust-boundary.spec.ts 同款；expect.poll 默认 1000ms 太紧）

async function openAndSearch50(page: Page): Promise<void> {
  await page.getByRole('button', { name: '聊天记录' }).click()
  await page.getByRole('button', { name: '搜索' }).click()
  // 虚拟化后 `.cy-history-item` 只挂可视行（非 50），不能再用 count==50 等完成——
  // 改等 aria-live 播报到结果数（announceText「找到 N 条相关聊天记录」），证明搜索已完成、store.items.length=50。
  // 注意：`.cy-live` 在 Live2D 面板存在同名 aside，须限定 `.cy-history .cy-live` 作用域。
  await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLElement>('.cy-history .cy-live')?.textContent ?? ''), POLL).toContain('找到 50 条')
}

/** 读可视行数（虚拟窗口）：loadMore/滚动后 poll 用——不等固定全量数，只等 >0 或 ≤ 上界 */
const readBoxes = (page: Page) => page.evaluate(() => {
  const b = (sel: string) => { const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }
  return { vp: { w: window.innerWidth, h: window.innerHeight }, header: b('.cy-history-header'), panel: b('.cy-history'), footer: b('.cy-history-footer'), btn: b('.cy-more-btn') }
})

describe('历史查看器布局（FE-S3-RUN2-P1-01，阶段7批次C Task2 虚拟列表语义）', () => {
  it('虚拟化：可视行有界、分组 header 显示、loadMore 后新页可达、锚点偏移保留', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      const page = launched.page
      await openAndSearch50(page)
      // 1) 面板/页脚/按钮/标题完整在视口内（布局不受虚拟化影响——页脚在 ul 外）
      const before = await readBoxes(page)
      for (const k of ['panel', 'footer', 'btn', 'header'] as const) {
        expect(before[k].top).toBeGreaterThanOrEqual(0)
        expect(before[k].bottom).toBeLessThanOrEqual(before.vp.h)
      }
      // 2) overflow-anchor:none 生效（spec §4.2 配套：防止 Chromium 原生锚定掩盖 §4.2 手动补偿 → step 8 假绿）
      expect(await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('.cy-history-results')!).overflowAnchor)).toBe('none')
      // 3) 虚拟化后可视行有界（不随 120/500 线性；1184×721 + overscan 400px 上界保守 60，L-4 修正）
      await expect.poll(async () => page.evaluate(() => document.querySelectorAll('.cy-history-item').length), POLL).toBeLessThanOrEqual(60)
      // 4) 分组 header 可见且正确（>0，虚拟窗口内至少渲染到首组 header）
      await expect.poll(async () => page.evaluate(() => document.querySelectorAll('.cy-history-day').length), POLL).toBeGreaterThan(0)
      // 5) 结果区内部滚动到跨页边界（spec §4.4 step 4）；虚拟化后需要真实滚动触发窗口重算（异步）
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.cy-history-results')!
        el.scrollTop = el.scrollHeight * 0.7
      })
      await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLElement>('.cy-history-results')!.scrollTop), POLL).toBeGreaterThan(0)
      // 窗口重算为异步——poll 到至少一个 item 入视口（bottom > 容器 top）再取锚点，否则锚点落在旧窗口全空判 null
      await expect.poll(async () => page.evaluate(() => {
        const c = document.querySelector<HTMLElement>('.cy-history-results')!
        const cr = c.getBoundingClientRect()
        return [...c.querySelectorAll<HTMLElement>('.cy-history-item')].some((el) => el.getBoundingClientRect().bottom > cr.top)
      }), POLL).toBe(true)
      // 6) 捕获锚点：首个可见 item 的 hitId + data 层视角的视口内偏移（不依赖全 DOM）
      const anchor = await page.evaluate(() => {
        const c = document.querySelector<HTMLElement>('.cy-history-results')!
        const cr = c.getBoundingClientRect()
        const item = [...c.querySelectorAll<HTMLElement>('.cy-history-item')].find((el) => el.getBoundingClientRect().bottom > cr.top)
        return item?.dataset.hitId ? { hitId: item.dataset.hitId, offsetTop: item.getBoundingClientRect().top - cr.top } : null
      })
      expect(anchor).not.toBeNull()
      // 7) 真点击加载更多
      const beforeLoadScrollH = await page.evaluate(() => document.querySelector<HTMLElement>('.cy-history-results')!.scrollHeight)
      await page.locator('.cy-more-btn').click()
      // 8) 虚拟化后 loadMore 把新页行接入 rows（scrollHeight 增长 ≈ 一倍——新页可达，非全量 DOM count；
      //    稀疏 day-header 下可见窗可能落在单组中部，day 数不为判断「新页可达」的充分条件，故用 scrollHeight 增长断言）
      await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLElement>('.cy-history-results')!.scrollHeight), POLL).toBeGreaterThan(beforeLoadScrollH)
      // 9) 锚点偏移 ≤1px（data 层恢复：组件用 prefix[idx]+offset 还原 scrollTop，估/实测高度收敛后可视位置不跳）
      const anchorAfter = await page.evaluate((hitId) => {
        const c = document.querySelector<HTMLElement>('.cy-history-results')!
        const el = [...c.querySelectorAll<HTMLElement>('.cy-history-item')].find((n) => n.dataset.hitId === hitId)
        return el ? el.getBoundingClientRect().top - c.getBoundingClientRect().top : null
      }, anchor!.hitId)
      expect(anchorAfter).not.toBeNull()
      expect(Math.abs(anchorAfter! - anchor!.offsetTop)).toBeLessThanOrEqual(1)
      // 10) Tab 可达：重聚焦搜索框 → Shift+Tab 三次回绕到 last=加载更多
      await page.getByLabel('关键词搜索').click()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Shift+Tab')
      const activeText = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? '')
      expect(activeText).toContain('加载更多')
      // 11) Esc 关闭 + 回焦「聊天记录」
      await page.keyboard.press('Escape')
      await expect.poll(async () => page.evaluate(() => document.querySelector('.cy-history-overlay')), POLL).toBeNull()
      const activeTitle = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('title') ?? '')
      expect(activeTitle).toBe('聊天记录')
    } finally { await closeApp(launched) }
  })

  it('1100×700 最小档：面板/加载更多在视口内、真点击加载第二页（虚拟化后可视行有界）', async () => {
    const launched = await launchWithSize(1100, 700)
    try {
      const page = launched.page
      await openAndSearch50(page)
      const boxes = await readBoxes(page)
      for (const k of ['panel', 'footer', 'btn'] as const) {
        expect(boxes[k].top).toBeGreaterThanOrEqual(0)
        expect(boxes[k].bottom).toBeLessThanOrEqual(boxes.vp.h)
      }
      await page.locator('.cy-more-btn').click()
      // loadMore 高效可达：虚拟化 DOM 有界（≤60），且首组 header 仍渲染
      await expect.poll(async () => page.evaluate(() => document.querySelectorAll('.cy-history-item').length), POLL).toBeGreaterThan(0)
      const visAfter = await page.evaluate(() => document.querySelectorAll('.cy-history-item').length)
      expect(visAfter).toBeLessThanOrEqual(60)
      const dayCount2 = await page.evaluate(() => document.querySelectorAll('.cy-history-day').length)
      expect(dayCount2).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })

  it('空结果态：空态文本可见且 ⊂ 面板、无加载更多按钮', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      const page = launched.page
      await page.getByRole('button', { name: '聊天记录' }).click()
      await page.getByLabel('关键词搜索').fill('zzz_nonexistent')
      await page.getByRole('button', { name: '搜索' }).click()
      // 按「没有找到相关聊天记录」文本 poll（loading 态文本为「正在搜索…」，不会误匹配，避免对 loading 假绿）
      await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLElement>('.cy-history-state')?.textContent ?? ''), POLL).toContain('没有找到相关聊天记录')
      const state = await page.evaluate(() => { const r = document.querySelector<HTMLElement>('.cy-history-state')!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: window.innerHeight } })
      expect(state.top).toBeGreaterThanOrEqual(0)
      expect(state.bottom).toBeLessThanOrEqual(state.vh)
      expect(await page.locator('.cy-more-btn').count()).toBe(0)
    } finally { await closeApp(launched) }
  })
})
