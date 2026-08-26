# 阶段 7 批次 C（7C 性能收敛）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对靶 doc16 §10 四项性能目标——长会话/长流式/历史资源列表/Live2D 性能、200 条混合消息/100 多分段回复/500 项历史资源操作正常、长时间运行无明显持续内存增长、Live2D 关闭后 CPU/GPU 明显下降。

**Architecture:** 纯 renderer 性能优化 + 测量 + mock 扩展，无 Main↔Renderer 契约/IPC/schema 变更。（1）生成化 `virtual-window` 数学内核并扁平化历史查看器为虚拟行；（2）`renderMarkdown` 加模块级 Map 缓存；（3）mock 补多分段种子；（4）性能测量常驻集成 suite（松阈值）。§4C 流式增量合并降级观察项（用户拍板——§4B 已解主瓶颈，剩余 sort 成本低但实现复杂）。

**Tech Stack:** Electron + Vue 3 + TypeScript + Vite, Vitest, Playwright (`_electron`), Pinia。

**Spec:** [docs/superpowers/specs/2026-08-26-phase7-batchc-perf-convergence-design.md](../specs/2026-08-26-phase7-batchc-perf-convergence-design.md)

---

## Global Constraints

- **三态纪律**：本批 = 代码批、Mock 驱动，标注「已开发、未联调」；真实 Windows Electron 联调为批次后独立项，本批不写「已真实联调/已完成」。
- **正文敏感性**：chat content / 分段文本 / snippet 为敏感——**永不写日志、永不进诊断导出**；性能测量断言**仅限聚合计数**（usedJSHeapSize 字节 / DOM 节点数 / 可视行数），绝不含 message text / segment 逐条长度 / 分段内容量。
- **no new wire contract**：不新增 IPC 通道 / schema / ipc-security 白名单（mock 多分段是 mock 行为，非 wire 变更）。
- **mock env 门控**：`CYRENE_MOCK_MULTI_SEGMENT` 解析必须 `useMock ? ... : undefined`，真实模式误设不注入；mock 生成文本为可读确定性文本（避 base64-long-string 黑名单）。
- **DOMPurify 静态配置**：`DOMPurify.ALLOWED_URI_REGEXP` 等为静态常量，不引入运行时可变 sanitize 配置（否则缓存键需并入版本，记观察项）。
- **虚拟列表内核复用**：不各组件各自实现，统一复用泛型化 `virtual-window` 数学。
- **Vue 响应性**：凡共享对象引用禁止原地变更（变更即建新对象），防 Vue 响应丢失。**豁免**：Task 3 模块级 `Map<string,string>` 是非响应式命令式对象（在纯函数 `renderMarkdown` 内 `.set()/.clear()`，未接 ref/reactive），无响应丢失风险——豁免此约束（符合性 L-5）。
- **Node**：所有 pnpm 命令前 `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH`（默认 v26 触发 engines 门禁）。
- **集成测试跑法**：xvfb-run + 虚拟显示（`DISPLAY` 必须设，否则裸跑失败——环境限制）。`pnpm -F @cyrene/desktop exec electron-vite ...` 而非裸 `electron-vite`。
- **verify:sensitive 预期**：新测试/文档预计触发 base64-long-string 类别命中→按 fail-loud 纪律补逐行核对 allowlist 条目（非零新增 allowlist）。

---

## 文件结构

- **`apps/desktop/src/renderer/src/utils/virtual-window.ts`**（修改）——泛型化数学内核：`estimateHeight`（T重载+Message重载）、`buildPrefix<T>`、`computeWindow`、`captureAnchor<T>`、`restoreScrollTop<T>`，注入 `estimate`/`keyFor`/`isAnchorable` 访问器 + 旧参量默认参重载（消息列表零改动）。
- **`apps/desktop/src/renderer/src/components/CyMessageList.vue`**（**不修改**——经默认参/重载兼容，既有 `buildPrefix(2参)`/`captureAnchor(4参)`/`restoreScrollTop(3参)`/`estimateHeight(1参)` 调用零改动，H-1 修复保证）。
- **`apps/desktop/src/renderer/src/components/CyHistoryViewer.vue`**（修改）——`groupedItems` → 扁平虚拟行 `rows`，用泛型化 virtual-window 渲染窗口；锚点补偿改 data 层；焦点陷阱/跳转/无障碍不变；`estimateItemHeight` 内联定义（header 34px / item 72px / sticker +64px）。
- **`apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue`**（**不修改**——estimateItemHeight 内联在 CyHistoryViewer，本组件仅复用；snippet 保持 mustache 插值转义不变）。
- **`apps/desktop/src/renderer/src/utils/markdown.ts`**（修改）——模块级 `Map<string,string>` 缓存 + `clearMarkdownCache()`。
- **`apps/desktop/src/renderer/src/stores/message.store.ts`**（修改）——`resetConversation` 内调 `clearMarkdownCache()`。
- **`apps/desktop/src/main/transport/mock-backend.ts`**（修改）——`CYRENE_MOCK_MULTI_SEGMENT` env 生成 N 段 public_reply 回复 + `getConversationMessages` 对 seed 会话返回 messageRecords（长会话前提，准确 M-2）。
- **`apps/desktop/src/main/index.ts`**（修改）——mock `CYRENE_MOCK_MULTI_SEGMENT` env 桥接线（useMock 门控）+ `app.commandLine.appendSwitch('enable-precise-memory-info')`（性能测量精确堆）。
- **测试**：`tests/unit/virtual-window.spec.ts`（改/增——含 buildPrefix/captureAnchor/restoreScrollTop 的 Message 兼容回归锁,完整 L-3）、`tests/unit/markdown-cache.spec.ts`（新,含 resetConversation 挂载点测试）、`tests/unit/mock-multi-segment.spec.ts`（新,含 seed 生成单测）、`tests/integration/history-viewer-layout.spec.ts`（重写虚拟化断言）、`tests/integration/perf-gate.spec.ts`（新,性能测量 suite,含 500 项/100 分段/长会话/Live2D rAF 复核）。
- **文档**：doc 03（历史查看器虚拟化）、doc 10/16（7C 状态注记 + 勾选）、doc 01/06（性能面）、doc 11（Live2D 读数注记）、doc 13/17、README、CLAUDE.md、决策记录。

---

### Task 1: 泛型化 virtual-window 数学内核 + 单测

**Files:**
- Modify: `apps/desktop/src/renderer/src/utils/virtual-window.ts`
- Modify: `apps/desktop/tests/unit/virtual-window.spec.ts`
- Test: `apps/desktop/tests/unit/virtual-window.spec.ts`

**Interfaces:**
- Consumes: 现有 `virtual-window.ts` 导出（`estimateHeight(m: Message)`、`buildPrefix(items, heights)`、`computeWindow`、`captureAnchor`、`restoreScrollTop`、`OVERSCAN_PX`）。
- Produces（后续 Task 2 依赖）:
  - `estimateHeight<T>(item: T, estimate: (t: T) => number): number`——保留 `Message` 重载 `estimateHeight(m: Message)`（消息列表零改动）。
  - `buildPrefix<T>(items: T[], heights: Record<string, number>, opts: { estimate: (t: T) => number; keyFor: (t: T) => string }): number[]`
  - `computeWindow(prefix, scrollTop, viewportHeight, overscanPx): WindowSlice`（不变）
  - `captureAnchor<T>(items, prefix, scrollTop, viewportHeight, opts: { isAnchorable: (t: T) => boolean; keyFor: (t: T) => string }): ScrollAnchor`
  - `restoreScrollTop<T>(items, prefix, anchor, keyFor: (t: T) => string): number`
  - `estimateMessageHeight(m: Message): number`（导出现有 Message 估算逻辑——供 `estimateHeight` Message 重载 + `buildPrefix` 默认 `MESSAGE_PREFIX_OPTS` 内部用；消息列表调用处**零改动**，不直接传它）

- [ ] **Step 1: 写失败测试（泛型化后既有行为回归）**

现有 `virtual-window.ts` 是 `Message` 紧耦合。先写测试锁定两个方向：
a) 消息列表行为不变（泛型化后用 `estimate=estimateMessageHeight`、`keyFor=m=>m.messageId`、`isAnchorable=()=>true` 注入，结果与现状一致）；
b) 新泛型签名的差异注入正确性（header 行与 item 行高度不同、keyFor 取不同键）。

```ts
// apps/desktop/tests/unit/virtual-window.spec.ts（追加）
import { describe, expect, it } from 'vitest'
import { buildPrefix, captureAnchor, computeWindow, estimateHeight, restoreScrollTop, OVERSCAN_PX } from '../../src/renderer/src/utils/virtual-window'
import type { Message } from '@shared/contracts'

type Row = { kind: 'header' | 'item'; key: string; h: number }

const mkRows = (): Row[] => [
  { kind: 'header', key: 'h1', h: 34 },
  { kind: 'item', key: 'a', h: 72 },
  { kind: 'item', key: 'b', h: 72 },
  { kind: 'header', key: 'h2', h: 34 },
  { kind: 'item', key: 'c', h: 80 },
]

const keyFor = (r: Row) => (r.kind === 'header' ? `header:${r.key}` : r.key)
const isAnchorable = (r: Row) => r.kind === 'item'
const estimate = (r: Row) => r.h

describe('virtual-window 泛型化（Task 1）', () => {
  it('buildPrefix 用注入 estimate + keyFor 计算视觉高度（header/item 差异）', () => {
    const rows = mkRows()
    const prefix = buildPrefix(rows, {}, { estimate, keyFor })
    expect(prefix).toEqual([0, 34, 106, 178, 212, 292])
  })
  it('captureAnchor 经 isAnchorable 跳过 header 行取首个 item', () => {
    const rows = mkRows()
    const prefix = buildPrefix(rows, {}, { estimate, keyFor })
    // scrollTop=90 → 首个 item 行（'a', prefix[1]=34）为锚点，offset=90-34=56
    const a = captureAnchor(rows, prefix, 90, 600, { isAnchorable, keyFor })
    expect(a.messageId).toBe('a')
    expect(a.offset).toBe(56)
  })
  it('restoreScrollTop 按 keyFor 找回锚点行', () => {
    const rows = mkRows()
    const prefix = buildPrefix(rows, {}, { estimate, keyFor })
    expect(restoreScrollTop(rows, prefix, { messageId: 'c', offset: 10 }, keyFor)).toBe(212 + 10)
  })
  it('estimateHeight 泛型签名 + Message 重载并存', () => {
    expect(estimateHeight(mkRows()[0], estimate)).toBe(34)   // 泛型签名
    const msg = { role: 'user', content: 'hi', messageId: 'm1' } as unknown as Message
    expect(estimateHeight(msg)).toBeGreaterThan(0)           // Message 重载（单参零改动）
  })
})

// 完整 L-3 + 符合性 L-3 修复：Message 兼容回归锁——旧参调用（2/4/3 参）行为不变
describe('virtual-window Message 兼容重载（Task 1，H-1 修复回归锁）', () => {
  const mkMsg = (id: string, role: 'user' | 'assistant', content: string): Message =>
    ({ messageId: id, role, content, createdAt: '', status: 'completed' } as Message)
  it('buildPrefix 2 参（消息列表零改动）', () => {
    const msgs = [mkMsg('a', 'user', 'x'), mkMsg('b', 'assistant', 'y')]
    const heights = { a: 50, b: 80 }
    expect(buildPrefix(msgs, heights)).toEqual([0, 50, 130])
  })
  it('captureAnchor 4 参（消息列表零改动）', () => {
    const msgs = [mkMsg('a', 'user', 'x'), mkMsg('b', 'assistant', 'y')]
    const heights = { a: 50, b: 80 }
    const prefix = buildPrefix(msgs, heights)
    const a = captureAnchor(msgs, prefix, 30, 600)
    expect(a.messageId).toBe('a')
  })
  it('restoreScrollTop 3 参（消息列表零改动）', () => {
    const msgs = [mkMsg('a', 'user', 'x'), mkMsg('b', 'assistant', 'y')]
    const heights = { a: 50, b: 80 }
    const prefix = buildPrefix(msgs, heights)
    expect(restoreScrollTop(msgs, prefix, { messageId: 'b', offset: 10 })).toBe(60)   // 准确 r2 off-by-one 修正：prefix[1]=50 + offset 10 = 60（非 prefix[2] 的 130）
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run --config vitest.config.mts apps/desktop/tests/unit/virtual-window.spec.ts`
Expected: FAIL——`estimateMessageHeight` 未定义、`buildPrefix` 签名对不上、`captureAnchor`/`restoreScrollTop` 不收 opts/keyFor。

- [ ] **Step 3: 泛型化实现**

改 `virtual-window.ts`：

```ts
import type { Message, ScrollAnchor } from '@shared/contracts'

export const OVERSCAN_PX = 400
// ...countFences 不变...

/** 消息列表专用估算（fence counting 等，原 estimateHeight 的 Message 版逻辑） */
export function estimateMessageHeight(m: Message): number {
  const BASE = 36, LINE = 20
  if (m.role === 'user') {
    const lines = Math.max(1, Math.ceil((m.content?.length ?? 1) / 40))
    return BASE + lines * LINE
  }
  if (m.role === 'assistant') {
    let textLen = 0, extra = 0
    for (const seg of m.assistantSegments ?? []) {
      textLen += seg.text?.length ?? 0
      if (seg.kind === 'markdown' && seg.text) {
        extra += countFences(seg.text) * 3
        extra += (seg.text.match(/^\s*[-*] |^\s*\d+\. /gm)?.length ?? 0) / 2
      }
    }
    return BASE + Math.ceil(textLen / 45) * LINE + Math.round(extra) * LINE
  }
  return BASE
}

/** 双签名重载（准确性 M-10 修复：作为 Step 3 正稿，删除旧冲突首段）：
 *  - `estimateHeight(m: Message)` 既有重载（消息列表零改动，CyMessageList.vue:107 单参调用不破坏）
 *  - `estimateHeight<T>(item, estimate)` 泛型签名（历史查看器注入 estimate）
 */
export function estimateHeight(m: Message): number
export function estimateHeight<T>(item: T, estimate: (t: T) => number): number
export function estimateHeight(item: unknown, estimate?: (t: unknown) => number): number {
  if (estimate) return estimate(item)
  return estimateMessageHeight(item as Message)
}

export interface PrefixOpts<T> { estimate: (t: T) => number; keyFor: (t: T) => string }

/** 消息列表默认注入（Message 版）：keyFor=messageId、estimate=estimateMessageHeight */
const MESSAGE_PREFIX_OPTS: PrefixOpts<Message> = { estimate: estimateMessageHeight, keyFor: (m) => m.messageId }

export function buildPrefix(items: Message[], heights: Record<string, number>): number[]   // 既有 2 参（消息列表零改动）
export function buildPrefix<T>(items: T[], heights: Record<string, number>, opts: PrefixOpts<T>): number[]
export function buildPrefix(items: unknown[], heights: Record<string, number>, opts?: PrefixOpts<unknown>): number[] {
  const o = opts ?? (MESSAGE_PREFIX_OPTS as PrefixOpts<unknown>)
  const prefix: number[] = new Array(items.length + 1)
  prefix[0] = 0
  for (let i = 0; i < items.length; i++) {
    const key = o.keyFor(items[i])
    prefix[i + 1] = prefix[i] + (heights[key] ?? o.estimate(items[i]))
  }
  return prefix
}
// ...lowerBound/upperBound 不变...

export interface WindowSlice { startIndex: number; endIndex: number; paddingTop: number; paddingBottom: number }

export function computeWindow(prefix: number[], scrollTop: number, viewportHeight: number, overscanPx: number): WindowSlice {
  // ...原实现不变...
}

export interface AnchorOpts<T> { isAnchorable: (t: T) => boolean; keyFor: (t: T) => string }

/** 消息列表默认锚定（Message 版）：isAnchorable 恒 true、keyFor=messageId */
const MESSAGE_ANCHOR_OPTS: AnchorOpts<Message> = { isAnchorable: () => true, keyFor: (m) => m.messageId }

export function captureAnchor(items: Message[], prefix: number[], scrollTop: number, _viewportHeight: number): ScrollAnchor   // 既有 4 参（消息列表零改动）
export function captureAnchor<T>(items: T[], prefix: number[], scrollTop: number, viewportHeight: number, opts: AnchorOpts<T>): ScrollAnchor
export function captureAnchor(items: unknown[], prefix: number[], scrollTop: number, _viewportHeight: number, opts?: AnchorOpts<unknown>): ScrollAnchor {
  const o = opts ?? (MESSAGE_ANCHOR_OPTS as AnchorOpts<unknown>)
  if (items.length === 0) return { messageId: '', offset: 0 }
  let idx = Math.max(0, lowerBound(prefix, scrollTop) - 1)
  // 跳过 header 行：向后找到首个 isAnchorable 行（准确性 M-8 注：视口顶在 header 内时 offset 可为负，影响极小——消息列表无 header 不触发）
  while (idx < items.length && !o.isAnchorable(items[idx])) idx++
  if (idx >= items.length) return { messageId: '', offset: 0 }
  return { messageId: o.keyFor(items[idx]), offset: scrollTop - prefix[idx] }
}

export function restoreScrollTop(items: Message[], prefix: number[], anchor: ScrollAnchor): number   // 既有 3 参（消息列表零改动）
export function restoreScrollTop<T>(items: T[], prefix: number[], anchor: ScrollAnchor, keyFor: (t: T) => string): number
export function restoreScrollTop(items: unknown[], prefix: number[], anchor: ScrollAnchor, keyFor?: (t: unknown) => string): number {
  const kf = keyFor ?? ((m: unknown) => (m as Message).messageId)
  if (!anchor.messageId) return 0
  const idx = items.findIndex((t) => kf(t) === anchor.messageId)
  if (idx < 0) return 0
  return prefix[idx] + anchor.offset
}

export function compensateScroll(deltas: Array<{ old: number; new: number }>): number {
  return deltas.reduce((acc, d) => acc + (d.new - d.old), 0)
}
```

> 注：`estimateHeight` 用上述双签名重载——消息列表既有 `estimateHeight(items.value[idx])`（单参）命中 Message 重载零改动；历史查看器 `estimateHeight(item, estimate)` 命中泛型签名。

> **H-1 修复（3 维独立确认，必须）**：以下三个函数需**保留旧参数量 + 新增泛型参数量**的双签名/默认参，否则 `CyMessageList.vue` 的 `buildPrefix(items.value, heights.value)`(:22)、`captureAnchor(items, prefix, scrollTop, clientHeight)`(:61/:64/:90)、`restoreScrollTop(items, prefix, anchor)`(:77/:145) 报 TS2554 参数不足，且既有 `virtual-window.spec.ts:38/:70/:75/:78/:83/:87` 的旧参调用同样报错。实现为「旧参量走 Message 默认注入，新参量走显式注入」：

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run --config vitest.config.mts apps/desktop/tests/unit/virtual-window.spec.ts`
Expected: PASS + 既有 virtual-window 相关测试回归绿。

- [ ] **Step 5: 跑既有消息列表测试确认调用处零改动**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop test`
Expected: 全部单测绿（含 CyMessageList 依赖的既有虚拟窗口行为）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/virtual-window.ts apps/desktop/tests/unit/virtual-window.spec.ts
git commit -m "feat(阶段7批次C): Task1 泛型化 virtual-window 数学内核（estimate/buildPrefix/captureAnchor/restoreScrollTop 注入 estimate+keyFor+isAnchorable）+ 消息列表兼容重载（TDD）"
```

---

### Task 2: 历史查看器虚拟化

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyHistoryViewer.vue`
- Modify: `apps/desktop/tests/integration/history-viewer-layout.spec.ts`
- Test: `apps/desktop/tests/integration/history-viewer-layout.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `buildPrefix<T>`/`computeWindow`/`captureAnchor<T>`/`restoreScrollTop<T>`/`estimateHeight<T>`（注入 keyFor/isAnchorable/estimate）。
- Produces: 历史查看器扁平虚拟行 `rows` + 组件 data 层锚点补偿。

- [ ] **Step 1: 重写测试为虚拟列表语义（先写失败）**

现有断言 `.cy-history-item` count=50/100、`.cy-history-day`=4、DOM 选择器锚点 → 改为：
- `.cy-history-item` **有界**（≤ 可视行×常数，用 `launchWithSize` 固定 1184×721 下 poll 取值，非硬相等）。
- 分组 header 仍正确显示（`.cy-history-day` 可见数有界 >0）。
- 锚点偏移 ≤1px（data 层）。
- 加载更多后新页行可达（滚动、虚拟窗口重算）。

```ts
// history-viewer-layout.spec.ts 第一条用例改写（虚拟化断言）
// 用 poll 断言 #1：可视行有界（虚拟化后 .cy-history-item 数不随 500 线性）
await openAndSearch50(page)
const visCount = await expect.poll(async () => page.locator('.cy-history-item').count(), POLL)
expect(visCount).toBeLessThanOrEqual(60)   // 1184×721 + overscan OVERSCAN_PX=400→窗口行数上界（保守 60，符合性 L-4 修正）
// 分组 header 仍显示（可见 >0）
const dayCount = await expect.poll(async () => page.locator('.cy-history-day').count(), POLL)
expect(dayCount).toBeGreaterThan(0)
// 锚点：data 层计算（不再依赖全 DOM）——用 expect.poll 等虚拟窗口稳定后取值
```

完整重写含加载更多（需真实断言虚拟窗口重算后新行可达）——见 Step 4 详细测试。

- [ ] **Step 2: 运行确认失败**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts history-viewer-layout.spec.ts`
Expected: FAIL——现有断言 `.cy-history-item` count 将不再等于 50/100（虚拟化后仅可视行挂载）。

- [ ] **Step 3: 实现扁平虚拟行**

在 `CyHistoryViewer.vue` `<script setup>`：

```ts
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildPrefix, captureAnchor, computeWindow, estimateHeight, restoreScrollTop, OVERSCAN_PX } from '../utils/virtual-window'
// ...既有 import 不变...

type HistoryRow = { kind: 'header'; key: string; date: string; label: string } | { kind: 'item'; key: string; hit: ChatHistoryItem }

/** 历史行估算（完整 H-2/准确 M-4 修复——estimateItemHeight 明确定义 + 归属，不再悬空）。
 *  header 固定 ~34px；item 单行 snippet ~72px，sticker 缩略图行更高（约 +64px）。 */
function estimateItemHeight(hit: ChatHistoryItem): number {
  const BASE_ITEM = 72
  if (hit.resource?.kind === 'sticker') return BASE_ITEM + 64
  return BASE_ITEM
}

const rowKeyFor = (r: HistoryRow) => r.key
const rowIsAnchorable = (r: HistoryRow) => r.kind === 'item'
const rowEstimate = (r: HistoryRow) => (r.kind === 'header' ? 34 : estimateItemHeight(r.hit))

const rows = computed<HistoryRow[]>(() => {
  const out: HistoryRow[] = []
  for (const g of groupedItems.value) {
    out.push({ kind: 'header', key: `header:${g.date}`, date: g.date, label: g.label })
    for (const hit of g.items) out.push({ kind: 'item', key: hit.hitId, hit })
  }
  return out
})
const heights = ref<Record<string, number>>({})
const prefix = computed(() => buildPrefix(rows.value, heights.value, { estimate: rowEstimate, keyFor: rowKeyFor }))
const scrollTop = ref(0)
const viewportHeight = ref(600)

const win = computed(() => {
  const w = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
  return { ...w, visibleRows: rows.value.slice(w.startIndex, w.endIndex + 1) }
})

// 准确 M-5 修复：ResizeObserver 实测行高——每行 :ref 注册到 setRowEl，写 heights（est 优先/实测覆盖）
const rowEls = new Map<string, HTMLElement>()
const resizeObs = ref<ResizeObserver>()
function setRowEl(key: string, el: Element | null, _kind: 'header' | 'item'): void {
  if (el) { rowEls.set(key, el as HTMLElement); resizeObs.value?.observe(el as HTMLElement) }
  else { const prev = rowEls.get(key); if (prev) { resizeObs.value?.unobserve(prev); rowEls.delete(key) } }
}
function onRowResized(key: string, entry: ResizeObserverEntry): void {
  const h = entry.contentRect.height
  if (heights.value[key] === h) return
  heights.value[key] = h
  // 锚点上方变化补偿（同消息列表 compensateScroll 模式）——防实测高度把锚点推走
}
onMounted(() => {
  resizeObs.value = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const key = (entry.target as HTMLElement).dataset?.rowKey ?? ''
      if (key) onRowResized(key, entry)
    }
  })
  if (resultsEl.value) viewportHeight.value = resultsEl.value.clientHeight
})
onBeforeUnmount(() => { resizeObs.value?.disconnect() })
```

模板改：

```vue
<ul ref="resultsEl" class="cy-history-results">
  <div :style="{ height: win.paddingTop + 'px' }" class="cy-vlist-pad" />
  <template v-for="row in win.visibleRows" :key="row.key">
    <!-- 准确 M-5 修复：每行挂 :ref + data-row-key 供 ResizeObserver 观察（否则 heights 恒空、实测高度永不收敛） -->
    <li v-if="row.kind === 'header'" :ref="(el) => setRowEl(row.key, el, 'header')" :data-row-key="row.key" class="cy-history-day">{{ row.label }}</li>
    <div v-else :ref="(el) => setRowEl(row.key, el, 'item')" :data-row-key="row.key" class="cy-vlist-row">
      <CyHistoryResultItem :hit="row.hit" @jump="onJump" />
    </div>
  </template>
  <div :style="{ height: win.paddingBottom + 'px' }" class="cy-vlist-pad" />
</ul>
```

> 关键：`resultsEl` 的 DOM 现只含可视行；`loadMore` 锚点补偿改为 data 层（Step 4 说明）。`groupedItems` 保留（供 rows 派生 + announceText），不再直接 `v-for`。**`setRowEl` 需在 `<script setup>` 定义**（注册 `ResizeObserver` 观察每行 + 写 `heights`，复用消息列表 `onRowResized`/`compensateScroll` 模式）。**snippet 保持纯文本转义**（完整 M-4）：`CyHistoryResultItem` 继续用 `{{ hit.snippet || ... }}` mustache 插值，**不得**改 v-html / renderMarkdown（§4A⑥ 安全 M-5 重申——虚拟化不改 snippet 敏感处理）。

- [ ] **Step 4: 锚点补偿改 data 层**

`onLoadMorePreservingAnchor` 的 `.cy-history-item` DOM 选择器 → data 层：

```ts
async function onLoadMorePreservingAnchor(): Promise<void> {
  let anchor: { rowKey: string; offsetTop: number } | undefined
  if (prefix.value.length) {
    // 首个锚点行（跳 header）：data 层二分
    const target = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
    for (let i = target.startIndex; i < rows.value.length; i++) {
      if (rows.value[i].kind === 'item') { anchor = { rowKey: rowKeyFor(rows.value[i]), offsetTop: scrollTop.value - prefix.value[i] }; break }
    }
  }
  await store.loadMore()
  if (anchor) {
    await nextTick()
    const idx = rows.value.findIndex((r) => r.kind === 'item' && rowKeyFor(r) === anchor!.rowKey)
    if (idx >= 0 && resultsEl.value) {
      // 虚拟化后 rows 重算，恢复可视位移（估高误差由 ResizeObserver 实测补偿——resizeObs 模式同 Task 1 消息列表）
      resultsEl.value.scrollTop = prefix.value[idx] + anchor.offsetTop
    }
  }
}
```

resizeObs 实测补偿：`CyHistoryViewer` 加 `ResizeObserver`，`setRowEl` 注册到 `.cy-vlist-row`/item 行，写 `heights` 并补偿锚点上方变化（复用消息列表 `onRowResized` + `compensateScroll` 模式）。

> **准确性 M-8/M-9 注（LOW，实现自洽，注明即可）**：
> - **M-8**：视口顶恰落在 header 行内时，`captureAnchor` 跳到首个 item 行后 `offset = scrollTop - prefix[idx]` 可为负（如 scrollTop=10、header[0,34)、item prefix[1]=34 → offset=-24）。消息列表 `isAnchorable=()=>true` 无 header 不触发；仅历史查看器首行 header 场景出现，恢复公式自洽（负 offset 由 prefix 抵消），非 bug——注明防实现困惑。
> - **M-9**：新 `offsetTop = scrollTop - prefix[idx]`（视口相对**负值**）与旧 DOM `anchor.offsetTop = el.top - cr.top`（正值）符号约定相反；但各自恢复公式自洽（新 `scrollTop = prefix[idx] + offsetTop` 在 prefix 未变时回到原 scrollTop），append 场景位置不跳。锚点选择取 `computeWindow.startIndex`（受 OVERSCAN_PX 影响，可上探 400px）而非严格首个可见项——影响极小（锚到视口上方少许行），可接受。

- [ ] **Step 5: 重写集成测试完整版**

```ts
it('虚拟化：可视行有界、分组 header 显示、loadMore 后新页可达、锚点偏移保留', async () => {
  const launched = await launchWithSize(1184, 721)
  try {
    const page = launched.page
    await openAndSearch50(page)
    // 虚拟化后可视行有界（不随 500 线性）
    const visCount = await expect.poll(async () => page.locator('.cy-history-item').count(), POLL)
    expect(visCount).toBeLessThanOrEqual(60)
    // 分组 header 可见且正确
    const dayCount = await expect.poll(async () => page.locator('.cy-history-day').count(), POLL)
    expect(dayCount).toBeGreaterThan(0)
    // 锚点（data 层，等虚拟窗口稳定）：捕获首个可见 item + offset
    const anchor = await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>('.cy-history-results')!
      const cr = c.getBoundingClientRect()
      const item = [...c.querySelectorAll<HTMLElement>('.cy-history-item')].find((el) => el.getBoundingClientRect().bottom > cr.top)
      return item?.dataset.hitId ? { hitId: item.dataset.hitId, offsetTop: item.getBoundingClientRect().top - cr.top } : null
    })
    expect(anchor).not.toBeNull()
    // overflow-anchor:none 保留
    expect(await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('.cy-history-results')!).overflowAnchor)).toBe('none')
    // 滚动到跨页边界
    await page.evaluate(() => { const el = document.querySelector<HTMLElement>('.cy-history-results')!; el.scrollTop = el.scrollHeight * 0.7 })
    // loadMore 真点击
    await page.locator('.cy-more-btn').click()
    // 虚拟化后可视行仍 < 全量（新页行可达——滚动窗口内出现第二个日期 header）
    await expect.poll(async () => page.evaluate(() => document.querySelectorAll<HTMLElement>('.cy-history-day').length), POLL).toBeGreaterThan(0)
    // 锚点偏移 ≤1px（data 层恢复）
    const anchorAfter = await page.evaluate((hitId) => {
      const c = document.querySelector<HTMLElement>('.cy-history-results')!
      const el = [...c.querySelectorAll<HTMLElement>('.cy-history-item')].find((n) => n.dataset.hitId === hitId)
      return el ? el.getBoundingClientRect().top - c.getBoundingClientRect().top : null
    }, anchor!.hitId)
    expect(anchorAfter).not.toBeNull()
    expect(Math.abs(anchorAfter! - anchor!.offsetTop)).toBeLessThanOrEqual(1)
    // Tab 可达仍保留
    await page.getByLabel('关键词搜索').click()
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? '')).toContain('加载更多')
  } finally { await closeApp(launched) }
})
```

> 注：`offset` 偏移的 ≤1px 依赖 data 层前缀和与 ResizeObserver 实测高度收敛——若估高未收敛 transiently 可能 >1px，测试用 poll + 锚点 in-view 时取值（实现收敛时序在 Task 2 守）。

- [ ] **Step 6: 运行测试确认通过**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts history-viewer-layout.spec.ts`
Expected: PASS（虚拟化断言替换旧断言）。

- [ ] **Step 7: 跑全量集成确认无关联破坏**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts`
Expected: 全绿（history-viewer-ipc.spec.ts 等关联测试不破坏）。

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyHistoryViewer.vue apps/desktop/tests/integration/history-viewer-layout.spec.ts
git commit -m "feat(阶段7批次C): Task2 历史查看器虚拟化——groupedItems 扁平虚拟行 + data 层锚点补偿 + 集成断言重写（TDD）"
```

---

### Task 3: CyMarkdown 渲染缓存 + 单测

**Files:**
- Modify: `apps/desktop/src/renderer/src/utils/markdown.ts`
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`
- Test: `apps/desktop/tests/unit/markdown-cache.spec.ts`（新）

**Interfaces:**
- Consumes: `renderMarkdown(text: string): string`（纯函数）、`resetConversation`（message.store.ts）。
- Produces: `renderMarkdown` 命中缓存 + `clearMarkdownCache()` 导出。

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/tests/unit/markdown-cache.spec.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import DOMPurify from 'dompurify'   // 准确 r2 M-6 修正：default import（dompurify ESM 仅 export default；import * as 得 namespace，sanitize undefined 且非同一引用）
import { renderMarkdown, clearMarkdownCache } from '../../src/renderer/src/utils/markdown'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'

describe('renderMarkdown 缓存（Task 3）', () => {
  beforeEach(() => clearMarkdownCache())
  it('相同 source 二次调用命中缓存（DOMPurify.sanitize 不重复执行）', () => {
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    const html1 = renderMarkdown('**hello**')
    const html2 = renderMarkdown('**hello**')
    expect(html2).toBe(html1)
    expect(spy).toHaveBeenCalledTimes(1)   // 缓存命中跳过第二次 parse+sanitize
    spy.mockRestore()
  })
  it('不同 source 不命中，各自 parse', () => {
    const a = renderMarkdown('# A')
    const b = renderMarkdown('# B')
    expect(a).not.toBe(b)
  })
  it('clearMarkdownCache 后重新 parse', () => {
    renderMarkdown('**x**')
    clearMarkdownCache()
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    renderMarkdown('**x**')
    expect(spy).toHaveBeenCalledTimes(1)   // 清空后重新 parse
    spy.mockRestore()
  })
  // 完整 M-3 修复：resetConversation 挂载点触发缓存清空（不是只直接测 clearMarkdownCache）
  it('resetConversation 触发缓存清空（挂载点集成）', () => {
    renderMarkdown('**会话内文本**')
    const store = useMessageStore()
    store.resetConversation('conv-1')
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    renderMarkdown('**会话内文本**')   // 清空后应重新 parse
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run --config vitest.config.mts apps/desktop/tests/unit/markdown-cache.spec.ts`
Expected: FAIL——`clearMarkdownCache` 未定义、命中缓存不生效。

- [ ] **Step 3: 实现缓存**

改 `markdown.ts`：

```ts
// ...既有 export 不变...
const markdownCache = new Map<string, string>()

export function renderMarkdown(text: string): string {
  const cached = markdownCache.get(text)
  if (cached !== undefined) return cached
  const html = wrapCodeBlocks(DOMPurify.sanitize(marked.parse(text, { async: false }), DOMPURIFY_CONFIG))
  markdownCache.set(text, html)
  return html
}

export function clearMarkdownCache(): void {
  markdownCache.clear()
}
```

> 注：cache key = `text`（source 字符串）；值为 sanitize 后 HTML。敏感文本作为值驻留于 renderer 堆内（安全 M-1 接受档）——post-sanitize、仅会话内清空、不跨信任边界。

改 `message.store.ts` `resetConversation`：

```ts
import { clearMarkdownCache } from '../utils/markdown'   // 新增 import

function resetConversation(_conversationId: string): void {
  byId.value = {}
  order.value = []
  // ...既有重置...
  clearMarkdownCache()   // 会话切换清空 markdown 缓存（安全 M-2 单一挂载点）
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run --config vitest.config.mts apps/desktop/tests/unit/markdown-cache.spec.ts`
Expected: PASS。

- [ ] **Step 5: 跑既有 markdown 相关测试 + 全量确认**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop test`
Expected: 全绿（含 markdown-xss 集成测试行为不变——缓存只改性能不改输出）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/markdown.ts apps/desktop/src/renderer/src/stores/message.store.ts apps/desktop/tests/unit/markdown-cache.spec.ts
git commit -m "feat(阶段7批次C): Task3 CyMarkdown 渲染缓存——模块级 Map<source,html> + clearMarkdownCache 挂 resetConversation（TDD）"
```

---

### Task 4: mock 多分段种子 + 单测

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`
- Modify: `apps/desktop/src/main/index.ts`（env 桥接线）
- Test: `apps/desktop/tests/unit/mock-multi-segment.spec.ts`（新，或并入既有 mock-backend spec）

**Interfaces:**
- Consumes: `MockBackendOptions`、`MockBackend` 的 `emit`/`scheduleReplay`（既有）。
- Produces: `CYRENE_MOCK_MULTI_SEGMENT` env → MockBackend 生成含 N 个 `public_reply` 分段的回复。

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/tests/unit/mock-multi-segment.spec.ts
import { describe, expect, it } from 'vitest'
import { MockBackend, parseMockMultiSegmentEnv } from '../../src/main/transport/mock-backend'
import type { ChatHistoryQuery } from '@shared/contracts'

describe('CYRENE_MOCK_MULTI_SEGMENT env 解析（Task 4）', () => {
  it('未设/空串/非法 → undefined（不注入）', () => {
    expect(parseMockMultiSegmentEnv(undefined)).toBeUndefined()
    expect(parseMockMultiSegmentEnv('')).toBeUndefined()
    expect(parseMockMultiSegmentEnv('abc')).toBeUndefined()
  })
  it('正整数 → 分段数 N', () => {
    expect(parseMockMultiSegmentEnv('100')).toBe(100)
    expect(parseMockMultiSegmentEnv('3')).toBe(3)
  })
  it('0/负数/NaN → undefined（不允许空 seed）', () => {
    expect(parseMockMultiSegmentEnv('0')).toBeUndefined()
    expect(parseMockMultiSegmentEnv('-5')).toBeUndefined()
  })
})

// 完整性 M-2 修复：seed 生成逻辑单测（不只 env 解析）
describe('CYRENE_MOCK_MULTI_SEGMENT seed 生成（Task 4）', () => {
  it('multiSegmentCount=5 时 generateMultiSegmentEvents 生成 5 个 public_reply 分段，segmentIndex 0..4 有序无重复 + completed 在末 + 文本可读', () => {
    const mock = new MockBackend({ multiSegmentCount: 5 })
    // 准确 r2 + 符合 N-1 修正：调用实现定义的纯方法 generateMultiSegmentEvents（非未定义的 Cells helper）
    const segs = mock.generateMultiSegmentEvents('g1', 'm1', 'r1', 'c1')
    expect(segs.filter((e) => e.event === 'generation.segment.started').length).toBe(5)
    const idxs = segs.filter((e) => e.event === 'generation.segment.started').map((e) => e.segmentIndex)
    expect(idxs).toEqual([0, 1, 2, 3, 4])   // 有序无重复
    expect(new Set(idxs).size).toBe(5)
    // completed 在末
    expect(segs[segs.length - 1].event).toBe('generation.completed')
    // 文本可读确定性（避 base64 黑名单，安全 M-4）
    const firstDelta = segs.find((e) => e.event === 'generation.delta')
    expect(firstDelta!.text).toMatch(/^模拟命中文本 \d+$/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run --config vitest.config.mts apps/desktop/tests/unit/mock-multi-segment.spec.ts`
Expected: FAIL——`parseMockMultiSegmentEnv` 未定义。

- [ ] **Step 3: 实现 env 解析 + seed 生成**

改 `mock-backend.ts`：

```ts
/** CYRENE_MOCK_MULTI_SEGMENT env → 多分段回复分段数：undefined/空串→undefined；
 *  正整数→原值；0/负数/NaN/非整数→undefined（不允许空 seed）。useMock 门控（index.ts 装配）。 */
export function parseMockMultiSegmentEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) return undefined
  return n
}
```

构造体加 `readonly multiSegmentCount?: number`（`this.multiSegmentCount = options.multiSegmentCount ?? undefined`），并加 `readonly seedHistoryCount: number`（既有，供 getConversationMessages seed）。

在 scheduleReplay / generation 事件生成路径，若 `this.multiSegmentCount` 为 N，则生成 N 个 `public_reply` 分段。**准确性 M-7 关键约束（否则 renderer 标 completing 不 completed）**：
- **取代而非追加**：N 段**替换**夹具既有段（seg-pr-1/seg-pr-2）——当 `multiSegmentCount` 设置时，跳过夹具的 public_reply 分段重放，仅播放合成 N 段。
- **segmentIndex 从 0 递增**（0..N-1），不与夹具占位冲突——夹具仅在 `multiSegmentCount` 未设时生效。
- **deltaSequence 每段从 0 累计**：每 segment 发 `generation.segment.started`（segmentIndex=i）→ 若干 `generation.delta`（deltaSequence=0..k）→ `generation.segment.completed`。
- **`generation.completed` 须排在最末**（所有 N 段完成后）——playlist 末尾追加，确保 `applyCompleted` 在最后执行，否则 `hasGap`→`completing` 非 `completed`。

**准确 M-7 + 符合 N-1 修复**：生成逻辑抽成**可测纯方法** `generateMultiSegmentEvents(genId, msgId, responseId, convId): BackendEvent[]`（scheduleReplay 与单测共用——不再是内联未定义 helper），并 `scheduleReplay` 在 `multiSegmentCount` 设置时改用它：

```ts
// MockBackend 类内纯方法（可供单测直接调）
generateMultiSegmentEvents(generationId: string, messageId: string, responseId: string, conversationId: string): BackendEvent[] {
  const events: BackendEvent[] = []
  for (let i = 0; i < (this.multiSegmentCount ?? 0); i++) {
    const segId = `pr-ms-${i}`
    const text = `模拟命中文本 ${i}`   // 可读确定性文本，避 base64 黑名单（安全 M-4）
    events.push(this.stampEvent({ event: 'generation.segment.started', segmentId: segId, segmentIndex: i, channel: 'public_reply', kind: 'markdown', generationId, messageId, responseId, conversationId }))
    events.push(this.stampEvent({ event: 'generation.delta', segmentId: segId, segmentIndex: i, channel: 'public_reply', kind: 'markdown', generationId, messageId, responseId, conversationId, deltaSequence: 0, text }))
    events.push(this.stampEvent({ event: 'generation.segment.completed', segmentId: segId, segmentIndex: i, channel: 'public_reply', kind: 'markdown', generationId, messageId, responseId, conversationId }))
  }
  events.push(this.stampEvent({ event: 'generation.completed', generationId, messageId, responseId, conversationId }))
  return events
}

// scheduleReplay 内：multiSegmentCount 设置时改用 generateMultiSegmentEvents（取代夹具 public_reply 段）
if (this.multiSegmentCount) {
  const events = this.generateMultiSegmentEvents(this.generationId, this.messageId, this.responseId, this.conversationId)
  events.forEach((e, i) => setTimeout(() => this.emit(e), i * this.emitDelayMs))
  return
}
// ...否则走既有夹具逐条重放...
```

> 注：完整事件字段按既有 `BackendEvent` 判别联合；`stampEvent` 为既有 envelope 打戳。`multiSegmentCount` 与 `CYRENE_MOCK_HISTORY_LARGE` 正交——前者控回复分段数，后者控历史/长会话消息数。

改 `index.ts` env 桥：

```ts
const mockMultiSegment = useMock ? parseMockMultiSegmentEnv(process.env.CYRENE_MOCK_MULTI_SEGMENT) : undefined   // useMock 门控（安全 M-4）
// ...new MockBackend({ multiSegmentCount: mockMultiSegment, ... })
```

**getConversationMessages seed（准确性 M-2 修复——长会话 200 条前提）**：`seedHistoryCount>0` 时 `getConversationMessages` 返回该会话的 `messageRecords`（升序分页），否则维持 `{ items: [], hasMore: false }`：

```ts
// mock-backend.ts:544-546 改
async getConversationMessages(input: ConversationMessagesQuery): Promise<MessagePage> {
  if (this.seedHistoryCount > 0) {
    const records = this.messageRecords
      .filter((m) => m.conversationId === input.conversationId)
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
    return { items: records, hasMore: false }
  }
  return { items: [], hasMore: false }
}
```

> 注：长会话用例经 `CYRENE_MOCK_HISTORY_LARGE`（=N 条）激活 seed 会话，`activate()→getMessages()` 调 `getConversationMessages` 返回 N 条 → 消息列表虚拟列表渲染（可视行有界）。`conversation.store.ts:158` activate 读 `getMessages`——消息列表走此路径。

- [ ] **Step 4: 运行测试确认通过**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run --config vitest.config.mts apps/desktop/tests/unit/mock-multi-segment.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/mock-multi-segment.spec.ts
git commit -m "feat(阶段7批次C): Task4 mock 多分段种子——CYRENE_MOCK_MULTI_SEGMENT env + useMock 门控 + parseMockMultiSegmentEnv（TDD）"
```

---

### Task 5: 性能测量集成 suite

**Files:**
- Test: `apps/desktop/tests/integration/perf-gate.spec.ts`（新）
- Modify: `apps/desktop/src/main/index.ts`（`app.commandLine.appendSwitch('enable-precise-memory-info')`，若未接）

**Interfaces:**
- Consumes: `launchApp`（helpers/app.ts）、`CYRENE_MOCK_HISTORY_LARGE`、`CYRENE_MOCK_MULTI_SEGMENT`。
- Produces: 性能测量断言（DOM 节点有界硬失败 + JS 堆告警）。

- [ ] **Step 1: 写失败测试（先跑无断言测量定基线）**

先写一个不含断言的测量脚本，跑出基线值（堆字节 / DOM 节点数），再用基线×1.5 填断言。

```ts
// apps/desktop/tests/integration/perf-gate.spec.ts
import { describe, expect, it } from 'vitest'
import { closeApp, launchApp, type LaunchedApp } from './helpers/app'

const POLL = { timeout: 15000, interval: 300 }   // 堆/节点 poll 需更长（大 seed + rAF 稳定）

async function sample(page: LaunchedApp['page'], selector = '.cy-history-item'): Promise<{ heap: number; dom: number }> {
  return page.evaluate(async (sel) => {
    // 等 3 次 rAF 稳定（JIT/GC 周期性尖峰采样）
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

describe('性能测量门禁（Task 5，松阈值=实测×1.5）', () => {
  it('历史查看器 500 项：真实加载 500 → DOM 节点有界（硬失败）+ JS 堆告警', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_HISTORY_LARGE: '500' } })
    try {
      const page = launched.page
      await page.getByRole('button', { name: '聊天记录' }).click()
      await page.getByRole('button', { name: '搜索' }).click()
      // 准确性 M-3 修复：submitQuery 默认 limit=50，需连点「加载更多」加载到 500 项（否则只渲染 50，断言空过）
      // 循环点加载更多直到 items 达全量（500），再进虚拟化窗口采样
      for (let i = 0; i < 10; i++) {
        const hasMore = await page.locator('.cy-more-btn').count()
        if (hasMore === 0) break
        await page.locator('.cy-more-btn').click()
        await expect.poll(async () => page.locator('.cy-history-item').count(), POLL).toBeGreaterThan(0)
      }
      // 等虚拟窗口稳定后采样
      const r = await sample(page)
      // DOM 节点硬失败：虚拟化后 ≤ 可视行×常数（1184×721 下 ≤60；随 overscan 独立）——500 项真实加载后仍不随 500 线性
      expect(r.dom).toBeLessThanOrEqual(60)
      expect(r.dom).toBeGreaterThan(0)   // 非空
      // JS 堆告警（非硬失败，Step 3 填松阈值）
    } finally { await closeApp(launched) }
  })

  // 完整性 M-1 + 符合性 M-1 修复：100 分段流式测量（CYRENE_MOCK_MULTI_SEGMENT 消费）
  it('100 分段回复流式渲染：可视 segment 有界 + 回放不停顿', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_MULTI_SEGMENT: '100', CYRENE_MOCK_EMIT_DELAY_MS: '1' } })
    try {
      const page = launched.page
      // 真实发送触发流式回复（经既有 send 入口）
      await page.getByPlaceholder(/发送|输入/).fill('测试 100 分段')
      await page.getByRole('button', { name: '发送' }).click()
      // 等 generation.completed（mock 多分段种子回放完成）
      await expect.poll(async () => page.evaluate(() => document.querySelectorAll('.cy-segment').length), POLL).toBeGreaterThan(0)
      // 流式渲染中可视 segment DOM 有界（CyMarkdown 缓存——多分段不重复 parse）
      const r = await sample(page, '.cy-segment')   // 符合 N-2 修正：消息流用 .cy-segment（非 .cy-history-item）
      expect(r.dom).toBeLessThanOrEqual(60)
    } finally { await closeApp(launched) }
  })

  // 准确性 M-2 修复：长会话消息列表——CYRENE_MOCK_HISTORY_LARGE 使 getConversationMessages 返回 seed（Task 4 扩展），激活会话加载长会话
  // 准确 r2 注：seedSyntheticHistory 按 i%2 均分 conv-1001/conv-1002，故 200 条 seed 下单会话约 100 条——断言「可视行有界」而非「恰好 200 条」，100 条已足够验证虚拟化窗口（> 可视窗口 60）
  it('长会话（seed ≥100）：消息列表可视行有界（虚拟窗口，非全量 DOM）', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_HISTORY_LARGE: '200' } })
    try {
      const page = launched.page
      // 激活种子会话（conversation list 首会话 = conv-1001）→ activate → getMessages → getConversationMessages 返回该会话 records
      // 会话栏条目选择器用既有 .cy-conversation（评审确认真实类名，非 .cy-conv-item）
      await page.locator('.cy-conversation').first().click()
      // 消息列表虚拟化：可视行有界（seed 均分后>100 条，但可视行 ≤ 窗口），且 >0（非空）
      await expect.poll(async () => page.evaluate(() => document.querySelectorAll('.cy-vlist-row').length), POLL).toBeGreaterThan(0)
      const rows = await page.evaluate(() => document.querySelectorAll('.cy-vlist-row').length)
      expect(rows).toBeLessThanOrEqual(60)   // 可视行有界（虚化，非全量 100+）
    } finally { await closeApp(launched) }
  })

  // 符合性 M-2 修复：Live2D 关停 rAF 停复核（复用既有 electron-live2d 断言或本批独立测）
  it('Live2D 关闭后 rAF 停（7C 复核，维持现状）', async () => {
    const launched = await launchApp(undefined)
    try {
      const page = launched.page
      // 复用既有 electron-live2d.spec.ts:284-310 的 __rafCalls 法：折叠面板后 rAF delta 0
      await page.evaluate(() => {
        let n = 0
        const orig = window.requestAnimationFrame.bind(window)
        const origCancel = window.cancelAnimationFrame.bind(window)
        ;(window as unknown as { __rafCalls: number }).__rafCalls = 0
        window.requestAnimationFrame = (cb) => { (window as unknown as { __rafCalls: number }).__rafCalls++; return orig(cb) }
        window.cancelAnimationFrame = (id) => origCancel(id)
      })
      await expect.poll(async () => page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls), POLL).toBeGreaterThan(0)
      await page.locator('.cy-live2d-toggle').first().click()   // 折叠 Live2D 面板
      const before = await page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls)
      await page.waitForTimeout(300)
      const after = await page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls)
      expect(after - before).toBe(0)   // rAF 停（维持现状，不 dispose）
    } finally { await closeApp(launched) }
  })
})
```

> 堆断言设 `it.skip` 或独立 `it.fails` 标记（可行 M-4 告警非硬失败）——实际按「告警」处理，见 Step 3。

- [ ] **Step 2: 跑测量得基线**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts perf-gate.spec.ts`
Expected: 先观察 DOM 节点数 / 堆尺寸实际值（console.log 或临时断言），得基线。

- [ ] **Step 3: 填松阈值 + 堆告警**

用基线×1.5 填 DOM 断言（硬失败）+ 堆断言标记为告警（注释声明仅聚合计数，安全 M-3）。接 `--enable-precise-memory-info`：

```ts
// index.ts（app ready 前）
app.commandLine.appendSwitch('enable-precise-memory-info')
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts perf-gate.spec.ts`
Expected: PASS——DOM 节点有界断言通过；堆告警不阻断。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/integration/perf-gate.spec.ts apps/desktop/src/main/index.ts
git commit -m "feat(阶段7批次C): Task5 性能测量集成门禁——历史查看器 DOM 节点有界(硬) + JS 堆告警 + precise-memory-info（松阈值）"
```

---

### Task 6: 全量门禁 + 文档同步

**Files:**
- Modify: `docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md`
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`
- Modify: `docs/03-Cyrene-前端UI与交互设计.md`
- Modify: `docs/01/06/11/13/17`（按 §9 文档同步清单）
- Modify: `README.md`, `CLAUDE.md`
- Modify: `docs/review/2026-08-26-阶段7批次C-决策记录.md`（新）

**Interfaces:**
- Consumes: Task 1-5 交付。

- [ ] **Step 1: 全量门禁**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop test && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop build && pnpm -F @cyrene/desktop check:contract && pnpm -F @cyrene/desktop verify:sensitive`
Expected: 全绿（verify:sensitive 若有 base64-long-string 命中，按 fail-loud 纪律补 allowlist 条目 + 人工核对）。

- [ ] **Step 2: 文档同步**

按 spec §9：doc 10 §10（7C 状态注记 + §10.2 勾选「200 条/100 分段/500 项」「内存增长」「Live2D 下降」「长会话/长流式/历史资源/Live2D」）、doc 16 §10（状态注记 + 任务清单[ → 7C] 勾选 + 进度表）、doc 03（历史查看器虚拟化）、doc 01/06（性能面）、doc 11（Live2D 读数注记）、doc 13/17、README/CLAUDE.md 状态段、决策记录（D7C-01~08 + §4C 降级记录）。

**三态声明**：本批 = 已开发、未联调。

- [ ] **Step 3: Commit**

```bash
git add docs/ README.md CLAUDE.md
git commit -m "docs(阶段7批次C): Task6 文档同步——doc10/16/03/01/06/11/13/17 + README/CLAUDE 状态段 + 决策记录（三态=已开发、未联调）"
```

---

## 验收标准（对应 spec §7）

| doc 16 验收 | 7C 落点 | 对应 Task |
|---|---|---|
| 长会话、长流式、历史资源列表与 Live2D 性能 | 历史查看器虚拟化（**500 项不虚化**）+ CyMarkdown 缓存（多分段/**长流式的副收益**——§4C 增量合并降级观察项） | Task 2/3 |
| 200 条混合消息、100 个多分段回复、500 项历史资源操作正常 | mock 多分段 + 测量 suite 断言 + 虚拟化 DOM 有界（真实加载 500 项非 50，准确 M-3） | Task 4/5/2 |
| 长时间运行无明显持续内存增长 | 测量 suite JS 堆（告警，**测量驱动**——若实测无病态增长记观察项）+ DOM 有界 | Task 5 |
| Live2D 关闭后 CPU/GPU 明显下降 | 维持现状（rAF 停为代理证据，CPU/GPU 数值实测记 7D/后续）+ 测量 suite 复核 rAF 停 | Task 5 |
| 日志和诊断导出通过敏感信息扫描 | 无新秘密面 + allowlist 条目按 fail-loud 补 | Task 6 |

---

## 三态与已知限制

- **三态 = 已开发、未联调**（真实 Windows Electron 联调为批次后独立项）。
- **§4C 流式增量合并降级**（观察项）：§4B 缓存已解「流式重复 re-parse」主瓶颈，剩余 sort 成本低但实现复杂。
- **历史查看器虚拟化后**：锚点恢复仅覆盖已加载行（未加载行无 DOM，data 层计算恢复）；Tab 焦点陷阱查询 overlay 全量 focusable。
- **性能阈值**：松阈值×1.5 防 CI 抖动，Task 5 实测后定稿；`performance.memory` 非标准 API（告警非硬失败），若 Chromium 移除则退化为仅 DOM 断言。
- **CyMarkdown 缓存**：模块级 Map，敏感文本二次驻留（post-sanitize、仅会话内清空、不跨边界）——接受档。
