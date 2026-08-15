// tests/integration/settings-model-services.spec.ts
// Task 10（阶段 4 批次 A）：模型服务设置中心真实 Electron 布局/点击/表单集成测试。
// 夹具：launchApp 恒 mock（CYRENE_BACKEND=mock，装配策略已默认 Real→显式 mock）；1184×721 视口（setContentSize，决策 D3 同款）。
// 纪律：locator.click() 真点击，禁 force/DOM .click()/直调 store（history-viewer-layout.spec.ts 同款）；
//   async store→DOM 迁移一律 expect.poll（POLL 同套件先例），文本/属性/值读取用 page.evaluate 可空链（本套件不用 Playwright expect 扩展，只用 Vitest 原生 matcher）。
// mock-backend 夹具（Task 10 增量）：llm 内置 ollama（local_worker，两模型）→ 徽标/滚动用例。
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { closeApp, launchApp, type LaunchedApp } from './helpers/app'

const POLL = { timeout: 5000, interval: 200 } // 对齐套件先例（trust-boundary/history-viewer-layout）

async function launchWithSize(w: number, h: number): Promise<LaunchedApp> {
  const launched = await launchApp()
  // app.evaluate 回调在主进程执行，闭包不可达——尺寸经第二参显式传入（history-viewer-layout.spec.ts 同款）
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h)
  }, { w, h } as const)
  await launched.page.waitForFunction(([ww, hh]) => window.innerWidth === ww && window.innerHeight === hh, [w, h] as const)
  return launched
}

/** NavRail「设置」→ 打开设置中心；等 store.load() 完成（卡片出现才退出 loading 态，避免对 loading 假绿） */
async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBeGreaterThan(0)
  await expect.poll(() => page.locator('.cy-profile-card').count(), POLL).toBeGreaterThan(0)
}

/** 经 UI 向导创建 custom LLM profile（添加 → 填名称/Endpoint/apiKey → 测试并保存 → 向导关闭、卡片出现） */
async function createCustom(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: '添加自定义模型', exact: true }).click()
  await expect.poll(() => page.locator('.cy-wizard').count(), POLL).toBe(1)
  await page.getByPlaceholder('例如 my-llm', { exact: true }).fill(name)
  await page.getByPlaceholder('https://', { exact: true }).fill('https://api.example.com')
  await page.locator('.cy-wizard input[type="password"]').fill('sk-test')
  await page.getByRole('button', { name: '测试并保存', exact: true }).click()
  await expect.poll(() => page.locator(`.cy-profile-card[data-profile-id="custom/${name}"]`).count(), POLL).toBe(1)
  await expect.poll(() => page.locator('.cy-wizard').count(), POLL).toBe(0)
}

const cardSel = (id: string) => `.cy-profile-card[data-profile-id="${id}"]`
const text = (page: Page, sel: string) => page.evaluate((s) => document.querySelector<HTMLElement>(s)?.textContent ?? '', sel)
const textInCard = (page: Page, id: string, sub: string) => text(page, `${cardSel(id)} ${sub}`)
const countInCard = (page: Page, id: string, sub: string) => page.evaluate((s) => document.querySelectorAll(s).length, `${cardSel(id)} ${sub}`)
const btnInCard = (page: Page, id: string, label: string) => page.evaluate(([s, l]) =>
  [...document.querySelectorAll<HTMLElement>(`${s} button`)].some((b) => (b.textContent ?? '').trim() === l), [cardSel(id), label] as const)

describe('模型服务设置中心（真实 Electron 1184×721）', () => {
  it('1. NavRail「设置」→ .cy-settings 出现且 bounding box ⊂ viewport', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      const box = await launched.page.evaluate(() => {
        const r = document.querySelector<HTMLElement>('.cy-settings')!.getBoundingClientRect()
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight }
      })
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(box.vw)
      expect(box.bottom).toBeLessThanOrEqual(box.vh)
    } finally { await closeApp(launched) }
  })

  it('2. 模型服务页：LLM tab 默认激活，内置 deepseek 卡片可见', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      await expect.poll(() => text(launched.page, '.cy-ms-tab.active'), POLL).toBe('LLM')
      const card = launched.page.locator(cardSel('deepseek/deepseek-v4-flash'))
      await expect.poll(() => card.count(), POLL).toBe(1)
      await expect.poll(() => textInCard(launched.page, 'deepseek/deepseek-v4-flash', '.cy-profile-model'), POLL).toContain('deepseek/deepseek-v4-flash')
      await expect.poll(() => textInCard(launched.page, 'deepseek/deepseek-v4-flash', 'strong'), POLL).toContain('deepseek')
    } finally { await closeApp(launched) }
  })

  it('3. 执行位置徽标：backend 行「后端」；local_worker 行「不可用·待配置」且无调用按钮', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      const backendCard = launched.page.locator(cardSel('deepseek/deepseek-v4-flash'))
      await expect.poll(() => backendCard.count(), POLL).toBe(1)
      await expect.poll(() => textInCard(launched.page, 'deepseek/deepseek-v4-flash', '.cy-ms-badge.backend'), POLL).toBe('后端')
      // desktop/local 行（mock 增量 ollama）：灰标「不可用·待配置」+ 无任何调用按钮（决策 D4）
      const localCard = launched.page.locator(cardSel('ollama/llama3.2'))
      await expect.poll(() => localCard.count(), POLL).toBe(1)
      await expect.poll(() => textInCard(launched.page, 'ollama/llama3.2', '.cy-ms-badge.unavailable'), POLL).toBe('不可用·待配置')
      await expect.poll(() => textInCard(launched.page, 'ollama/llama3.2', '.cy-profile-actions'), POLL).toContain('该执行位置由本机承载，当前版本不提供调用')
      expect(await localCard.locator('button').count()).toBe(0)
      // backend 行有类型化测试入口（对照：测试连接存在）
      await expect.poll(() => countInCard(launched.page, 'deepseek/deepseek-v4-flash', 'button'), POLL).toBeGreaterThanOrEqual(3)
      await expect.poll(() => btnInCard(launched.page, 'deepseek/deepseek-v4-flash', '测试连接'), POLL).toBe(true)
    } finally { await closeApp(launched) }
  })

  it('4. 测试连接 → 结果区出现「连接正常」+ 延迟', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      const card = launched.page.locator(cardSel('deepseek/deepseek-v4-flash'))
      await card.getByRole('button', { name: '测试连接', exact: true }).click()
      await expect.poll(() => textInCard(launched.page, 'deepseek/deepseek-v4-flash', '.cy-ms-result.ok'), POLL).toContain('连接正常')
      await expect.poll(() => textInCard(launched.page, 'deepseek/deepseek-v4-flash', '.cy-ms-result.ok'), POLL).toContain('ms')
    } finally { await closeApp(launched) }
  })

  it('5. 设为当前 → 「当前」chip + 按钮变「当前使用中」', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      const card = launched.page.locator(cardSel('deepseek/deepseek-v4-flash'))
      await card.getByRole('button', { name: '设为当前', exact: true }).click()
      await expect.poll(() => countInCard(launched.page, 'deepseek/deepseek-v4-flash', '.cy-profile-current'), POLL).toBe(1)
      await expect.poll(() => btnInCard(launched.page, 'deepseek/deepseek-v4-flash', '当前使用中'), POLL).toBe(true)
    } finally { await closeApp(launched) }
  })

  it('6. TTS tab → 声音列表可见 → 试听 → <audio> 出现（preview audioUrl）', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      await launched.page.getByRole('tab', { name: 'TTS', exact: true }).click()
      await expect.poll(() => launched.page.evaluate(() => document.querySelectorAll('.cy-tts-item').length), POLL).toBeGreaterThan(0)
      await launched.page.locator('.cy-tts-item').first().getByRole('button', { name: '试听', exact: true }).click()
      await expect.poll(() => launched.page.locator('audio.cy-tts-audio').count(), POLL).toBe(1)
      await expect.poll(() => launched.page.evaluate(() => document.querySelector<HTMLAudioElement>('audio.cy-tts-audio')?.getAttribute('src') ?? ''), POLL).toMatch(/^cyrene:\/\/renderer\/__cyrene-media\/tts-preview\//)
    } finally { await closeApp(launched) }
  })

  it('7. 自定义向导：填名称/Endpoint/apiKey → 测试并保存 → custom 卡片出现；重开编辑 apiKey 不回显', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      await createCustom(launched.page, 'wiz-custom')
      await expect.poll(() => textInCard(launched.page, 'custom/wiz-custom', '.cy-profile-endpoint'), POLL).toBe('api.example.com') // 脱敏 host
      await expect.poll(() => textInCard(launched.page, 'custom/wiz-custom', '.cy-ms-cred'), POLL).toContain('凭据已配置')               // apiKey 已生效
      // 重开编辑：apiKey 输入为空（一次性，不回显已存密钥）
      await launched.page.locator(cardSel('custom/wiz-custom')).getByRole('button', { name: '编辑', exact: true }).click()
      await expect.poll(() => launched.page.locator('.cy-wizard').count(), POLL).toBe(1)
      await expect.poll(() => launched.page.evaluate(() => document.querySelector<HTMLInputElement>('.cy-wizard input[type="password"]')?.value ?? null), POLL).toBe('')
      await expect.poll(() => text(launched.page, '.cy-wizard'), POLL).toContain('凭据已配置（编辑不回显密钥，留空则保持原密钥）')
    } finally { await closeApp(launched) }
  })

  it('8. 删除激活中 custom → 两步确认 → 可见 PROFILE_IN_USE 错误', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      await createCustom(launched.page, 'del-custom')
      const card = launched.page.locator(cardSel('custom/del-custom'))
      // 先设为当前，使 mock activeSelection 指向它
      await card.getByRole('button', { name: '设为当前', exact: true }).click()
      await expect.poll(() => countInCard(launched.page, 'custom/del-custom', '.cy-profile-current'), POLL).toBe(1)
      // 删除两步：删除 → 确认删除
      await card.getByRole('button', { name: '删除', exact: true }).click()
      await expect.poll(() => btnInCard(launched.page, 'custom/del-custom', '确认删除'), POLL).toBe(true)
      await card.getByRole('button', { name: '确认删除', exact: true }).click()
      // 可见错误（mock PROFILE_IN_USE → message「正在使用，无法删除」），卡片保留
      await expect.poll(() => text(launched.page, '.cy-ms-error'), POLL).toContain('正在使用，无法删除')
      await expect.poll(() => card.count(), POLL).toBe(1)
    } finally { await closeApp(launched) }
  })

  it('9. 保存并设为当前 → 保存成功且卡片激活', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      await launched.page.getByRole('button', { name: '添加自定义模型', exact: true }).click()
      await expect.poll(() => launched.page.locator('.cy-wizard').count(), POLL).toBe(1)
      await launched.page.getByPlaceholder('例如 my-llm', { exact: true }).fill('act-custom')
      await launched.page.getByPlaceholder('https://', { exact: true }).fill('https://api.example.com')
      await launched.page.locator('.cy-wizard input[type="password"]').fill('sk-secret-1')
      await launched.page.getByRole('button', { name: '保存并设为当前', exact: true }).click()
      await expect.poll(() => launched.page.locator(cardSel('custom/act-custom')).count(), POLL).toBe(1)
      await expect.poll(() => countInCard(launched.page, 'custom/act-custom', '.cy-profile-current'), POLL).toBe(1)
      await expect.poll(() => btnInCard(launched.page, 'custom/act-custom', '当前使用中'), POLL).toBe(true)
      await expect.poll(() => launched.page.locator('.cy-wizard').count(), POLL).toBe(0)
    } finally { await closeApp(launched) }
  })

  it('10. 关闭设置（Esc）→ 回 chat 视图且焦点回到「设置」按钮', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      await launched.page.keyboard.press('Escape')
      await expect.poll(() => launched.page.locator('.cy-settings').count(), POLL).toBe(0)
      const activeTitle = await launched.page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('title') ?? '')
      expect(activeTitle).toBe('设置')
    } finally { await closeApp(launched) }
  })

  it('11. 内容区内部滚动：.cy-settings-body overflow-y:auto 且有可滚内容', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      await openSettings(launched.page)
      await expect.poll(() => launched.page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('.cy-settings-body')!).overflowY), POLL).toBe('auto')
      // 追加 custom 卡片保证内容量超过可视区（面板定高 + 内部滚动，决策同 FE-S3-RUN2-P1-01）
      await createCustom(launched.page, 'scroll-custom')
      const sizes = await launched.page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.cy-settings-body')!
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
      })
      expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight)
    } finally { await closeApp(launched) }
  })
})
