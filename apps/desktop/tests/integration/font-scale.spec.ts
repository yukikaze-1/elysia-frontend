// tests/integration/font-scale.spec.ts —— 规格漂移台账 ②-3：doc 03 §12.4 / doc 11 §7.2「全局字体缩放 + 即时预览」
//
// 为什么必须落在集成层：本项的实质是"整条字号阶梯乘同一个变量"。单测只能断言 CSS 文本与纯函数，
// 而"用户看到的字真的变大了吗"只有真实 Chromium 的 computed style 能回答——本项落地前的事实正是
// 反例：`--cy-user-font-scale` 早已定义、也早已被 body 消费，但组件的绝对 px 字号覆盖了继承，
// 给变量赋值**视觉上几乎无效**（unit 层对这一点完全无感）。
//
// 判别面（全是用户可见性质）：
//   ① 默认：根变量 = 1、聊天正文（markdown）computed font-size = 14px
//   ② 即时预览：在设置页拖动滑杆后**不重载**即生效（根变量 1.3）
//   ③ 全阶梯跟随：正文 14→18.2px **且**标题 15→19.5px 同比例（只变 body 是"阶梯没乘"的退化形态）
//   ④ doc 03 §14 的可访问性红线「文字缩放后不得遮挡允许/拒绝按钮」：130% 下授权弹窗两个按钮
//      仍在视口内、有尺寸、且命中测试拿到的是按钮自己（未被任何元素盖住）
//   ⑤ 持久化 + 启动期应用：settings.json 落盘 130；**另起一个应用实例并预置该文件**时启动即 130%
//      （水合路径，而不是只测"当场拖动"这条路径）
//   ⑥ 「恢复默认设置」→ 回到 100%
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

const POLL = { timeout: 15000, interval: 200 }

// 授权弹窗需要一次**真实存在**的路径：决策链在授权前做 full realpath（不存在的路径直接失败、
// 根本不会弹权限窗——首版就是这么红的）。故照 electron-tools 先例建 fixture 根并放宽黑名单。
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'cy-font-'))
const FIXTURE = join(FIXTURE_ROOT, 'note.txt')
writeFileSync(FIXTURE, 'font scale probe\n')
const FLOW_READ = JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: FIXTURE } } })
afterEach(() => { rmSync(FIXTURE_ROOT, { recursive: true, force: true }) })

async function connectAndActivateFirst(page: Page): Promise<void> {
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true), POLL).toBe(false)
}

/** 打开设置中心 → 「外观与 Live2D」子页（对齐 electron-live2d.spec 的 openCharacterPane 先例） */
async function openAppearancePane(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
  await page.getByRole('button', { name: /外观与 Live2D/ }).click()
  await expect.poll(() => page.locator('.cy-l2d-pane').count(), POLL).toBe(1)
}

/** 根节点上的缩放乘数（未设置时为空串——那才是"变量没落地"的形态） */
const rootScale = (page: Page): Promise<string> =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--cy-user-font-scale'))

/** 指定选择器的 computed font-size（px 数值；元素不存在 → NaN） */
function computedFontPx(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el ? Number.parseFloat(getComputedStyle(el).fontSize) : Number.NaN
  }, selector)
}

/** 读 settings.json 的 appearance 子树（未落盘/文件缺失 → null，供 expect.poll 等待防抖写盘） */
function readSettingsFontScale(userData: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(userData, 'Cyrene', 'config', 'settings.json'), 'utf8')) as { appearance?: { fontScale?: number } }
    return raw.appearance?.fontScale ?? null
  } catch {
    return null
  }
}

/** 预置一份 settings.json（**刻意不含 live2d/tools 段**：顺带覆盖"旧文件缺段"的兼容路径） */
function seedSettingsFile(userData: string, fontScale: number): void {
  const dir = join(userData, 'Cyrene', 'config')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    version: 1,
    voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false },
    dictation: { insertMode: 'append' },
    appearance: { fontScale }
  }), { mode: 0o600 })
}

describe('全局字体缩放（doc 03 §12.4 / doc 11 §7.2）', () => {
  it('① 默认不缩放；② 拖动滑杆即时预览；③ 全阶梯同比例；④ 130% 下授权按钮不被遮挡；⑤ 落盘；⑥ 恢复默认', async () => {
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
      CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT])   // fixture 在黑名单（/tmp、%TEMP%）内 → 放宽
    } })
    const { app, page, userData } = launched
    try {
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill('字体缩放判别用例')
      await page.getByLabel('消息输入框').press('Enter')
      await expect.poll(() => page.locator('.cy-markdown').count(), POLL).toBeGreaterThan(0)

      // ① 默认：根变量 = 1（main.ts 在 mount 前无条件落一次，故内联样式里就是 '1'）、正文 12px
      //    （首个 .cy-markdown 是「内心独白」，由 .cy-inner-voice-text 的更高特异性规则定为 --cy-font-md=12px）
      expect(await rootScale(page)).toBe('1')
      expect(await computedFontPx(page, '.cy-markdown')).toBeCloseTo(12, 1)

      // ② 通过真实控件改到 130%（即时预览：不重载、不重启）
      await openAppearancePane(page)
      const range = page.locator('[data-testid="font-scale-range"]')
      await range.fill('130')
      await expect.poll(() => rootScale(page), POLL).toBe('1.3')
      await expect.poll(() => page.locator('[data-testid="font-scale-value"]').textContent(), POLL).toBe('130%')

      // ③ 设置页自身同比例：标题 15→19.5px（--cy-font-xl）
      //    ⚠ 设置是整窗覆盖层、chat 视图会被卸载，故聊天区的字号只能在关闭设置后再量（见下）
      expect(await computedFontPx(page, '.cy-l2d-title')).toBeCloseTo(19.5, 1)

      // 关设置，回到聊天区（授权弹窗在聊天区卡片上打开）
      await page.getByRole('button', { name: '关闭设置', exact: true }).click()
      await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(0)
      // ③' 聊天正文 12→15.6px（--cy-font-md）——不同档位一起变，证明"整条阶梯乘同一个变量"
      expect(await computedFontPx(page, '.cy-markdown')).toBeCloseTo(15.6, 1)

      // ④ 可访问性红线（doc 03 §14）：130% 下授权弹窗的拒绝/允许按钮仍可用
      await page.getByTestId('tool-approve').click()
      await expect.poll(() => page.getByTestId('approval-deny').count(), POLL).toBe(1)
      const buttons = await page.evaluate(() => {
        const pick = (id: string) => {
          const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
          if (!el) return null
          const r = el.getBoundingClientRect()
          const cx = r.left + r.width / 2
          const cy = r.top + r.height / 2
          const hit = document.elementFromPoint(cx, cy)
          return {
            inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
            width: Math.round(r.width), height: Math.round(r.height),
            hitSelf: hit === el || el.contains(hit)
          }
        }
        return { deny: pick('approval-deny'), allow: pick('approval-allow') }
      })
      for (const [name, b] of Object.entries(buttons)) {
        expect(b, `${name} 按钮不存在`).not.toBeNull()
        expect(b!.width, `${name} 宽度为 0`).toBeGreaterThan(20)
        expect(b!.height, `${name} 高度为 0`).toBeGreaterThan(10)
        expect(b!.inViewport, `130% 字号下「${name}」按钮被挤出视口（doc 03 §14：文字缩放后不得遮挡允许/拒绝按钮）`).toBe(true)
        expect(b!.hitSelf, `130% 字号下「${name}」按钮中心被其它元素盖住`).toBe(true)
      }
      await page.getByTestId('approval-deny').click() // 安全默认：拒绝，结束流程
      await expect.poll(() => page.getByTestId('approval-deny').count(), POLL).toBe(0)

      // ⑤ 持久化：500ms 防抖后写入 settings.json
      await expect.poll(() => readSettingsFontScale(userData), POLL).toBe(130)

      // ⑥ 恢复默认设置 → 字号回 100%，根变量回到 1
      await openAppearancePane(page)
      await page.getByRole('button', { name: /恢复默认设置/ }).click()
      await expect.poll(() => rootScale(page), POLL).toBe('1')
      await expect.poll(() => page.locator('[data-testid="font-scale-value"]').textContent(), POLL).toBe('100%')
      await page.getByRole('button', { name: '关闭设置', exact: true }).click()
      await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(0)
      expect(await computedFontPx(page, '.cy-markdown')).toBeCloseTo(12, 1)
    } finally {
      try { await closeApp({ app, page, userData }) } catch { /* 尽力 */ }
    }
  }, 90_000)

  it('⑤ 启动期应用：预置 settings.json（无 live2d/tools 段）时启动即按 130% 渲染', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'cy-int-ud-'))
    seedSettingsFile(userData, 130)
    const launched = await launchApp(undefined, { userData })
    const { app, page } = launched
    try {
      // 水合是异步的（main.ts 先按默认落一次、hydrate 后 watch 纠正）⇒ 轮询到生效为止
      await expect.poll(() => rootScale(page), POLL).toBe('1.3')
      expect(await computedFontPx(page, 'body')).toBeCloseTo(18.2, 1)
      // 旧文件兼容：同一份文件里没有 live2d/tools 段，应用仍正常起（schema 补默认，不走 corrupt 全量重置）
      await openAppearancePane(page)
      await expect.poll(() => page.locator('[data-testid="font-scale-value"]').textContent(), POLL).toBe('130%')
    } finally {
      try { await closeApp({ app, page, userData }) } catch { /* 尽力 */ }
      try { rmSync(userData, { recursive: true, force: true }) } catch { /* 尽力 */ }
    }
  }, 90_000)
})
