// tests/integration/message-actions.spec.ts —— 规格漂移台账 ②-4：doc 03 §7.5 的「重新发送」「重新生成」
//
// 判别面（用户可见 + 规格原话）：
//   ① 用户消息行有「重新发送」、助手回复行有「重新生成」（此前只有「复制」，`重新生成` 全仓 0 命中）
//   ② **doc 12 C-03 的验收原话**：「重发同一请求不会创建两条用户消息」——重发/重生成之后
//      用户消息行数恒为 1（这是本项最容易做错的形态：照搬 send() 会新增一条 local-* 乐观气泡）
//   ③ 重新生成确实产生**新一代回复**（助手行数 +1，旧回复保留）
//   ④ 生成中两个动作都禁用（与输入区禁用发送同一口径），生成结束后恢复可用
//
// 刻意放慢 mock 回放（CYRENE_MOCK_EMIT_DELAY_MS=300，约 3.3s/代）：否则"生成中禁用"这一条
// 只有一个几百毫秒的窗口，断言会变成偶发。
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

const POLL = { timeout: 15000, interval: 200 }

async function connectAndActivateFirst(page: Page): Promise<void> {
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true), POLL).toBe(false)
}

const userRows = (page: Page): Promise<number> => page.locator('.cy-user-row').count()
const assistantRows = (page: Page): Promise<number> => page.locator('.cy-assistant-row').count()

/** 生成结束的判据：两个动作按钮恢复可用（busy 门放开） */
const actionsEnabled = (page: Page, testId: string): Promise<boolean> =>
  page.locator(`[data-testid="${testId}"]`).first().isEnabled()

describe('消息操作行：重新发送 / 重新生成（doc 03 §7.5）', () => {
  it('① 入口就位 ② 重生成不新增用户消息 ③ 产生新一代回复 ④ 生成中禁用', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_EMIT_DELAY_MS: '300' } })
    const { app, page, userData } = launched
    try {
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill('第一条问题')
      await page.getByLabel('消息输入框').press('Enter')

      await expect.poll(() => assistantRows(page), POLL).toBe(1)
      await expect.poll(() => userRows(page), POLL).toBe(1)

      // ① 两侧入口（操作行默认 opacity:0，hover/focus 才显形；Playwright 的可见性判定不看 opacity）
      await expect.poll(() => page.locator('[data-testid="message-resend"]').count(), POLL).toBe(1)
      await expect.poll(() => page.locator('[data-testid="message-regenerate"]').count(), POLL).toBe(1)
      // 到手写检查：用户行只有重发、助手行只有重生成（不混）
      expect(await page.locator('.cy-user-row [data-testid="message-regenerate"]').count()).toBe(0)
      expect(await page.locator('.cy-assistant-row [data-testid="message-resend"]').count()).toBe(0)

      // 等第一代结束（按钮恢复可用）
      await expect.poll(() => actionsEnabled(page, 'message-regenerate'), POLL).toBe(true)

      // —— 重新生成 ——
      await page.locator('[data-testid="message-regenerate"]').first().click()
      // ④ 生成中：两个动作都禁用（不等它变红，先确认这条门真的生效）
      await expect.poll(() => actionsEnabled(page, 'message-regenerate'), POLL).toBe(false)
      expect(await actionsEnabled(page, 'message-resend')).toBe(false)

      await expect.poll(() => assistantRows(page), POLL).toBe(2)   // ③ 新一代回复
      expect(await userRows(page), '② 重新生成不得新增用户消息（doc 12 C-03）').toBe(1)
      await expect.poll(() => actionsEnabled(page, 'message-regenerate'), POLL).toBe(true)

      // —— 重新发送（已确认的用户消息）——
      await page.locator('[data-testid="message-resend"]').first().click()
      await expect.poll(() => actionsEnabled(page, 'message-resend'), POLL).toBe(false)
      await expect.poll(() => assistantRows(page), POLL).toBe(3)
      expect(await userRows(page), '② 重新发送不得新增用户消息（doc 12 C-03）').toBe(1)
      await expect.poll(() => actionsEnabled(page, 'message-resend'), POLL).toBe(true)

      // 重发用的是**同一条**用户消息（内容与条数都没变）
      expect(await page.locator('.cy-user-row .cy-user-bubble').allTextContents()).toEqual(['第一条问题'])
    } finally {
      try { await closeApp({ app, page, userData }) } catch { /* 尽力 */ }
    }
  }, 120_000)
})
