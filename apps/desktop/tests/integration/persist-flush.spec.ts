// tests/integration/persist-flush.spec.ts —— H-04（2026-09-11）：退出前 flush 防抖持久化。
//
// 真实用户路径：**改完设置/敲完字立刻关窗**。修复前 Renderer 侧防抖（设置 500ms、布局 200ms、
// 角色草稿、以及非当前会话的草稿）没有任何退出 flush——`flush()` 全仓只有「切会话」与「断线」两个调用点。
//
// 判别力设计（第一版曾写错，记录教训）：最初用「当前会话草稿」作断言，结果**变异验证不变红**。
// 追查后确认：关窗时 `createShutdownHandler` 会 preventDefault 并执行 `adapter.disconnect()`，
// 该步骤向仍存活的 Renderer 推 `disconnected` → `message.store.ts:1064` 的**既有断线 flush**
// 顺带把当前会话草稿写下去了。即「当前会话草稿」这条路径**本来就有兜底**，用它断言测不出本修复。
// 故判别点改用**设置（settings.json）**：它没有任何既有 teardown flush，是真正会丢的那一批。
// 「当前会话草稿」保留为回归用例，但明确标注其兜底来源，不冒充本修复的判别证据。
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

const POLL = { timeout: 15000, interval: 200 }
const MARK = 'H04-关窗前键入的草稿-9f3a2c'
const DRAFTS_REL = 'app-cache/drafts-v1.json'

/** 在 userData 树下定位 settings.json（不硬编码 config 目录名，避免路径假设） */
function findSettingsFile(userData: string): string | undefined {
  const walk = (dir: string): string | undefined => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { const hit = walk(p); if (hit) return hit }
      else if (name === 'settings.json') return p
    }
    return undefined
  }
  try { return walk(join(userData, 'Cyrene')) } catch { return undefined }
}

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

describe('退出前持久化 flush（H-04）', () => {
  it('关窗前改动的设置（500ms 防抖未到期）由退出 flush 落盘【判别用例】', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      // 打开设置中心 → 语音子页
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.locator('.cy-settings-nav-item').filter({ hasText: '语音' }).first().click()
      await expect.poll(() => page.locator('.cy-voice-pane').count(), POLL).toBe(1)

      // 真实点击开关（默认开 → 关）。不 await 任何 sleep，保持「立即关窗」时序。
      await page.getByLabel('TTS 自动朗读 AI 回复').click()
      await expect.poll(() => page.getByLabel('TTS 自动朗读 AI 回复').isChecked(), POLL).toBe(false)

      const settingsPath = findSettingsFile(launched.userData)
      const before = settingsPath && existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
      expect(before.includes('"autoReadReply": false'), '防抖未到期时设置不应已落盘').toBe(false)

      // 立刻关窗（远早于 500ms 防抖）。移除 Main 的 renderer-persist step 后此处必红。
      await closeApp(launched, { keepUserData: true })

      const after = findSettingsFile(launched.userData)
      expect(after, 'settings.json 应存在').toBeDefined()
      const parsed = JSON.parse(readFileSync(after!, 'utf8')) as { voice?: { autoReadReply?: boolean } }
      expect(parsed.voice?.autoReadReply, '关窗前的设置改动必须已被退出 flush 落盘').toBe(false)
    } finally {
      rmSync(launched.userData, { recursive: true, force: true })
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2026-09-16 审计 P1-1：**真实用户退出路径**（关最后一个窗口）。
  //
  // 上一条用例走的是 `closeApp()` → Playwright `ElectronApplication.close()` → `app.quit()`，
  // 这条路径上 `before-quit` 触发时窗口仍存活，flush 能投递出去——**所以它对本缺陷零判别力**
  // （审计报告的原话：该用例的价值恰恰在于它测不到）。
  //
  // Windows/Linux 用户关应用的唯一路径是点窗口 ✕，事件顺序经同版本 Electron 43.3.0 实测为：
  //   win.close → win.closed（此处 getMainWindow() 已置 null）→ window-all-closed → app.quit() → before-quit
  // 挂在 before-quit 上的 flush 此时 `deliver()` 恒返回 false（fail-open 立即 resolve），
  // 而 Renderer 侧没有 beforeunload/pagehide/unload 补偿通道（全仓 0 命中）⇒ 防抖写静默丢失。
  //
  // 判别力：移除 `index.ts` 的 `setBeforeCloseFlush(...)` 接线 ⇒ 本条必红（上一条仍绿）。
  // ───────────────────────────────────────────────────────────────────────────
  it('点窗口 ✕ 关最后一个窗口：真实退出路径上的设置改动必须落盘【判别用例，2026-09-16 审计 P1-1】', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.locator('.cy-settings-nav-item').filter({ hasText: '语音' }).first().click()
      await expect.poll(() => page.locator('.cy-voice-pane').count(), POLL).toBe(1)

      await page.getByLabel('TTS 自动朗读 AI 回复').click()
      await expect.poll(() => page.getByLabel('TTS 自动朗读 AI 回复').isChecked(), POLL).toBe(false)

      const settingsPath = findSettingsFile(launched.userData)
      const before = settingsPath && existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
      expect(before.includes('"autoReadReply": false'), '防抖未到期时设置不应已落盘').toBe(false)

      // 真实关窗：等价于用户点 ✕（不是 app.quit()，两者的 before-quit 时序相反）。
      await launched.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() })

      // 窗口必须真的消失——本修复在 close 上 preventDefault 过一次，绝不能把退出卡住。
      await expect.poll(() => page.isClosed(), POLL).toBe(true)

      const after = findSettingsFile(launched.userData)
      expect(after, 'settings.json 应存在').toBeDefined()
      const parsed = JSON.parse(readFileSync(after!, 'utf8')) as { voice?: { autoReadReply?: boolean } }
      expect(parsed.voice?.autoReadReply, '点 ✕ 前的设置改动必须已被关窗前 flush 落盘').toBe(false)
    } finally {
      await closeApp(launched, { keepUserData: true }).catch(() => { /* 窗口已关闭时 app.close 会抛——清理仍要继续 */ })
      rmSync(launched.userData, { recursive: true, force: true })
    }
  })

  it('关窗前键入的当前会话草稿仍落盘【回归用例——兜底来自既有断线 flush，非本修复】', async () => {
    const launched = await launchApp()
    const draftsPath = join(launched.userData, 'Cyrene', DRAFTS_REL)
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill(MARK)   // 触发 800ms 防抖；绝不按 Enter

      const before = existsSync(draftsPath) ? readFileSync(draftsPath, 'utf8') : ''
      expect(before.includes(MARK), '防抖未到期时草稿不应已落盘').toBe(false)

      await closeApp(launched, { keepUserData: true })

      const drafts = JSON.parse(readFileSync(draftsPath, 'utf8')) as { entries: Record<string, { text?: string }> }
      expect(Object.values(drafts.entries).map((e) => e.text)).toContain(MARK)
    } finally {
      rmSync(launched.userData, { recursive: true, force: true })
    }
  })
})
