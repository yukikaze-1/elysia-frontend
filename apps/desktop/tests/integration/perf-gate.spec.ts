// tests/integration/perf-gate.spec.ts
// 阶段 7 批次 C（Task 5）：性能测量集成门禁。
//
// 目标——仅聚合计数断言（安全 M-3：不读消息文本/分段长度/分段内容量，绝不让测量演化为内容侧信道），
// 把四项性能场景放进真实 Electron 常驻门禁，防性能回归：
//   ① 历史查看器 500 项（虚拟化：DOM 节点有界，不随 500 线性）
//   ② 100 分段流式回复（全量分段正确呈现 + 消息列表行有界 + 回放不停顿）
//   ③ 长会话 200 条（消息列表可视行有界）
//   ④ Live2D 折叠后 rAF 停（维持现状，不 dispose）
//
// 断言分级（spec §4D④，可行 M-4）：
//  - DOM 节点有界 = 硬失败（虚拟化失效会直接红）；
//  - JS 堆 usedJSHeapSize = 告警（warn）非硬失败（JIT/GC/CI 抖动大，硬失败会误伤，致团队禁用整个门禁）。
//    当前实现：采样多次（≥3 次 rAF 后取稳定值）+ 超阈值仅 console.warn，不 expect 硬失败。
//
// 阈值口径：launchWithSize 固定 1184×721 内容视口 + OVERSCAN_PX=400（virtual-window.ts）下，虚拟窗口上界
// 保守 ≤60（L-4 修正，对齐 history-viewer-layout.spec.ts 的既有 ≤60 标定）。硬上限是结构性的，非基线×1.5 数值。
//
// 注意（阶段 7 批次 C §4D①/§1.2）：100 分段回复的全部 N 个 segment 都渲染为 `.cy-segment` DOM（行内 segment
// 不经虚拟列表窗口裁剪——虚拟化只裁剪消息「行」，行内 segment 无条件渲染）。故 ② 的 `.cy-segment` 断言为
// 「等于 N（正确性，聚合计数）」而非「≤60（界）」，真正的「有界」断言落在 `.cy-vlist-row`（行级虚拟化）。
// 阶段 7 批次 D：视图感知暂停已落地——视口内完成态全量渲染，滚动出视口延迟（空 source），②该恒可视行不生效。
// 断言仅计数，不读文本/长度。
//
// M-3 例外（阶段7批次D）：③尾差异化断言读 .cy-segment textContent——仅 mock 确定性文本（模拟命中文本 N，
// seedSyntheticHistory 生成，非用户内容），不进日志/导出；非内容侧信道（perf-gate 只用于性能门禁，读的是 mock 种子）。
import { describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, chmodSync, readdirSync, lstatSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Page } from 'playwright'
import { closeApp, launchApp, type LaunchedApp } from './helpers/app'

const POLL = { timeout: 15000, interval: 300 }   // 堆/节点 poll 需更长（大 seed + rAF 稳定）

// 100 分段种子的分段数：既是 CYRENE_MOCK_MULTI_SEGMENT env 注入值，也是 .cy-segment 全量呈现断言目标。
// MUST track mock-backend generateMultiSegmentEvents 的 multiSegmentCount——seed 数变更此处同步，否则断言失效。
const MULTI_SEGMENT_N = 100

// Live2D rAF 停复核的非封闭性守卫：需本机已装配模型（userData/models）。CI 干净镜像无模型时跳过本用例——
// Live2D rAF 停已由 electron-live2d.spec.ts「折叠：live2dShown=false → rAF 无新帧」覆盖，本批仅 7C 复核不重复覆盖。
// 缺失模型时不要硬失败（否则 CI 伪红）。用 existsSync 判目录存在（无模型渲染循环恒不启动，rAF 恒 0，无法测「停」）。
//
// 2026-09-10 修复：原写法 `join(process.env.HOME!, '.config/Cyrene/models')` 在**收集期**求值——
// Windows 上 HOME 未定义（用 USERPROFILE/APPDATA），`path.join(undefined, …)` 抛 TypeError，整个文件加载失败、
// 本 spec 的 4 个用例（含 2 个硬门禁）从未执行；`!` 非空断言恰好把类型检查挡在外面，所以本地看不出来。
// 现按平台解析，公式与 Main 的 userData 解析（main/app/lifecycle.ts expectedUserDataBase()）及装配工具
// scripts/live2d-install.mjs resolveModelsDir() 保持一致（三处同公式，改动须同步）：
//   Windows: %APPDATA%\Cyrene\models ｜ Linux: XDG_CONFIG_HOME ?? $HOME/.config → <base>/Cyrene/models
const homeBaseDir = process.platform === 'win32'
  ? process.env.APPDATA
  : (process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, '.config') : undefined))
const LIVE2D_MODELS = homeBaseDir ? join(homeBaseDir, 'Cyrene', 'models') : ''
const LIVE2D_MODELS_EXIST = LIVE2D_MODELS !== '' && existsSync(LIVE2D_MODELS) && readdirSync(LIVE2D_MODELS).length > 0

// 固定内容视口 1184×721（对齐 history-viewer-layout.spec 的 ≤60 标定；默认窗 1200×760 需 setContentSize）。
// 关键：≤60 的有界上界 = f(1184×721 内容视口, OVERSCAN_PX=400)。改视口/overscan 时须与 history-viewer-layout.spec.ts
// 的 ≤60 标定、virtual-window.ts 的 OVERSCAN_PX 保持同步，否则本上界失效。
// app.evaluate 回调在 Main 执行，尺寸经第二参显式传入（trust-boundary.spec 同款）。
async function launchWithSize(env: Record<string, string>): Promise<LaunchedApp> {
  const launched = await launchApp(undefined, { env })
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h)
  }, { w: 1184, h: 721 } as const)
  await launched.page.waitForFunction(([ww, hh]) => window.innerWidth === ww && window.innerHeight === hh, [1184, 721] as const)
  return launched
}

/** 等 3 次 rAF 稳定（JIT/GC 周期性尖峰采样）后读 JS 堆 + 目标节点聚合计数（仅计数，不读文本/长度——安全 M-3）。 */
async function sample(page: LaunchedApp['page'], selector: string): Promise<{ heap: number; dom: number }> {
  return page.evaluate(async (sel) => {
    await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => requestAnimationFrame(r))
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
    return {
      heap: mem?.usedJSHeapSize ?? 0,
      dom: document.querySelectorAll(sel).length,
    }
  }, selector)
}

/** 连接 → 激活首个会话 → 输入框可用。cy-conversation-main 真点击（对齐 electron-live2d / markdown-xss 先例）。 */
async function connectAndActivateFirst(page: Page): Promise<void> {
  // UII-QQ：连接钮收进连接入口 popover——先点徽标（REAL/MOCK）展开，再点连接（能力不删，入口变更）
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => (document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true)), POLL).toBe(false)
}

describe('性能测量门禁（Task 5；聚合计数仅、安全 M-3）', () => {
  it('① 历史查看器 500 项：真实加载 500 → .cy-history-item DOM 有界（硬失败，≤60）+ 堆告警', async () => {
    const launched = await launchWithSize({ CYRENE_MOCK_HISTORY_LARGE: '500' })
    try {
      const page = launched.page
      await page.getByRole('button', { name: '聊天记录' }).click()
      await page.getByRole('button', { name: '搜索' }).click()
      // 准确性 M-3：submitQuery 默认 limit=50，连点「加载更多」直到 items 全量（500），再进虚拟窗口采样。
      // 以 announceText「找到 N 条相关聊天记录」的 N 单调增长判 drain 进度（每次 +50，50→100→…→500）。
      const readFound = (): Promise<number> => page.evaluate(() => {
        const t = document.querySelector<HTMLElement>('.cy-history .cy-live')?.textContent ?? ''
        const m = t.match(/找到 (\d+) 条/)
        return m ? parseInt(m[1], 10) : -1
      })
      await expect.poll(readFound, POLL).toBeGreaterThanOrEqual(0)
      // 连点「加载更多」到全量 500：每页 limit=50，共 10 页。读 <前> 基线再 click，poll 等 announce N 增长到 >基线，
      // 避免 click 后 busy 置位尚未完成时读回的 prev 已含本页（poll 无法再增长）。
      for (let i = 0; i < 12; i++) {
        const hasMore = await page.locator('.cy-more-btn').count()
        if (hasMore === 0) break
        const prev = await readFound()
        await page.locator('.cy-more-btn').click()
        await expect.poll(readFound, POLL).toBeGreaterThan(prev)   // 等 announce 数字本页 +50
      }
      // 全量 500 后：moreBtn=0（无更多页）。虚拟化后 .cy-history-item 恒 ≤60（实测 5）
      expect(await page.locator('.cy-more-btn').count()).toBe(0)
      const r = await sample(page, '.cy-history-item')
      // DOM 硬失败：虚拟化后 ≤ 可视行×常数（1184×721 + overscan 400 下 ≤60，随 overscan 独立）——500 项不随 500 线性
      expect(r.dom).toBeGreaterThan(0)   // 非空
      expect(r.dom).toBeLessThanOrEqual(60)
      // 堆告警（非硬失败；仅聚合字节尺寸）——超基线×1.5 仅 warn
      const HEAP_WARN_B = 41_000_000
      if (r.heap > HEAP_WARN_B * 1.5) console.warn(`[perf-gate] history500 heap=${r.heap} 超告警阈值（仅告警，非失败）`)
      console.log(`[perf-gate] history500 found=500 dom=${r.dom} heap=${r.heap}`)
    } finally { await closeApp(launched) }
  })

  it('② 100 分段回复流式：全量 N 分段呈现（正确性）+ 消息列表行有界（≤60）+ 回放不停顿', async () => {
    const launched = await launchWithSize({ CYRENE_MOCK_MULTI_SEGMENT: String(MULTI_SEGMENT_N), CYRENE_MOCK_EMIT_DELAY_MS: '1' })
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      // 真实发送触发流式回复（经既有 send 入口）
      await page.locator('textarea[aria-label="消息输入框"]').fill(`测试 ${MULTI_SEGMENT_N} 分段`)
      const assistantsBefore = await page.evaluate(() => document.querySelectorAll('.cy-assistant-row').length)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      // 等 generation.completed（mock 多分段种子回放完成）——「回放不停顿」：N 分段回放不阻塞到 completed。
      //
      // 2026-09-10 修复：原断言读 `.cy-response-cluster .cy-muted` 的 /completed/ 文案，但
      // `c2d92c2`（feat(desktop): 重构 QQ 风格聊天界面）已删除 `.cy-response-cluster`（源码 0 命中），
      // 且 CyMessageBubble 明确「正常 completed 不展示」（UII-QQ 状态噪音清零，terminalNote 仅 failed/
      // interrupted 有文案）——该选择器恒为空串，断言必然超时。改为两个稳定的 DOM 事实：
      // ① 新 assistant 行已创建（乐观/generation.started 即建行，早于完成，不会与「已完成」竞态）；
      // ② 没有任何 assistant 行仍处 streaming（is-streaming 绑定 status==='streaming'，见 CyMessageBubble:154）。
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('.cy-assistant-row').length), POLL).toBeGreaterThan(assistantsBefore)
      await expect.poll(() => page.evaluate(() => document.querySelectorAll('.cy-assistant-row.is-streaming').length), POLL).toBe(0)
      const r = await sample(page, '.cy-segment')
      // 正确性（聚合计数，M-3）：mock 生成恰 MULTI_SEGMENT_N 个 public_reply 分段，completed 后全部渲染为 .cy-segment。
      // 视图感知暂停已落地（7D）：行内 segment 经 CyMessageBubble.needsDeferredRender 门控——视口内完成态全量渲染，
      // 滚动出视口延迟（空 source）；本行所在回复恒跨视口（rowVisible 恒 true），视图感知不生效 → 断言「==N」保持不回退。
      // N 取自上方的 MULTI_SEGMENT_N，与 env 注入同源——seed 数变更此处自动同步，不硬编码 magic literal。
      expect(r.dom).toBe(MULTI_SEGMENT_N)
      // 真正的「有界」落在行级：100 分段挤在单条回复行，消息列表虚拟化后 .cy-vlist-row 恒 ≤60（实测 2）
      const rows = await page.evaluate(() => document.querySelectorAll('.cy-vlist-row').length)
      expect(rows).toBeGreaterThan(0)
      expect(rows).toBeLessThanOrEqual(60)
      // 堆告警（非硬失败；CyMarkdown 缓存吸收重复 parse 的收益靶）
      const HEAP_WARN_B = 40_000_000
      if (r.heap > HEAP_WARN_B * 1.5) console.warn(`[perf-gate] multi100 heap=${r.heap} 超告警阈值（仅告警，非失败）`)
      console.log(`[perf-gate] multi100 seg=${r.dom} rows=${rows} heap=${r.heap}`)
    } finally { await closeApp(launched) }
  })

  it('②b 流式分段全量渲染：streaming 与 completed 滚动出视口均仍渲染（UI 问题1 修复——无几何折叠）', async () => {
    // 同时注入长会话种子：上滚 300px 需要上方有足够历史内容（默认夹具会话只有 2 条，scrollTop 会被钳到 0）
    const launched = await launchWithSize({ CYRENE_MOCK_MULTI_SEGMENT: '60', CYRENE_MOCK_EMIT_DELAY_MS: '40', CYRENE_MOCK_HISTORY_LARGE: '200' })
    try {
      const page = launched.page
      await connectAndActivateFirst(page)
      await page.locator('textarea[aria-label="消息输入框"]').fill('测试 60 分段流式豁免')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      /** 找 streaming assistant 行（DOM 状态文案为 streaming；不含正文内容） */
      const sampleStreaming = () => page.evaluate(() => {
        const cont = document.querySelector<HTMLElement>('.cy-messages')
        if (!cont) return null
        const cRect = cont.getBoundingClientRect()
        const row = [...cont.querySelectorAll<HTMLElement>(':scope > .cy-vlist-row')]
          .find((r) => r.querySelector('.cy-assistant-row.is-streaming') !== null)
        if (!row) return null
        const rect = row.getBoundingClientRect()
        const segs = [...row.querySelectorAll<HTMLElement>('.cy-segment')].map((s) => (s.textContent ?? '').trim())
        return {
          id: row.getAttribute('data-message-id') ?? '',
          status: 'streaming',
          top: Math.round(rect.top - cRect.top),
          clientH: Math.round(cont.clientHeight),
          segs: segs.length,
          nonEmpty: segs.filter((t) => t.length > 0).length,
          empty: segs.length - segs.filter((t) => t.length > 0).length
        }
      })
      // 等 active assistant 行已渲染且至少 1 个 .cy-segment（emit delay 40ms × 60 → 流式窗口 ~2.4s）
      await expect.poll(async () => {
        const r = await sampleStreaming()
        return r !== null && r.segs > 0
      }, POLL).toBe(true)
      // 第一段刚出现时行高仍小：立刻把该行滚到视口下方 ~120px（< 400px overscan，保持渲染）
      await page.evaluate(() => {
        const cont = document.querySelector<HTMLElement>('.cy-messages')
        if (!cont) throw new Error('no .cy-messages')
        const cRect = cont.getBoundingClientRect()
        const row = [...cont.querySelectorAll<HTMLElement>(':scope > .cy-vlist-row')]
          .find((r) => r.querySelector('.cy-assistant-row.is-streaming') !== null)
        if (!row) throw new Error('streaming row not rendered')
        const top = row.getBoundingClientRect().top - cRect.top
        const delta = Math.max(0, cont.clientHeight - top + 120)
        cont.scrollTop = Math.max(0, cont.scrollTop - delta)
        cont.dispatchEvent(new Event('scroll'))
      })
      await page.waitForTimeout(150)   // 滚动后让 visible prop 更新 + CyMarkdown 80ms 尾沿防抖稳定
      const streamingOff = await sampleStreaming()
      expect(streamingOff).not.toBeNull()
      expect(streamingOff!.top).toBeGreaterThanOrEqual(streamingOff!.clientH)   // 完全在视口下方（overscan 内）
      expect(streamingOff!.segs).toBeGreaterThan(0)
      expect(streamingOff!.nonEmpty).toBeGreaterThan(0)   // UI 问题1 修复：视口外也全量渲染真实内容（无骨架/空 source）
      // 后续新 segment 有 CyMarkdown 80ms 尾沿防抖，采样瞬间可存在少数临时空段——只要非全空即证全量渲染
      const mid = streamingOff!.id
      // 等 completed：仍保持视口外 → 内容仍非空（全量渲染，不再折叠/空 source）
      // 2026-09-10 修复：原读 `.cy-response-head .cy-muted` 的 'completed'，同 ② 的根因——该结构与
      // 「completed 不展示」一起被 QQ 重构（c2d92c2）移除，源码 0 命中。改用 is-streaming 消失判定完成。
      await expect.poll(() => page.evaluate((id) => {
        const cont = document.querySelector<HTMLElement>('.cy-messages')
        const row = cont?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        return row != null && !row.classList.contains('is-streaming')
      }, mid), POLL).toBe(true)
      await page.waitForTimeout(150)
      const completedOff = await page.evaluate((id) => {
        const cont = document.querySelector<HTMLElement>('.cy-messages')
        if (!cont) throw new Error('no .cy-messages')
        const cRect = cont.getBoundingClientRect()
        const row = cont.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        if (!row) throw new Error('row not rendered')
        const rect = row.getBoundingClientRect()
        const segs = [...row.querySelectorAll<HTMLElement>('.cy-segment')].map((s) => (s.textContent ?? '').trim())
        return { top: Math.round(rect.top - cRect.top), clientH: Math.round(cont.clientHeight), segs: segs.length, empty: segs.filter((t) => t.length === 0).length }
      }, mid)
      expect(completedOff.top).toBeGreaterThanOrEqual(completedOff.clientH)
      expect(completedOff.segs).toBeGreaterThan(0)
      // UI 问题1 修复：视口外 completed 段不再延迟渲染为「空 source」——虚拟窗口/overscan 内全量渲染真实内容，
      // 消除「完整↔骨架」几何切跳。故视口外行内容仍非空（empty=0）。
      expect(completedOff.empty).toBe(0)
      // 滚回底部 → 全部恢复非空（正确性不回退）
      await page.evaluate(() => {
        const c = document.querySelector<HTMLElement>('.cy-messages')
        if (!c) throw new Error('no .cy-messages')
        c.scrollTop = c.scrollHeight
        c.dispatchEvent(new Event('scroll'))
      })
      await expect.poll(() => page.evaluate((id) => {
        const cont = document.querySelector<HTMLElement>('.cy-messages')
        const row = cont?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        return row?.querySelectorAll('.cy-segment').length ?? 0
      }, mid), POLL).toBe(60)
      await page.waitForTimeout(150)
      const visibleFull = await page.evaluate((id) => {
        const cont = document.querySelector<HTMLElement>('.cy-messages')
        if (!cont) throw new Error('no .cy-messages')
        const row = cont.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        if (!row) throw new Error('row not rendered')
        const segs = [...row.querySelectorAll<HTMLElement>('.cy-segment')].map((s) => (s.textContent ?? '').trim())
        return { segs: segs.length, empty: segs.filter((t) => t.length === 0).length }
      }, mid)
      expect(visibleFull.segs).toBe(60)
      expect(visibleFull.empty).toBe(0)
    } finally { await closeApp(launched) }
  })

  it('③ 长会话（seed ≥100）：消息列表可视行有界 + 虚拟垫片不收缩（真机修复回归门禁）', async () => {
    const launched = await launchWithSize({ CYRENE_MOCK_HISTORY_LARGE: '200' })
    try {
      const page = launched.page
      // 激活种子会话（conversation list 首会话 = conv-1001）→ activate → getConversationMessages 返回该会话 records。
      // 准确 r2 注：seedSyntheticHistory 按 i%2 均分 conv-1001/conv-1002，200 条 seed 下单会话约 100 条——
      // 断言「可视行有界」而非「恰好 200 条」，100 条已足够验证虚拟化窗口（> 可视窗口 60）。
      await connectAndActivateFirst(page)
      // 消息列表虚拟化：可视行有界（seed 均分后>100 条，但可视行 ≤ 窗口），且 >0（非空）
      await expect.poll(async () => page.evaluate(() => document.querySelectorAll('.cy-messages > .cy-vlist-row').length), POLL).toBeGreaterThan(0)
      const rows = await page.evaluate(() => document.querySelectorAll('.cy-messages > .cy-vlist-row').length)
      expect(rows).toBeGreaterThan(0)
      expect(rows).toBeLessThanOrEqual(60)   // 可视行有界（虚化，非全量 100+；实测 26）
      // 7C 真机修复回归：flex 列内的虚拟垫片不得被 flex-shrink 压成 0（否则 scrollHeight 不含估算总高，
      // 长会话滚不到底部新消息——Windows 真机 56 条即复现，补 flex-shrink:0 后修复）。
      const pads = await page.evaluate(() => {
        const el = document.querySelector('.cy-messages')
        if (!el) return null
          const list = [...el.querySelectorAll(':scope > .cy-vlist-pad')]
          const heights = list.map((p) => Number.parseFloat(getComputedStyle(p).height))
          return {
            flexShrink: list.map((p) => getComputedStyle(p).flexShrink),
            topHeight: heights[0] ?? 0,
            bottomHeight: heights[1] ?? 0,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight
          }
        })
        expect(pads).not.toBeNull()
        expect(pads!.flexShrink).toHaveLength(2)
        expect(pads!.flexShrink.every((v) => v === '0')).toBe(true)
        expect(pads!.scrollHeight).toBeGreaterThan(pads!.clientHeight)
        expect(Math.max(pads!.topHeight, pads!.bottomHeight)).toBeGreaterThan(0)
        console.log(`[perf-gate] long200 rows=${rows} padTop=${pads?.topHeight}px padBottom=${pads?.bottomHeight}px sh=${pads?.scrollHeight}`)
        // UI 问题1 修复：视口外行不再延迟渲染（无「空 source .cy-segment」）——虚拟窗口/overscan 内全量渲染真实内容。
        // 断言：所有已渲染 .cy-segment 皆非空（无几何折叠），视口内/外一致。
        const segs = await page.evaluate(() => {
          const out = { total: 0, empty: 0, nonEmpty: 0 }
          document.querySelectorAll('.cy-messages .cy-segment').forEach((s) => {
            out.total++
            if ((s.textContent ?? '').trim().length > 0) out.nonEmpty++; else out.empty++
          })
          return out
        })
        expect(segs.total).toBeGreaterThan(0)
        expect(segs.empty).toBe(0)   // 全量渲染：视口外无「空 source」段（几何稳定，不折叠）
        // 视口内回复非空（门控只影响视口外行）
        expect(segs.nonEmpty).toBeGreaterThan(0)
        // 7D 真机回归：border-box 实测高修复前，前缀和每行欠估 12px（padding 未计）→ strict 窗口偏前，
        // 视口边缘出现「行已与视口相交但 completed segment 仍空 source」。UI 问题1 修复后全量渲染，
        // 任何与视口相交的 .cy-vlist-row 内不得有空 .cy-segment（无几何折叠）。
        await page.waitForTimeout(150)   // CyMarkdown 80ms 尾沿防抖 + ResizeObserver 实测高写入 → 让可见性翻转/行高补偿先稳定
        const visibleBlank = await page.evaluate(() => {
          const el = document.querySelector('.cy-messages')
          if (!el) return []
          const cRect = el.getBoundingClientRect()
          const bad: string[] = []
          el.querySelectorAll(':scope > .cy-vlist-row').forEach((row) => {
            const rect = row.getBoundingClientRect()
            if (rect.bottom <= cRect.top || rect.top >= cRect.bottom) return
            row.querySelectorAll('.cy-segment').forEach((s) => {
              if ((s.textContent ?? '').trim().length === 0) bad.push(`${row.getAttribute('data-message-id')?.slice(-6)}@${Math.round(rect.top - cRect.top)}`)
            })
          })
          return bad
        })
        expect(visibleBlank).toEqual([])
        console.log(`[perf-gate] viewsense seg total=${segs.total} empty=${segs.empty} nonEmpty=${segs.nonEmpty} visibleBlank=${visibleBlank.length}`)
    } finally { await closeApp(launched) }
  })

  it.skipIf(!LIVE2D_MODELS_EXIST)('④ Live2D 折叠后 rAF 停（7C 复核，维持现状——collapse 不 dispose，rAF 停；无模型时跳过）', async () => {
    // 偏差：.cy-live2d-toggle 类不存在——折叠按钮实为 .cy-live-min（aria-label="折叠角色栏"，CyLive2DPanel.vue:280）。
    // 且 Live2D 渲染循环需已装配模型；普通 mkdtemp userData 无模型 → 状态为「静态头像回退」，rAF 恒 0（无法区分「停」与「从未启动」）。
    // 故克隆本机已装配模型（LIVE2D_MODELS）到独立 userData，再 force SwiftShader 软渲染。
    // CI 无模型时（LIVE2D_MODELS_EXIST=false）本用例被 skipIf 跳过——rAF 停已由 electron-live2d.spec.ts 覆盖。
    const ud = mkdtempSync(join(tmpdir(), 'cy-l2d-ud-'))
    cpSync(LIVE2D_MODELS, join(ud, 'Cyrene/models'), { recursive: true })
    const chmodTree = (p: string, mode: number): void => {
      try { chmodSync(p, mode); lstatSync(p) } catch { /* 尽力 */ }
      for (const name of readdirSync(p)) {
        const child = join(p, name)
        try { if (lstatSync(child).isDirectory()) chmodTree(child, mode) } catch { /* 尽力 */ }
      }
    }
    chmodTree(ud, 0o700)
    const launched = await launchApp(undefined, { userData: ud, extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    try {
      const page = launched.page
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-live-status')?.textContent ?? ''), POLL).toMatch(/就绪|回退|失败/)
      // 包裹 requestAnimationFrame 计数（须在渲染循环激活前注入）
      await page.evaluate(() => {
        const w = window as unknown as { __rafCalls: number; __origRaf: typeof requestAnimationFrame }
        w.__rafCalls = 0
        const orig = requestAnimationFrame.bind(window)
        w.__origRaf = orig
        window.requestAnimationFrame = (cb) => { w.__rafCalls++; return orig(cb) }
      })
      // 折叠前渲染循环确实在跑（rAF 计数 >0）
      await expect.poll(() => page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls), POLL).toBeGreaterThan(0)
      // 真实点击折叠按钮（aria-label 折叠角色栏）
      await page.getByRole('button', { name: '折叠角色栏' }).click()
      await expect.poll(() => page.locator('.cy-live').isVisible(), POLL).toBe(false)   // v-show 隐藏
      const before = await page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls)
      await page.waitForTimeout(300)
      const after = await page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls)
      expect(after - before).toBe(0)   // rAF 停（维持现状，不 dispose）
      expect((await page.evaluate(() => document.querySelector('.cy-live-status')?.textContent ?? '')).length).toBeGreaterThan(0) // 面板仍在 DOM（隐藏态）
      console.log(`[perf-gate] live2d rafBefore=${before} rafAfter=${after} delta=${after - before}`)
    } finally { await closeApp(launched) }
  })
})
