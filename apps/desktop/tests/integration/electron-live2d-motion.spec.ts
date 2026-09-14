// tests/integration/electron-live2d-motion.spec.ts
// 阶段 5 批次 B/C：Live2D **表现层**集成（状态驱动 / 动作播放 / 情绪态→表情 / 中文 mood 归一 / live2d.directive 指令消费）。
//
// 2026-09-15 拆分（A-1）：从 electron-live2d.spec.ts（28 用例 / 62.9KB，CI 上独占一个 job = 墙钟地板）按
//   **实测逐用例耗时**切出。本文件 7 用例实测 47.3s（B1 6.3 + B2 3.1 + B3 8.5 + F-1 9.3 + C3.1 7.2 + C3.2 6.5 + C3.3 6.4）。
//   三文件对照：core 12 例 35.1s / motion 7 例 47.3s / settings 9 例 43.7s。
//   **断言强度逐字未动**：用例体原样搬运（含全部注释），装配与观测原语来自 helpers/live2d-fixture.ts（只此一份）。
//   本文件收原 `（B7：状态驱动/动作/设置/性能/布局/竞态）` describe 中的表现层 4 例，故该 describe 标题按本文件
//   实际收容的用例改写为 `（B7：状态驱动/动作/情绪）`；C3 的 describe 原样保留。**it 名逐字未动**。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { closeApp } from './helpers/app'
import {
  POLL, installLive2dMaster, teardownLive2dMaster, freshUserData, launchL2d,
  statusText, waitLive2dSettled, connectAndActivateFirst, countNonTransparentPx, badgeText, sendChat
} from './helpers/live2d-fixture'

// —— 装配（本文件用到的标志：haru / lil；wanko 只在本文件之外的切换类用例需要）——
let haruInstalled = false
let lilInstalled = false

beforeAll(async () => {
  const res = await installLive2dMaster()
  haruInstalled = res.haru
  lilInstalled = res.lil
}, 120_000)

afterAll(() => { teardownLive2dMaster() })

describe('阶段5批次B Live2D Electron 集成（B7：状态驱动/动作/情绪）', () => {
  it('B1.状态驱动：发送消息 → 徽标「思考中」→「说话中」→「空闲」（真实 DOM）', async () => {
    // 放宽 mock replay 事件间隔：thinking/speaking 窗口在 200ms 轮询下可稳定捕获（缺省 30ms 会被漏掉）
    const ud = freshUserData()
    const launched = await launchL2d(ud, { CYRENE_MOCK_EMIT_DELAY_MS: '400' })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await connectAndActivateFirst(page)
      // 连接后业务态 idle（徽标「空闲」；未连接前为 offline「未连接」）
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
      // generation.started → thinking（「思考中」）；首个公众正文 delta → speaking（「说话中」）
      await sendChat(page, '你好')
      await expect.poll(() => badgeText(page), POLL).toContain('思考中')
      await expect.poll(() => badgeText(page), POLL).toContain('说话中')
      // generation.completed → 回 idle（默认夹具 emotion='thinking' 非已知 mood → 被状态源忽略，不回情绪态）
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
    } finally { await closeApp(launched) }
  })

  it('B2.动作播放：Haru（有动作）speaking → 画布非空无错误；lil（无动作）切换优雅不崩、聊天可用', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, { CYRENE_MOCK_EMIT_DELAY_MS: '300' })
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      if (haruInstalled) {
        // B3 路径：有动作模型，指定切到 Haru 后触发 speaking → 帧推进、画布非空
        await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('haru')
        await expect.poll(() => statusText(page), POLL).toContain('Haru')
        await connectAndActivateFirst(page)
        await sendChat(page, 'haru speaking')
        await expect.poll(() => badgeText(page), POLL).toContain('说话中')
        await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      }
      if (lilInstalled) {
        // B4 路径：无动作模型。lil 的 8192px 大纹理超 SwiftShader MAX_TEXTURE_SIZE（批次 A 已实测装载即失败）——
        // 本环境断言「切换不崩 + 优雅保留原模型 + 聊天可用」；参数级回退的正向断言由单测（live2d-controller B4）
        // 覆盖。若其他环境 lil 可渲染，则补强画布断言。
        await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('lil')
        await expect.poll(() => statusText(page), POLL).toMatch(/就绪|回退|失败/)
        if ((await statusText(page)).includes('修女莉尔')) {
          await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
        }
      }
      expect(errors).toEqual([])
    } finally { await closeApp(launched) }
  })

  it('B3.情绪态→表情：mock emotion=happy → 徽标「开心」+ 画布非空 + 无 console error', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, { CYRENE_MOCK_EMIT_DELAY_MS: '400', CYRENE_MOCK_GENERATION_EMOTION: 'happy' })
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('haru')
      await expect.poll(() => statusText(page), POLL).toContain('Haru')
      await connectAndActivateFirst(page)
      await sendChat(page, 'happy')
      // 流式 speaking → completion(emotion=happy) → 情绪态「开心」（~2s 后 mood 超时回空闲）
      await expect.poll(() => badgeText(page), POLL).toContain('说话中')
      await expect.poll(() => badgeText(page), POLL).toContain('开心')
      // 情绪态期间渲染不中断（Haru F01 表情 setExpression 进入——白名单内）
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
      expect(errors).toEqual([])
    } finally { await closeApp(launched) }
  })

  it('F-1.中文 mood 归一：mock emotion=开心 → 徽标「开心」+ 画布非空 + 无 console error', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, { CYRENE_MOCK_EMIT_DELAY_MS: '400', CYRENE_MOCK_GENERATION_EMOTION: '开心' })
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('haru')
      await expect.poll(() => statusText(page), POLL).toContain('Haru')
      await connectAndActivateFirst(page)
      await sendChat(page, '开心')
      // 流式 speaking → completion(emotion=开心) → normalizeEmotionCode 归一 happy → 情绪态「开心」
      await expect.poll(() => badgeText(page), POLL).toContain('说话中')
      await expect.poll(() => badgeText(page), POLL).toContain('开心')
      // 情绪态期间渲染不中断（Haru F01 表情 setExpression 进入——白名单内）
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
      expect(errors).toEqual([])
    } finally { await closeApp(launched) }
  })
})

describe('阶段5批次C Live2D Electron 集成（C3：live2d.directive 指令消费）', () => {
  it('C3.1.指令 happy+F01：generation.completed 后徽标「开心」+ 表情被消费（画布非空）+ 无 console error', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, {
      CYRENE_MOCK_EMIT_DELAY_MS: '400',
      CYRENE_MOCK_DIRECTIVE: '{"state":"happy","expression":"expressions/F01.exp3.json","priority":1}'
    })
    const errors: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await page.locator('select[aria-label="选择 Live2D 模型"]').selectOption('haru')
      await expect.poll(() => statusText(page), POLL).toContain('Haru')
      await connectAndActivateFirst(page)
      await sendChat(page, 'directive happy')
      // 流式 speaking → completion 后指令(state=happy) → 情绪态「开心」（指令瞬态 ~2s）
      await expect.poll(() => badgeText(page), POLL).toContain('说话中')
      await expect.poll(() => badgeText(page), POLL).toContain('开心')
      // 指令 expression F01 命中白名单 → 表情被消费（startExpression → 渲染不中断）
      await expect.poll(() => countNonTransparentPx(page), { ...POLL, timeout: 6000 }).toBeGreaterThan(0)
      expect(errors).toEqual([])
    } finally { await closeApp(launched) }
  })

  it('C3.2.指令非白名单 expression：不崩 + 脱敏 warn（directive_miss，不记 payload 原文）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, {
      CYRENE_MOCK_EMIT_DELAY_MS: '400',
      CYRENE_MOCK_DIRECTIVE: '{"state":"happy","expression":"expressions/evil.exp3.json","priority":1}'
    })
    const warns: string[] = []
    launched.page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()) })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await connectAndActivateFirst(page)
      await sendChat(page, 'directive miss')
      // generation.completed 后指令消费 → expression 未命中白名单 → 脱敏 warn（code=directive_miss）
      await expect.poll(() => warns.some((w) => w.includes('directive_miss')), POLL).toBe(true)
      // 脱敏：warn 不记 payload 原文（evil 路径不得出现）
      expect(warns.some((w) => w.includes('expressions/evil.exp3.json'))).toBe(false)
      // 聊天仍可用（不崩）
      await expect.poll(() => page.locator('textarea[aria-label="消息输入框"]').count(), POLL).toBe(1)
    } finally { await closeApp(launched) }
  })

  it('C3.3.指令 state:working（越界）→ env 解析缺省不发射（无指令、不崩、聊天可用）', async () => {
    const ud = freshUserData()
    const launched = await launchL2d(ud, {
      CYRENE_MOCK_EMIT_DELAY_MS: '400',
      CYRENE_MOCK_DIRECTIVE: '{"state":"working","expression":"expressions/F01.exp3.json","priority":1}'
    })
    try {
      const { page } = launched
      await waitLive2dSettled(page)
      await connectAndActivateFirst(page)
      await sendChat(page, 'directive working')
      // 等 generation.completed 完成（指令应不发射——working 非七值，parseMockDirectiveEnv 拒）
      await expect.poll(() => badgeText(page), POLL).toContain('空闲')
      await expect.poll(() => page.locator('textarea[aria-label="消息输入框"]').count(), POLL).toBe(1)
    } finally { await closeApp(launched) }
  })
})
