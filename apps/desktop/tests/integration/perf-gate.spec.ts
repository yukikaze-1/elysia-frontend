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
// 注意（与本批 spec §4D①/§1.2 L40 一致，见报告「偏差」）：100 分段回复的全部 N 个 segment 都渲染为
// `.cy-segment` DOM（行内 segment 不经虚拟列表窗口裁剪——虚拟化只裁剪消息「行」，行内 segment 无条件渲染，
// spec 记录为新观察项「视图感知暂停」）。故 ② 的 `.cy-segment` 断言为「等于 N（正确性，聚合计数）」而非
// 「≤60（界）」，真正的「有界」断言落在 `.cy-vlist-row`（行级虚拟化）。断言仅计数，不读文本/长度。
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

// Live2D rAF 停复核的非封闭性守卫：需本机已装配模型（~/.config/Cyrene/models）。CI 干净镜像无模型时跳过本用例——
// Live2D rAF 停已由 electron-live2d.spec.ts「折叠：live2dShown=false → rAF 无新帧」覆盖，本批仅 7C 复核不重复覆盖。
// 缺失模型时不要硬失败（否则 CI 伪红）。用 existsSync 判目录存在（无模型渲染循环恒不启动，rAF 恒 0，无法测「停」）。
const LIVE2D_MODELS = join(process.env.HOME!, '.config/Cyrene/models')
const LIVE2D_MODELS_EXIST = existsSync(LIVE2D_MODELS) && readdirSync(LIVE2D_MODELS).length > 0

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
      await page.getByRole('button', { name: '发送', exact: true }).click()
      // 等 generation.completed（mock 多分段种子回放完成）——「回放不停顿」：N 分段回放不阻塞到 completed
      await expect.poll(() => page.evaluate(() => document.querySelector('.cy-response-cluster .cy-muted')?.textContent ?? ''), POLL).toMatch(/completed/)
      const r = await sample(page, '.cy-segment')
      // 正确性（聚合计数，M-3）：mock 生成恰 MULTI_SEGMENT_N 个 public_reply 分段，completed 后全部渲染为 .cy-segment。
      // 注意：行内 segment 不经虚拟列表窗口裁剪（spec §1.2 观察项「视图感知暂停」）——故断言「==N 全量呈现」而非「≤60」。
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

  it('③ 长会话（seed ≥100）：消息列表可视行有界（虚拟窗口，非全量 DOM，≤60）', async () => {
    const launched = await launchWithSize({ CYRENE_MOCK_HISTORY_LARGE: '200' })
    try {
      const page = launched.page
      // 激活种子会话（conversation list 首会话 = conv-1001）→ activate → getConversationMessages 返回该会话 records。
      // 准确 r2 注：seedSyntheticHistory 按 i%2 均分 conv-1001/conv-1002，200 条 seed 下单会话约 100 条——
      // 断言「可视行有界」而非「恰好 200 条」，100 条已足够验证虚拟化窗口（> 可视窗口 60）。
      await connectAndActivateFirst(page)
      // 消息列表虚拟化：可视行有界（seed 均分后>100 条，但可视行 ≤ 窗口），且 >0（非空）
      await expect.poll(async () => page.evaluate(() => document.querySelectorAll('.cy-vlist-row').length), POLL).toBeGreaterThan(0)
      const rows = await page.evaluate(() => document.querySelectorAll('.cy-vlist-row').length)
      expect(rows).toBeGreaterThan(0)
      expect(rows).toBeLessThanOrEqual(60)   // 可视行有界（虚化，非全量 100+；实测 26）
      console.log(`[perf-gate] long200 rows=${rows}`)
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
