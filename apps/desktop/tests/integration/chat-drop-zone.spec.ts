// tests/integration/chat-drop-zone.spec.ts —— 规格漂移台账 ②-2：docs/03 §8.3「拖入聊天区（落区不只输入条）」
//
// 判别面是**几何与真实状态机**，不是"有没有绑定某个事件"：
//   ① 拖到**消息列**上也要出现投放区（修复前只有 composer 收拖拽，往消息区拖毫无反馈）
//   ② 投放区必须**真的覆盖聊天区域**：它的矩形要盖住消息列与输入区——这是"覆盖式投放区"
//      与"只在输入条内的一小块"的区别（单测只能断言 DOM 层级，几何必须在真实渲染器里量）
//   ③ 离开后立即恢复（§8.3「离开后立即恢复」）
//   ④ 松开后只创建**待发送**附件条目：出现在待发送队列里，且不发送消息（§8.3 + §15 验收项）
//
// 拖拽注入手法：真实 Chromium 里 `DragEvent` 与 `DataTransfer` 均可构造，故用它们构造一次
// 真正的拖拽事件序列（本仓库集成层此前无 drag/drop 先例，这是第一处）。
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

const POLL = { timeout: 15000, interval: 200 }

/** 连接 + 激活首个会话（与 message-list-follow-bottom.spec 同一先例） */
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

/** 在指定选择器上派发一次真实拖拽事件（dataTransfer 带 1 个文件） */
async function dispatchDrag(page: Page, selector: string, type: 'dragenter' | 'dragleave' | 'drop'): Promise<void> {
  await page.evaluate(({ selector, type }) => {
    const el = document.querySelector(selector)
    if (!el) throw new Error(`未找到拖拽目标：${selector}`)
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(16)], 'drop-probe.png', { type: 'image/png' }))
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, { selector, type })
}

describe('拖入聊天区（docs/03 §8.3）', () => {
  it('① 拖到消息列上出现投放区，且覆盖整个聊天区域；松开只创建待发送附件、不发送消息', async () => {
    const launched = await launchApp()
    const { app, page, userData } = launched
    try {
      await connectAndActivateFirst(page)

      const messageCountBefore = await page.locator('.cy-message-row').count()

      // —— ① 拖到消息列（不是输入条）——
      await dispatchDrag(page, '.cy-messages', 'dragenter')
      await expect.poll(() => page.locator('.cy-drop-overlay').count(), POLL).toBe(1)

      // —— ② 覆盖式：投放区矩形必须盖住消息列与输入区 ——
      const cover = await page.evaluate(() => {
        const overlay = document.querySelector<HTMLElement>('.cy-drop-overlay')
        const messages = document.querySelector<HTMLElement>('.cy-messages')
        const composer = document.querySelector<HTMLElement>('.cy-composer')
        if (!overlay || !messages || !composer) return null
        const o = overlay.getBoundingClientRect()
        const m = messages.getBoundingClientRect()
        const c = composer.getBoundingClientRect()
        return {
          coversMessages: o.top <= m.top + 1 && o.bottom >= m.bottom - 1,
          coversComposer: o.top <= c.top + 1 && o.bottom >= c.bottom - 1,
          overlayHeight: Math.round(o.height),
          messagesHeight: Math.round(m.height),
        }
      })
      expect(cover).not.toBeNull()
      expect(cover!.coversMessages, '投放区没有盖住消息列 ⇒ 落区仍然只有输入条').toBe(true)
      expect(cover!.coversComposer).toBe(true)
      // 反向哨兵：投放区确实有尺寸（happy 路径下若 rect 全 0，上面的 cover 会因 0<=0 而假通过）
      expect(cover!.overlayHeight).toBeGreaterThan(100)
      expect(cover!.messagesHeight).toBeGreaterThan(0)

      // —— ③ 离开后立即恢复 ——
      await dispatchDrag(page, '.cy-messages', 'dragleave')
      await expect.poll(() => page.locator('.cy-drop-overlay').count(), POLL).toBe(0)

      // —— ④ 松开：只创建待发送附件（不发送消息）——
      await dispatchDrag(page, '.cy-messages', 'dragenter')
      await expect.poll(() => page.locator('.cy-drop-overlay').count(), POLL).toBe(1)
      await dispatchDrag(page, '.cy-messages', 'drop')
      await expect.poll(() => page.locator('.cy-drop-overlay').count(), POLL).toBe(0)
      // 文件确实进了待发送队列（pathless 夹具可能随后被校验判失败，但"入队"这一步是 §8.3 的要求）
      await expect.poll(() => page.locator('.cy-attachment-queue').getByText('drop-probe.png').count(), POLL).toBe(1)
      // 且没有因此产生新消息（"不得自动上传或发送"）
      expect(await page.locator('.cy-message-row').count()).toBe(messageCountBefore)
    } finally {
      try { await closeApp({ app, page, userData }) } catch { /* 尽力 */ }
    }
  }, 90_000)
})
