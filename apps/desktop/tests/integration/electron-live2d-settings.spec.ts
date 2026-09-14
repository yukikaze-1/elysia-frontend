// tests/integration/electron-live2d-settings.spec.ts
// 阶段 5 批次 B/C + 阶段 7 批次 D：Live2D **设置中心 / 性能模式 / 诊断页** 集成
//   （C1 TTS 音量口型 / B4 设置子页 / B5 性能模式读回归一 / B6 布局 / C2.1 四值切换 / C2.2 GPU 重建 /
//     收口回归「恢复默认」/ 7D 诊断页读数与禁用-启用）。
//
// 2026-09-15 拆分（A-1）：从 electron-live2d.spec.ts（28 用例 / 62.9KB，CI 上独占一个 job = 墙钟地板）按
//   **实测逐用例耗时**切出。本文件 9 用例实测 43.7s（C1 11.9 + B4 5.5 + B5 3.5 + B6 4.4 + C2.1 3.2 + C2.2 2.5
//   + 收口 7.1 + 7D 2.4 + 禁用启用 3.2）。三文件对照：core 12 例 35.1s / motion 7 例 47.3s / settings 9 例 43.7s。
//   **断言强度逐字未动**：用例体原样搬运（含全部注释），装配与观测原语来自 helpers/live2d-fixture.ts（只此一份）。
//   C1（口型链路，单例 11.9s 是原文件最重的单例）放在这里的依据是**实测耗时均衡**：它全程经设置中心的
//   TTS Profile 页驱动（openSettings → TTS tab → 设为当前 → closeSettings），归入设置中心一族并不牵强；
//   若把它留在 motion 文件，motion 会到 59.2s 而 core 只有 30.1s，三文件墙钟失衡。
//   本文件收原 `（B7：状态驱动/动作/设置/性能/布局/竞态）` describe 中的设置/性能/布局 3 例，故该 describe 标题
//   按本文件实际收容的用例改写为 `（B7：设置子页/性能模式/布局）`；C1/C2/收口/7D 的 describe 原样保留。
//   **it 名逐字未动**。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'node:path'
import { closeApp } from './helpers/app'
import {
  POLL, WANKO_ID, installLive2dMaster, teardownLive2dMaster, freshUserData, launchL2d,
  statusText, selectValue, waitLive2dSettled, waitLive2dTerminal, connectAndActivateFirst,
  countNonTransparentPx, openSettings, closeSettings, openCharacterPane, readSettingsL2d, presetSettings, sendChat
} from './helpers/live2d-fixture'

// —— 装配（本文件的用例按 id 断言模型装载结果，不读 haru/lil/wanko 标志）——
beforeAll(async () => {
  await installLive2dMaster()
}, 120_000)

afterAll(() => { teardownLive2dMaster() })

describe('阶段5批次C Live2D Electron 集成（C1：TTS 音量口型）', () => {
  it('C1.口型链路：CYRENE_MOCK_MOUTH_LEVEL=step → 激活 TTS → 发送 → 口型电平随合成包络变化 → 停止归 0', async () => {
    const ud = freshUserData()
    // CI 稳健化（2026-08-19）：CYRENE_MOCK_MOUTH_WINDOW_MS=5000 把 mock 采样窗口从 1.5s 放宽到 5s——
    // 慢 CI（SwiftShader 渲染饱和）上 1.5s 窗口可能被口部采样错过；setInterval 采集器独立于 rAF，
    // 不受渲染饱和/页面 rAF 节流影响（rAF 采集器曾只采到 13 帧即停）。
    const launched = await launchL2d(ud, { CYRENE_MOCK_MOUTH_LEVEL: 'step', CYRENE_MOCK_EMIT_DELAY_MS: '400', CYRENE_MOCK_MOUTH_WINDOW_MS: '5000' })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 探针必须暴露（dev/test 构建经 window.__cyreneTest.getMouthLevel 读 store.mouthLevel）
      const probe = await page.evaluate(() =>
        typeof (window as unknown as { __cyreneTest?: { getMouthLevel?: () => number } }).__cyreneTest?.getMouthLevel)
      expect(probe).toBe('function')
      await connectAndActivateFirst(page)
      // 激活 TTS Profile（mock ttsActive = !!activeSelection.ttsProfileId → generation.completed 才发 audio.session.ready）
      await openSettings(page)
      await page.getByRole('tab', { name: 'TTS', exact: true }).click()
      const edgeCard = page.locator('.cy-profile-card[data-profile-id="edge/edge-tts"]')
      await expect.poll(() => edgeCard.count(), POLL).toBe(1)
      await edgeCard.getByRole('button', { name: '设为当前', exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('.cy-profile-card[data-profile-id="edge/edge-tts"] .cy-profile-current').length), POLL).toBe(1)
      await closeSettings(page)
      // 发送 → generation.completed → audio.session.ready → tts.playing=true → attach → tick 采样 step 序列
      await sendChat(page, 'mouth')
      // 断言：口部曾随合成包络非零（moved）且窗口结束归零（settled）——轮询**持久标志**而非瞬态采样。
      // 根因（2026-08-19 CI 第 4 轮）：SwiftShader 渲染饱和 renderer 主线程，page.evaluate 慢到 ~3.75s/次
      // （15s 只取到 4 个读值），瞬态窗口采样全漏；持久标志由 tick 写入（tick 即饱和源、恒运行），
      // 外部慢轮询几次即读到。附带断言 kind=step（mockMouthLevel 水合生效）——排除真实 Analyser 读静音。
      try {
        await expect.poll(async () => {
          const m = await page.evaluate(() =>
            (window as unknown as {
              __cyreneTest?: { getMouthInfo: () => { kind: 'step' | 'sine' | 'real' | null; moved: boolean; settled: boolean } }
            }).__cyreneTest?.getMouthInfo?.() ?? null)
          return m !== null && m.kind === 'step' && m.moved && m.settled
        }, { ...POLL, timeout: 15000 }).toBe(true)
      } catch (e) {
        // DEBUG：超时转储 voiceStore.tts 态 + 口部源/标志 + 当前电平 + 页面可见性（定位链路断点）
        const dump = await page.evaluate(() => {
          const el = document.querySelector<HTMLAudioElement>('audio.cy-tts-player')
          const t = (window as unknown as {
            __cyreneTest?: {
              getTtsState?: () => {
                url: string | null
                playing: boolean
                playingStreamId: number | null
                readySeen: boolean
                autoReadReply: boolean
                ttsAudioElPresent: boolean
              }
              getMouthInfo?: () => { kind: 'step' | 'sine' | 'real' | null; moved: boolean; settled: boolean }
              getMouthLevel?: () => number
            }
          }).__cyreneTest
          return {
            audio: { src: el?.getAttribute('src') ?? null, paused: el?.paused ?? null },
            voice: t?.getTtsState?.() ?? null,
            mouth: t?.getMouthInfo?.() ?? null,
            mouthLevel: t?.getMouthLevel?.() ?? null,
            visibility: document.visibilityState
          }
        })
        console.log('C1 DEBUG state:', JSON.stringify(dump))
        throw e
      }
    } finally { await closeApp(launched) }
  })
})

describe('阶段5批次B Live2D Electron 集成（B7：设置子页/性能模式/布局）', () => {
  it('B4.设置子页：改 scale/performanceMode → 即时生效 + 重启后持久化恢复', async () => {
    const ud = freshUserData()
    // 第一次 launch：设置页调 scale=1.5、performanceMode=balanced（设置即时改 + 500ms 防抖持久化）
    const launched1 = await launchL2d(ud)
    try {
      const { page } = launched1
      await waitLive2dSettled(page)
      await openCharacterPane(page)
      // scale 滑块（表现组首个 range = 大小）→ 设置即时更新（Pane 字段值即刻变化）。
      // 2026-09-13：**按 testid 取控件**，不再用 `.first()`/`.cy-l2d-field-value` 首个命中——「外观与 Live2D」
      // 子页新增了字体大小滑杆（页首），位置假设当场失效：CI run 34737645766 的 B4 红于
      // `expected '90%' to contain '1.50'`（读到的其实是字体缩放读数）。
      // B4 滑块以 evaluate 合成事件（直接置 value + dispatch input/change）驱动——headless SwiftShader 下
      // Playwright 的 range 真实拖拽（dragTo/键盘箭头）依赖可见指针命中测试且帧时序不可控，合成事件与真实
      // 滑块在 Vue 的 @input 绑定上等价（同一 setLive2d patch 路径），足够断言「即时预览 + 持久化」链路。
      // V-05 补注：① 组件（CyLive2DPane.vue）故意用 `:value` + `@input` 而非 v-model——因此裸 evaluate 置 value 后
      // 必须显式 dispatch 'input' 才会走 onSlider → setLive2d 即时预览；② 'input' 与 'change' 是两个不同监听器：
      // 'input' 满足 @input（即时预览，onSlider），'change' 满足即时预览之外的持久化/失焦路径——两者都 dispatch 才能
      // 覆盖「即时生效」与「落盘持久化」两条链（单发 'input' 或单发 'change' 都会漏另一条链）。
      await page.locator('[data-testid="live2d-scale-range"]').evaluate((el) => {
        const input = el as HTMLInputElement
        input.value = '1.5'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await expect.poll(() => page.locator('[data-testid="live2d-scale-value"]').textContent(), POLL).toContain('1.50')
      // 帧率模式下拉 → 设置即时更新
      await page.locator('.cy-l2d-pane select').selectOption('balanced')
      await expect.poll(() => page.locator('.cy-l2d-pane select').inputValue(), POLL).toBe('balanced')
      // 关闭设置 → chat 视图重挂载（Panel 重 init 读最新 settings 应用视图变换）。
      // UII-Live2D 修缮：画布顶部滑块组（.cy-live-view-controls）已移除、视图操作改为画布拖动/滚轮直接操作，
      // 面板侧不再有 scale DOM 读数——「即时生效」以设置页字段值（上方 1.50 断言）+ 视图变换转发单测为准。
      await page.getByRole('button', { name: '关闭设置' }).click()
      await waitLive2dSettled(page)
      // 500ms 防抖 + settingsSave → settings.json 落盘
      await expect.poll(() => readSettingsL2d(ud), POLL).toMatchObject({ scale: 1.5, performanceMode: 'balanced' })
    } finally { await closeApp(launched1, { keepUserData: true }) }
    const persisted = readSettingsL2d(ud)
    expect(persisted?.scale).toBe(1.5)
    expect(persisted?.performanceMode).toBe('balanced')
    // 第二次 launch（复用同一 userData）：设置恢复
    const launched2 = await launchL2d(ud)
    try {
      const { page } = launched2
      await waitLive2dSettled(page)
      await openCharacterPane(page)
      await expect.poll(() => page.locator('[data-testid="live2d-scale-value"]').textContent(), POLL).toContain('1.50')
      await expect.poll(() => page.locator('.cy-l2d-pane select').inputValue(), POLL).toBe('balanced')
    } finally { await closeApp(launched2) }
  })

  it('B5.性能模式：四值下拉存在、选中持久化、旧值 high 读回归一（不 corrupt）', async () => {
    const ud = freshUserData()
    presetSettings(ud, { performanceMode: 'high' }) // 批次 A 旧三值 → 读回归一 quality
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 不 corrupt：无 .corrupt 备份 + 原文件仍存在
      expect(existsSync(join(ud, 'Cyrene', 'config', 'settings.json.corrupt'))).toBe(false)
      await openCharacterPane(page)
      const pmSelect = page.locator('.cy-l2d-pane select')
      // 四值下拉：auto/quality/balanced/low_power
      const options: string[] = await pmSelect.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))
      expect(options.sort()).toEqual(['auto', 'balanced', 'low_power', 'quality'])
      // 旧值 'high' 已归一为 'quality'（内存态，setting pane 绑定 settings.live2d.performanceMode）
      await expect.poll(() => pmSelect.inputValue(), POLL).toBe('quality')
      // 选中持久化
      await pmSelect.selectOption('low_power')
      await page.getByRole('button', { name: '关闭设置' }).click()
      await expect.poll(() => readSettingsL2d(ud), POLL).toMatchObject({ performanceMode: 'low_power' })
    } finally { await closeApp(launched) }
  })

  it('B6.布局：无 Layout 模型画幅均正常（默认 + switch 到 wanko 后 canvas 均非空）', async () => {
    // 本仓装配模型（haru/wanko/lil）均无 model3 Layout → 走 scale-only 拟合（批次 A 路径）；
    // 有 Layout fixture 的 setupFromLayout 拟合由单测（live2d-adapter.spec 夹具）覆盖。
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption(WANKO_ID)
      await expect.poll(() => statusText(page), POLL).toContain('Wanko')
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })
})

describe('阶段5批次C Live2D Electron 集成（C2：性能降级 + GPU 重建 + 可见性）', () => {
  it('C2.1.性能模式四值切换：low_power 降帧切换后渲染不崩 + 设置持久化', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await openCharacterPane(page)
      const pmSelect = page.locator('.cy-l2d-pane select')
      // 四值依次切换 → 渲染不崩（FrameBudget setMode 热切换；集成仅断言无回归，时序语义由 perf.spec 覆盖）
      for (const mode of ['quality', 'balanced', 'low_power', 'auto']) {
        await pmSelect.selectOption(mode)
        await expect.poll(() => pmSelect.inputValue(), POLL).toBe(mode)
      }
      // 落 low_power → 关闭设置 → 渲染仍正常（就绪 + 画布非空；或静态回退不崩）
      await pmSelect.selectOption('low_power')
      await page.getByRole('button', { name: '关闭设置' }).click()
      await waitLive2dSettled(page)
      const s = await statusText(page)
      if (s.includes('就绪')) {
        await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      }
      // 500ms 防抖 + settingsSave → settings.json 落盘 performanceMode=low_power
      await expect.poll(() => readSettingsL2d(ud), POLL).toMatchObject({ performanceMode: 'low_power' })
    } finally { await closeApp(launched) }
  })

  it('C2.2.GPU 丢失重建一次：webglcontextlost → 重建（回到就绪+渲染恢复，或回退不崩）+ 聊天可用', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 触发 webglcontextlost → adapter gpuLost → 渲染 tick 抛 Live2DGpuLostError → device_lost → store 重建
      await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.cy-live-canvas')
        const gl = canvas?.getContext('webgl') ?? canvas?.getContext('webgl2')
        const ext = gl?.getExtension('WEBGL_lose_context')
        ext?.loseContext()
      })
      // 重建一次：等真正落终态（就绪=重建成功 / 回退=重建失败，SwiftShader 下均合法）；「一次」由单测 guard 覆盖，
      // 集成以「不崩 + 状态机合法」为准（brief Step 7）。终态文案在此确定读取，供下面的像素分支使用。
      const s = await waitLive2dTerminal(page) ?? (await statusText(page))
      if (s.includes('就绪')) {
        // 重建成功 → 渲染恢复（非透明像素重新出现）
        await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 8000 }).toBeGreaterThan(0)
      }
      await connectAndActivateFirst(page) // 重建不阻塞聊天
    } finally { await closeApp(launched) }
  })
})

describe('阶段5批次C Live2D Electron 集成（收口回归：恢复默认 → 画布与持久化一致）', () => {
  it('恢复默认设置：已加载非首个模型 → 切回首个可用（画布/select/持久化三方一致）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      // 切到非首个模型 wanko（haru = 首个可用）→ 已加载 ≠ 首个可用，持久化 wanko
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption(WANKO_ID)
      await expect.poll(() => statusText(page), POLL).toContain('Wanko')
      await expect.poll(() => readSettingsL2d(ud)?.modelId ?? null, POLL).toBe(WANKO_ID)
      // 打开设置子页 → 恢复默认设置（7D 起面板常驻挂载且 ready → store.restoreDefaults 走 controller 存活
      // 分支：settings 打开时即 switchModel 首个可用；关闭设置后画布/select/持久化一致）
      await openCharacterPane(page)
      await page.getByRole('button', { name: '恢复默认设置' }).click()
      await page.getByRole('button', { name: '关闭设置' }).click()
      // 切回首个可用 Haru：画布状态含 Haru（switchModel 完成）
      await expect.poll(() => statusText(page), POLL).toContain('Haru')
      // select 值与持久化 modelId 三方一致（500ms 防抖 + settingsSave 落盘）
      await expect.poll(() => selectValue(page), POLL).toBe('haru')
      await expect.poll(() => readSettingsL2d(ud)?.modelId ?? null, POLL).toBe('haru')
      // 画布非空（切回首个可用渲染正常）
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })
})

describe('阶段7批次D Live2D Electron 集成（7D：Live2D 数值读数接入诊断页）', () => {
  it('诊断页 Live2D 性能：Live2D 面板常驻挂载，设置打开仍显示真实帧耗时/帧率读数', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page) // chat 视图 Live2D 就绪（settings 未打开）
      // 打开设置 → 开发与诊断 → 开开发者模式（confirm 处理）
      page.on('dialog', (d) => d.accept())
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
      // 7D：面板不随 chat 卸载——设置打开后仍 ready，但 v-show 隐藏（rAF 由 currentView gate 停止）
      await expect.poll(() => page.locator('.cy-live').count(), POLL).toBe(1)
      await expect(page.locator('.cy-live').isVisible()).resolves.toBe(false)
      await expect.poll(() => statusText(page), POLL).toContain('就绪')
      await page.locator('.cy-settings-nav-item', { hasText: '开发与诊断' }).click()
      await expect.poll(() => page.locator('.cy-l2d-pane').count(), POLL).toBe(1)
      await page.locator('button[data-testid="diag-dev-toggle"]').click()
      // settings 打开但 store 保持 ready → getStats 非 null → 显示真实帧读数（模式/帧耗时 EMA）
      await expect.poll(() => page.getByTestId('diag-dev-perf').textContent(), POLL).toMatch(/帧耗时（EMA）：\d+(\.\d+)? ms/)
      expect(await page.getByTestId('diag-dev-perf').textContent()).toContain('模式：')
    } finally { await closeApp(launched) }
  })

  it('禁用/启用 Live2D：常驻面板立即 dispose/重载，诊断页读数随 status 切换（未启动 ↔ 帧读数）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud)
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await openCharacterPane(page)
      // 关闭启用开关 → 面板常驻但立即 dispose（7D 补上的原「settings 卸载即释放」语义）
      await page.locator('.cy-l2d-pane input[type="checkbox"]').first().uncheck()
      await expect.poll(() => statusText(page), POLL).toContain('已关闭')
      // 诊断页此刻应显示未启动（store.status=unloaded → getStats null）
      await page.locator('.cy-settings-nav-item', { hasText: '开发与诊断' }).click()
      await expect.poll(() => page.locator('.cy-l2d-pane').count(), POLL).toBe(1)
      page.on('dialog', (d) => d.accept())
      await page.locator('button[data-testid="diag-dev-toggle"]').click()
      await expect.poll(() => page.getByTestId('diag-dev-perf').textContent(), POLL).toMatch(/未启动|无读数/)
      // 重新启用 → 面板隐藏态也能 init → ready（关闭设置后 rAF 恢复、画布非空）
      await page.locator('.cy-settings-nav-item', { hasText: '外观与 Live2D' }).click()
      await page.locator('.cy-l2d-pane input[type="checkbox"]').first().check()
      await expect.poll(() => statusText(page), POLL).toContain('就绪')
      await closeSettings(page)
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })
})
