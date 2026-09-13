// tests/integration/settings-save-failure.spec.ts
//
// M-19（2026-09-13）：**设置保存失败必须到达用户**，而且失败的改动不能丢。
//
// 修前的两处事实（评审 M-19，本轮先复核实测再动手）：
//   ① `settings.store.persist()` 的 `pending = {}` 在 `await` **之前**执行 ⇒ 保存失败即丢弃该 patch：
//      用户看到开关生效、重启后被静默还原；
//   ② `saveError` / `saved` 全仓**没有任何组件渲染**（grep 只命中 store 自身），而 Live2D 子页写着
//      "500ms 自动保存"——即失败以"什么都没有"的形式到达用户。
//
// 本用例走**真实产品路径**构造"必然写不进去"（与 H-11b 的 persistence-degraded 同款手法，链接形态
// 探测见 helpers/links.ts）：把 `config/settings.json` 预置成指向 **userData 之外**的链接 →
// `openSafeFile` 拒符号链接（posix O_NOFOLLOW / windows pre-open lstat）→ 隔离分支 →
// `isolate()` 的 `assertContained` 因 realpath 越根而上抛 → **设置域降级**（保现场 + 拒绝写入）。
//
// 这条链同时是**启动路径的回归用例**：`main/index.ts` 里 `await settingsSvc.load()` 是 eager 的，
// 修前隔离失败会让该 await 上抛、打断整条装配（注释却写着"不阻塞启动"）。故本用例开头就要求
// 应用照常可用——真被打断时后面每一步都走不到。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { launchApp, closeApp } from './helpers/app'
import { detectLinkMode } from './helpers/links'

const POLL = { timeout: 15000, interval: 200 }
const SETTINGS_REL = 'config/settings.json'
const linkMode = detectLinkMode()

describe.skipIf(linkMode === 'none')(`设置保存失败对用户可见（M-19；构造形态=${linkMode}）`, () => {
  it('配置文件无法隔离 → 应用照常启动（不再打断装配）+ 改设置后出现保存失败提示', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cy-settings-save-fail-'))
    const targetFile = join(outside, 'settings.json')
    const sentinel = join(outside, 'sentinel.txt')
    const sentinelText = 'outside-dir-sentinel'
    writeFileSync(sentinel, sentinelText, { mode: 0o600 })
    const original = JSON.stringify({ version: 2, voice: {} })
    // dir-junction 形态：链接指向**目录**，于是"外部目录里有什么"就是可断言的全部事实
    if (linkMode === 'file-symlink') writeFileSync(targetFile, original, { mode: 0o600 })
    const launched = await launchApp([{ relPath: SETTINGS_REL, symlinkTo: linkMode === 'file-symlink' ? targetFile : outside }])
    try {
      const { page } = launched

      // ① 启动没被打断：设置中心可用、语音子页正常渲染（若 load() 上抛，IPC 根本没注册）
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect.poll(() => page.locator('.cy-settings-overlay').count(), POLL).toBe(1)
      await page.locator('.cy-settings-nav-item').filter({ hasText: '语音' }).first().click()
      await expect.poll(() => page.locator('.cy-voice-pane').count(), POLL).toBe(1)

      // ② **降级在启动时就可见**（⑤b，2026-09-13 同日补的那半边）：`settings:load` 在降级态拒绝读取
      //    → Renderer 的 hydrate 把失败记进 saveError → 设置页横幅在用户**还没改任何设置**时就显示。
      //    修前的口径是"要等到一次保存被拒才看得见"，本条正是那半边差异的端到端证据。
      //    （本断言最初写的是 `toBe(0)`，被 CI shard 1/3 当场红在 `expected 1 to be +0`——那是我自己
      //     在同一个批次里把行为改好了、却没同步这条用例；红是对的，用例已按新口径改写。）
      const alert = page.locator('[data-testid="settings-save-error"]')
      await expect.poll(() => alert.count(), POLL).toBe(1)

      // ③ 真实拨动一个开关（TTS 自动朗读）→ 500ms 防抖后写盘必失败 → 状态保持可见且文案正确
      await page.getByLabel('TTS 自动朗读 AI 回复').click()
      await expect.poll(() => page.getByLabel('TTS 自动朗读 AI 回复').isChecked(), POLL).toBe(false) // 本地即时生效
      await expect.poll(() => alert.count(), POLL).toBe(1)
      const alertText = (await alert.textContent()) ?? ''
      // 降级态复用 PERSISTENCE_DEGRADED 文案（见 errors/index.ts 的说明）
      expect(alertText).toContain('本地保存已停用')
      expect(alertText, '必须告诉用户改动还在待写队列，否则他会以为白改了').toContain('改动仍保留在待写队列')
      expect(alertText, '提示不得回显任何本地绝对路径').not.toContain(outside)
      expect(alertText).not.toMatch(/[A-Za-z]:\\|\/(tmp|home)\//)

      // ④ 现场保住：外部目标在写失败后逐字节未变
      if (linkMode === 'file-symlink') {
        expect(readFileSync(targetFile, 'utf8')).toBe(original)
      } else {
        expect(readdirSync(outside).sort(), '外部目录不得出现任何新文件').toEqual(['sentinel.txt'])
        expect(readFileSync(sentinel, 'utf8')).toBe(sentinelText)
      }

      // ⑤ 失败后应用仍可用（不是"弹个错就废了"）：切回聊天视图无异常
      await page.getByRole('button', { name: '关闭设置' }).click()
      await expect.poll(() => page.locator('.cy-chat').count(), POLL).toBe(1)
    } finally {
      await closeApp(launched)
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
