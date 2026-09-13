// tests/integration/context-menu.spec.ts —— 规格漂移台账 ②-5：doc 03 §5.1 会话右键菜单（＋消息右键，台账要求同一机制覆盖两处）
//
// 本仓库集成层此前**没有任何右键先例**（`button: 'right'` 与 `contextmenu` 在 tests 下 0 命中），
// 故这里同时确立两件事：真实 CDP 右键可用，且菜单确实按**指针坐标**定位。
//
// 判别面：
//   ① 右键会话行 → 菜单出现在**指针处**（不是某个写死的锚点位置），且项为「重命名/删除」（PRD §6.3 的清单）
//   ② 选中「重命名」→ 该行进入重命名态（菜单真的接到了既有动作，不是只画了个框）
//   ③ Escape 关菜单；点外部关菜单
//   ④ 右键助手回复 → 「复制回答 + 重新生成」；右键用户消息 → 「复制消息 + 重新发送」（两侧不混）
//   ⑤ 通过菜单点「重新生成」→ 真的产生新一代回复，且**用户消息行数不变**（doc 12 C-03 同一条不变量）
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

/** 菜单几何：相对**右键点**的偏移（判"按指针定位"），以及是否在视口内 */
async function menuGeometry(page: Page): Promise<{ dx: number; dy: number; inViewport: boolean } | null> {
  return page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-testid="context-menu"]')
    const probe = (window as unknown as { __menuProbe?: { x: number; y: number } }).__menuProbe
    if (!menu || !probe) return null
    const r = menu.getBoundingClientRect()
    return {
      dx: Math.round(r.left - probe.x),
      dy: Math.round(r.top - probe.y),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
    }
  })
}

describe('右键菜单（doc 03 §5.1 / §7.5）', () => {
  it('① 会话行右键按指针定位 ② 重命名真的进入重命名态 ③ Esc/点外部关闭 ④⑤ 消息右键两条动作', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_EMIT_DELAY_MS: '150' } })
    const { app, page, userData } = launched
    try {
      await connectAndActivateFirst(page)
      // 记录右键点坐标（菜单"按指针定位"的判据需要一个可信的参照）
      await page.evaluate(() => {
        ;(window as unknown as { __menuProbe?: { x: number; y: number } }).__menuProbe = undefined
        document.addEventListener('contextmenu', (e) => {
          ;(window as unknown as { __menuProbe?: { x: number; y: number } }).__menuProbe = { x: e.clientX, y: e.clientY }
        }, { capture: true, once: false })
      })

      // —— ① 会话行右键 ——
      await page.locator('.cy-conversation-main').first().click({ button: 'right' })
      await expect.poll(() => page.locator('[data-testid="context-menu"]').count(), POLL).toBe(1)
      await expect.poll(() => page.locator('[data-testid="context-menu-rename"]').count(), POLL).toBe(1)
      expect(await page.locator('[data-testid="context-menu-delete"]').count()).toBe(1)
      const convGeo = await menuGeometry(page)
      expect(convGeo).not.toBeNull()
      expect(Math.abs(convGeo!.dx), '菜单没有出现在右键点（横向）').toBeLessThanOrEqual(2)
      expect(Math.abs(convGeo!.dy), '菜单没有出现在右键点（纵向）').toBeLessThanOrEqual(2)
      expect(convGeo!.inViewport).toBe(true)

      // —— ③ Escape 关闭 ——
      await page.keyboard.press('Escape')
      await expect.poll(() => page.locator('[data-testid="context-menu"]').count(), POLL).toBe(0)

      // —— ② 选中「重命名」→ 进入重命名态且**焦点已落在输入框**（"点完就能打字"）——
      await page.locator('.cy-conversation-main').first().click({ button: 'right' })
      await expect.poll(() => page.locator('[data-testid="context-menu-rename"]').count(), POLL).toBe(1)
      await page.locator('[data-testid="context-menu-rename"]').click()
      await expect.poll(() => page.locator('.cy-rename-input').count(), POLL).toBe(1)
      await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('cy-rename-input') ?? false), POLL).toBe(true)
      await page.keyboard.press('Escape')   // 取消重命名（不落盘）——Escape 由输入框自身处理
      await expect.poll(() => page.locator('.cy-rename-input').count(), POLL).toBe(0)

      // —— ③b 点外部关闭 ——
      await page.locator('.cy-conversation-main').first().click({ button: 'right' })
      await expect.poll(() => page.locator('[data-testid="context-menu"]').count(), POLL).toBe(1)
      await page.locator('.cy-chat-header').click()
      await expect.poll(() => page.locator('[data-testid="context-menu"]').count(), POLL).toBe(0)

      // —— 发一条消息，拿到助手回复 ——
      await page.getByLabel('消息输入框').fill('右键菜单判别用例')
      await page.getByLabel('消息输入框').press('Enter')
      await expect.poll(() => page.locator('.cy-assistant-row').count(), POLL).toBe(1)
      await expect.poll(() => page.locator('[data-testid="message-regenerate"]').first().isEnabled(), POLL).toBe(true)

      // —— ④ 助手回复右键：复制回答 + 重新生成（不含重新发送）——
      await page.locator('.cy-assistant-row').first().click({ button: 'right' })
      await expect.poll(() => page.locator('[data-testid="context-menu"]').count(), POLL).toBe(1)
      expect(await page.locator('[data-testid="context-menu-copy"]').textContent()).toBe('复制回答')
      expect(await page.locator('[data-testid="context-menu-regenerate"]').count()).toBe(1)
      expect(await page.locator('[data-testid="context-menu-resend"]').count()).toBe(0)
      const msgGeo = await menuGeometry(page)
      expect(Math.abs(msgGeo!.dx)).toBeLessThanOrEqual(2)
      expect(Math.abs(msgGeo!.dy)).toBeLessThanOrEqual(2)

      // —— ⑤ 通过菜单点「重新生成」→ 新一代回复，且用户消息行数不变 ——
      await page.locator('[data-testid="context-menu-regenerate"]').click()
      await expect.poll(() => page.locator('[data-testid="context-menu"]').count(), POLL).toBe(0)
      await expect.poll(() => page.locator('.cy-assistant-row').count(), POLL).toBe(2)
      expect(await page.locator('.cy-user-row').count(), '菜单重生成不得新增用户消息（doc 12 C-03）').toBe(1)

      // —— ④b 用户消息右键：复制消息 + 重新发送（不含重新生成）——
      await expect.poll(() => page.locator('[data-testid="message-resend"]').first().isEnabled(), POLL).toBe(true)
      await page.locator('.cy-user-row').first().click({ button: 'right' })
      await expect.poll(() => page.locator('[data-testid="context-menu"]').count(), POLL).toBe(1)
      expect(await page.locator('[data-testid="context-menu-copy"]').textContent()).toBe('复制消息')
      expect(await page.locator('[data-testid="context-menu-resend"]').count()).toBe(1)
      expect(await page.locator('[data-testid="context-menu-regenerate"]').count()).toBe(0)
      await page.keyboard.press('Escape')
    } finally {
      try { await closeApp({ app, page, userData }) } catch { /* 尽力 */ }
    }
  }, 120_000)
})
