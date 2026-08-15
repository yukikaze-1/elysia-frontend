# FE-S3-RUN2-P1-01 历史查看器布局修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复历史查看器模态框被结果撑高、`加载更多` 不可达的布局问题（纯 CSS 容器约束 + loadMore 滚动锚点补偿），并补真实 Electron 布局/点击集成测试，mock 数据基建支撑 100 条测试前提。

**Architecture:** 三处改动各司其职——① mock-backend.ts 增加 `seedHistoryCount` 选项 + `CYRENE_MOCK_HISTORY_LARGE` env 透传 + 分页语义与 real 对齐（DESC 源切片 + 页内升序），为集成测试提供 ≥100 条确定性历史；② CyHistoryViewer.vue 纯 CSS 容器约束（overlay grid→flex + 面板 min-height:0 + 结果区 flex:1/overflow-y:auto/overflow-anchor:none + 固定兄弟 flex-shrink:0）+ 组件层 loadMore 滚动锚点精确补偿；③ 新集成测试三用例（1184×721 / 1100×700 / 空结果态）用真实 Playwright 点击验证布局与锚点。

**Tech Stack:** Vue 3 (script setup) / Electron / Playwright `_electron` / Vitest / pnpm workspace shims。

**Spec:** [docs/superpowers/specs/2026-08-15-phase3-rerun2-layout-design.md](../specs/2026-08-15-phase3-rerun2-layout-design.md)（权威设计；plan 从 spec 论证，executor 须同时读 spec 与 plan）

## Global Constraints

- **不改后端分页大小 / 不截断 / 不改变 cursor 或 sortKey 排序语义**（清单 §3.4.7）；**不改 store 数据逻辑**（`historyViewer.store.ts` loadMore 合并/去重/升序重排维持现状）。
- **`.cy-history-results` 必须 `overflow-anchor: none`**——否则 Chromium 原生滚动锚定会掩盖手动补偿、使 step 8 断言假绿（spec §4.2）。
- **集成测试纪律**（清单 §3.5）：用 Playwright 普通 `locator.click()`，**禁止 `{ force: true }` / DOM `.click()` / 直调 store**；锚点断言为**精确偏移保留（≤1px）**，非「可见」。
- mock 默认（未设置 `seedHistoryCount`）行为不变：仍 5 条 seed；`parseMockHistoryCountEnv` 语义：`undefined/空串→undefined`、正整数→原值、`0/负数/NaN/非整数→120`（不允许空 seed）。
- `seedHistoryCount` 必须以**字段声明式**在 `messageRecords` **之前**声明（字段初始化器先于构造函数体执行，spec §4.3.1）。
- 阶段 3 状态保持「已开发、未联调」（真实 Windows Electron 回归是验收方）。
- 门禁必须全绿：`pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm test` / `pnpm test:integration` / `pnpm -F @cyrene/desktop check:contract`（WS 13/13 + REST 8/8；本批不触 wire schema）。

---

### Task 1: Mock 历史数据基建（seedHistoryCount + env 解析 + 分页语义对齐）

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（`MockBackendOptions`、`MockBackend` 字段顺序、`seedMessages()`、`queryChatHistory()`；新增导出 `parseMockHistoryCountEnv`）
- Modify: `apps/desktop/src/main/index.ts:139`（Mock 装配读 env 透传 `seedHistoryCount`）
- Create: `apps/desktop/tests/unit/mock-backend-seed.spec.ts`

**Interfaces:**
- Consumes: 无（独立自足）。
- Produces: `parseMockHistoryCountEnv(value: string | undefined): number | undefined`（export，mock-backend.ts）；`MockBackendOptions.seedHistoryCount?: number`；`CYRENE_MOCK_HISTORY_LARGE` env → `seedHistoryCount`；mock `queryChatHistory` 新语义（第一页=最新 50 条页内升序、第二页=更旧 50 条、`mock:{offset}` cursor）。Task 3 的集成测试依赖这些。

- [ ] **Step 1: 写失败的单元测试** `apps/desktop/tests/unit/mock-backend-seed.spec.ts`

```ts
// tests/unit/mock-backend-seed.spec.ts
// Task 1: MockBackend.seedHistoryCount + parseMockHistoryCountEnv + 分页语义对齐 real（spec §4.3）
import { describe, expect, it } from 'vitest'
import { MockBackend, parseMockHistoryCountEnv } from '../../src/main/transport/mock-backend'

const NOW = new Date('2026-08-14T04:00:00.000Z')
let idCounter = 0
function mkSeed(count: number): MockBackend {
  idCounter = 0
  return new MockBackend({ seedHistoryCount: count, now: () => NOW, idFactory: () => `id${++idCounter}` })
}
const Q = { scope: { type: 'all_conversations' } as const, timeZone: 'UTC', category: 'all' as const }

describe('parseMockHistoryCountEnv（spec §4.3.1）', () => {
  it('undefined/空串 → undefined（不开大 seed）', () => {
    expect(parseMockHistoryCountEnv(undefined)).toBeUndefined()
    expect(parseMockHistoryCountEnv('')).toBeUndefined()
    expect(parseMockHistoryCountEnv('  ')).toBeUndefined()
  })
  it('正整数 → 原值', () => {
    expect(parseMockHistoryCountEnv('120')).toBe(120)
    expect(parseMockHistoryCountEnv('1')).toBe(1)
  })
  it('0/负数/NaN/非整数 → 默认 120（不允许空 seed）', () => {
    expect(parseMockHistoryCountEnv('0')).toBe(120)
    expect(parseMockHistoryCountEnv('-3')).toBe(120)
    expect(parseMockHistoryCountEnv('abc')).toBe(120)
    expect(parseMockHistoryCountEnv('120.5')).toBe(120)
  })
})

describe('MockBackend.seedHistoryCount 大 seed（spec §4.3.1）', () => {
  it('120 条确定性合成集：唯一 hitId、跨 ≥2 自然日、单调 createdAt、无 sticker、纯文本', async () => {
    const mb = mkSeed(120)
    const all = await mb.queryChatHistory({ ...Q, limit: 200 })
    expect(all.items).toHaveLength(120)
    expect(all.items[0].hitId).toBe('conv-1001:run2-msg-0001:')
    expect(new Set(all.items.map((i) => i.hitId)).size).toBe(120)
    expect(new Set(all.items.map((i) => i.createdAt.slice(0, 10))).size).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < all.items.length; i++) expect(all.items[i].createdAt >= all.items[i - 1].createdAt).toBe(true)
    expect(all.items.some((i) => i.resource?.kind === 'sticker')).toBe(false)
    expect(all.items.every((i) => i.snippet?.startsWith('模拟命中文本'))).toBe(true)
  })
  it('分页对齐 real：第一页=最新 50（页内升序）、第二页=更旧 50、合并后首屏 50 相对顺序保持、去重', async () => {
    const mb = mkSeed(120)
    const p1 = await mb.queryChatHistory({ ...Q, limit: 50 })
    expect(p1.items).toHaveLength(50)
    expect(p1.hasMore).toBe(true)
    const p1Keys = p1.items.map((i) => i.sortKey)
    expect([...p1Keys].sort()).toEqual(p1Keys)                 // 页内升序
    const p2 = await mb.queryChatHistory({ ...Q, limit: 50, cursor: p1.nextCursor })
    expect(p2.items).toHaveLength(50)
    expect(p2.items[p2.items.length - 1].sortKey < p1.items[0].sortKey).toBe(true)  // 第二页更旧
    const merged = [...p1.items, ...p2.items].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    expect(merged).toHaveLength(100)
    const p1HitIds = new Set(p1.items.map((i) => i.hitId))
    expect(merged.filter((i) => p1HitIds.has(i.hitId))).toEqual(p1.items)  // 首屏 50 相对顺序保持（子序列）
    expect(new Set(merged.map((i) => i.hitId)).size).toBe(100)             // 去重
  })
  it('默认（未设置 seedHistoryCount）行为不变：仍 5 条默认 seed', async () => {
    idCounter = 0
    const mb = new MockBackend({ now: () => NOW, idFactory: () => `id${++idCounter}` })
    const all = await mb.queryChatHistory({ ...Q, limit: 200 })
    expect(all.items).toHaveLength(5)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /home/yomu/elysia-frontend && pnpm -F @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/mock-backend-seed.spec.ts 2>&1 | tail -20`
Expected: **运行时报错**（`parseMockHistoryCountEnv is not a function`）或断言失败（`seedHistoryCount` 无效果）。vitest 用 esbuild 转译不 typecheck，红态为运行时/断言失败，非编译失败（typecheck 由独立 tsc/vue-tsc 承担）。

- [ ] **Step 3: mock-backend.ts 实现**

1) `MockBackendOptions` 增加：
```ts
  /** 大 seed：设置时 seedMessages() 返回确定性合成历史（spec §4.3.1）；默认 undefined 保持 5 条 */
  seedHistoryCount?: number
```

2) 新增导出纯函数（文件内 `kindFromMimeForMock` 之后、`MockBackendOptions` 之前或同区域）：
```ts
/** CYRENE_MOCK_HISTORY_LARGE env → seedHistoryCount：undefined/空串→undefined（不开）；
 *  正整数→原值；0/负数/NaN/非整数→120（「大」语义兜底，不允许空 seed，spec §4.3.1） */
export function parseMockHistoryCountEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  if (Number.isInteger(n) && n > 0) return n
  return 120
}
```

3) `MockBackend` 类内，**在 `messageRecords` 字段声明之前**新增 `seedHistoryCount` 字段声明（字段初始化器按声明顺序执行，`seedMessages()` 才能读到；spec §4.3.1 顺序约束）：
```ts
  /** 大 seed 条数（字段声明式，须先于 messageRecords 初始化；spec §4.3.1） */
  private readonly seedHistoryCount = options.seedHistoryCount ?? 0
  /** 历史记录（预置样例 + sendMessage 追加；查看器 Mock 全链路数据源） */
  private readonly messageRecords: Message[] = this.seedMessages()
```

4) `seedMessages()` 增加大 seed 分支 + 新增合成方法：
```ts
  private seedMessages(): Message[] {
    if (this.seedHistoryCount > 0) return this.seedSyntheticHistory(this.seedHistoryCount)
    const mk = (messageId: string, conversationId: string, role: 'user' | 'assistant', createdAt: string, content?: string, stickerId?: string): Message =>
      ({ messageId, conversationId, role, createdAt, status: 'completed', ...(content !== undefined ? { content } : {}), ...(stickerId ? { stickerId } : {}) })
    return [
      mk('msg-1001', 'conv-1001', 'user', '2026-08-14T02:00:00.000Z', '你好，帮我总结一下'),
      mk('msg-1002', 'conv-1001', 'assistant', '2026-08-14T02:00:10.000Z', '好的，正在总结……'),
      mk('msg-1003', 'conv-1001', 'user', '2026-08-13T09:00:00.000Z', '发个表情', 'st_1'),
      mk('msg-1004', 'conv-1002', 'user', '2026-08-07T01:30:00.000Z', '历史会话的问题'),
      mk('msg-1005', 'conv-1002', 'assistant', '2026-08-07T01:31:00.000Z', '这是历史会话的回复')
    ]
  }

  /** 确定性合成历史（spec §4.3.1）：30 条/日 × 若干日、createdAt 单调、纯文本无 sticker */
  private seedSyntheticHistory(count: number): Message[] {
    const mk = (messageId: string, conversationId: string, role: 'user' | 'assistant', createdAt: string, content: string): Message =>
      ({ messageId, conversationId, role, createdAt, status: 'completed', content })
    const DAY = 86_400_000, MIN = 60_000
    const base = new Date('2026-08-08T00:00:00.000Z').getTime()
    const out: Message[] = []
    for (let i = 0; i < count; i++) {
      const day = Math.floor(i / 30), minute = i % 30
      const createdAt = new Date(base + day * DAY + minute * MIN).toISOString()
      out.push(mk(`run2-msg-${String(i + 1).padStart(4, '0')}`, i % 2 === 0 ? 'conv-1001' : 'conv-1002', i % 2 === 0 ? 'user' : 'assistant', createdAt, `模拟命中文本 ${i + 1}`))
    }
    return out
  }
```

5) `queryChatHistory` 分页语义对齐（spec §4.3.2）：过滤后先 DESC 切片、再页内升序返回。替换现有 `.sort(...)` + `slice`：
```ts
  async queryChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryPage> {
    const filtered = this.messageRecords
      .filter((m) => input.scope.type === 'all_conversations' || m.conversationId === input.scope.conversationId)
      .filter((m) => !input.query || (m.content ?? '').toLowerCase().includes(input.query.toLowerCase()))
      .filter((m) => !input.localDate || isoToLocalDate(m.createdAt, input.timeZone) === input.localDate)
      .filter((m) => categoryMatches(m, input.category))
      .map((m) => this.toHistoryItem(m))
      .sort((a, b) => (a.sortKey > b.sortKey ? -1 : a.sortKey < b.sortKey ? 1 : 0)) // DESC：最新在前（real keyset 同构）
    let offset = 0
    if (input.cursor?.startsWith('mock:')) offset = Number(input.cursor.slice(5)) || 0
    const page = filtered.slice(offset, offset + input.limit)
    const items = [...page].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)) // 页内升序返回（real transport 后序一致）
    const nextOffset = offset + input.limit
    return { items, hasMore: nextOffset < filtered.length, nextCursor: nextOffset < filtered.length ? `mock:${nextOffset}` : undefined }
  }
```

- [ ] **Step 4: index.ts 装配透传（spec §4.3.3）**

`apps/desktop/src/main/index.ts`：
1) 顶部 import 增加 `parseMockHistoryCountEnv`：
```ts
import { MockBackend, parseMockHistoryCountEnv } from './transport/mock-backend'
```
2) Mock 装配分支（现 :138-139）：
```ts
    const mockHistoryCount = parseMockHistoryCountEnv(process.env.CYRENE_MOCK_HISTORY_LARGE)
    const adapter: BackendAdapter = useMock
      ? new MockBackend({ onConnectionStateChange: onState, ...(mockHistoryCount !== undefined ? { seedHistoryCount: mockHistoryCount } : {}) })
```
（`mockHistoryCount` 常量声明放在 `const useMock` 之后。）

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /home/yomu/elysia-frontend && pnpm -F @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/mock-backend-seed.spec.ts tests/unit/mock-backend-search.spec.ts 2>&1 | tail -25`
Expected: 新 spec 全过；`mock-backend-search.spec.ts` 5+3 用例**不回归**（DESC 切片后页内仍升序、关键词/sticker/自然日/游标断言仍成立）。

- [ ] **Step 6: 门禁 + 提交**

Run: `cd /home/yomu/elysia-frontend && pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -5`
Expected: typecheck/lint 绿；unit 全绿。
```bash
cd /home/yomu/elysia-frontend && git add apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/mock-backend-seed.spec.ts && git commit -m "feat(阶段3 真实联调第二轮): mock 历史数据基建——seedHistoryCount + CYRENE_MOCK_HISTORY_LARGE env + 分页语义对齐 real"
```

---

### Task 2: 历史查看器 CSS 容器约束 + loadMore 滚动锚点补偿

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyHistoryViewer.vue`（CSS §4.1、`resultsEl` ref、`onLoadMorePreservingAnchor()`、footer 按钮接线）
- Modify: `apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue`（`<li>` 加 `:data-hit-id`）

**Interfaces:**
- Consumes: 无（store `loadMore()` 既有签名 `(): Promise<void>` 零改动）。
- Produces: `.cy-history-item[data-hit-id]`（Task 3 锚点定位用）；`resultsEl` ref（`HTMLElement | undefined`）；`onLoadMorePreservingAnchor(): Promise<void>`（footer `加载更多` 的 click 处理器）。

- [ ] **Step 1: CyHistoryResultItem.vue 加 data-hit-id**

`apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue:25` 模板第一行：
```html
  <li class="cy-history-item" :data-hit-id="hit.hitId">
```

- [ ] **Step 2: CyHistoryViewer.vue CSS 容器约束（spec §4.1，方案 A）**

1) `.cy-history-overlay`（现 :173-181）`display: grid; place-items: center;` 改为 flex 居中（消除 grid area 百分比环）：
```css
.cy-history-overlay {
  position: fixed;
  inset: 36px 0 0 60px;   /* 保留标题栏(36px)与导航栏(60px,NAV_WIDTH) */
  z-index: 50;
  display: flex;           /* grid → flex：max-height 百分比恢复确定性（spec §4.1 方案 A） */
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--cy-window) 70%, transparent);
  backdrop-filter: blur(2px);
}
```
2) `.cy-history`（现 :182-192）加 `min-height: 0`（grid/flex item 允许收缩到内容以下，使 max-height 生效）：
```css
.cy-history {
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100% - 48px));
  max-height: calc(100% - 48px);
  min-height: 0;           /* 允许收缩：面板不再被内容撑破 max-height（spec §4.1） */
  padding: 14px;
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  border-radius: 16px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);
}
```
3) `.cy-history-results`（现 :208）加 flex 尺寸 + `overflow-anchor: none`（保留 `min-height:120px` 下限与内部 grid 布局）：
```css
.cy-history-results { flex: 1 1 0; display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; overflow-y: auto; overflow-anchor: none; min-height: 120px; }
```
4) 新增固定兄弟 `flex-shrink:0` 规则（header/filters/tabs/live/error/state/footer 不随结果挤压/滚出）：
```css
.cy-history-header, .cy-history-filters, .cy-history-tabs, .cy-live, .cy-history-error, .cy-history-state, .cy-history-footer { flex-shrink: 0; }
```
（放在 `.cy-history-footer` 规则附近。）

- [ ] **Step 3: CyHistoryViewer.vue 脚本——resultsEl + onLoadMorePreservingAnchor（spec §4.2）**

1) `import { computed, nextTick, ... }` 已有 `nextTick`? 现 import 行（:5）为 `import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'` —— **确认 `nextTick` 已在其中；若没有则补上**。
2) 新增 ref（`const store` 声明附近）：
```ts
const resultsEl = ref<HTMLElement>()
interface AnchorRef { hitId: string; offsetTop: number }
```
3) 新增组件方法（`onEnter` 附近）：
```ts
/** FE-S3-RUN2-P1-01：加载第二页前捕获首个可见项 + 视口内偏移，DOM 更新后补偿 scrollTop
 *  （spec §4.2；边界日期组前插的真实扰动点，配合 .cy-history-results overflow-anchor:none 成为唯一调整机制） */
async function onLoadMorePreservingAnchor(): Promise<void> {
  const c = resultsEl.value
  let anchor: AnchorRef | undefined
  if (c) {
    const cr = c.getBoundingClientRect()
    const firstVisible = [...c.querySelectorAll<HTMLElement>('.cy-history-item')]
      .find((el) => el.getBoundingClientRect().bottom > cr.top)
    if (firstVisible) {
      const hitId = firstVisible.dataset.hitId
      if (hitId) anchor = { hitId, offsetTop: firstVisible.getBoundingClientRect().top - cr.top }
    }
  }
  await store.loadMore()
  if (c && anchor) {
    await nextTick()
    const el = c.querySelector<HTMLElement>(`[data-hit-id="${anchor.hitId}"]`)
    if (el) {
      const cr = c.getBoundingClientRect()
      c.scrollTop += el.getBoundingClientRect().top - cr.top - anchor.offsetTop
    }
  }
}
```
4) `<ul class="cy-history-results">`（模板 :156）加 `ref="resultsEl"`：
```html
        <ul v-else ref="resultsEl" class="cy-history-results">
```
5) footer 按钮（模板 :164）接线：
```html
          <button v-if="store.hasMore && !store.loadingMore" class="cy-more-btn" @click="onLoadMorePreservingAnchor()">加载更多</button>
```

- [ ] **Step 4: 门禁（本任务无 jsdom 单测——布局以 Task 3 真实 Electron 集成测试为准）**

Run: `cd /home/yomu/elysia-frontend && pnpm typecheck && pnpm lint && pnpm build 2>&1 | tail -5`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
cd /home/yomu/elysia-frontend && git add apps/desktop/src/renderer/src/components/CyHistoryViewer.vue apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue && git commit -m "fix(阶段3 真实联调第二轮): 历史查看器面板定高 + 结果区内部滚动 + loadMore 锚点补偿（FE-S3-RUN2-P1-01）"
```

---

### Task 3: 历史查看器布局/点击集成测试（三用例）

**Files:**
- Create: `apps/desktop/tests/integration/history-viewer-layout.spec.ts`

**Interfaces:**
- Consumes: `launchApp(seedFiles?, opts?: { env })`（helpers/app.ts，`opts.env` 已支持）；Task 1 的 `CYRENE_MOCK_HISTORY_LARGE=120` 大 seed；Task 2 的 `.cy-history-item[data-hit-id]` / `resultsEl` / `onLoadMorePreservingAnchor` / `overflow-anchor:none`。
- Produces: 三个 `it` 用例（1184×721 主档 / 1100×700 最小档 / 空结果态），作为 FE-S3-RUN2-P1-01 的自动化验收。

- [ ] **Step 1: 写集成测试**

```ts
// tests/integration/history-viewer-layout.spec.ts
// FE-S3-RUN2-P1-01：历史查看器面板被结果撑高 → 加载更多不可达。真实 Electron 布局 + 点击集成测试。
// 夹具：CYRENE_MOCK_HISTORY_LARGE=120 大 seed（Task 1）；测试侧 setContentSize 固定真实 viewport（决策 D3）。
// 纪律：locator.click() 真点击，禁 force/DOM .click()/直调 store（清单 §3.5）。
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { closeApp, launchApp, type LaunchedApp } from './helpers/app'

async function launchWithSize(w: number, h: number): Promise<LaunchedApp> {
  const launched = await launchApp(undefined, { env: { CYRENE_MOCK_HISTORY_LARGE: '120' } })
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(w, h)
  })
  await launched.page.waitForFunction(([ww, hh]) => window.innerWidth === ww && window.innerHeight === hh, [w, h] as const)
  return launched
}

const POLL = { timeout: 5000, interval: 200 } // 对齐套件先例（trust-boundary.spec.ts 同款；expect.poll 默认 1000ms 太紧）

async function openAndSearch50(page: Page): Promise<void> {
  await page.getByRole('button', { name: '聊天记录' }).click()
  await page.getByRole('button', { name: '搜索' }).click()
  await expect.poll(async () => page.locator('.cy-history-item').count(), POLL).toBe(50)
}

const readBoxes = (page: Page) => page.evaluate(() => {
  const b = (sel: string) => { const r = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }
  return { vp: { w: window.innerWidth, h: window.innerHeight }, header: b('.cy-history-header'), panel: b('.cy-history'), footer: b('.cy-history-footer'), btn: b('.cy-more-btn') }
})

describe('历史查看器布局（FE-S3-RUN2-P1-01）', () => {
  it('1184×721：面板完整在视口内、真点击加载第二页 100 条且顺序/去重/锚点偏移保留', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      const page = launched.page
      await openAndSearch50(page)
      const before = await readBoxes(page)
      for (const k of ['panel', 'footer', 'btn', 'header'] as const) {
        expect(before[k].top).toBeGreaterThanOrEqual(0)
        expect(before[k].bottom).toBeLessThanOrEqual(before.vp.h)
      }
      // overflow-anchor:none 生效（spec §4.2 配套：防止 Chromium 原生锚定掩盖 §4.2 手动补偿 → step 8 假绿）
      const anchorMode = await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('.cy-history-results')!).overflowAnchor)
      expect(anchorMode).toBe('none')
      // 4) 结果区内部滚动到跨页边界日期组（spec §4.4 step 4；合成数据下 0.7×scrollHeight 对任意条目高恒落边界组，故弃用 spec 的「动态下移」防御子句）
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.cy-history-results')!
        el.scrollTop = el.scrollHeight * 0.7
      })
      await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLElement>('.cy-history-results')!.scrollTop), POLL).toBeGreaterThan(0)
      const afterScroll = await readBoxes(page)
      expect(afterScroll.header.top).toBeCloseTo(before.header.top, 0)    // header 不随内容滚出
      expect(afterScroll.footer.bottom).toBeCloseTo(before.footer.bottom, 0)
      // 5) 捕获锚点：首个可见项 hitId + 精确 offsetTop + first50 DOM 序
      const anchor = await page.evaluate(() => {
        const c = document.querySelector<HTMLElement>('.cy-history-results')!
        const cr = c.getBoundingClientRect()
        const item = [...c.querySelectorAll<HTMLElement>('.cy-history-item')].find((el) => el.getBoundingClientRect().bottom > cr.top)
        if (!item?.dataset.hitId) return null
        return { hitId: item.dataset.hitId, offsetTop: item.getBoundingClientRect().top - cr.top }
      })
      expect(anchor).not.toBeNull()
      const first50 = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.cy-history-item')].map((el) => el.dataset.hitId ?? ''))
      expect(first50).toHaveLength(50)
      // 6) 真点击加载更多
      await page.locator('.cy-more-btn').click()
      // 7) 100 条 + 唯一 + 首屏相对顺序子序列 + day 组 2→4
      await expect.poll(async () => page.locator('.cy-history-item').count(), POLL).toBe(100)
      const allIds = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.cy-history-item')].map((el) => el.dataset.hitId ?? ''))
      expect(new Set(allIds).size).toBe(100)
      const first50Set = new Set(first50)
      expect(allIds.filter((id) => first50Set.has(id))).toEqual(first50)
      const dayCount = await page.evaluate(() => document.querySelectorAll('.cy-history-day').length)
      expect(dayCount).toBe(4)
      // 8) 锚点精确偏移保留（≤1px）
      const anchorAfter = await page.evaluate((hitId) => {
        const c = document.querySelector<HTMLElement>('.cy-history-results')!
        const cr = c.getBoundingClientRect()
        const el = [...c.querySelectorAll<HTMLElement>('.cy-history-item')].find((n) => n.dataset.hitId === hitId)
        if (!el) return null
        return el.getBoundingClientRect().top - cr.top
      }, anchor!.hitId)
      expect(anchorAfter).not.toBeNull()
      expect(Math.abs(anchorAfter! - anchor!.offsetTop)).toBeLessThanOrEqual(1)
      // 9) Tab 可达：重聚焦搜索框 → Shift+Tab 三次回绕到 last=加载更多
      await page.getByLabel('关键词搜索').click()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Shift+Tab')
      const activeText = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? '')
      expect(activeText).toContain('加载更多')
      // 10) Esc 关闭 + 回焦「聊天记录」
      await page.keyboard.press('Escape')
      await expect.poll(async () => page.evaluate(() => document.querySelector('.cy-history-overlay')), POLL).toBeNull()
      const activeTitle = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('title') ?? '')
      expect(activeTitle).toBe('聊天记录')
    } finally { await closeApp(launched) }
  })

  it('1100×700 最小档：面板/加载更多在视口内、真点击加载第二页', async () => {
    const launched = await launchWithSize(1100, 700)
    try {
      const page = launched.page
      await openAndSearch50(page)
      const boxes = await readBoxes(page)
      for (const k of ['panel', 'footer', 'btn'] as const) {
        expect(boxes[k].top).toBeGreaterThanOrEqual(0)
        expect(boxes[k].bottom).toBeLessThanOrEqual(boxes.vp.h)
      }
      await page.locator('.cy-more-btn').click()
      await expect.poll(async () => page.locator('.cy-history-item').count(), POLL).toBe(100)
    } finally { await closeApp(launched) }
  })

  it('空结果态：空态文本可见且 ⊂ 面板、无加载更多按钮', async () => {
    const launched = await launchWithSize(1184, 721)
    try {
      const page = launched.page
      await page.getByRole('button', { name: '聊天记录' }).click()
      await page.getByLabel('关键词搜索').fill('zzz_nonexistent')
      await page.getByRole('button', { name: '搜索' }).click()
      // 按「没有找到相关聊天记录」文本 poll（loading 态文本为「正在搜索…」，不会误匹配，避免对 loading 假绿）
      await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLElement>('.cy-history-state')?.textContent ?? ''), POLL).toContain('没有找到相关聊天记录')
      const state = await page.evaluate(() => { const r = document.querySelector<HTMLElement>('.cy-history-state')!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: window.innerHeight } })
      expect(state.top).toBeGreaterThanOrEqual(0)
      expect(state.bottom).toBeLessThanOrEqual(state.vh)
      expect(await page.locator('.cy-more-btn').count()).toBe(0)
    } finally { await closeApp(launched) }
  })
})
```

- [ ] **Step 2: 构建测试产物 + 运行新 spec**

Run: `cd /home/yomu/elysia-frontend && pnpm -F @cyrene/desktop exec electron-vite build --mode test && pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts tests/integration/history-viewer-layout.spec.ts 2>&1 | tail -40`
Expected: 三用例全过（Electron 冷启动约 10-20s/用例）。若有失败，逐条诊断——最常见：setContentSize 后 viewport 未就绪（waitForFunction 已处理）、可访问名不匹配、或 CSS 修复未生效（此时回 Task 2 排查）。

- [ ] **Step 3: 运行全量集成套件确认不回归**

Run: `cd /home/yomu/elysia-frontend && pnpm test:integration 2>&1 | tail -30`
Expected: 既有 10 个 spec + 新 spec 全过（fileParallelism:false，约 2-4 分钟）。

- [ ] **Step 4: 门禁 + 提交**

Run: `cd /home/yomu/elysia-frontend && pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm -F @cyrene/desktop check:contract 2>&1 | tail -5`
Expected: 全绿；`check:contract` WS 13/13 + REST 8/8（本批不触 wire schema，指纹不变）。
```bash
cd /home/yomu/elysia-frontend && git add apps/desktop/tests/integration/history-viewer-layout.spec.ts && git commit -m "test(阶段3 真实联调第二轮): 历史查看器布局/点击集成测试三用例（1184×721 / 1100×700 / 空态）"
```

---

### Task 4: 文档同步（决策记录 + README/CLAUDE/docs16）

**Files:**
- Create: `docs/review/2026-08-15-阶段3真实联调第二轮前端整改-决策记录.md`
- Modify: `README.md`、`CLAUDE.md`、`docs/16-*.md`（测试数字 + FE-S3-RUN2-P1-01 状态）

**Interfaces:**
- Consumes: 全部既有改动（Task 1-3）。测试数字以 Task 4 Step 1 的 `pnpm test` / `pnpm test:integration` **实际输出**为准填报（新 spec 贡献 6 单测 + 3 集成用例；基线见仓库文档当前记录，勿凭估算）。
- Produces: 本轮决策记录 + 文档口径同步。

- [ ] **Step 1: 取实际测试数字**

Run: `cd /home/yomu/elysia-frontend && pnpm test 2>&1 | tail -3 && pnpm test:integration 2>&1 | tail -3`
Expected: 形如 `Test Files  N passed | N failed  / Tests  M passed` 与 integration 对应行；记录 N/M。

- [ ] **Step 2: 写决策记录** `docs/review/2026-08-15-阶段3真实联调第二轮前端整改-决策记录.md`

内容（中文，对照 spec §5）：
- 元信息：日期、前端基线、后端对照、清单链接。
- **D1 纯 CSS 容器约束 / D2 env-gated 大 seed（CYRENE_MOCK_HISTORY_LARGE）/ D3 测试侧 setContentSize / D4 mock 分页语义对齐 real** 各一段：结论 + 理由。
- **spec 评审补强记录**：锚点测试初稿空转（渲染序≠store 序，日期降序）→ 修正为边界日期组 + 精确偏移 ≤1px 断言；`overflow-anchor:none` 必要性（防止原生锚定掩盖手动补偿）；`parseMockHistoryCountEnv` 语义（0/负/非法→120）。
- **测试与门禁**：unit / integration / typecheck / lint / build / check:contract 实际数字。
- **后续**：真实 Windows Electron 50+50 短回归（后端 `556117a`）通过后阶段 3 升「已真实联调」。

- [ ] **Step 3: 同步 README/CLAUDE/docs16**

1) `README.md`：阶段 3 段落——把「936 unit / 39 integration」等数字更新为 Step 1 实际值；新增 FE-S3-RUN2-P1-01 已修复句（仍「已开发、未联调」）。
2) `CLAUDE.md` 当前状态段：同步同一数字与措辞。
3) `docs/16-*.md` 阶段 3 执行清单：标记 FE-S3-RUN2-P1-01 完成（修复 + 集成测试）；测试数字同步。
（保持中文；只改数字/状态，不动结构。）

- [ ] **Step 4: 门禁 + 提交**

Run: `cd /home/yomu/elysia-frontend && pnpm typecheck && pnpm lint 2>&1 | tail -3`
Expected: 绿（docs 改动不涉代码，typecheck/lint 应不变）。
```bash
cd /home/yomu/elysia-frontend && git add "docs/review/2026-08-15-阶段3真实联调第二轮前端整改-决策记录.md" README.md CLAUDE.md docs/16-*.md && git commit -m "docs(阶段3 真实联调第二轮): 决策记录 + README/CLAUDE/docs16 测试数字与状态同步"
```

---

## 自审记录（对照 spec）

- **§4.1 CSS 容器约束** → Task 2 Step 2（方案 A：overlay flex + 面板 min-height:0 + 结果区 flex:1/overflow/anchor:none + 固定兄弟 flex-shrink:0）。✓
- **§4.2 锚点补偿** → Task 2 Step 3（resultsEl + onLoadMorePreservingAnchor + data-hit-id + nextTick 时序 + overflow-anchor:none 配套）。✓
- **§4.3.1 seedHistoryCount + parseMockHistoryCountEnv** → Task 1 Step 3（含字段顺序约束、0/负/非法→120、`'0'` 不允许空 seed）。✓
- **§4.3.2 分页语义对齐** → Task 1 Step 3（DESC 切片 + 页内升序）。✓
- **§4.3.3 Main 装配透传** → Task 1 Step 4（CYRENE_MOCK_HISTORY_LARGE）。✓
- **§4.4 集成测试三用例** → Task 3（主档精确锚点断言 / 最小档 / 空态；Shift+Tab×3 回绕；Esc 回焦）。✓
- **§6.1 单测** → Task 1 Step 1（env 解析 3 组 + seed 120 集 + 分页对齐 + 默认 5 条不回归）。注：spec §6.1 的「跨页边界日期组组首前插」属跨层断言（mock 不做分组、分组在组件 `groupedItems`），不单独做 mock 层单测，由 Task 3 集成测试端到端覆盖（dayCount 2→4 + 锚点 ≤1px）。✓
- **§7 完成定义** → Task 3 门禁 + Task 4 文档同步 + 阶段 3 保持「已开发、未联调」。✓
- **类型一致性**：`parseMockHistoryCountEnv`、`seedHistoryCount`、`onLoadMorePreservingAnchor`、`resultsEl`、`data-hit-id` 各任务间命名一致。✓
