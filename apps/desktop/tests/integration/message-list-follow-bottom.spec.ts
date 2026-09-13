// tests/integration/message-list-follow-bottom.spec.ts —— H-02（2026-09-11）：
// ① 内容增长时贴底跟随；② 回复可复制；③ 正文可选中。
//
// 修复前的实测事实（报告 H-02 + 本轮读码复核）：`atBottom` 明明有 8 个赋值点，却**没有一处**
// 由内容增长触发；`.cy-messages` 又用 `overflow-anchor: none` 关掉了浏览器原生补偿。
// 于是超过一屏的会话里，按 Enter 后自己的消息落在视口下方、scrollTop 不动，而 atBottom 仍为 true，
// 连「回到底部」按钮都不出现——用户感受是「按了发送没反应」。
//
// 判别力：删除 CyMessageList 的 followBottomIfSticky 调用后，用例 ① 必红（已做变异验证）。
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

/** 距底部距离（scrollHeight - scrollTop - clientHeight） */
const bottomGap = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.cy-messages')
    if (!el) return Number.NaN
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
  })

/**
 * 冻结曲线采样（2026-09-13，④ 的第 6 次再现之后加的**纯诊断**，不改任何判据）。
 *
 * 为什么需要它：④ 的六次 CI 红出现了三组不同签名，其中`2506/5011/2-of-25/5526` 那一组**逐像素重复**
 * （含同一 commit 的两次 attempt）——说明触发时缺口落在**确定的饱和值**上，而不是"机器慢一点"的连续浮动。
 * 三个聚合值（median/max/within）判不出这件事发生在哪一步，故补逐采样的几何量：
 *   `top` 是 `.cy-messages` 的 scrollTop，`height` 是 scrollHeight。
 *   代码里已记录过一条"**再无恢复路径**"分支（`CyMessageList.vue:112-125`：一旦早退，scrollTop 冻结、
 *   不再产生 scroll 事件 → 没有 settle → 没有重锚，缺口永久累积），而本曲线正是判定它的直接证据：
 *   **height 持续增长而 top 冻结不动** ⇒ 就是那条分支。
 * 只在失败时多花时间：收敛值 > 40 时再补三次 5s 重采样，用来区分「慢到超出 15s 观测窗」与「永不收敛」。
 */
const geometry = (page: Page): Promise<{ gap: number; top: number; height: number; intent: string; atb: string; clears: number; clearLast: string; clearFlip: string; upCount: number; upLast: string } | null> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.cy-messages')
    if (!el) return null
    return {
      gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      top: Math.round(el.scrollTop),
      height: Math.round(el.scrollHeight),
      // 只读探针（组件把两个内部布尔量反射到 data-* 上）：判定"是谁把跟随意图清了"必须看得见它们
      intent: el.dataset.followIntent ?? '?',
      atb: el.dataset.atBottom ?? '?',
      // 第二／三轮探针：位置下移事件的上下文（下移量 / 累计量 / 是否紧跟程序性写入 / 当时的 max 与 clientHeight）
      upCount: Number(el.dataset.followUpCount ?? '0'),
      upLast: el.dataset.followUpLast ?? '',
      clears: Number(el.dataset.followClears ?? '0'),
      clearLast: el.dataset.followClearLast ?? '',
      clearFlip: el.dataset.followClearFlip ?? ''
    }
  })

describe('消息列表贴底跟随与复制（H-02）', () => {
  it('① 长会话中发送消息后仍贴底（跟随底部，最新内容可见）', async () => {
    // 200 条种子历史 → 远超一屏，复现「按 Enter 看不见自己的消息」的真实前提
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_HISTORY_LARGE: '200' } })
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await expect.poll(() => bottomGap(page), POLL).toBeLessThanOrEqual(40)   // 激活后应贴底

      const text = '贴底跟随验证'
      await page.getByLabel('消息输入框').fill(text)
      await page.getByLabel('消息输入框').press('Enter')

      // 自己的消息确实进了列表（不是没发出去）
      await expect.poll(() => page.evaluate((t) =>
        [...document.querySelectorAll<HTMLElement>('.cy-user-bubble')].some((n) => (n.textContent ?? '').includes(t)), text), POLL).toBe(true)

      // 判别点 = 产品语义「贴底跟随」：发送后容器仍贴底，故最新内容可见。
      // **刻意不用「自己的消息完整落在视口内」作断言**：助手回复可能很长，会合法地把它顶出视口——
      // 那是正常滚动而非缺陷。该断言在 CI 的小视口上误报过一次（本地视口大、回复顶不出去），
      // 而真正承重的是这里的 bottomGap：变异验证显示移除贴底重锚后它立刻红于 551px。
      await expect.poll(() => bottomGap(page), POLL).toBeLessThanOrEqual(40)
    } finally { await closeApp(launched) }
  })

  it('② 助手回复渲染复制按钮（copyableText 非空才渲染），且可点击不报错', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill('你好')
      await page.getByLabel('消息输入框').press('Enter')
      await expect.poll(() => page.locator('[data-testid="message-copy"]').count(), POLL).toBeGreaterThan(0)
      const btn = page.locator('[data-testid="message-copy"]').last()
      await expect.poll(() => btn.textContent(), POLL).toContain('复制')
      // 真实剪贴板写入在本 harness 下依赖窗口焦点、结果不稳定（同一用例曾通过也曾失败），
      // 故 e2e 只断言渲染与可点击；「复制什么内容、是否调用剪贴板」由可注入的
      // tests/unit/cy-message-bubble.spec.ts 确定性覆盖（见该文件 H-02 用例）。
      await btn.click()
      await expect.poll(() => btn.textContent(), POLL).toMatch(/复制|已复制/)
    } finally { await closeApp(launched) }
  })

  it('③ 消息正文 user-select 为 text（全局 body 是 none，此前 Ctrl+A/Ctrl+C 无效）', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await page.getByLabel('消息输入框').fill('可选中验证')
      await page.getByLabel('消息输入框').press('Enter')
      await expect.poll(() => page.locator('.cy-user-bubble').count(), POLL).toBeGreaterThan(0)
      const selectable = await page.evaluate(() => {
        const bubble = document.querySelector<HTMLElement>('.cy-user-bubble')
        return bubble ? getComputedStyle(bubble).userSelect : 'missing'
      })
      expect(selectable).toBe('text')
    } finally { await closeApp(launched) }
  })

  // H-02 续修（2026-09-11）：**流式持续增长**下的贴底保持。
  //
  // ① 只发一条消息（单次增长），而真实故障形态是流式回复**连续多次**增长：每一次增长都让
  // scrollHeight 变大而 scrollTop 不变，若「是否跟随」用的是瞬时位置而不是用户意图，
  // 就会在某个瞬间被判成「用户已上翻」→ 永久放弃跟随 → 缺口累积且**不会自愈**
  // （此后不再产生 scroll 事件 → 没有 settle → 没有重锚）。
  // 探针实测：scrollTop 冻在 6146 而 scrollHeight 从 7176 涨到 12093；CI 上以距底 779px 现形。
  // 本用例用 60 段多分段流式回复把增长次数放大到足以稳定复现。
  it('④ 流式回复持续增长时缺口不累积且能收敛（跟随意图不被瞬时位置吞掉）', async () => {
    const launched = await launchApp(undefined, {
      env: { CYRENE_MOCK_HISTORY_LARGE: '200', CYRENE_MOCK_MULTI_SEGMENT: '60' }
    })
    try {
      const { page } = launched
      await connectAndActivateFirst(page)
      await expect.poll(() => bottomGap(page), POLL).toBeLessThanOrEqual(40)

      await page.getByLabel('消息输入框').fill('流式贴底验证')
      await page.getByLabel('消息输入框').press('Enter')

      /**
       * 流式期间采样：要证的性质是「缺口**不累积**」，不是「任何瞬间都不许抖」。
       *
       * 我第一版把这条写成 `max(samples) ≤ 200`——**判据与意图不符**：虚拟列表在内容增长到下一次重锚之间
       * 天然存在瞬时缺口，而 CI（xvfb + 软件渲染 + 负载）上单个采样点还可能正好落在一次大幅增长之后，
       * 于是出现 653px 的一次性尖峰（缺陷形态是**持续累积**：缺口单调增长且永不回落，实测 4732px）。
       * 用 max 判定会把"瞬时抖动"误判成"缺陷"，属判据错误。
       *
       * 改为**稳健统计 + 收敛断言**（两者结合才对应真实性质）：
       *   · 中位数在容差内 —— 缺陷下中位数本身就极大，一眼可分；
       *   · 多数采样在容差内 —— 挡住"始终远离底部"；
       *   · 最终收敛到 ≤40px —— 缺陷下永不收敛（最强信号）。
       * 判别力由变异保证：把守卫改回瞬时位置 → 中位数与占比双双爆掉。
       *
       * **自诊断（2026-09-12）**：前两条断言原本是硬断言，于是失败时立刻抛出，最后那句
       * 「收敛后必须严格贴底」在历次 CI 失败里**从未被执行过**——而它恰好是唯一能区分两种成因的
       * 信号：机器慢跟不上（窗口结束后仍会收敛）vs 缺陷（永不收敛）。故前两条改为 `expect.soft`
       * （**判据一字不放宽**：三条里任何一条不过整例仍红，只是三条都会跑、都会出现在报告里），
       * 并在 finally 里取一次窗口结束后的实测缺口打印出来。这样下一次 CI 红自带结论：
       * `settledGap ≤ 40` ⇒ 只是跟不上；`settledGap 仍大` ⇒ 永不收敛，是缺陷。
       * 起因见 doc 16：`34692644842` 与 `34681240933` 两次红在**缺陷量级**（中位数 2506／2961px，
       * 而变异实测 2274px、噪声带仅 ~84px），却因该断言从未执行而无法定性。
       */
      const samples: number[] = []
      const tops: number[] = []
      const heights: number[] = []
      const intents: string[] = []
      const atbs: string[] = []
      const flips: string[] = []
      const clearTotals: number[] = []
      const lasts: string[] = []
      const upLasts: string[] = []
      for (let i = 0; i < 25; i++) {
        const g = await geometry(page)
        samples.push(g?.gap ?? Number.NaN)
        tops.push(g?.top ?? Number.NaN)
        heights.push(g?.height ?? Number.NaN)
        intents.push(g?.intent ?? '?')
        atbs.push(g?.atb ?? '?')
        flips.push(g?.clearFlip ?? '')
        clearTotals.push(g?.clears ?? 0)
        lasts.push(g?.clearLast ?? '')
        upLasts.push(g?.upLast ?? '')
        await page.waitForTimeout(200)
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      const max = sorted[sorted.length - 1]
      const withinTolerance = samples.filter((gap) => gap <= 200).length
      console.log(
        `[follow-bottom ④] median=${median}px max=${max}px within=${withinTolerance}/${samples.length}`
      )
      // 冻结曲线（纯诊断）：height 涨而 top 不动 ⇒ 命中代码里记过的"再无恢复路径"分支
      console.log(`[follow-bottom ④] top=${tops.join(',')}`)
      console.log(`[follow-bottom ④] height=${heights.join(',')}`)
      console.log(`[follow-bottom ④] intent=${intents.join('')} atb=${atbs.join('')}`)
      // 清意图事件的上下文（④ 第二／三轮探针）：**这一行是修复定数的依据**——
      // `d=` 下移量、`acc=` 累计量（`USER_SCROLL_MIN_PX=64` 就是按实测的 31px 误清定的）、
      // `w=own/ext` 是不是紧跟我们的程序性写入、`max`/`c` 用来判"下移后距底多远"。
      // 修复后的健康形态：`up=` 里可能出现小幅下移（浏览器自己的回退），但**不应有** `首次清意图`。
      const flip = flips.find((f) => f.length > 0) ?? ''
      console.log(`[follow-bottom ④] 清意图事件数=${clearTotals[clearTotals.length - 1] ?? 0} 最近一次=${lasts[lasts.length - 1] || '（无）'}`)
      console.log(`[follow-bottom ④] 位置下移事件（最近一次）：${upLasts[upLasts.length - 1] || '（无）'}`)
      console.log(`[follow-bottom ④] 首次清意图（intent 1→0，决定性读数）：${flip || '（本轮未发生）'}`)
      // 冻结判定（**纯诊断**）：末尾**连续 ≥3 个采样** top 不变而 height 仍在增长。
      // 第一版写成"任意相邻两点 top 相同且 height 增长"——实测**假阳性**（X99 run2：`top=…,6701,6701,…`
      // 只是跟随恰好落回同一个取整值，`intent` 全程为 1、`settledGap=0`、用例本身通过）。
      // 真冻结是**持续**的：流式结束时 top 再不变化（本机复现那一轮是连续 7 个采样）。
      let lastChange = 0
      for (let i = 1; i < tops.length; i++) if (tops[i] !== tops[i - 1]) lastChange = i
      const frozenRun = tops.length - 1 - lastChange
      const frozenAt = frozenRun >= 3 && heights[heights.length - 1] > heights[lastChange] ? lastChange + 1 : -1
      if (frozenAt > 0) {
        console.log(
          `[follow-bottom ④] frozenAt=#${frozenAt} 连续${frozenRun}个采样 top=${tops[frozenAt]} 不变，而 height=${heights[frozenAt]}→${heights[heights.length - 1]}`
        )
        // 冻结那一刻的两个内部布尔量：`intent=0` ⇒ 跟随意图被清（谁清的见 onScroll 的 scrollTop<prevTop 分支）；
        // `intent=1` 却不动 ⇒ 意图还在、是"没人推动滚动"，那是另一条分支。这一行就是为了把两者分开。
        console.log(
          `[follow-bottom ④] 冻结时 intent=${intents[frozenAt]} atb=${atbs[frozenAt]}（前一点 intent=${intents[frozenAt - 1]} atb=${atbs[frozenAt - 1]}）`
        )
      }
      expect.soft(
        median,
        `流式期间距底缺口中位数 ${median}px（max ${max}px）——「持续累积」才是缺陷形态，瞬时抖动不是`
      ).toBeLessThanOrEqual(200)
      expect.soft(
        withinTolerance,
        `仅 ${withinTolerance}/${samples.length} 个采样在容差内（缺陷下几乎为 0；max ${max}px）`
      ).toBeGreaterThanOrEqual(Math.ceil(samples.length * 0.6))

      // 收敛后必须严格贴底（缺陷下永不收敛——这是最强信号）
      try {
        await expect.poll(() => bottomGap(page), POLL).toBeLessThanOrEqual(40)
      } finally {
        // 诊断取值：无论上面收敛断言过没过都打一行，使失败日志能直接判「慢」还是「缺陷」。
        // 取值自身失败（页面已关）不得覆盖或掩盖原断言结果，故单独兜住。
        try {
          const settledGap = await bottomGap(page)
          console.log(
            `[follow-bottom ④] settledGap=${settledGap}px（≤40 ⇒ 窗口内已收敛=只是跟不上；仍大 ⇒ 永不收敛=缺陷）`
          )
          // 只在"不收敛"时补采样：用来看它是**慢**（后续会降下来）还是**真的永不收敛**
          // （`POLL` 的 15s 是观测窗口，"永不收敛"实测口径其实就是"15s 内不收敛"——这三次重采样正是为了
          // 把这两种解释分开；只加时间、不加断言）。
          if (settledGap > 40) {
            for (const wait of [5000, 5000, 5000]) {
              await page.waitForTimeout(wait)
              const g = await geometry(page)
              console.log(`[follow-bottom ④] resample(+${wait}ms)=${g?.gap}px top=${g?.top} height=${g?.height} intent=${g?.intent} atb=${g?.atb}`)
            }
          }
        } catch { /* 页面已关闭：无诊断值可打，不影响断言结论 */ }
      }
    } finally { await closeApp(launched) }
  })
})
