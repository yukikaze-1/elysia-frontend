// tests/integration/session-usage.spec.ts
// C2 展示半边（2026-09-15）：**输入框下方**的会话级 token 条，端到端。
//
// 为什么必须真机跑一遍：单测覆盖了 store 的归属/栅栏与组件渲染，但它们证明不了
// 「真实事件流经 preload 的 schema 校验 → bootstrap → store → 组件后，用户真的看得见这两个数」。
// （本仓有过 e2e 断言选错对象而恒绿的先例，故判据取用户可见的文本与**几何位置**，不取内部状态。）
//
// 数据来自内置夹具 `streaming-reply.jsonl` 的 generation.completed：本轮 usage 208，
// 会话累计 conversationUsage 2100（两个口径都在夹具里，故不需要任何测试专用注入）。
//
// 判据：
//   ① 发送前**整条不存在**（后端没有该会话记录 → unknown ≠ 0，不显示 "0 tokens"）；
//   ② 生成完成后出现，且两个数分别标注为「本会话累计」「最近一轮」；
//   ③ 它在 Composer 容器**下方**（几何判据，而不是"代码里写在下面"）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import type { Page } from 'playwright'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
let page: Page

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await predicate()) return } catch { /* 元素尚未出现：继续轮询 */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
}

beforeAll(async () => {
  launched = await launchApp()
  page = launched.page
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await waitFor(
    async () => ((await page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? '')) ?? '').includes('已连接'),
    20_000, '连接成功'
  )
  await waitFor(async () => (await page.locator('.cy-conversation').count()) > 0, 20_000, '会话列表出现')
  await page.locator('.cy-conversation-main').first().click()
  await waitFor(
    async () => ((await page.evaluate(() => document.querySelector('.cy-chat-heading h2')?.textContent ?? '')) ?? '').length > 0,
    30_000, '会话标题出现（激活完成）'
  )
}, 150_000)

afterAll(async () => { if (launched) await closeApp(launched) })

describe('会话级 token 条（输入框下方）', () => {
  it('无记录时整条不存在；一次生成完成后出现「本会话累计 / 最近一轮」，且位于输入框下方', async () => {
    // ① 发送前：后端还没有该会话的 token 记录（Mock 不回放 token_stats）→ 整条不显示
    expect(await page.locator('[data-testid="session-usage"]').count(), '无数据时不得出现占位').toBe(0)

    const input = page.locator('textarea[aria-label="消息输入框"]')
    await input.click()
    await input.pressSequentially('这条消息会带回会话级 token 统计', { delay: 10 })
    await page.getByRole('button', { name: '发送', exact: true }).click({ timeout: 20_000 })

    // ② 生成完成（夹具最后一条 generation.completed 带 usage + conversationUsage）→ 出现
    await waitFor(
      async () => (await page.locator('[data-testid="session-usage"]').count()) === 1,
      30_000, 'token 条出现'
    )
    const totalText = (await page.locator('[data-testid="session-usage-total"]').textContent()) ?? ''
    expect(totalText).toContain('本会话累计')
    expect(totalText).toContain('2.1K')            // 夹具 conversationUsage.total = 2100
    const turnText = (await page.locator('[data-testid="session-usage-last-turn"]').textContent()) ?? ''
    expect(turnText).toContain('最近一轮')
    expect(turnText).toContain('208')              // 夹具本轮 usage.total = 208
    // 夹具的 usage 无 rounds ⇒ 后端未上报 cached_tokens ⇒ 不得出现一个编出来的命中率
    expect(turnText).not.toContain('缓存命中')

    // ③ 位置：在 Composer 容器下方（几何判据）
    const shell = await page.locator('.cy-composer-shell').boundingBox()
    const bar = await page.locator('[data-testid="session-usage"]').boundingBox()
    expect(shell, 'Composer 容器应可见').not.toBeNull()
    expect(bar, 'token 条应可见').not.toBeNull()
    expect(bar!.y, 'token 条必须在输入框容器下方').toBeGreaterThanOrEqual(shell!.y + shell!.height - 1)
  }, 120_000)
})
