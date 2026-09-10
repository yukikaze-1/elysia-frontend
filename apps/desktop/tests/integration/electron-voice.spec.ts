// tests/integration/electron-voice.spec.ts
// Task 15（阶段 4 批次 B）：真实 Electron 语音链路集成测试——装配/交互/持久化验收证据。
// 覆盖：录音闭环 / 未识别（CYRENE_MOCK_VOICE_TRANSCRIPT 空串 env 桥）/ 转写 / 实时 / TTS 播放态回落 /
//       设置持久化（重启复用 userData）/ 语音子页布局 / 会话切换守卫 / 断线清理 / consent（同意+重启+取消）/ deleteProfile 回退。
// 纪律（对齐 history-viewer-layout.spec.ts）：locator.click() 真点击，禁 force/DOM .click()/直调 store；
//   async store→DOM 迁移一律 expect.poll（POLL {timeout:5000, interval:200}）；每用例独立 launchApp/closeApp（临时 userData 隔离），
//   重启用例单独成块（closeApp keepUserData + launchApp opts.userData 复用）。
// 麦克风：launchApp extraArgs 注入 Chromium fake media 开关（--use-fake-device-for-media-stream 提供确定性音频输入，
//   --use-fake-ui-for-media-stream 跳过系统级权限 UI）；Main mic-permission 对受信 origin auto-grant audio，无 OS 弹窗。
// 断言状态而非声音（D-P13 mock 占位 URL 404 → <audio> onerror → 播放态回落）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { Page } from 'playwright'
import { closeApp, launchApp, type LaunchedApp } from './helpers/app'

const POLL = { timeout: 5000, interval: 200 } // 对齐套件先例（trust-boundary/history-viewer-layout）
/**
 * 「开启语音采集」类等待的放宽预算。
 *
 * `voiceStore.startRealtime/startRecord/startDictation` 在置 mode 之前要 **await 一整条真实系统资源链**：
 *   voiceStartRealtime IPC（WS 控制帧）→ getUserMedia(16k mono, EC/NS/AGC) → new AudioContext({sampleRate:16000})
 *   → worklet.addModule(workletUrl)
 * 其中 getUserMedia 与 AudioContext 都要真实麦克风/音频设备，冷启动 + 高负载 CI runner 上可能远超 5s。
 * 这段静默期没有任何 UI 反馈，用默认 POLL 会把「慢」误判为「失败」。
 *
 * 实测依据（2026-09-10）：CI run 34508996184 首跑用例 4 在此处超时（`.cy-realtime-bar` 计数恒 0），
 * 同 commit 重跑即绿，同代码的 98efd5d 全绿；本地连跑 6 轮全过、单轮约 310ms（本地无冷启动+资源竞争，
 * 无法复现）——故为环境时序偶发而非代码回归。
 * 放宽先例：electron-tools.spec.ts 的 SLOW_POLL（15000）、electron-live2d.spec.ts:471 的 {...POLL, timeout:15000}。
 */
const CAPTURE_POLL = { timeout: 15000, interval: 200 }
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

/** 预置 settings.json：consent 已接受（跳过 D-P16 弹窗——consent 专测用例不传）+ 默认语音设置 */
const CONSENT_SETTINGS = JSON.stringify({
  version: 1,
  voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: true },
  dictation: { insertMode: 'append' }
})
/** 断线清理（实时分支）专用：realtimeEnabled 预开，聚焦 disconnect 而非设置切换 */
const REALTIME_SETTINGS = JSON.stringify({
  version: 1,
  voice: { enabled: true, realtimeEnabled: true, autoReadReply: true, showCaptions: true, consentBackendStt: true },
  dictation: { insertMode: 'append' }
})

interface VoiceLaunchOpts {
  env?: Record<string, string>
  /** 预置 settings.json；false = 不预置（默认 DEFAULT_SETTINGS）；缺省 = consent 预置 */
  seed?: Array<{ relPath: string; content: string }> | false
  userData?: string
}

function launchVoice(opts: VoiceLaunchOpts = {}): Promise<LaunchedApp> {
  const seed = opts.seed === false ? undefined : (opts.seed ?? [{ relPath: 'config/settings.json', content: CONSENT_SETTINGS }])
  return launchApp(seed, { env: opts.env, userData: opts.userData, extraArgs: FAKE_MEDIA })
}

async function launchVoiceWithSize(w: number, h: number, opts: VoiceLaunchOpts = {}): Promise<LaunchedApp> {
  const launched = await launchVoice(opts)
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h)
  }, { w, h } as const)
  await launched.page.waitForFunction(([ww, hh]) => window.innerWidth === ww && window.innerHeight === hh, [w, h] as const)
  return launched
}

/** 1280×800：四区布局全展开（NAV60+会话260+角色340+聊天≥500），聊天区 620px 放得下连接面板，无 header 溢出 */
const VW = 1280
const VH = 800

function readSettingsFile(userData: string): { voice?: Record<string, unknown> } | undefined {
  try { return JSON.parse(readFileSync(join(userData, 'Cyrene', 'config', 'settings.json'), 'utf8')) as { voice?: Record<string, unknown> } }
  catch { return undefined }
}

// —— 常用流程 ——

/** 点连接 → 激活首个会话（conv-1001）→ 输入框就绪 */
async function connectAndActivateFirst(page: Page): Promise<void> {
  // UII-QQ：连接钮收进连接入口 popover——先点徽标（REAL/MOCK）展开，再点连接（能力不删，入口变更）
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-chat-heading h2')?.textContent ?? ''), POLL).toContain('流式回复演示')
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true), POLL).toBe(false)
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
}

async function openVoicePane(page: Page): Promise<void> {
  await page.locator('.cy-settings-nav-item', { hasText: '语音' }).click()
  await expect.poll(() => page.locator('.cy-voice-pane').count(), POLL).toBe(1)
}

/** 关闭设置：点 ✕ 关闭按钮（确定性；Escape 键经真实按键在重渲染瞬间偶有丢失——异步 activate 后紧随按键有竞态） */
async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(0)
}

/** 待发送条内按钮（作用域限定——「删除」与会话列表删除按钮同名，必须圈定 .cy-voice-pending） */
const pendingBtn = (page: Page, name: string) => page.locator('.cy-voice-pending').getByRole('button', { name, exact: true })

/** 开始录音：UII02rev 独立录音按钮 —— 直接点「普通录音」，录音态变「停止录音」（红点+计时）。 */
async function startRecord(page: Page): Promise<void> {
  await page.getByRole('button', { name: '普通录音', exact: true }).click()
  await expect.poll(() => page.getByRole('button', { name: '停止录音', exact: true }).count(), POLL).toBe(1)
}

/** 仅触发录音入口（不等录音态）——用于 consent 确认等「点击后会弹窗/异步」场景，断言由调用方做。 */
async function clickRecordEntry(page: Page): Promise<void> {
  await page.getByRole('button', { name: '普通录音', exact: true }).click()
}

/** 断言录音入口回到 idle（准备可录音）：普通录音按钮存在、无「停止录音」。 */
async function expectIdleRecordEntry(page: Page): Promise<void> {
  await expect.poll(() => page.getByRole('button', { name: '普通录音', exact: true }).count(), POLL).toBe(1)
  expect(await page.getByRole('button', { name: '停止录音', exact: true }).count()).toBe(0)
}

/** 覆写 renderer 的 navigator.mediaDevices.getUserMedia 为拒绝（NotAllowedError，与真实权限拒绝走同一 capture 失败路径）；
 *  原函数先存 window.__origGUM，供 restoreGetUserMedia 还原。 */
async function stubGetUserMediaReject(page: Page): Promise<void> {
  await page.evaluate(() => {
    const md = navigator.mediaDevices as unknown as Record<string, unknown>
    ;(window as unknown as Record<string, unknown>).__origGUM = md.getUserMedia
    md.getUserMedia = () => Promise.reject(new DOMException('NotAllowedError', 'NotAllowedError'))
  })
}

async function restoreGetUserMedia(page: Page): Promise<void> {
  await page.evaluate(() => {
    const md = navigator.mediaDevices as unknown as Record<string, unknown>
    const orig = (window as unknown as Record<string, unknown>).__origGUM
    if (orig) md.getUserMedia = orig
  })
}

describe('真实 Electron 语音链路（阶段 4 批次 B，Task 15）', () => {
  it('1. 录音闭环：🎤→录音态（计时）→停止→待发送条字幕→确认发送→用户消息出现', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await startRecord(page)
      // 录音态：按钮变「停止录音」+ 时长文本出现（录到 00:01 保证 ≥1s 音频，AudioBuffer 非空 → 试听可用）
      await expect.poll(() => page.locator('.cy-rec-timer').textContent(), POLL).toBe('00:01')
      await page.getByRole('button', { name: '停止录音', exact: true }).click()
      // 待发送条出现 + 字幕（mock 缺省转写文案）
      await expect.poll(() => page.locator('.cy-voice-pending').count(), CAPTURE_POLL).toBe(1)
      await expect.poll(() => page.locator('.cy-vp-text').textContent(), POLL).toContain('这是一段测试录音的转写文本')
      // 有音频缓冲 → 试听可用（证明 fake media 采集真的产出了样本）
      expect(await pendingBtn(page, '试听').isDisabled()).toBe(false)
      // 确认发送
      await page.getByRole('button', { name: '确认发送', exact: true }).click()
      // 用户消息出现（转写文本落消息）
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-messages')?.textContent ?? ''), POLL).toContain('这是一段测试录音的转写文本')
      await expect.poll(() => page.locator('.cy-voice-pending').count(), POLL).toBe(0)
    } finally { await closeApp(launched) }
  })

  it('2. 未识别：CYRENE_MOCK_VOICE_TRANSCRIPT="" → 「正在识别…」等待态（非未识别）+确认发送禁用 + 删除收口', async () => {
    const launched = await launchVoiceWithSize(VW, VH, { env: { CYRENE_MOCK_VOICE_TRANSCRIPT: '' } })
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await startRecord(page)
      await page.getByRole('button', { name: '停止录音', exact: true }).click()
      // P1-02：空/慢转写在 45s 兜底前显示「正在识别…」等待态，而非立即误报「未识别，请重试」
      await expect.poll(() => page.locator('.cy-vp-waiting').count(), POLL).toBe(1)
      await expect.poll(() => page.locator('.cy-vp-waiting').textContent(), POLL).toContain('正在识别…')
      // 短窗 2s 内「未识别，请重试」不得出现（慢转写不被误报）。注：空转写 mock 不发 transcript，
      // awaitingTranscript 持续 true，45s timer 后才翻「未识别」——此处只用 count() 断言（textContent 会因
      // Playwright auto-wait 阻塞到 45s 后元素出现而误报）。
      await page.waitForTimeout(2000)
      expect(await page.locator('.cy-vp-empty').count()).toBe(0)
      // 无字幕 → 确认发送禁用（R-S4-07：等待期可删除、试听，但不可发送）
      expect(await page.getByRole('button', { name: '确认发送', exact: true }).isDisabled()).toBe(true)
      // 删除收口 → 回 idle（无残留待发送条）+ 普通录音按钮恢复 + 连接保持
      await pendingBtn(page, '删除').click()
      await expect.poll(() => page.locator('.cy-voice-pending').count(), POLL).toBe(0)
      await expectIdleRecordEntry(page)
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
    } finally { await closeApp(launched) }
  })

  it('2b. 等待态不闪烁：CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS=1500 →「正在识别…」可见 → 字幕到达（无未识别闪烁）→确认发送可用', async () => {
    const launched = await launchVoiceWithSize(VW, VH, { env: { CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS: '1500' } })
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await startRecord(page)
      await page.getByRole('button', { name: '停止录音', exact: true }).click()
      // R-S4-05（Task 5 修正）：stopRecordVoice 控制帧立即 resolve → renderer 即刻置 awaitingTranscript=true，
      // 慢转写延迟窗口（1500ms）内「正在识别…」等待态可观察
      await expect.poll(() => page.locator('.cy-vp-waiting').count(), POLL).toBe(1)
      await expect.poll(() => page.locator('.cy-vp-waiting').textContent(), POLL).toContain('正在识别…')
      // 短窗（< delay 1500ms）内「未识别，请重试」不得出现——慢转写不误报（R-S4-07）。
      // 缺席断言用 count()：locator.textContent() 会对不存在的元素 auto-wait 到 45s 翻转才返回。
      await page.waitForTimeout(800)
      expect(await page.locator('.cy-vp-empty').count()).toBe(0)
      // transcript 到达（≈1500ms）→ 字幕显示；等待态退出；全程无「未识别」闪烁
      await expect.poll(() => page.locator('.cy-vp-text').textContent(), POLL).toContain('这是一段测试录音的转写文本')
      await expect.poll(() => page.locator('.cy-vp-waiting').count(), POLL).toBe(0)
      expect(await page.locator('.cy-vp-empty').count()).toBe(0)
      // 确认发送可用（字幕就绪）
      expect(await page.getByRole('button', { name: '确认发送', exact: true }).isDisabled()).toBe(false)
    } finally { await closeApp(launched) }
  })

  it('3. 转写：按住（pointerdown）→ 浮层出现 → 松开（pointerup）→ dictation.final 进草稿', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      const dictBtn = page.getByRole('button', { name: '输入法转写（按住说话）', exact: true })
      await dictBtn.hover()
      await page.mouse.down() // 真实 CDP 输入：pointerdown → startDictation
      await expect.poll(() => page.locator('.cy-dictation-hint').count(), CAPTURE_POLL).toBe(1)
      await expect.poll(() => page.locator('.cy-dh-tip').textContent(), POLL).toContain('松开提交')
      await page.mouse.up()   // pointerup → stopDictation → dictation.final
      await expect.poll(() => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.value ?? ''), POLL).toBe('这是听写文本')
      await expect.poll(() => page.locator('.cy-dictation-hint').count(), POLL).toBe(0)
    } finally { await closeApp(launched) }
  })

  it('4. 实时：设置页开实时开关 → 🔊 → CyRealtimeBar 出现 → 停止 → 恢复输入区', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      // 默认 realtimeEnabled=false → 🔊 禁用（设置子开关生效）
      expect(await page.getByRole('button', { name: '实时会话', exact: true }).isDisabled()).toBe(true)
      await openSettings(page)
      await openVoicePane(page)
      const rtCheckbox = page.locator('.cy-vp-row', { hasText: '启用实时语音会话' }).locator('input[type="checkbox"]')
      await rtCheckbox.check()
      await expect.poll(() => rtCheckbox.isChecked(), POLL).toBe(true)
      await closeSettings(page)
      await page.getByRole('button', { name: '实时会话', exact: true }).click()
      // CAPTURE_POLL（不是 POLL）：此处要等 getUserMedia + AudioContext + worklet 整条真实资源链，
      // 详见文件头 CAPTURE_POLL 注释（CI 首跑曾在此处超时）。失效时输出现场 DOM 以便区分
      // 「快速失败（有错误横幅/麦克风错误）」与「单纯慢」——而非只报一个计数不符。
      await expect.poll(
        () => page.locator('.cy-realtime-bar').count(),
        { ...CAPTURE_POLL, message: '实时条未出现：检查是否出现错误横幅（快速失败）还是仅采集链偏慢' },
      ).toBe(1)
      await expect.poll(() => page.locator('.cy-rt-status').textContent(), POLL).toContain('聆听中')
      // 停止 → 实时条消失 → 输入区（textarea）恢复
      await page.getByRole('button', { name: '停止', exact: true }).click()
      await expect.poll(() => page.locator('.cy-realtime-bar').count(), POLL).toBe(0)
      await expect.poll(() => page.locator('textarea[aria-label="消息输入框"]').count(), POLL).toBe(1)
    } finally { await closeApp(launched) }
  })

  it('5. TTS 自动朗读：激活 TTS Profile → 发送文本 → audio.session.ready 置 src → mock 404 onerror → 播放态回落', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      // 激活 TTS（mock ttsActive = !!activeSelection.ttsProfileId）
      await openSettings(page)
      await page.getByRole('tab', { name: 'TTS', exact: true }).click()
      const edgeCard = page.locator('.cy-profile-card[data-profile-id="edge/edge-tts"]')
      await expect.poll(() => edgeCard.count(), POLL).toBe(1)
      await edgeCard.getByRole('button', { name: '设为当前', exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('.cy-profile-card[data-profile-id="edge/edge-tts"] .cy-profile-current').length), POLL).toBe(1)
      await closeSettings(page)
      // 装 MutationObserver 记录 <audio> src 变化序列（D-P13 断言状态而非声音：ready 置 src → onerror 清态卸 src）
      await page.evaluate(() => {
        const audio = document.querySelector<HTMLAudioElement>('audio.cy-tts-player')
        if (!audio) return
        const seen: string[] = []
        ;(window as unknown as { __ttsSeen: string[] }).__ttsSeen = seen
        const mo = new MutationObserver(() => { seen.push(audio.getAttribute('src') ?? '') })
        mo.observe(audio, { attributes: true, attributeFilter: ['src'] })
      })
      // 发送文本 → mock generation 完成 emit audio.session.started + ready（url=tts-live/mock-silent）
      await page.getByLabel('消息输入框').fill('你好')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      // ready 置 src（播放启动）
      await expect.poll(async () => page.evaluate(() => (window as unknown as { __ttsSeen?: string[] }).__ttsSeen ?? []), POLL).toContain('cyrene://renderer/__cyrene-media/tts-live/mock-silent')
      // MediaService tts-live 对 mock-silent 404 → <audio> onerror → clearTtsState 卸 src（播放态回落，无卡死）
      await expect.poll(async () => page.evaluate(() => {
        const seen = (window as unknown as { __ttsSeen?: string[] }).__ttsSeen ?? []
        const i = seen.findIndex((s) => s.includes('mock-silent'))
        return i >= 0 && seen.length > i + 1 && seen[i + 1] === ''
      }), POLL).toBe(true)
    } finally { await closeApp(launched) }
  })

  it('6. 设置持久化（重启）：语音页关 autoReadReply → 重启复用 userData → 开关仍关（真实重启断言）', async () => {
    let ud = ''
    const first = await launchVoiceWithSize(VW, VH, { seed: false })
    try {
      const page = first.page
      await openSettings(page)
      await openVoicePane(page)
      const cb = page.locator('.cy-vp-row', { hasText: 'TTS 自动朗读 AI 回复' }).locator('input[type="checkbox"]')
      await cb.uncheck()
      await expect.poll(() => cb.isChecked(), POLL).toBe(false)
      // 等待 500ms 防抖持久化落盘（不落盘就关会丢更新）
      await expect.poll(() => readSettingsFile(first.userData)?.voice?.autoReadReply, POLL).toBe(false)
      ud = first.userData
      await closeApp(first, { keepUserData: true })
    } finally { /* closeApp 已按 keepUserData 处理 */ }
    const second = await launchVoice({ userData: ud, seed: false })
    try {
      await openSettings(second.page)
      await openVoicePane(second.page)
      const cb2 = second.page.locator('.cy-vp-row', { hasText: 'TTS 自动朗读 AI 回复' }).locator('input[type="checkbox"]')
      await expect.poll(() => cb2.isChecked(), POLL).toBe(false) // 重启后仍关
      expect(readSettingsFile(second.userData)?.voice?.autoReadReply).toBe(false)
    } finally { await closeApp(second) }
  })

  it('7. 语音设置子页：导航「语音」→ CyVoicePane 可见（⊂ 视口）+ 开关可交互 + STT 下拉含空项', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await openSettings(page)
      await openVoicePane(page)
      const box = await page.evaluate(() => {
        const r = document.querySelector<HTMLElement>('.cy-voice-pane')!.getBoundingClientRect()
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight }
      })
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(box.vw)
      expect(box.bottom).toBeLessThanOrEqual(box.vh)
      // 开关交互：翻「显示直接语音字幕」
      const cb = page.locator('.cy-vp-row', { hasText: '显示直接语音字幕' }).locator('input[type="checkbox"]')
      await cb.uncheck()
      await expect.poll(() => cb.isChecked(), POLL).toBe(false)
      // STT 下拉：mock 内置 sensevoice/sense-voice（backend）可列 + 「使用全局活动 STT」空项
      const sttSel = page.locator('.cy-vp-field', { hasText: '转写 STT Profile' }).locator('select')
      await expect.poll(() => sttSel.locator('option').count(), POLL).toBeGreaterThanOrEqual(2)
      expect(await sttSel.locator('option').first().textContent()).toContain('使用全局活动 STT')
    } finally { await closeApp(launched) }
  })

  it('8. 会话切换守卫（D-P5）：录音中切会话被拦（提示先结束，不切换）', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await startRecord(page)
      // 点第二个会话（conv-1002）
      await page.locator('.cy-conversation').nth(1).locator('.cy-conversation-main').click()
      await expect.poll(() => page.evaluate(() => document.body.textContent ?? ''), POLL).toContain('请先结束当前语音会话')
      // 未切换：标题仍是 conv-1001
      expect(await page.evaluate(() => document.querySelector('.cy-chat-heading h2')?.textContent ?? '')).toContain('流式回复演示')
      // 清理：停止 → 删除（record_pending → idle），守卫提示随下一切换清
      await page.getByRole('button', { name: '停止录音', exact: true }).click()
      await pendingBtn(page, '删除').click()
      await expect.poll(() => page.locator('.cy-voice-pending').count(), POLL).toBe(0)
    } finally { await closeApp(launched) }
  })

  it('9a. 断线清理（录音）：录音中断开 → 语音态清 + 回未连接', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await startRecord(page)
      // UII-QQ：断开钮在连接入口 popover 内——先点徽标展开
      await page.getByRole('button', { name: /REAL|MOCK/ }).click()
      await page.getByRole('button', { name: '断开', exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('未连接')
      // voiceStore.reset 清态：录音入口回 idle（主键=转写 hold），无残留待发送条
      await expect.poll(() => page.getByRole('button', { name: '停止录音', exact: true }).count(), POLL).toBe(0)
      await expectIdleRecordEntry(page)
    } finally { await closeApp(launched) }
  })

  it('9b. 断线清理（实时）：实时中断开 → CyRealtimeBar 消失 + 回未连接', async () => {
    const launched = await launchVoiceWithSize(VW, VH, { seed: [{ relPath: 'config/settings.json', content: REALTIME_SETTINGS }] })
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await page.getByRole('button', { name: '实时会话', exact: true }).click()
      await expect.poll(() => page.locator('.cy-realtime-bar').count(), CAPTURE_POLL).toBe(1)
      // UII-QQ：断开钮在连接入口 popover 内——先点徽标展开
      await page.getByRole('button', { name: /REAL|MOCK/ }).click()
      await page.getByRole('button', { name: '断开', exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('未连接')
      await expect.poll(() => page.locator('.cy-realtime-bar').count(), POLL).toBe(0)
      await expect.poll(() => page.locator('textarea[aria-label="消息输入框"]').count(), POLL).toBe(1)
    } finally { await closeApp(launched) }
  })

  it('10a. consent：首次点 🎤 弹确认 → 同意继续录音 + 持久化不再提示 → 重启不再弹', async () => {
    let ud = ''
    const first = await launchVoiceWithSize(VW, VH, { seed: false }) // 默认 consentBackendStt=false
    try {
      const page = first.page
      await connectAndActivateFirst(page)
      await clickRecordEntry(page)
      await expect.poll(() => page.getByRole('dialog', { name: '后端语音识别确认' }).count(), POLL).toBe(1)
      await page.getByRole('button', { name: '同意', exact: true }).click()
      // 同意后继续录音（confirmConsent 重发挂起的 startRecord）
      await expect.poll(() => page.getByRole('button', { name: '停止录音', exact: true }).count(), POLL).toBe(1)
      await page.getByRole('button', { name: '停止录音', exact: true }).click()
      await pendingBtn(page, '删除').click()
      await expect.poll(() => page.locator('.cy-voice-pending').count(), POLL).toBe(0)
      // 等「不再提示」持久化落盘再关（防防抖丢更新）
      await expect.poll(() => readSettingsFile(first.userData)?.voice?.consentBackendStt, POLL).toBe(true)
      ud = first.userData
      await closeApp(first, { keepUserData: true })
    } finally { /* closeApp 已按 keepUserData 处理 */ }
    const second = await launchVoice({ userData: ud, seed: false })
    try {
      await connectAndActivateFirst(second.page)
      await clickRecordEntry(second.page)
      // 重启后不再弹确认：直接进录音态
      await expect.poll(() => second.page.getByRole('button', { name: '停止录音', exact: true }).count(), POLL).toBe(1)
      expect(await second.page.getByRole('dialog', { name: '后端语音识别确认' }).count()).toBe(0)
    } finally { await closeApp(second) }
  })

  it('10b. consent：取消 → 中止（不进入录音）', async () => {
    const launched = await launchVoiceWithSize(VW, VH, { seed: false })
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await clickRecordEntry(page)
      await expect.poll(() => page.getByRole('dialog', { name: '后端语音识别确认' }).count(), POLL).toBe(1)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      // 中止：不进入录音态（入口回 idle），无待发送条
      await expect.poll(() => page.getByRole('dialog', { name: '后端语音识别确认' }).count(), POLL).toBe(0)
      expect(await page.getByRole('button', { name: '停止录音', exact: true }).count()).toBe(0)
      await expectIdleRecordEntry(page)
    } finally { await closeApp(launched) }
  })

  it('11. deleteProfile 回退（D-P20）：删除被转写引用的 STT Profile → 下拉回全局 + toast', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await openSettings(page)
      // 1) 模型服务 → STT tab → 创建 custom STT Profile
      await page.getByRole('tab', { name: 'STT', exact: true }).click()
      await page.getByRole('button', { name: '添加自定义模型', exact: true }).click()
      await expect.poll(() => page.locator('.cy-wizard').count(), POLL).toBe(1)
      await page.getByPlaceholder('例如 my-llm', { exact: true }).fill('stt-custom')
      await page.getByPlaceholder('https://', { exact: true }).fill('https://api.example.com')
      await page.getByRole('button', { name: '测试并保存', exact: true }).click()
      const cardSel = '.cy-profile-card[data-profile-id="custom/stt-custom"]'
      await expect.poll(() => page.locator(cardSel).count(), POLL).toBe(1)
      // 2) 语音页 → 转写 STT 下拉选 custom（dictation.sttProfileId = custom/stt-custom）
      await openVoicePane(page)
      const sttSel = page.locator('.cy-vp-field', { hasText: '转写 STT Profile' }).locator('select')
      await sttSel.selectOption('custom/stt-custom')
      await expect.poll(() => sttSel.inputValue(), POLL).toBe('custom/stt-custom')
      // 3) 回模型服务（重挂载 tab 回 llm，需再切 STT）→ 删除 custom
      await page.locator('.cy-settings-nav-item', { hasText: '模型服务' }).click()
      await expect.poll(() => page.locator('.cy-model-services').count(), POLL).toBe(1)
      await page.getByRole('tab', { name: 'STT', exact: true }).click()
      const card = page.locator(cardSel)
      await expect.poll(() => card.count(), POLL).toBe(1)
      await card.getByRole('button', { name: '删除', exact: true }).click()
      await card.getByRole('button', { name: '确认删除', exact: true }).click()
      // 4) 回语音页 → 下拉回「使用全局活动 STT」+ toast「转写已回退全局 STT」
      await openVoicePane(page)
      const sttSel2 = page.locator('.cy-vp-field', { hasText: '转写 STT Profile' }).locator('select')
      await expect.poll(() => sttSel2.inputValue(), POLL).toBe('')
      await expect.poll(() => page.locator('.cy-settings-toast').textContent(), POLL).toContain('转写已回退全局 STT')
    } finally { await closeApp(launched) }
  })

  it('12. 采集失败免重连：getUserMedia 拒绝 → micError banner + 按钮恢复(mode idle) → 还原同连接三语音各自成功', async () => {
    const launched = await launchVoiceWithSize(VW, VH, {
      seed: [{ relPath: 'config/settings.json', content: REALTIME_SETTINGS }], // realtimeEnabled+consent 预开
    })
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      // 1) 覆写 getUserMedia 拒绝（NotAllowedError，真实权限拒绝同路径），原函数存 window.__origGUM
      await stubGetUserMediaReject(page)
      // 2) 点录音入口（菜单）→ control 帧先行（voice.record.start）→ capture 拒绝 → composer micError banner + 入口回 idle（mode 回 idle）
      await expect.poll(() => page.locator('.cy-status-text').textContent(), POLL).toContain('已连接')
      await clickRecordEntry(page)
      await expect.poll(() => page.locator('.cy-mic-error-banner').count(), POLL).toBe(1)
      await expectIdleRecordEntry(page)
      expect(await page.getByRole('button', { name: '停止录音', exact: true }).count()).toBe(0)
      // 3) 还原 getUserMedia → 同一连接普通录音成功：进入 recording（P0-01：后端会话已由 discard 释放，无 VOICE_SESSION_CONFLICT）
      await restoreGetUserMedia(page)
      await clickRecordEntry(page)
      await expect.poll(() => page.getByRole('button', { name: '停止录音', exact: true }).count(), POLL).toBe(1)
      await expect.poll(() => page.locator('.cy-mic-error-banner').count(), POLL).toBe(0)
      // 4) stop → 删除（discardRecord：待发送条消失 + mode 回 idle）——realtime/dictation 的 guardStart 要求 idle，必须先 discard
      await page.getByRole('button', { name: '停止录音', exact: true }).click()
      await expect.poll(() => page.locator('.cy-voice-pending').count(), CAPTURE_POLL).toBe(1)
      await pendingBtn(page, '删除').click()
      await expect.poll(() => page.locator('.cy-voice-pending').count(), POLL).toBe(0)
      await expectIdleRecordEntry(page)
      // 5) 实时 start+stop（同连接，无需重连）
      await page.getByRole('button', { name: '实时会话', exact: true }).click()
      await expect.poll(() => page.locator('.cy-realtime-bar').count(), CAPTURE_POLL).toBe(1)
      await expect.poll(() => page.locator('.cy-rt-status').textContent(), POLL).toContain('聆听中')
      await page.getByRole('button', { name: '停止', exact: true }).click()
      await expect.poll(() => page.locator('.cy-realtime-bar').count(), POLL).toBe(0)
      // 6) 转写 start+stop（按住说话，同连接）
      const dictBtn = page.getByRole('button', { name: '输入法转写（按住说话）', exact: true })
      await dictBtn.hover()
      await page.mouse.down()
      await expect.poll(() => page.locator('.cy-dictation-hint').count(), CAPTURE_POLL).toBe(1)
      await page.mouse.up()
      await expect.poll(() => page.locator('.cy-dictation-hint').count(), POLL).toBe(0)
      // 全程连接保持（未重连）
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
    } finally { await closeApp(launched) }
  })

  it('13. 设置页 mic 失败退出后聊天可立即语音：micTestError 展示 + 无残留 composer banner(clearTransientErrors)', async () => {
    const launched = await launchVoiceWithSize(VW, VH)
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await stubGetUserMediaReject(page)
      // 设置 → 语音 → 「测试麦克风」→ getUserMedia 拒绝 → micTestError 展示（micTesting 回落 idle）
      await openSettings(page)
      await openVoicePane(page)
      await page.getByRole('button', { name: '测试麦克风', exact: true }).click()
      await expect.poll(() => page.locator('.cy-vp-mictest .cy-vp-error').count(), POLL).toBe(1)
      // 退出设置 → CyVoicePane 卸载 clearTransientErrors → 聊天页无残留 composer banner（mode-idle micError 残差不误展示）
      await closeSettings(page)
      await expect.poll(() => page.locator('.cy-mic-error-banner').count(), POLL).toBe(0)
      // 还原 getUserMedia → 录音入口可立即启动（进入 recording）
      await restoreGetUserMedia(page)
      await clickRecordEntry(page)
      await expect.poll(() => page.getByRole('button', { name: '停止录音', exact: true }).count(), POLL).toBe(1)
      await page.getByRole('button', { name: '停止录音', exact: true }).click()
      await expect.poll(() => page.locator('.cy-voice-pending').count(), CAPTURE_POLL).toBe(1)
      await pendingBtn(page, '删除').click()
      await expect.poll(() => page.locator('.cy-voice-pending').count(), POLL).toBe(0)
    } finally { await closeApp(launched) }
  })
})
