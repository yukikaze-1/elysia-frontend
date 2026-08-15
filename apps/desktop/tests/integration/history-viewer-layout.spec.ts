// tests/integration/history-viewer-layout.spec.ts
// FE-S3-RUN2-P1-01：历史查看器面板被结果撑高 → 加载更多不可达。真实 Electron 布局 + 点击集成测试。
// 夹具：CYRENE_MOCK_HISTORY_LARGE=120 大 seed（Task 1）；测试侧 setContentSize 固定真实 viewport（决策 D3）。
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
  await expect.poll(async () => page.locator('.cy-history-item').count(), POLL).toBe(50)
}

const readBoxes = (page: Page) => page.evaluate(() => {
  const b = (sel: string) => { const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }
  return { vp: { w: window.innerWidth, h: window.innerHeight }, header: b('.cy-history-header'), panel: b('.cy-history'), footer: b('.cy-history-footer'), btn: b('.cy-more-btn') }
})

describe('历史查看器布局（FE-S3-RUN2-P1-01）', () => {
  it('1184×721：面板完整在视口内、真点击加载第二页 100 条且顺序/去重/锚点偏移保留', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      const page = launched.page
      await openAndSearch50(page)
      const before = await readBoxes(page)
      for (const k of ['panel', 'footer', 'btn', 'header'] as const) {
        expect(before[k].top).toBeGreaterThanOrEqual(0)
        expect(before[k].bottom).toBeLessThanOrEqual(before.vp.h)
      }
      // overflow-anchor:none 生效（spec §4.2 配套：防止 Chromium 原生锚定掩盖 §4.2 手动补偿 → step 8 假绿）
      const anchorMode = await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('.cy-history-results')!).overflowAnchor)
      expect(anchorMode).toBe('none')
      // 4) 结果区内部滚动到跨页边界日期组（spec §4.4 step 4；合成数据下 0.7×scrollHeight 对任意条目高恒落边界组，故弃用 spec 的「动态下移」防御子句）
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.cy-history-results')!
        el.scrollTop = el.scrollHeight * 0.7
      })
      await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLElement>('.cy-history-results')!.scrollTop), POLL).toBeGreaterThan(0)
      const afterScroll = await readBoxes(page)
      expect(afterScroll.header.top).toBeCloseTo(before.header.top, 0)    // header 不随内容滚出
      expect(afterScroll.footer.bottom).toBeCloseTo(before.footer.bottom, 0)
      // 5) 捕获锚点：首个可见项 hitId + 精确 offsetTop + first50 DOM 序
      const anchor = await page.evaluate(() => {
        const c = document.querySelector<HTMLElement>('.cy-history-results')!
        const cr = c.getBoundingClientRect()
        const item = [...c.querySelectorAll<HTMLElement>('.cy-history-item')].find((el) => el.getBoundingClientRect().bottom > cr.top)
        if (!item?.dataset.hitId) return null
        return { hitId: item.dataset.hitId, offsetTop: item.getBoundingClientRect().top - cr.top }
      })
      expect(anchor).not.toBeNull()
      const first50 = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.cy-history-item')].map((el) => el.dataset.hitId ?? ''))
      expect(first50).toHaveLength(50)
      // 6) 真点击加载更多
      await page.locator('.cy-more-btn').click()
      // 7) 100 条 + 唯一 + 首屏相对顺序子序列 + day 组 2→4
      await expect.poll(async () => page.locator('.cy-history-item').count(), POLL).toBe(100)
      const allIds = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.cy-history-item')].map((el) => el.dataset.hitId ?? ''))
      expect(new Set(allIds).size).toBe(100)
      const first50Set = new Set(first50)
      expect(allIds.filter((id) => first50Set.has(id))).toEqual(first50)
      const dayCount = await page.evaluate(() => document.querySelectorAll('.cy-history-day').length)
      expect(dayCount).toBe(4)
      // 8) 锚点精确偏移保留（≤1px）
      const anchorAfter = await page.evaluate((hitId) => {
        const c = document.querySelector<HTMLElement>('.cy-history-results')!
        const cr = c.getBoundingClientRect()
        const el = [...c.querySelectorAll<HTMLElement>('.cy-history-item')].find((n) => n.dataset.hitId === hitId)
        if (!el) return null
        return el.getBoundingClientRect().top - cr.top
      }, anchor!.hitId)
      expect(anchorAfter).not.toBeNull()
      expect(Math.abs(anchorAfter! - anchor!.offsetTop)).toBeLessThanOrEqual(1)
      // 9) Tab 可达：重聚焦搜索框 → Shift+Tab 三次回绕到 last=加载更多
      await page.getByLabel('关键词搜索').click()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Shift+Tab')
      const activeText = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? '')
      expect(activeText).toContain('加载更多')
      // 10) Esc 关闭 + 回焦「聊天记录」
      await page.keyboard.press('Escape')
      await expect.poll(async () => page.evaluate(() => document.querySelector('.cy-history-overlay')), POLL).toBeNull()
      const activeTitle = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('title') ?? '')
      expect(activeTitle).toBe('聊天记录')
    } finally { await closeApp(launched) }
  })

  it('1100×700 最小档：面板/加载更多在视口内、真点击加载第二页', async () => {
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
      await expect.poll(async () => page.locator('.cy-history-item').count(), POLL).toBe(100)
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
