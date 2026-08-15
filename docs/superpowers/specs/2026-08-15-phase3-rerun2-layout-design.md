# Cyrene 阶段3 真实联调第二轮前端整改设计：历史查看器布局修复（FE-S3-RUN2-P1-01）

- **日期：** 2026-08-15（Asia/Shanghai）
- **状态：** 设计定稿（待评审）
- **清单来源：** [docs/review/2026-08-15-阶段3真实联调第二轮前端复验问题清单.md](../../review/2026-08-15-阶段3真实联调第二轮前端复验问题清单.md)
- **上一批：** [2026-08-15-phase3-reverify-fixes-design.md](./2026-08-15-phase3-reverify-fixes-design.md)（FE-S3-RUN-P0-01/02/03、P1-01，已真实复验通过）
- **前端基线：** `main@5e10756`；后端对照 `elysia-agent main@556117a`（protocol 2.0）
- **相关文档：** docs 03（UI 与交互）、docs 16（阶段执行清单）、README（三态状态）、CLAUDE.md（当前状态）

## 1. 背景与目标

阶段 3 真实联调第二轮在 Windows Electron（viewport 1184×721）复验：上一轮四项整改全部通过，唯一遗留 **FE-S3-RUN2-P1-01**——历史查看器模态框被 50 条搜索结果撑高（`.cy-history` 实测高 5478px），`加载更多` 落到视口外。数据链路（后端分页 / cursor / 去重 / 排序）正确：DOM 直调按钮 click 后第二页正常返回并渲染 100 条、首屏 50 相对顺序保持、无分页错误。**问题纯属前端布局约束未生效**。

**目标：** 历史查看器面板始终完整落在 overlay/viewport 内、仅结果列表内部纵向滚动、header/筛选/分类/状态/footer 常驻可见、`加载更多` 可被真实鼠标/键盘到达；补真实 Electron 布局与点击集成测试（1184×721 主档 + 1100×700 最小档）。

## 2. 范围（做 vs 不做）

### 做
1. **CSS 容器约束**（[CyHistoryViewer.vue](apps/desktop/src/renderer/src/components/CyHistoryViewer.vue)）：面板定高不随结果条数增长；结果区 `flex:1; overflow-y:auto`（保留 `min-height:120px` 下限）独占剩余空间内部滚动；header/筛选/分类/状态/footer `flex-shrink:0` 常驻；`overflow-anchor:none` 关停原生滚动锚定以配合手动补偿。
2. **loadMore 滚动锚点保留**（组件层）：加载第二页前记录「首个可见命中项 + 视口内偏移」，DOM 更新后补偿 `scrollTop`，用户浏览位置不被前插结果甩走（清单 §3.4.4）。
3. **Mock 数据基建**（[mock-backend.ts](apps/desktop/src/main/transport/mock-backend.ts) + [index.ts](apps/desktop/src/main/index.ts)）：`MockBackendOptions.seedHistoryCount` + `CYRENE_MOCK_HISTORY_LARGE` env 透传，产出 ≥110 条确定性多自然日历史；**并将 mock 历史分页语义与 real 对齐**（第一页=最新、第二页=更旧），使集成测试数据行为与 real 同构，并显式瞄准「跨页边界日期组前插」这一锚点真实扰动点（详见 §3.3/§4.3）。
4. **集成测试**（新 `tests/integration/history-viewer-layout.spec.ts`）：真实 Electron 内打开查看器 → 空关键词搜索 → 50 条入 UI + bounding box 断言 → 真 `locator.click()` 加载第二页 → 100 条 + hitId 唯一 + 首屏 50 相对顺序保持 + 锚点精确偏移保留 → 内部滚动 + Shift+Tab 回绕到达 `加载更多` + Esc 关闭并回焦；1184×721、1100×700、空结果态三用例。
5. **文档同步**：本轮决策记录 + README / CLAUDE.md / docs 16 测试数字与状态同步。

### 不做
- **不改后端分页大小 / 不截断 / 不改变 cursor 或 sortKey 排序语义**（清单 §3.4.7 明令禁止）。
- **不改 store 数据逻辑**（`historyViewer.store.ts` 的 loadMore 合并/去重/升序重排维持现状）。
- **不引入虚拟滚动**（决策 D1；清单 §3.5 测试仅要求 100 条，纯 CSS 容器约束足够）。
- **不依赖原生 `overflow-anchor` 机制**：显式 `overflow-anchor:none` 关停（§4.1/§4.2），否则 Chromium 原生滚动锚定会掩盖 §4.2 手动补偿、使 step 8 断言假绿；手动补偿成为唯一调整机制。
- 阶段 3 状态保持「已开发、未联调」——真实 Windows Electron 回归（清单 §5）是验收方，非本批职责。

## 3. 现状与根因（代码证据）

### 3.1 现场几何（清单 §3.2，viewport 1184×721）

| 元素 | top | bottom | height |
|---|---:|---:|---:|
| viewport | 0 | 721 | 721 |
| `.cy-history-overlay` | 36 | 721 | 685 |
| `.cy-history` | 60 | 5538 | 5478 |
| `.cy-history-results` | 215 | 5483 | 5268 |
| `.cy-history-footer` / `加载更多` | 5493 | 5523 | 30 |

50 条时面板已 5478px；100 条时 `.cy-history` ≈10743px、`加载更多` top≈10758px——`max-height` 完全未生效。

### 3.2 CSS 根因（[CyHistoryViewer.vue:172-212](apps/desktop/src/renderer/src/components/CyHistoryViewer.vue#L172-L212)）

- `.cy-history-overlay` 是 `display:grid; place-items:center`，`.cy-history` 是其 grid item，默认自动最小尺寸 `min-height:auto` → 拒绝收缩到内容以下。
- `.cy-history` 的 `max-height: calc(100% - 48px)` 中 `100%` 解析到**grid area**（单隐式行由内容撑开），形成「行高←内容←max-height 百分比←行高」的循环，结果 max-height 退化为 none（5478px 无上限）。
- `.cy-history-results` 有 `overflow-y:auto`，但作为 flex column 子项没有 `flex:1` + `min-height:0`，不占据/收缩到剩余空间，50 条直接贡献完整内容高度。
- footer 是 flex column 的最后一个兄弟，跟随结果内容落到视口外。

### 3.3 分页/排序语义（real vs mock 偏差，影响锚点路径真实性）

**渲染序 ≠ store 序：** store 数组是 `sortKey` 升序（`historyViewer.store.ts` loadMore 合并后升序重排），但组件 `groupedItems`（[CyHistoryViewer.vue:30-51](apps/desktop/src/renderer/src/components/CyHistoryViewer.vue#L30-L51)）按本地自然日**降序**重组渲染——最新日期组在最前，组内保持升序。**锚点补偿作用于渲染后的 DOM，因此必须以上述日期降序布局为基准推导。**

- **real**（[real-backend.ts:665-671](apps/desktop/src/main/transport/real-backend.ts#L665-L671)）：后端 keyset 分页 `timestamp DESC` → 前端 `compareBySortKey` 升序。第一页=最新 50 条；第二页=更旧 50 条。合并升序后 store 数组里旧条目在前，但**渲染**为：更旧条目落到**更旧的日期组 → 渲染列表底部**；唯一向上扰动是「跨页边界日期组」内部按升序**前插**（该组第一页只含部分条目，第二页补入更旧条目置于组首）。
- **mock 现状**（[mock-backend.ts:263-276](apps/desktop/src/main/transport/mock-backend.ts#L263-L276)）：先升序再切片 → 第一页=**最旧** 50 条；第二页=**更新** 50 条 → 渲染为新日期组**前插列表顶部**、锚点被大幅下推——虽然会剧烈执行补偿路径，但**页内容语义与 real 相反**（第一页应为最新）。
- 结论：mock 需对齐 real 的**页内容语义**（第一页=最新、第二页=更旧），使测试数据行为同构；锚点路径的真实扰动点（跨页边界日期组前插）需测试显式瞄准（见 §4.4 步骤 4-8）。
- `chat-service.queryChatHistory` 直通 adapter（[chat-service.ts:93](apps/desktop/src/main/chat/chat-service.ts#L93)），mock 返回顺序原样到达 store，无中间重排。

### 3.4 测试基建现状

- `launchApp()`（[tests/integration/helpers/app.ts](apps/desktop/tests/integration/helpers/app.ts)）已支持 `opts.env` 透传子进程 env；`CYRENE_BACKEND=mock` 固定 Mock 装配。
- Mock 默认只 seed 5 条历史（[mock-backend.ts:93-103](apps/desktop/src/main/transport/mock-backend.ts#L93-L103)），`queryChatHistory` 不要求连接（`this.connected` 未校验）。
- 现有集成测试（`history-viewer-ipc.spec.ts` 等）走 `page.evaluate` 直调 `desktopApi`，**没有**驱动 renderer UI 的布局/点击断言先例——本轮新增该测试纪律。
- 查看器 UI 入口：`CyChatView.vue:76`「聊天记录」按钮 → `historyStore.openViewer()`；打开后初始焦点在搜索框（`onOpen`）。窗口默认 1200×760、最小 1100×700（[main-window.ts:25-30](apps/desktop/src/main/windows/main-window.ts#L25-L30)）。

## 4. 整改项设计

### 4.1 FE-S3-RUN2-P1-01-a：CSS 容器约束（纯 CSS）

**目标不变量（集成测试断言）：**
- `.cy-history` 的 bounding box 始终 ⊂ overlay（真实几何：≤ `calc(100vh - 36px - 48px)`）。
- header / filters / tabs / 状态区 / error / footer 六个 flex 兄弟项 `flex-shrink:0`，不随结果挤压/滚出；只有 `.cy-history-results` 内部纵向滚动。
- 内容少（空/5 条）时面板贴内容高；内容多（50+ 条）时面板封顶、结果区滚动。`加载更多` 始终在 viewport 内可点。

**推荐实现（两选一，集成测试定判）：**
- **方案 A（首选）**：`.cy-history-overlay` `display:grid; place-items:center` → `display:flex; align-items:center; justify-content:center`（视觉等价），消除 grid area 百分比环——flex 容器高度由 `inset` 定值，`max-height: calc(100% - 48px)` 恢复确定性；`.cy-history` 加 `min-height:0` 允许收缩。
- **方案 B（兜底）**：保持 grid，`.cy-history` 改 `max-height: calc(100vh - 84px)`（36 标题栏 + 48 边距，视口定值，不依赖 grid area）+ `min-height:0` + `height:max-content`（内容少时贴内容）。

两方案共同终点：
```css
.cy-history-results { flex: 1 1 0; min-height: 120px; overflow-y: auto; overflow-anchor: none; }  /* 保留内部 display:grid; gap:6px 与既有 min-height:120px 下限；overflow-anchor:none 关停 Chromium 原生滚动锚定，避免与 §4.2 手动补偿双重调整 */
.cy-history-footer, .cy-history-header, .cy-history-filters, .cy-history-tabs, .cy-live, .cy-history-error, .cy-history-state { flex-shrink: 0; }  /* 含 loading/空态 div */
```
`min-height:120px` 为既有下限，有意保留（空/少结果时给结果区一个可见下限）；关键改动是 `flex-basis:0` + `min-height:0`→`min-height:120px` 让 flex 收缩生效、`overflow-y:auto` 内部滚动。方案 B 的 `84px`（36 标题栏 + 48 边距）与 overlay `inset:36px` 硬编码耦合——若标题栏高度变化需同步（方案 A 无此耦合）。

**验证纪律（清单 §3.3）：** 不得只在 jsdom 断言 class 存在；以 §4.4 真实 Electron 集成测试的 bounding box / 点击 / 滚动断言为准。

### 4.2 FE-S3-RUN2-P1-01-b：loadMore 滚动锚点保留（组件层）

**触发路径：** 用户滚动结果区后点 footer 的 `加载更多`。锚点扰动仅发生在「跨页边界日期组」——该组第一页只含部分条目，第二页补入更旧条目按组内升序**前插到组首**（§3.3）；新日期组则追加在列表底部不扰动上游。若不做补偿，边界组内可见项被下推，用户浏览位置跳变（清单 §3.4.4「不能因旧结果插入而把用户突然甩到列表另一端」）。补偿逻辑作用于渲染后 DOM，对日期分组结构透明。

**实现（CyHistoryViewer.vue）：**
1. 给 [CyHistoryResultItem.vue](apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue) 的 `<li class="cy-history-item">` 加 `:data-hit-id="hit.hitId"`（锚点定位；hitId 含 `:`，用 `CSS.escape`）。
2. 组件新增 `resultsEl` ref 指向 `.cy-history-results`（滚动容器）。
3. 替换 footer 按钮 `@click="store.loadMore()"` 为组件方法 `onLoadMorePreservingAnchor()`：
   - **捕获**：`resultsEl` 内第一个 `bottom > 容器top` 的 `.cy-history-item`，记 `{ hitId, offsetTop }`（`offsetTop = el.getBoundingClientRect().top - 容器.getBoundingClientRect().top`，即其在滚动视口内的纵向偏移）。
   - **加载**：`await store.loadMore()`（store 逻辑零改动）。
   - **补偿**：`await nextTick()` 后 `querySelector([data-hit-id])`，若存在 → `容器.scrollTop += el.getBoundingClientRect().top - 容器.getBoundingClientRect().top - offsetTop`（把锚点拉回原屏幕位置）。
   - 捕获不到锚点（空态/loading 等）→ 直接 `await store.loadMore()` 不补偿。

**弃用替代 + 必要配套：**
- 不用 CSS `overflow-anchor:auto` 原生滚动锚定作为机制——Vue 按 key 重渲染 + 组前插的跨平台行为不一致，且集成测试难以确定性断言；显式补偿可测、可断言。
- **必须配套** `.cy-history-results { overflow-anchor: none }`（§4.1 共同终点已含）：Chromium 原生滚动锚定（默认 `auto`）会在 DOM 插入时**独立**调整 scrollTop 把可见项拉回原位。若不禁用，手动补偿在 `nextTick` 后测到偏移已≈0 而变成 no-op，step 8 断言被原生机制满足——**即使 §4.2 补偿被删/写坏测试照样绿，对 §4.2 假绿**。关停后手动补偿成为唯一调整机制，step 8 只反映 §4.2 是否生效。

### 4.3 FE-S3-RUN2-P1-01-c：Mock 数据基建（env-gated 大 seed + 分页语义对齐）

**4.3.1 `MockBackendOptions.seedHistoryCount`**（[mock-backend.ts](apps/desktop/src/main/transport/mock-backend.ts)）：
- 新增 `seedHistoryCount?: number` 选项。设置时 `seedMessages()` 返回确定性合成集（替换默认 5 条）；未设置行为不变。
- 合成集：`count` 条记录，`messageId = run2-msg-${String(i+1).padStart(4,'0')}`；`conversationId` 在 `conv-1001/1002` 交替；`role` 在 `user/assistant` 交替；`createdAt` 单调递增且跨 ≥2 个自然日（如 `2026-08-08T00:00Z + floor(i/30)*1day + (i%30)*1min`，120 条→4 日）；`content = 模拟命中文本 ${i+1}`（唯一，助 hitId/顺序断言）；**纯文本、无 stickerId**（本批只验证 `all` 分类布局；sticker 分类由默认 seed 既有测试覆盖，且避免缩略图加载噪音）。
- 新增导出纯函数 `parseMockHistoryCountEnv(value: string | undefined): number | undefined`：`undefined`→undefined；解析为**正整数**（>0）→该值；`0`/负数/NaN/非法→默认 `120`（「大」语义兜底，且 `'0'` 不允许产出空 seed——否则与「≥100」测试前提冲突）。
- **字段初始化顺序约束**（[mock-backend.ts:91](apps/desktop/src/main/transport/mock-backend.ts#L91) `private readonly messageRecords: Message[] = this.seedMessages()` 是字段初始化器，先于构造函数体执行）：`seedHistoryCount` 必须以**字段声明式**（`private readonly seedHistoryCount = options.seedHistoryCount ?? 0`）在 `messageRecords` **之前**声明，`seedMessages()` 才能读到；不得在构造函数体内赋值后指望 `seedMessages()` 取到。

**4.3.2 分页语义对齐（mock → real 一致）**：[mock-backend.ts:263-276](apps/desktop/src/main/transport/mock-backend.ts#L263-L276) 改为——过滤后先 **DESC（最新在前）** 切片（`offset/limit` 语义与 real keyset 一致：第一页=最新 50），再对当前页 **升序** 返回（与 real transport 的 `compareBySortKey` 后序一致）。效果：mock 第一页=最新 50 条、第二页=更旧 50 条；store loadMore 合并升序后旧条目位于数组前部，**渲染**后落入更旧日期组（列表底部）或边界组前插——与 real 完全同构。

**既有测试影响核查（均已验证不破坏）：**
- `mock-backend-search.spec.ts`：`结果按时间稳定排序`（页内升序仍成立）、`关键词过滤`（升序后首条仍是命中项，snippet 含关键词）、`分类 sticker`（过滤不变）、`本地自然日`（页内升序切片不越界）、`游标分页`（limit 2 + 无重复，仍成立）。
- `history-viewer-ipc.spec.ts`：默认 seed 不变；`first` 断言取 `conv-1001` 最旧条，仍成立。
- `history-viewer.store.spec.ts` 等 store 单测注入 api mock，不触真实 mock。

**4.3.3 Main 装配透传**（[index.ts:139](apps/desktop/src/main/index.ts#L139)）：`new MockBackend({ onConnectionStateChange: onState })` → `new MockBackend({ onConnectionStateChange: onState, ...(parseMockHistoryCountEnv(process.env.CYRENE_MOCK_HISTORY_LARGE) !== undefined ? { seedHistoryCount: ... } : {}) })`。仅影响 Mock 装配分支；Real 分支零触碰。

### 4.4 集成测试设计（新 `tests/integration/history-viewer-layout.spec.ts`）

**测试夹具：**
- `launchApp(undefined, { env: { CYRENE_MOCK_HISTORY_LARGE: '120' } })` → 大 seed 装配。
- 窗口尺寸：`launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1184, 721))`（测试侧 setContentSize，决策 D3，跨平台确定性，零 Main 改动）；随后 `page.waitForFunction(() => innerWidth === 1184 && innerHeight === 721)` 等待 renderer viewport 实际生效；断言一律用 `page.evaluate(() => ({w: innerWidth, h: innerHeight}))` 实际 viewport 相对坐标。

**主档 `1184×721` 用例步骤：**
1. `page.getByRole('button', { name: '聊天记录' }).click()` 打开查看器（真实 UI 入口）。
2. 初始焦点在搜索框；点击 `搜索`（空关键词 + 全部会话 + 全部分类 → 第一页 50 条，120 条全集可分页）。
3. `expect.poll(.cy-history-item 数量).toBe(50)`；断言 `.cy-history` / `.cy-history-footer` / `.cy-more-btn` 的 bounding box top≥0 且 bottom≤viewport 高；header 可见。
4. 结果区内部滚动：`el.scrollTop = el.scrollHeight * 0.7`——**落入跨页边界日期组**（seed 30 条/日 × 4 日时，边界组为第 2 新日期组，第一页含其部分条目，第二页补入更旧条目按组内升序前插组首，是 §4.2 补偿的唯一真实扰动点；「第一页 20 条 / 补 10 条 / ~650px」为 UTC 示意图，实际前插条数随本地时区日边界略变，**断言不依赖该数值**）；断言 `scrollTop > 0` 且 header/footer 仍 ⊂ viewport（不随内容滚出）。
5. **捕获锚点**：首个可见 `.cy-history-item` 的 `data-hit-id` + **精确 `offsetTop`（`el.getBoundingClientRect().top - 容器.getBoundingClientRect().top`）** + 捕获 DOM 顺序 `first50`。防御：若条高异常导致 0.7 定位偏离边界组，测试动态下移 `scrollTop` 直至首可见项落入边界组后再捕获（边界组判据：该日期组在首屏 50 条内未满）。
6. **真点击**：`page.locator('.cy-more-btn').click()`（禁 `force` / DOM `.click()` / 直调 store）。
7. `expect.poll(数量).toBe(100)`；断言 100 个 `data-hit-id` 唯一；断言 `first50` 在 100 中按原相对顺序连续出现（`filter` 后 `toEqual(first50)`，兼容前插/追加两种方向）；断言 `.cy-history-day` 数量从首屏 2 组增至 4 组（渲染层分组覆盖）。
8. **精确偏移保留**：loadMore 后同 `data-hit-id` 项的新 `offsetTop` 与步骤 5 捕获值**差 ≤ 1px**（补偿生效；无补偿时边界组前插 10 条 → 偏移 +~650px，断言失败）。
9. **Tab 可达**：重新聚焦搜索框（`page.getByLabel('关键词搜索').click()`），随后 `Shift+Tab` **三次**——DOM 焦点序为 `keyword → select → close(first)`，到达 `first` 后再按 Shift+Tab 触发陷阱回绕到 `last`。断言 `document.activeElement` 文本含 `加载更多`（footer 按钮是 overlay 最后一个可聚焦元素：close → filters → tabs → 100×跳转按钮 → 加载更多）。若后续 DOM 顺序变化导致步数不同，测试仍以「activeElement == overlay 最后一个可聚焦元素」为结构性不变量。
10. **Esc 关闭 + 回焦**：`page.keyboard.press('Escape')` → overlay 消失 → `document.activeElement` 为「聊天记录」按钮（`triggerElement.focus()`）。

**最小档 `1100×700` 用例**：`setContentSize(1100, 700)` 后重复「打开 → 搜索 → 50 条 → 面板/footer/按钮 ⊂ viewport → 真点击 → 100 条」核心链路（防对 1184×721 特调，清单 §3.5）。

**空结果态用例**（清单 §3.4.6）：`1184×721` 下打开查看器 → 输入不存在关键词（如 `zzz_nonexistent`）→ 搜索 → 断言「没有找到相关聊天记录」（`.cy-history-state`）可见且 ⊂ 面板；`.cy-more-btn` 不存在（footer 无按钮）；面板贴内容高仍在 viewport 内。

**既有套件兼容：** 新 spec 用 `CYRENE_MOCK_HISTORY_LARGE` env 隔离，`history-viewer-ipc.spec.ts` 等默认 launchApp 不受影响。

## 5. 决策记录

| 编号 | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 结果列表方案 | **纯 CSS 容器约束**（不虚拟滚动） | 清单 §3.3 明确指引 grid/flex 的 min-height/flex/overflow 组合；测试仅要求 100 条 |
| D2 | 测试数据注入 | **env-gated 大 seed**（`CYRENE_MOCK_HISTORY_LARGE`，默认 seed 不变） | 与既有 `CYRENE_BACKEND=mock` 同风格，显式 opt-in、对既有测试零影响 |
| D3 | 窗口尺寸确定性 | **测试侧 setContentSize**（零 Main 改动） | 断言按实际 renderer viewport 相对坐标，跨平台确定 |
| D4 | mock 分页语义 | **与 real 对齐**（DESC 源切片 + 页内升序，spec 撰写时细化） | mock 第一页须为**最新** 50 条、第二页为**更旧** 50 条，与 real 页内容语义同构；否则集成测试数据行为与真实后端相反（现 mock 第一页=最旧）。锚点路径的真实扰动点（跨页边界日期组前插）由 §4.4 步骤 4-8 显式瞄准 |

锚点保留（§3.4.4）、footer 常驻（§3.4.1/2）、Tab 可达（§3.4.3）、不改后端分页（§3.4.7）均为清单钉死要求，非决策。

## 6. 测试计划

### 6.1 单元测试（新增/扩展）
- `mock-backend-search.spec.ts`（或新 `mock-backend-seed.spec.ts`）：
  - `parseMockHistoryCountEnv`：undefined / '120' / '0'→120 / 'abc'→120 / 负数→120。
  - `seedHistoryCount: 120` → 120 条、messageId/sortKey/hitId 唯一、跨 ≥2 自然日、createdAt 单调、无 stickerId。
  - 分页对齐：第一页=最新 50 条（页内升序）+ `hasMore` + cursor；第二页=更旧 50 条；合并升序后第一页 50 相对顺序保持（作为子序列）；**跨页边界日期组**第二页补入的条目按组内升序置于组首（§3.3 扰动点单测断言——mock 不做分组，分组在组件 `groupedItems`，该断言需在 store 层复刻 `isoToLocalDate` 分组，属跨层断言，落地时注意实现位置）。
  - 既有 5 条默认 seed 行为不回退（沿用现有用例）。

### 6.2 集成测试（新增）
- `history-viewer-layout.spec.ts`：§4.4 主档（1184×721）+ 最小档（1100×700）+ 空结果态三用例。

### 6.3 门禁
- typecheck / lint / build / `test` / `test:integration` / `check:contract`（WS 13/13 + REST 8/8）全绿。本批不触 wire schema → check:contract 指纹不变。

## 7. 完成定义

1. FE-S3-RUN2-P1-01 修复：真实 Electron 集成测试通过（两档 bounding box + 真点击 100 条 + 锚点保留 + Tab/Esc）。
2. 门禁全绿（unit/integration/typecheck/lint/build/check:contract）。
3. 文档同步：本轮决策记录 + README / CLAUDE.md / docs 16（测试数字 + FE-S3-RUN2-P1-01 状态）。
4. 阶段 3 保持「已开发、未联调」；真实 Windows Electron 50+50 短回归（清单 §5，后端 `556117a`）由验收方执行，通过后升「已真实联调」。
