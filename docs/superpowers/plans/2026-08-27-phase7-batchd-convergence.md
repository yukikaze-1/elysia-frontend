# 阶段 7 批次 D（7D 收口收敛）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成阶段 7 收口批——确认附件/录音/缓存上限清理面 + F-11 审批历史口径 + 重开两个观察项（视图感知暂停 + Live2D 读数接入诊断页）+ 阶段 7 全流程收口记录。

**Architecture:** 分五面 A~E。A 面（附件/录音/缓存上限）确认性 + 少量内存卫生补点；B 面（F-11 审批历史）纯口径文档化；C 面是**唯一真实功能**——① 视图感知暂停（CyMessageList 严格窗口下传 + CyMessageBubble 视口外 completed segment 空 source 延迟渲染）② Live2D 读数（FrameBudget.getStats → controller 透传 → live2dStore → CyDiagnosticsPane）；D 面（阶段 7 收口）纯记录+勾选；E 面（文档同步）覆盖 doc 10/12/16 + README + CLAUDE。

**Tech Stack:** Electron + Vue 3 + TypeScript + vitest（单测 + 集成 + perf-gate）+ pinia stores。

**Spec:** `docs/superpowers/specs/2026-08-27-phase7-batchd-convergence-design.md`（本 plan 的实现依据，spec §4A~4E + §5 验收标准；plan 每任务引用对应 spec 章节）

---

## Global Constraints

- **三态 = 已开发、未联调**（本批 Mock 驱动；真实 Windows Electron 联调为批次后独立项）。**所有文档一致标注「已开发、未联调」，不得标「已完成/已真实联调」。**
- **正文敏感纪律**：inner_voice / chat content / snippet / 录音永不写日志、永不出诊断导出；延迟渲染/读数只处理元数据（segment source / frame stats），不引入正文进日志/导出。
- **黑名单永远优先**、凭据 fail-closed 不拉平——本批无新凭据/权限面，但 D 面收口记录引用须与既有结论一致。
- **docs 全中文**。
- **Node**：测试命令前置 `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH`。
- **不推翻既有用户拍板**：D-08 资源落盘不做、§4C 流式增量合并降级观察项（7C）、长会话内存有界观察项（7C）、`performance.memory` 退化只记录。本批只做 spec §0 五块 A~E。
- **视图感知暂停不改断言语义**：perf-gate ② `.cy-segment=toBe(MULTI_SEGMENT_N)` **保持成立**（视口内完成态回复全量渲染），仅翻转注释为「已落地视图感知暂停」。
- **C 面两功能为纯 renderer 层**：无新 IPC、无新 main 进程改动（Live2D 读数读 store、视图感知下传 prop）。

---

## File Structure

| 文件 | 责任 | Task |
|---|---|---|
| `apps/desktop/src/renderer/src/stores/attachment.store.ts` | remove() 补清 kindByLocalId/fileByLocalId | 1 |
| `apps/desktop/tests/unit/attachment.store.spec.ts` | remove 清引用单测 | 1 |
| `apps/desktop/src/main/tools/tool-history.ts` | 读面 7 天/存面 30 天口径注释 | 2 |
| `apps/desktop/tests/unit/markdown-cache.spec.ts`（或既有） | 无改动（B 面纯注释） | 2 |
| `apps/desktop/src/renderer/src/utils/virtual-window.ts` | 无改动（复用 computeWindow） | 3 |
| `apps/desktop/src/renderer/src/components/CyMessageList.vue` | win 增 strictStart/strictEnd + v-for 下传 visible | 3 |
| `apps/desktop/src/renderer/src/components/CyMessageBubble.vue` | props.visible + needsDeferredRender | 3 |
| `apps/desktop/src/renderer/src/live2d/perf.ts` | FrameBudget.getStats() | 4 |
| `apps/desktop/src/renderer/src/live2d/controller.ts` | Live2DController.getStats() 透传 | 4 |
| `apps/desktop/src/renderer/src/stores/live2d.store.ts` | getStats() 判 status 返回 null | 4 |
| `apps/desktop/src/renderer/src/components/CyDiagnosticsPane.vue` | Live2D 性能读数替换占位 | 4 |
| `apps/desktop/tests/unit/perf.spec.ts` | FrameBudget.getStats 单测 | 4 |
| `apps/desktop/tests/integration/perf-gate.spec.ts` | ②注释翻转（视为已落地）+ ①新增视图感知断言 | 3 |
| `apps/desktop/tests/integration/electron-live2d.spec.ts` | 诊断页 Live2D 读数集成断言 | 4 |
| `docs/review/2026-08-27-阶段7批次D-决策记录.md` | D7D-01~04 决策 + 执行记录 + 收口确认 | 5 |
| `docs/10/12/16` + `docs/04/05/06` + `docs/07` + `README.md` + `CLAUDE.md` | 文档同步 | 5 |

---

### Task 1: 附件内存卫生（面 A）——remove() 清 kindByLocalId/fileByLocalId

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/attachment.store.ts:123-126`
- Test: `apps/desktop/tests/unit/attachment.store.spec.ts`

**Interfaces:**
- Consumes: `attachmentQueueReducer`（既有，`attachment-state.ts` remove action 只动 pendingById/order）。
- Produces: `remove(localId)` 在非上传中清 `kindByLocalId[localId]`/`fileByLocalId[localId]`——单测断言。

- [ ] **Step 1: 写失败测试**

在 `attachment.store.spec.ts` 增用例（参照既有 remove 用例 `:138-148`，须先 mock `attachmentsValidate` 返回 image kind——既有用例先例如 `attachment.store.spec.ts:40-41`，否则 `validateAll` 对 undefined 迭代报错）：

```ts
mockApi.attachmentsValidate.mockImplementation(async ({ files }) =>
  files.map((f) => ({ localId: f.localId, ok: true, kind: 'image' })))

it('remove：非上传中清 kindByLocalId/fileByLocalId（单个移除即时释放强引用）', async () => {
  store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
  const id = store.order[0]
  await vi.waitFor(() => { expect(store.kindByLocalId[id]).toBe('image') })   // validateAll → kind
  expect(store.fileByLocalId[id]).toBeDefined()   // bytes 引用存在
  store.remove(id)
  expect(store.pendingById[id]).toBeUndefined()   // 队列清
  expect(store.kindByLocalId[id]).toBeUndefined() // 新增：kind 清
  expect(store.fileByLocalId[id]).toBeUndefined() // 新增：file/bytes 引用清
  // 不清其它 localId
  store.addFiles([{ name: 'b.png', size: 10, mediaType: 'image/png', source: 'paste', bytes: new ArrayBuffer(2) }])
  const id2 = store.order.find((x) => x !== id)!
  expect(store.fileByLocalId[id2]).toBeDefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run tests/unit/attachment.store.spec.ts -t "remove"`
Expected: FAIL（`expect(store.kindByLocalId[id]).toBeUndefined()` 失败——现状 remove 不清）。

- [ ] **Step 3: 实现 remove 补清**

`attachment.store.ts:123-126`：

```ts
function remove(localId: string): void {
  if (uploading.value) return   // 上传中禁止移除（spec §4.3）
  commit({ type: 'remove', localId })
  delete kindByLocalId.value[localId]   // 7D：单个移除即时释放强引用（上传中短路不清，由 clearOnSent/clear 兜底）
  delete fileByLocalId.value[localId]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run tests/unit/attachment.store.spec.ts`
Expected: PASS（全用例，含既有 remove 用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/attachment.store.ts apps/desktop/tests/unit/attachment.store.spec.ts
git commit -m "fix(阶段7批次D Task1): 附件 remove 补清 kindByLocalId/fileByLocalId——单个移除即时释放 File/ArrayBuffer 强引用"
```

---

### Task 2: F-11 审批历史口径（面 B）——tool-history.ts 注释 + 文档化

**Files:**
- Modify: `apps/desktop/src/main/tools/tool-history.ts:20-21`
- Docs: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（F-11 行）、`docs/04-Cyrene-Desktop工具与权限交互设计-v0.2.md`（§7.4）

**Interfaces:**
- Consumes: 既有 `HISTORY_DAYS`/`HISTORY_MAX` 常量。
- Produces: 注释 + 文档化「读面 7 天（产品）vs 存面 30 天（审计合规）」。

- [ ] **Step 1: 加 tool-history.ts 注释**

`tool-history.ts:20-21` 常量处补注释（读面 7 天语义）：

```ts
// F-4：天数边界——读面「审批历史在设置页看最近 7 天」是产品语义；存面（audit-*.jsonl 磁盘保留 30 天，
// diagnostics-service.ts AUDIT_RETENTION_DAYS=30）是审计合规。两者目的不同，不拉平（7D D7D-02）。
export const HISTORY_DAYS = 7
// 合并结果总量上限（逐文件流式读满即停）
export const HISTORY_MAX = 200
```

- [ ] **Step 2: 更新 doc 16 F-11 行**

`docs/16` F-11 行（`审批历史/工具日志保留、容量、清理与导出策略`）：`[ ]`→`[x]` + 注记「7D 确认：读面 7 天（设置页审批历史，产品语义）+ 存面 30 天（审计合规）+ 容量上限 200 条回读——不拉平，见决策记录」。

- [ ] **Step 3: 更新 doc 04 §7.4**

`docs/04` §7.4 附录记「审批历史保留策略：读面 7 天 / 容量 200 条 / 存面跟审计 30 天——产品显示与审计留存分离（D7D-02）」。

- [ ] **Step 4: Verify**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop typecheck:node && pnpm -F @cyrene/desktop lint`
Expected: PASS（注释/doc 无类型/lint 影响）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/tools/tool-history.ts docs/16-Cyrene-前端实施任务清单与进度跟踪.md docs/04-Cyrene-Desktop工具与权限交互设计-v0.2.md
git commit -m "docs(阶段7批次D Task2): F-11 审批历史口径——读面7天(产品) vs 存面30天(审计合规)不拉平 + tool-history 注释"
```

---

### Task 3: 视图感知暂停（面 C①，真实功能）——mock 支撑 + 严格窗口下传 + 视口外 completed segment 延迟渲染

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts:446-459`（seedSyntheticHistory assistant 补 markdown 段，spec §4C.3）
- Modify: `apps/desktop/src/renderer/src/components/CyMessageList.vue:36-45,234-244`
- Modify: `apps/desktop/src/renderer/src/components/CyMessageBubble.vue:11,99-100`
- Test: `apps/desktop/tests/integration/perf-gate.spec.ts`（③尾差异化断言 + ②注释翻转；② `toBe(N)` 保持）

**Interfaces:**
- Consumes: `computeWindow`（`virtual-window.ts`, `overscanPx=0` 严格窗口），`OVERSCAN_PX=400`，`AssistantSegment.completed`（`contracts/message.ts:48`），`seedSyntheticHistory`（`mock-backend.ts`）。
- Produces: `CyMessageList` 在 win 暴露 `strictStartIndex/strictEndIndex` + `v-for` 下传 `:visible`；`CyMessageBubble` 新增 `props.visible`（不传=undefined 视为可见）+ `needsDeferredRender(seg)`；mock 长会话种子 assistant 带 `.cy-segment`。

> **测试策略（MD-1 定案）**：视图感知价值域是**长会话多短 markdown 回复滚动**——单条 100 分段恒跨视口、`rowVisible()` 恒 true、特性不生效。故差异化断言放 **perf-gate ③（长会话 seed）**：③尾先滚到某旧回复出视口 → 断言行 `.cy-segment` 内容为空（空 source 被门控）；滚回视口 → 内容非空（换真源）。②的 `toBe(MULTI_SEGMENT_N)` **保持**（视口内完成态全量渲染，视图感知对该行不生效），仅翻转注释。

- [ ] **Step 1: 写失败集成测试（③尾差异化断言 + ②注释翻转 + perf-gate 头部 M-3 例外）**

`perf-gate.spec.ts`：

**头部 M-3 例外 note（Minor 补）：** perf-gate.spec.ts 头部「仅聚合计数，不读消息文本…不读分段内容量」注释（:4-22）——差异化断言引入 `.textContent` 读（mock 确定性文本 `模拟命中文本`，非用户内容）——**须在头部追加例外注**：

```ts
// M-3 例外（阶段7批次D）：③尾差异化断言读 .cy-segment textContent——仅 mock 确定性文本（模拟命中文本 N，
// seedSyntheticHistory 生成，非用户内容），不进日志/导出；非内容侧信道（perf-gate 只用于性能门禁，读的是 mock 种子）。
```

**②注释翻转**：头部「观察项视图感知暂停」→「已落地视图感知暂停——视口内完成态全量渲染，滚动出视口延迟」；②现有 `expect(r.dom).toBe(MULTI_SEGMENT_N)` 保持不回退（视图感知对该恒可视行不生效）。

**③尾追加差异化断言**（在 ③ 既有 `expect(pads!.scrollHeight).toBeGreaterThan(...)` 之后）——MD-1 钉死为「空 segment 存在性」断言，可执行、无占位：

```ts
// MD-1：差异化断言——长会话 seed（大量短 markdown 回复，mock 补 markdown 段后）消息列表位于底部（最新在视口内，
// 上方 overscan 行视口外）。视图感知：视口外 completed segment 空 source → 其 .cy-segment 内容为空；视口内非空。
// 断言「存在内容为空的 .cy-segment」（视口外 overscan 行被门控）——恒全量渲染（视图感知失效）则 empty=0（fail）。
// 只读 mock 确定性文本（模拟命中文本，非用户内容），不引入内容侧信道（perf-gate 头部 M-3「仅聚合计数」例外已注明）。
const segs = await page.evaluate(() => {
  const out = { total: 0, empty: 0, nonEmpty: 0 }
  document.querySelectorAll('.cy-messages .cy-segment').forEach((s) => {
    out.total++
    if ((s.textContent ?? '').trim().length > 0) out.nonEmpty++; else out.empty++
  })
  return out
})
expect(segs.total).toBeGreaterThan(0)
expect(segs.empty).toBeGreaterThan(0)   // 视口外 overscan 行被门控（内容空）
// 视口内回复非空（门控只影响视口外行）
expect(segs.nonEmpty).toBeGreaterThan(0)
console.log(`[perf-gate] viewsense seg total=${segs.total} empty=${segs.empty} nonEmpty=${segs.nonEmpty}`)
```

> 注：`empty > 0` 依赖「底部长会话有 overscan 行在视口外且被门控」——虚拟化渲染窗含 overscan（`OVERSCAN_PX=400`），长会话 seed 后底部窗口上方必有视口外的 overscan 行；若某环境该场景不成立（窗口过小无 overscan 行），降级为：`window.__cyreneTest` 挂载计数探针（仿 7C `getMouthLevel`）读「renderMarkdown 调用计数」，断言视口外未调用。**实现者优先用 `empty>0` 断言，仅当实测确实无 overscan 行时用探针降级**（spec §4C.3 已明确）。

- [ ] **Step 2: 跑集成测试确认现状（②/③语义保持 + mock 种子兼容）**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts perf-gate`
Expected: ②/③ PASS（现状全量，seed 补 markdown 段前 ③ 不数 segment 内容，语义保持）；**视图感知未落地时 `empty>0` 失败**（恒全量渲染 empty=0）——待 Step 6 实现后通过。

- [ ] **Step 3: mock 长会话种子 assistant 补 markdown 段（spec §4C.3）**

`mock-backend.ts:446-459` `seedSyntheticHistory`——assistant 分支补 `assistantSegments`（让长会话含大量带 `.cy-segment` 的短 completed markdown 回复，视图感知才有可门控对象）：

```ts
private seedSyntheticHistory(count: number): Message[] {
  const mk = (messageId: string, conversationId: string, role: 'user' | 'assistant', createdAt: string, content: string): Message => {
    const base: Message = { messageId, conversationId, role, createdAt, status: 'completed', content }
    if (role !== 'assistant') return base
    // 7D（spec §4C.3）：assistant 补 markdown 段——长会话成为「大量带 .cy-segment 的短 completed markdown 回复」，
    // 滚动出视口后视图感知对其生效。content 保留作兜底（不删）。
    return { ...base, assistantSegments: [{ segmentId: `run2-seg-${messageId}`, segmentIndex: 0, channel: 'public_reply', kind: 'markdown', text: content, completed: true }] }
  }
  const DAY = 86_400_000, MIN = 60_000
  const base = new Date('2026-08-08T00:00:00.000Z').getTime()
  const out: Message[] = []
  for (let i = 0; i < count; i++) {
    const day = Math.floor(i / 30), minute = i % 30
    const createdAt = new Date(base + day * DAY + minute * MIN).toISOString()
    // 7D（Blocking1 修正）：conversation 与 role 解耦——conversation 按 i%2 均分（各 ~count/2 条，③「~100条/会话」前提保留），
    // role 按 Math.floor(i/2)%2 交替（conv-1001 得 user/assistant 混合，含 markdown 段——视图感知才有可门控对象；
    // 原「i%2 同时决定 conv 和 role」使 conv-1001 全 user、conv-1002 全 assistant，activate conv-1001 后 0 个 .cy-segment，断言必败）。
    const conversationId = i % 2 === 0 ? 'conv-1001' : 'conv-1002'
    const role = Math.floor(i / 2) % 2 === 0 ? 'user' : 'assistant'
    out.push(mk(`run2-msg-${String(i + 1).padStart(4, '0')}`, conversationId, role, createdAt, `模拟命中文本 ${i + 1}`))
  }
  return out
}
```

（单测：`mock-backend-seed.spec.ts`（若有）或 `mock-multi-segment.spec.ts` 补——seed 后 assistant 消息 `assistantSegments[0].channel==='public_reply' && completed===true`。）

- [ ] **Step 4: 实现 CyMessageList win 严格窗口 + 下传**

`CyMessageList.vue:36-45` 改 win computed：

```ts
const win = computed(() => {
  const w = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
  const strict = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, 0)  // 7D：严格可见窗口（无 overscan）
  return {
    startIndex: w.startIndex,
    endIndex: w.endIndex,
    paddingTop: w.paddingTop,
    paddingBottom: w.paddingBottom,
    visibleIds: items.value.slice(w.startIndex, w.endIndex + 1).map((m) => m.messageId),
    strictStartIndex: strict.startIndex,   // 7D：真正可见行区间
    strictEndIndex: strict.endIndex,
  }
})

/** 全球行 index 是否落在严格可见窗口（无 overscan）——直接比较循环内 index */
function rowVisible(globalIdx: number): boolean {
  return globalIdx >= win.value.strictStartIndex && globalIdx <= win.value.strictEndIndex
}
```

`CyMessageList.vue:234-244` 改渲染循环：

```html
<div
  v-for="(id, i) in win.visibleIds"
  :key="id"
  :data-message-id="id"
  :ref="(el) => setRowEl(id, el as Element | null)"
  class="cy-vlist-row"
  :class="{ 'cy-highlighted': messageStore.highlightMessageId === id }"
>
  <CyMessageBubble :message="messageStore.byId[id]" :visible="rowVisible(win.startIndex + i)" />
  <span v-if="messageStore.highlightMessageId === id" class="cy-located-chip">已定位</span>
</div>
```

- [ ] **Step 5: 实现 CyMessageBubble props.visible + needsDeferredRender**

`CyMessageBubble.vue:11`：

```ts
const props = defineProps<{ message: Message; visible?: boolean }>()   // 不传 = undefined → 视为可见（不延迟）；父级显式传 false 才延迟

/** 7D 视图感知暂停：视口外 completed segment 空 source 延迟渲染（streaming/mock 恒实时）。 */
function needsDeferredRender(seg: AssistantSegment): boolean {
  return props.visible === false && seg.completed === true
}
```

`CyMessageBubble.vue:99-100` 改 markdown segment 渲染：

```html
<CyMarkdown
  v-if="isTextSegment(seg)"
  class="cy-segment"
  :source="needsDeferredRender(seg) ? '' : segmentText(seg)"
/>
```

（CyMarkdown 的 `watch(() => props.source)` 收到 source 从 '' → 真值变化会自动触发渲染，无需改 CyMarkdown。）

- [ ] **Step 6: 跑集成测试确认通过**

Run（同 Step 2 命令，全 perf-gate）
Expected: PASS。② `toBe(N)` 保持（视图感知对该恒可视行不生效）；③尾差异化断言——滚出视口的行 `.cy-segment` 内容为空（空 source 被门控）、滚回视口非空（换真源）；③既有行有界/垫片不塌断言保持（`mock seed 补 markdown 段`不数 segment 内容，③ 语义不变）。

- [ ] **Step 7: Verify + Commit**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint`
Expected: PASS。

```bash
git add apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/renderer/src/components/CyMessageList.vue apps/desktop/src/renderer/src/components/CyMessageBubble.vue apps/desktop/tests/integration/perf-gate.spec.ts apps/desktop/tests/unit/mock-multi-segment.spec.ts
git commit -m "feat(阶段7批次D Task3): 视图感知暂停——视口外 completed segment 空 source 延迟渲染(严格窗口下传,streaming豁免+mock长会话种子补markdown段)"
```

---

### Task 4: Live2D 数值读数接入诊断页（面 C②，真实功能）——FrameBudget.getStats 透传

**Files:**
- Modify: `apps/desktop/src/renderer/src/live2d/perf.ts`（FrameBudget.getStats）
- Modify: `apps/desktop/src/renderer/src/live2d/controller.ts`（Live2DController.getStats）
- Modify: `apps/desktop/src/renderer/src/stores/live2d.store.ts`（getStats 判 status 返回 null）
- Modify: `apps/desktop/src/renderer/src/components/CyDiagnosticsPane.vue:240-241`
- Test: `apps/desktop/tests/unit/perf.spec.ts`（FrameBudget.getStats 单测）+ `apps/desktop/tests/unit/cy-diagnostics-pane.spec.ts:190`（N1：断言同步 `未启动`）+ `apps/desktop/tests/unit/live2d.store.spec.ts` 或既有 live2d store 测试（N3：getStats 正path）+ `apps/desktop/tests/integration/electron-live2d.spec.ts`（诊断页负向断言）

**Interfaces:**
- Consumes: `FrameBudget`（`perf.ts`，私有 `emaCost`/`autoTarget`/`mode`），`Live2DController.budget`（`controller.ts:93`），`live2dStore.status`（`live2d.store.ts`）。
- Produces: `FrameBudget.getStats(): { emaCostMs, autoTargetFps, mode }`；`Live2DController.getStats()` 透传；`live2dStore.getStats(): Live2dFrameStats | null`（status!==ready → null）。

- [ ] **Step 1: 写失败单测（FrameBudget.getStats）**

`perf.spec.ts` 增用例：

```ts
it('getStats：暴露 emaCostMs/autoTargetFps/mode（auto 模式目标帧率；非 auto 为 null）', () => {
  const b = new FrameBudget('auto', 0)
  b.shouldDraw(0)   // 首帧
  for (let i = 0; i < 12; i++) b.feedCost(20)   // 持续高耗时 → 降 30fps
  let s = b.getStats()
  expect(s.mode).toBe('auto')
  expect(s.autoTargetFps).toBe(30)
  expect(s.emaCostMs).toBeGreaterThan(0)
  b.setMode('balanced')
  s = b.getStats()
  expect(s.mode).toBe('balanced')
  expect(s.autoTargetFps).toBeNull()   // 非 auto 为 null
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run tests/unit/perf.spec.ts -t "getStats"`
Expected: FAIL（`getStats is not a function`）。

- [ ] **Step 3: 实现 FrameBudget.getStats**

`perf.ts` 加：

```ts
/** 性能读数（7D）：暴露帧耗时 EMA + 目标帧率 + 模式——诊断页「Live2D 性能」数据源。 */
getStats(): { emaCostMs: number; autoTargetFps: number | null; mode: PerformanceMode } {
  return { emaCostMs: this.emaCost, autoTargetFps: this.mode === 'auto' ? this.autoTarget : null, mode: this.mode }
}
```

- [ ] **Step 4: 实现 Live2DController.getStats 透传**

`controller.ts` 加：

```ts
/** 性能读数（7D）：透传 FrameBudget.getStats——budget 恒构造非空，未 ready 时为构造默认值（诊断页在 store 层判 status）。 */
getStats(): { emaCostMs: number; autoTargetFps: number | null; mode: PerformanceMode } {
  return this.budget.getStats()
}
```

- [ ] **Step 5: 实现 live2dStore.getStats（判 status 返回 null）**

`apps/desktop/src/shared/contracts/live2d.ts` 加类型：

```ts
/** Live2D 性能读数（7D）：FrameBudget 帧耗时 EMA + 目标帧率 + 模式——诊断页「Live2D 性能」数据源。 */
export interface Live2dFrameStats {
  emaCostMs: number
  autoTargetFps: number | null
  mode: PerformanceMode
}
```

`live2d.store.ts` 加：

```ts
/** 性能读数（7D）：仅在 ready 态返回（否则 null——诊断页无读数）。controller 缺失/未 ready → null（M-1：无读数判定唯一来源 = status）。 */
function getStats(): Live2dFrameStats | null {
  if (status.value !== 'ready' || !controller) return null
  return controller.getStats()
}
```

（`Live2dFrameStats` 从 `@shared/contracts` import；`controller.getStats()` 返回类型与之一致。）

`live2d.store.ts` return 加 `getStats`：

```ts
return {
  models, status, modelId, error, live2dSettings, characterState, mouthLevel, mouthSourceKind, mouthMoved, mouthSettled,
  init, switchModel, restoreDefaults, dispose, tick, handleDirective, getStats,   // 7D getStats
  ...
}
```

- [ ] **Step 6: 实现 CyDiagnosticsPane 替换占位**

`CyDiagnosticsPane.vue:240-241`：

```html
<h5 class="cy-diagnostic-dev-subtitle">Live2D 性能</h5>
<p v-if="live2dStats" class="cy-diagnostic-line" data-testid="diag-dev-perf">
  帧耗时（EMA）：<span class="cy-diagnostic-val">{{ live2dStats.emaCostMs.toFixed(1) }} ms</span>
  <template v-if="live2dStats.autoTargetFps">&nbsp;·&nbsp;目标帧率：{{ live2dStats.autoTargetFps }} fps</template>
  &nbsp;·&nbsp;模式：{{ live2dStats.mode }}
</p>
<p v-else class="cy-security-empty" data-testid="diag-dev-perf">Live2D 未启动（无读数）</p>
```

script 加：

```ts
import { useLive2dStore } from '../stores/live2d.store'
const live2dStore = useLive2dStore()
const live2dStats = computed(() => live2dStore.getStats())   // 读取时取值（诊断页打开时读当前值）
```

- [ ] **Step 6b: 同步既有测试断言（N1）+ 补 store 层 getStats 单测（N3）**

**N1——`tests/unit/cy-diagnostics-pane.spec.ts:190`**：既有断言 `expect(w.find('[data-testid="diag-dev-perf"]').text()).toContain('不可用')`——Step 6 把空态文案从「不可用——帧耗时统计未导出…」改为「Live2D 未启动（无读数）」，该断言必红。同步改为：

```ts
// 空态（happy-dom 未挂 Live2D controller → getStats null → 显示未启动）
expect(w.find('[data-testid="diag-dev-perf"]').text()).toContain('未启动')
```

**N3——store 层 `live2dStore.getStats` 正path 单测**（`perf.spec.ts` 只覆盖 FrameBudget 底层；`live2dStore.getStats` 的 status 分支零覆盖）。仿 `live2d-panel.spec.ts` 用 `setLive2dControllerFactory` 注入 fake controller，新增用例（`live2d.store.spec.ts` 或既有 live2d store 测试文件）：

```ts
it('getStats：status==ready && controller → 返回读数；status!==ready → null', async () => {
  const fake = { getStats: () => ({ emaCostMs: 12.3, autoTargetFps: 60, mode: 'auto' }), ... }   // fake controller（仿 live2d-panel 的 ControllerFactory 注入）
  setLive2dControllerFactory(() => fake as unknown as Live2DController)
  const store = useLive2dStore()
  await store.init(fakeCanvas as unknown as HTMLCanvasElement)   // 或以既有 fake 路径拉起 ready
  expect(store.status).toBe('ready')
  expect(store.getStats()).toEqual({ emaCostMs: 12.3, autoTargetFps: 60, mode: 'auto' })
  store.dispose()
  expect(store.getStats()).toBeNull()   // unloaded → null
})
```

> 注：具体注入/拉起路径以 `live2d-panel.spec.ts` 既有 fake controller 纪律为准（node 无 WebGL，用 fake adapter + 状态机驱动）。此用例补正path coverage（诊断页集成层不可达的 ready→读数由 store 层承载）。

- [ ] **Step 7: 跑单测 + 集成确认通过**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop exec vitest run tests/unit/perf.spec.ts tests/unit/cy-diagnostics-pane.spec.ts && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts electron-live2d`

**集成断言（Blocking2 定案：打开设置页 unmount 整个 chat 视图（含 CyLive2DPanel）→ `onBeforeUnmount` 调 `dispose()`（CyLive2DPanel.vue:252-259）→ `live2dStore.dispose()` 置 status='unloaded'、controller=null（live2d.store.ts:358-384）。故诊断页打开时 Live2D **恒为 'unloaded'**，`getStats()` 恒 null → `diag-dev-perf` **恒显示「未启动」**——ready 态读数在集成层**不可达**。集成只验**负向**（未启动），正path（ready→读数）由单测（`perf.spec.ts` FrameBudget.getStats）+ store 级集成（`live2dStore.getStats` status 判 null/非 null）承载。**）**——`electron-live2d.spec.ts` 加用例：

```ts
it('诊断页 Live2D 性能：设置打开时显示「未启动」（Live2D 被 settings 卸载 → status unloaded → getStats null）', async () => {
  const ud = ...   // 复用既有 launchL2d 的 userData
  const launched = await launchL2d(ud)
  try {
    const { page } = launched
    await waitLive2dSettled(page)   // chat 视图 Live2D 就绪
    // 打开设置 → 开发与诊断 → 开开发者模式（confirm 处理）
    page.on('dialog', (d) => d.accept())
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.cy-settings-nav-item', { hasText: '开发与诊断' }).click()
    await page.locator('button[data-testid="diag-dev-toggle"]').click()
    // 设置打开 → chat（Live2D）已 unmount → status unloaded → getStats null → 显示未启动
    await expect(page.getByTestId('diag-dev-perf')).toContainText(/未启动|无读数/)
  } finally { await closeApp(launched) }
})
```

> 注：`diag-dev-toggle` 是 `v-if="state"` 渲染（CyDiagnosticsPane.vue:207），`onToggleDev` 调 `window.confirm`（:90）——必须 `page.on('dialog', accept)`。`diag-dev-perf`（:241）在 `v-if="state?.devMode"` template 内。**正path（ready 态读数显示 `ms`/`模式`）在本架构下无集成可达面**（诊断页只存在于 settings，settings 卸载 chat/Live2D）——由单测 `perf.spec.ts`（FrameBudget.getStats 返回 `{emaCostMs, autoTargetFps, mode}`）+ store 级集成（`live2dStore.getStats`：status==='ready' && controller 非零 → 返回读数；否则 null）承载，spec §4C.2 已声明「读取时取值」的架构约束。

Expected: PASS（getStats 单测 + store-ish 集成 `status!=='ready'→null`；集成仅验设置打开时「未启动」负向）。

- [ ] **Step 8: Verify + Commit**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint`
Expected: PASS。

```bash
git add apps/desktop/src/renderer/src/live2d/perf.ts apps/desktop/src/renderer/src/live2d/controller.ts apps/desktop/src/renderer/src/stores/live2d.store.ts apps/desktop/src/renderer/src/components/CyDiagnosticsPane.vue apps/desktop/tests/unit/perf.spec.ts apps/desktop/tests/unit/cy-diagnostics-pane.spec.ts apps/desktop/tests/unit/live2d.store.spec.ts apps/desktop/tests/integration/electron-live2d.spec.ts
git commit -m "feat(阶段7批次D Task4): Live2D 数值读数接入诊断页——FrameBudget.getStats 透传,store 判 status 返回 null,闭合 D7A-06"
```

---

### Task 5: 阶段 7 收口 + 决策记录（面 D + A 面确认记录）

**Files:**
- Modify: `docs/review/2026-08-27-阶段7批次D-决策记录.md`（新）
- Modify: `docs/10` §10.2、`docs/16` §10（Blocker/Critical 为 0 + 安全发布清单勾选 + 附件/录音/缓存上限确认）
- Modify: `docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`（第 11/18 项标注结论）

**Interfaces:**
- Consumes: 7A 核对表（第 11/18 项证据缺口）、7B/7C 决策记录（历史遗留清单）。
- Produces: 决策记录 D7D-01~04 + 阶段 7 收口勾选 + A 面确认记录。

- [ ] **Step 1: 写决策记录**

`docs/review/2026-08-27-阶段7批次D-决策记录.md`——含：D7D-01~04 决策表（全按推荐）+ **D7D-05（执行中 review 澄清，自主决策）** + 面 A 确认记录（附件/录音无落盘无 Blob URL + remove 补点 + 缓存上限已落地）+ 面 B 口径 + 面 C 两功能 + 面 D 收口（Blocker/Critical 为 0 判定依据 + 安全发布清单第 11/18 项）+ 门禁结果 + 三态结论 + 提交链。

> **D7D-05（执行中自主决策，记录）**：视图感知暂停的价值域经 review 澄清为**「长会话多短 markdown 回复滚动」**而非「单条 100 分段」——后者恒跨视口（`rowVisible()` 恒 true）特性不生效。故：① mock 长会话种子 `seedSyntheticHistory` 的 assistant 消息补 `assistantSegments`（markdown 段，`completed: true`）；② seed 的 conversation 与 role 用**独立 mod** 解耦（`conversation=i%2`、`role=Math.floor(i/2)%2`）——原 `i%2` 同时决定二者造成 conv-1001 全 user（0 个 `.cy-segment`，activate 后差异化断言必败），解耦后 conv-1001 得 user/assistant 混合（含 markdown 段）；③ Live2D 读数集成断言改为**负向**（设置打开时 `status='unloaded'` → 显示「未启动」）——诊断页只存在于 settings，而 settings 卸载 chat 视图（含 CyLive2DPanel）→ `dispose()` 置 `status='unloaded'`，ready 态读数在集成层**不可达**，正path（ready→读数）由单测（`perf.spec.ts`）+ store 层（`live2dStore.getStats` status 判 null/非 null）承载。

- [ ] **Step 2: doc 10/16 收口勾选**

`docs/16` §10 验收门槛「Blocker / Critical 为 0」`[ ]`→`[x]` + 注记「判定依据：阶段 7 全程（7A/7B/7C 验收通过）+ 7D 无新 Blocker/Critical——历史遗留（message_id=""、Failed to fetch、.corrupt-*）登记但不算」；
「安全发布清单通过」`[ ]`→`[x]` + 注记「7A 核对表 20 项，第 11/18 为证据缺口（后端 SSRF 职责 / 阶段 8 签名联动），其余通过」。

- [ ] **Step 3: 更新安全发布清单核对表**

`docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`——第 11 项标注「后端职责（前端不做）」，第 18 项标注「阶段 8 签名联动（非本批）」，并注明「7D 收口确认」。

- [ ] **Step 4: Verify**

Run: 无代码变更；文档审查。`git diff --stat` 确认改动范围。

- [ ] **Step 5: Commit**

```bash
git add docs/review/2026-08-27-阶段7批次D-决策记录.md docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md
git commit -m "docs(阶段7批次D Task5): 阶段7收口——Blocker/Critical为0确认 + 安全发布清单通过(11/18非前端/阶段8联动) + D7D-01~04决策记录"
```

---

### Task 6: 文档同步（面 E）+ 全量门禁

**Files:**
- Modify: `docs/10` §10 状态注记、`docs/12` §10、`docs/16` §10/§11 进度表、`docs/06` §性能、`docs/05` §Live2D 读数注记、`docs/07` §17、`README.md`、`CLAUDE.md`

**Interfaces:**
- Consumes: Task 1-5 交付。
- Produces: 全量门禁 + 文档同步 + 三态状态。

- [ ] **Step 1: 全量门禁**

Run: `export PATH=/home/yomu/.nvm/versions/node/v22.23.0/bin:$PATH && pnpm -F @cyrene/desktop test && pnpm -F @cyrene/desktop exec electron-vite build --mode test && xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop build && pnpm -F @cyrene/desktop check:contract && pnpm -F @cyrene/desktop verify:sensitive`
Expected: 全绿（单测/集成/typecheck/lint/build/check:contract/verify:sensitive）。

- [ ] **Step 2: 文档同步**

按 spec §4E——doc 10 §10（7D 状态注记 + 三态 = 已开发、未联调）、doc 16（§10 状态注记 + 进度表 + 任务清单勾选）、doc 12 §10、doc 06 §性能（附件/录音内存卫生 + 缓存上限）、doc 05 §Live2D 读数注记（已接入 D7A-06 闭合）、doc 07 §17（收口确认）、README / CLAUDE.md（7D 状态段 + 阶段 7 全流程收口结论）。

- [ ] **Step 3: Commit**

```bash
git add docs/ README.md CLAUDE.md
git commit -m "docs(阶段7批次D): Task6 文档同步——doc10/12/16 + doc04/05/06/07 + README/CLAUDE 状态段 + 三态=已开发、未联调"
```

---

## 三态与已知限制

- **三态 = 已开发、未联调**（真实 Windows Electron 联调为批次后独立项）。
- **视图感知暂停**：行内 segment 仍不经虚拟窗口裁剪（单条回复行本身 1 个 `.cy-vlist-row`），改良的是「行内 completed segment 的 markdown parse 是否渲染瞬间执行」；perf-gate ② `toBe(N)` 断言保持（视口内完成态全量渲染）。
- **Live2D 读数**：诊断页读取时取值（非持续记录）；`status !== 'ready'` → null → 「未启动（无读数）」。
- **附件/录音**：不落盘、无 Blob URL；仅 remove 补点清引用 + 确认记录；缓存上限已落地（草稿 100KB×50 + 离线 20 会话）——无新磁盘清理面。
- **无新 IPC**：视图感知下传 prop、Live2D 读数读 store，均纯 renderer 层。
- **`performance.memory`**：7D 不引入诊断页（7C perf-gate 承担），退化只记录。
