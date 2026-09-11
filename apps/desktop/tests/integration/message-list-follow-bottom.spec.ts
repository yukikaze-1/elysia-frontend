// tests/integration/message-list-follow-bottom.spec.ts —— H-02（2026-09-11）：
// ① 内容增长时贴底跟随；② 回复可复制；③ 正文可选中。
//
// 修复前的实测事实（报告 H-02 + 本轮读码复核）：`atBottom` 明明有 8 个赋值点，却**没有一处**
// 由内容增长触发；`.cy-messages` 又用 `overflow-anchor: none` 关掉了浏览器原生补偿。
// 于是超过一屏的会话里，按 Enter 后自己的消息落在视口下方、scrollTop 不动，而 atBottom 仍为 true，
// 连「回到底部」按钮都不出现——用户感受是「按了发送没反应」。
//
// 判别力：删除 CyMessageList 的 followBottomIfSticky 调用后，用例 ① 必红（已做变异验证）。
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

const POLL = { timeout: 15000, interval: 200 }

/** 连连接 + 激活首个会话 */
async function connectAndActivateFirst(page: Page): Promise<void> {
  await page.getByRole('button', { name: /REAL|MOCK/ }).first().click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(
    () => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true),
    POLL
  ).toBe(false)
}

/** 距底部距离（scrollHeight - scrollTop - clientHeight） */
const bottomGap = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.cy-messages')
    if (!el) return Number.NaN
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
  })

describe('消息列表贴底跟随与复制（H-02）', () => {
  it('① 长会话中发送消息后仍贴底——自己的消息在视口内', async () => {
    // 200 条种子历史 → 远超一屏，复现「按 Enter 看不见自己的消息」的真实前提
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_HISTORY_LARGE: '200' } })
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await expect.poll(() => bottomGap(page), POLL).toBeLessThanOrEqual(40)   // 激活后应贴底

      const text = '贴底跟随验证'
      await page.getByLabel('消息输入框').fill(text)
      await page.getByLabel('消息输入框').press('Enter')

      // 判别点（产品级语义）：自己刚发的消息必须**真的在视口内可见**。
      // 修复前它落在视口下方且没有任何提示——用户感受是「按了发送没反应」。
      // 注意不能用「可视行数变多」当断言：虚拟窗口滚动后行数减少是正常的。
      await expect.poll(async () => page.evaluate((t) => {
        const el = document.querySelector<HTMLElement>('.cy-messages')
        const bubble = [...document.querySelectorAll<HTMLElement>('.cy-user-bubble')].find((n) => (n.textContent ?? '').includes(t))
        if (!el || !bubble) return false
        const c = el.getBoundingClientRect()
        const r = bubble.getBoundingClientRect()
        return r.top >= c.top - 1 && r.bottom <= c.bottom + 1
      }, text), POLL).toBe(true)
      expect(await bottomGap(page)).toBeLessThanOrEqual(40)
    } finally { await closeApp(launched) }
  })

  it('② 助手回复渲染复制按钮（copyableText 非空才渲染），且可点击不报错', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill('你好')
      await page.getByLabel('消息输入框').press('Enter')
      await expect.poll(() => page.locator('[data-testid="message-copy"]').count(), POLL).toBeGreaterThan(0)
      const btn = page.locator('[data-testid="message-copy"]').last()
      await expect.poll(() => btn.textContent(), POLL).toContain('复制')
      // 真实剪贴板写入在本 harness 下依赖窗口焦点、结果不稳定（同一用例曾通过也曾失败），
      // 故 e2e 只断言渲染与可点击；「复制什么内容、是否调用剪贴板」由可注入的
      // tests/unit/cy-message-bubble.spec.ts 确定性覆盖（见该文件 H-02 用例）。
      await btn.click()
      await expect.poll(() => btn.textContent(), POLL).toMatch(/复制|已复制/)
    } finally { await closeApp(launched) }
  })

  it('③ 消息正文 user-select 为 text（全局 body 是 none，此前 Ctrl+A/Ctrl+C 无效）', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill('可选中验证')
      await page.getByLabel('消息输入框').press('Enter')
      await expect.poll(() => page.locator('.cy-user-bubble').count(), POLL).toBeGreaterThan(0)
      const selectable = await page.evaluate(() => {
        const bubble = document.querySelector<HTMLElement>('.cy-user-bubble')
        return bubble ? getComputedStyle(bubble).userSelect : 'missing'
      })
      expect(selectable).toBe('text')
    } finally { await closeApp(launched) }
  })
})
