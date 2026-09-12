// tests/integration/reduce-motion.spec.ts
//
// M-24（2026-09-12，全量评审）：本文件补的是**单元测试证明不了的那一半**。
//
// `tests/unit/reduce-motion.spec.ts` 证明的是：门控逻辑正确、`reduced-motion.css` 里**写了**覆盖选择器。
// 它证明不了的两件事，只能在真实渲染器里量：
//   ① 组件 scoped 样式会给选择器加 `[data-v-*]`（如 `.cy-tool-status.is-running .cy-tool-dot[data-v-x]`
//      = 4 个类级），`html.cy-reduce-motion …` 前缀是否**真的**压过它——写对了选择器但特异性不够时，
//      单元测试照样全绿，而动画在用户机器上根本停不下来（"绿着但没生效"，正是本仓库反复记录的那类失效）。
//   ② 真实 `matchMedia` 偏好变化是否真的驱动了根类（单测里 matchMedia 是假的）。
//
// 故本用例在一个**真的在动的**元素上双向断言 computed `animation-name`：
// 有类 ⇒ `none`；去掉类 ⇒ 又是动画名（避免"选择器根本没匹配上、两边都是 none"这种假绿）。
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

/** 流式占位圆点的 computed 动画名；元素不存在时返回哨兵，便于把"没渲染"与"动画被关"区分开 */
const dotAnimationName = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.querySelector('.cy-typing-dot')
    if (!el) return '__absent__'
    return getComputedStyle(el).animationName
  })

describe('M-24 减少动态：真实渲染器里的有效性', () => {
  it('根类确实让持续动画停下，且去掉类后动画恢复（双向）', async () => {
    // 分段拉长到约 12s（60 × 200ms），保证断言期间流式占位一直在
    const launched = await launchApp(undefined, {
      env: { CYRENE_MOCK_MULTI_SEGMENT: '60', CYRENE_MOCK_EMIT_DELAY_MS: '200' }
    })
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill('减少动态验证')
      await page.getByLabel('消息输入框').press('Enter')

      // 基线：元素在、动画名是动画名（这一条同时排除"选择器没匹配上"的假绿）
      await expect.poll(() => dotAnimationName(page), POLL).not.toBe('__absent__')
      const baseline = await dotAnimationName(page)
      expect(baseline, `基线形态异常（期望动画名，得到 ${baseline}）`).not.toBe('none')

      // 落类 ⇒ 动画必须停
      await page.evaluate(() => document.documentElement.classList.add('cy-reduce-motion'))
      await expect.poll(() => dotAnimationName(page), POLL).toBe('none')
      expect(await dotAnimationName(page), '落类后仍在动：说明覆盖规则的特异性没压过组件 scoped 规则').toBe('none')

      // 去掉类 ⇒ 动画必须恢复（证明上面那次 none 是"门控生效"而不是"元素换了/动画本来就没有"）
      await page.evaluate(() => document.documentElement.classList.remove('cy-reduce-motion'))
      await expect.poll(() => dotAnimationName(page), POLL).not.toBe('none')
    } finally {
      await closeApp(launched)
    }
  })

  it('真实 matchMedia 偏好变化会驱动根类（接线在真渲染器里成立）', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_MULTI_SEGMENT: '1' } })
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      const hasClass = (): Promise<boolean> =>
        page.evaluate(() => document.documentElement.classList.contains('cy-reduce-motion'))

      // 先归零再翻转，避免受运行器环境默认值影响
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect.poll(hasClass, POLL).toBe(false)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect.poll(hasClass, POLL).toBe(true) // 根类由 matchMedia 的 change 事件异步落，必须轮询而非立即断言
      expect(await hasClass(), '系统偏好为 reduce 时根类未落：matchMedia → 门控接线断了').toBe(true)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect.poll(hasClass, POLL).toBe(false)
    } finally {
      await closeApp(launched)
    }
  })
})
