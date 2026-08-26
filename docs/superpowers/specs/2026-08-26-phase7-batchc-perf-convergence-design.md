# 阶段 7 批次 C（7C 性能收敛）—— 设计文档（spec）

**日期：** 2026-08-26（Asia/Shanghai）
**状态：** 代码批设计（Mock 驱动，三态 = 已开发、未联调）
**依据：** doc 16 §10 任务清单 + §10.2 完成标准、doc 10 §10（三态权威）；延续 7A 安全收敛、7B 稳定性收敛后，阶段 7 最后一收敛维（性能）。

---

## 0. 结论（TL;DR）

7C = **性能收敛代码批**。对靶 doc16 §10 验收门槛的四项性能目标（长会话/长流式/历史资源列表/Live2D 性能、200 条混合消息/100 多分段回复/500 项历史资源、长时间运行无明显持续内存增长、Live2D 关闭后 CPU/GPU 下降）。

本批核心交付（用户拍板后收敛）：
1. **历史查看器虚拟化**（头号）——500 项历史资源不再全量 DOM，改为扁平虚拟行（复用泛型化 virtual-window 内核），直接对靶「500 项历史资源操作正常」。
2. **CyMarkdown 渲染缓存**——模块级 Map 缓存 source→HTML（D7C-08：键为 string 不可 weak，WeakMap 无回收增益，取 Map），完成态 segment 不再重复 DOMPurify，对靶「100 多分段回复」。
3. **性能测量常驻门禁**——集成 suite + 松阈值（实测×1.5），断言虚拟化后 DOM 节点有界 + JS 堆上限，对靶「长时间运行无明显持续内存增长」。
4. **mock 多分段种子**——补多分段回复种子（对靶「100 多分段回复」，现有 `CYRENE_MOCK_HISTORY_LARGE` 只生成纯文本无分段）。

测量驱动项（视实测，有问题才纳入本批核心）：长会话内存有界（byId/cache.snapshots/historyViewer.items）、Live2D 性能读数接入诊断页（7A 延 7C 项）。
**流式增量合并（§4C）降级观察项**（用户 2026-08-26 拍板）：§4B 缓存已解决「流式重复 re-parse」主瓶颈，§4C 剩余每 delta 全量 sort 成本极低（segment 通常≤5）但实现需复杂纪律（定稿不可变 + authoritative 覆写失效 + Vue 响应），风险/收益不成比例——本批不做，记观察项（在 spec §1.2/§8 说明）。

预设决策（用户 2026-08-26 拍板，记录进决策记录）：测量门禁=集成 suite+松阈值；分组=扁平虚拟行+header 为虚拟行；markdown 缓存=模块级 Map；长流式=只做确定性优化；内存有界=测量驱动。

---

## 1. 范围

### 1.1 本批范围（7C）

1. **历史查看器虚拟化**——`CyHistoryViewer` 的 `groupedItems`（按自然日分组 + item）扁平化为虚拟行序列，虚拟窗口只渲染可视行 + overscan。复用/泛型化 `virtual-window` 数学内核。
2. **CyMarkdown 渲染缓存**——模块级 `Map<string, string>`（source→渲染 HTML，D7C-08 取 Map——键为 string 不可 weak），命中省 `marked.parse` + `DOMPurify.sanitize`。
3. **性能测量常驻门禁**——新增集成 suite，`CYRENE_MOCK_HISTORY_LARGE` 大 seed 下 `page.evaluate` 断言 JS 堆上限 + 历史查看器 DOM 节点有界。松阈值 = 实测×1.5 防 CI 抖动。
4. **mock 多分段种子**——现有 `CYRENE_MOCK_HISTORY_LARGE` 只生成纯文本无分段；本批补多分段回复种子（对靶「100 多分段回复」）。

**本批三态**：代码批、Mock 驱动，**已开发、未联调**（真实 Windows Electron 联调为批次后独立项）。

### 1.2 不在范围（7C 不做，记录观察项/移后续）

- **流式增量合并（§4C 降级）**：§4B 缓存已解决「流式重复 re-parse」主瓶颈，§4C 剩余每 delta 全量 sort 成本极低（segment 通常≤5）但实现需复杂纪律（定稿不可变 + authoritative 覆写失效 + Vue 响应），风险/收益不成比例——本批不做，记观察项。
- **视图感知暂停**（视口外 segment 不 re-parse）：范围增强（YAGNI 风险），记观察项。
- **长会话内存有界**（byId/cache.snapshots/historyViewer.items 上限）：**测量驱动**——本批先跑测量，若实测无病态增长则记观察项不强行加上限；仅当测量证明确有病态增长才纳入。
- **Live2D 性能读数接入诊断页**（7A 延 7C）：视测量——若 Live2D 读数测量简单且价值高则纳入，否则记观察项。
- **Live2D collapse dispose**：维持现状（collapse 不 dispose，资源常驻但 rAF 停）——用户明确拍板，变更成本高（expand 需重载模型，恢复变慢）。
- **UI 级 error boundary**（7B 记观察项）：本批不做，延续。
- **GPU 崩溃自动 reload**：不做（7B 已定），延续。
- **临时附件/录音磁盘清理**：归 7D。
- **性能基准 harness（Playwright CJ 独立）**：本批用集成 suite 承载测量，不另起独立 harness 框架。

---

## 2. 用户拍板决策点（记录进决策记录）

| 编号 | 决策点 | 拍板值 | 本批落点 |
|---|---|---|---|
| D7C-01 | 性能测量门禁形态 | **集成 suite + 松阈值**（实测×1.5，防 CI 抖动） | §4D |
| D7C-02 | 历史查看器分组虚拟化方式 | **扁平虚拟行，day header 为虚拟行** | §4A |
| D7C-03 | CyMarkdown 渲染缓存作用域 | **模块级 Map**（跨组件共享；D7C-08：键为 string 不可 weak，WeakMap 无回收增益） | §4B |
| D7C-04 | 长流式优化深度 | **§4B 缓存已解主瓶颈；§4C 增量合并降级观察项**（用户拍板，风险/收益不成比例） | §4C→观察项 |
| D7C-05 | 长会话内存有界 | **测量驱动**，实测有问题才加 | §4D/观察项 |
| D7C-06 | 虚拟列表内核复用 | **泛型化复用** `virtual-window` 数学（非各组件各自实现） | §4A |
| D7C-07 | Live2D collapse 资源处置 | **维持现状**（不 dispose，rAF 停） | 观察项 |

---

## 3. 现状与缺口（Explore 摸底 + 主会话独立核实）

### 3.1 历史查看器不虚拟化（头号缺口）

- `CyHistoryViewer.vue` 模板（`:186-191`）：`<ul>` 内 `v-for="hit in group.items"` 把 **全部 N 项塞进 DOM**。`groupedItems` 是 `computed`（`:33-54`），按自然日分组 + 组间日期降序，无窗口化。
- 对靶：「500 项历史资源操作正常」——500 项 → 500 个 `.cy-history-item` DOM 节点 + 分组 header。
- **虚拟化约束**：
  - `groupedItems` 输出的是「day header + item」混合结构，非单一 item 列表。
  - 现有锚点补偿 `onLoadMorePreservingAnchor`（`:84-107`）用 `.cy-history-item` DOM 选择器找首个可见项 + dataset `.hitId` 精确匹配（绕开选择器转义，`:100-101`）。
  - Tab 焦点陷阱（`:119-126`）遍历 overlay 内全部 focusable。
  - 跳转 `onJump`（`:132-136`）→ `conversationStore.jumpToMessage`（跨组件，不依赖查看器 DOM）。

### 3.2 CyMarkdown 无缓存

- `utils/markdown.ts` `renderMarkdown(text)`（`:23-26`）= `marked.parse` → `DOMPurify.sanitize` → `wrapCodeBlocks`，**无 source 字符串缓存**（grep `memoize|cache|WeakMap|Map` 零命中）。
- 每个 assistant segment 一个 `CyMarkdown` 组件（`CyMessageBubble.vue:100`），完成态 segment 的 `source` 不变，但组件 re-render 时 `renderMarkdown` 仍全量重跑。
- `CyMarkdown.vue:13` 已有 80ms 尾沿防抖（`createTrailingDebounce`）——流式 delta 合并已有，但完成态仍重复净化。对靶「100 多分段回复」。
- 无视图感知暂停：视口内每 segment 无条件渲染，视口外 segment 仅在行未被虚拟化卸载时才不可见（虚拟列表 overscan 外行卸载，但 overscan 内行每 segment 都渲染）。

### 3.3 流式每 delta 全量重建

- `StreamAccumulator.toAssistantSegments()`（`stream-accumulator.ts:211-224`）每 delta 全量 `.map().filter().sort().map()`（重排全部分段）。
- `message.store.ts` `patchAssistant`（`:98-102`）每 delta 调 `toAssistantSegments()` 赋值（`applyEvent` `:168-181`）。
- 对靶「长流式」：长回复+高频 delta 时，每 delta 全量重建 + 全量排序。当前无批量合并（组件层 80ms 防抖已合并 re-render，但 store 层仍逐 delta 重建）。

### 3.4 Live2D 关停接线（已较完善，仅 1 观察项）

- rAF **真停**非 flag-only：`CyLive2DPanel.vue:211-214` `cancelAnimationFrame`；`controller.ts:210` `if(!ready||!visible)return` 早退。集成 `electron-live2d.spec.ts:284-310` 已测 rAF delta 0。
- **缺口**：collapse/close 不 dispose，model/GL/AudioContext 常驻（scoped 到 unmount 才释放）；`backgroundThrottling:false`（`main-window.ts:96`）意味着窗口遮挡/blur 不节流 Live2D（只有 app-local `active` gate）。对靶「Live2D 关闭后 CPU/GPU 明显下降」——**维持现状（用户拍板）**，本批只在测量门禁中验证「关闭后 rAF 停 + 帧循环断」即可，不改 dispose 语义。

### 3.5 性能测量设施缺失

- `tests/unit/perf.spec.ts` 只测 `FrameBudget` 纯逻辑（Live2D 降帧）；**无** `usedJSHeapSize` / `performance.memory` / DOM 节点计数断言。
- **无** benchmark harness。
- `launchApp`（`tests/integration/helpers/app.ts:44`）经 `opts.env` 透传环境变量 → Main 读 `CYRENE_MOCK_*` → Mock 播种。**测量可行**：`page.evaluate` 读 `performance.memory.usedJSHeapSize` + `querySelectorAll(...).length`（真实 Electron 渲染进程）。

### 3.6 mock 大 seed 不覆盖多分段

- `CYRENE_MOCK_HISTORY_LARGE`（`mock-backend.ts:107`）+ `seedSyntheticHistory`（`:430-442`）生成 30 条/日、纯文本无分段。
- `streaming-reply.jsonl`（`fixtures/domain/`）仅 11 行 / 6 delta / `segmentIndex` max=2——**不覆盖 100 多分段回复**。
- 多分段回复种子缺（现有 `CYRENE_MOCK_REPLY_FIXTURE` 只换回复正文文本，不换分段数）。

---

## 4. 设计

### 4A. 历史查看器虚拟化（头号）

**核心**：`groupedItems`（按日分组 item 列表）→ 一维虚拟行序列 `rows: Array<DayHeaderRow | ResultRow>`，用泛型化 virtual-window 数学渲染可视行窗口。

**① 泛型化 `virtual-window` 数学内核**（`utils/virtual-window.ts`）：
- 泛型签名（注入 estimator + key accessor + anchorable 谓词，**契约 M-1/M-2 + 可行 M-1 修复**）：
  - `estimateHeight<T>(item: T, estimate: (t: T) => number)`——默认保留 `Message` 重载（契约 L-1 修复）：`estimateHeight(m: Message)` 仍导出且消息列表调用处零改动（见④兼容）。
  - `buildPrefix<T>(items: T[], heights: Record<string, number>, opts: { estimate: (t: T) => number; keyFor: (t: T) => string })`——`keyFor` 取行身份键（消息列表 = `messageId`；历史查看器 = item 行取 `hitId` / header 行取唯一合成键如 `header:<date>`）。
  - `computeWindow(prefix, scrollTop, viewportHeight, overscanPx)`——不变（前缀和 + 二分，与 T 无关）。
  - `captureAnchor<T>(items, prefix, scrollTop, viewportHeight, opts: { isAnchorable: (t: T) => boolean; keyFor: (t: T) => string })` → `ScrollAnchor`（其 `messageId` 字段为锚点 key，命名沿用但值可泛型化——历史 header 行 `isAnchorable` 为 false，不会被选为锚点）。
  - `restoreScrollTop<T>(items, prefix, anchor, keyFor)`——按 `keyFor` 找锚点行。
- `Message` 相关估算逻辑（fence counting 等）留在消息列表调用处（`estimateHeight` 只做数学，估算函数由调用方注入；消息列表走 `Message` 重载时用其既有估算）。
- **④兼容**：消息列表 `CyMessageList.vue` 调用处**零改动**——`estimateHeight` 保留 `Message` 重载；`buildPrefix` 传 `estimate: messageEstimate` + `keyFor: m => m.messageId`、`captureAnchor` 传 `isAnchorable: () => true` + `keyFor: m => m.messageId`、`restoreScrollTop` 仅传 `keyFor: m => m.messageId`（经默认参数/重载包一层，既有调用签名不破坏）。

**② 扁平化为虚拟行**：`rows` 由 `groupedItems` 派生（`computed`），每元素为 `{ kind: 'header', date, label }` 或 `{ kind: 'item', hit }`。header 行固定高（~34px），item 行近似固定高（单行 snippet ~72px；sticker 缩略图行更高，需实测估算）。

**③ 边界与高度估算**：
- header 行固定高（~34px），估算精确；item 行近似固定高（单行 snippet ~72px；sticker 缩略图行更高，需实测估算）。
- item 行 ResizeObserver 实测覆盖（复用消息列表模式——估高渲染 + 实测修正）。
- **header 高 + `.cy-history-results` 的 `gap: 6px` 归属**（feasibility L-4）：列表容器 `grid gap` 不进入行内高度，虚拟化改为逐行 absolute/spacer（padding 撑高），**header 高与 gap 计入行间间距**——为避免累计滚动偏移，行高估算含自身 margin/gap 分量，实测补偿（`resizeObs` 模式）兜底。
- **组间的边界**：跨组时 item 直接落在对应 header 行后，DOM 结构由虚拟行序列决定，`groupedItems` 不再直接 `v-for`。

**④ 锚点补偿改 data 层**：
- `onLoadMorePreservingAnchor` 的 `.cy-history-item` DOM 选择器 → 改为「按扁平行索引」找首个可见项（data 层：前缀和 + 二分，用 `captureAnchor` 泛型的 `isAnchorable` 谓词跳过 header 行取首个 item 行）。
- **锚点定位**（跳转后回看/高亮）：历史侧实际接的是 **jump 锚点定位**（`onJump` → `conversationStore.jumpToMessage`），**非**消息列表的 `scrollToHighlight` 高亮（feasibility L-1——历史查看器无 `scrollToHighlight` 对应物）；data 层定位用 `restoreScrollTop` 泛型 + `keyFor=hitId`。
- **锚点恢复语义不变**：`loadMore` 前插新行后 `restoreScrollTop` 精确恢复可视位移。

**⑤ 重写断言**（feasibility M-2——虚拟化后 count 恒等于窗口行数，重写量与断言稳健性高于初估）：
- `history-viewer-layout.spec.ts` 现有断言 `.cy-history-day` 全量计数 / `.cy-history-item` 全列表 / DOM 选择器锚点 → **重写为虚拟列表语义**：`.cy-history-item` 有界（≤ 可视行×常数，依赖 overscan `OVERSCAN_PX` + viewport；`history-viewer-layout.spec.ts` 用 `launchWithSize` 固定 1184×721，断言须在该固定 viewport 下取值）；`.cy-history-day` 断言改为「可见 header 数有界」而非全量。
- 锚点 offset ≤1px（P1-01 不变量）保留（data 层前缀和 + restoreScrollTop），分组 header 仍正确显示。
- **断言稳健性**：count 依赖窗口尺寸/overscan，CI 窗口节流/渲染差异可能抖动——用 poll/松阈值（§4D），非硬相等。

**⑥ 兼容既有交互**：
- Tab 焦点陷阱：**查询 overlay 全量 focusable**（`overlay.querySelectorAll('button,[href],input,select,textarea,[tabindex]…')`——含 header 搜索框/分类 tab/加载更多/footer 常驻控件；feasibility L-2——虚拟化只影响 item 行是否挂载，最后 focusable 仍为 footer「加载更多」，回绕语义保留）。
- 跳转 `onJump` / `close` / Esc / IME 守卫：不依赖查看器 DOM 结构，不变。
- 无障碍：`role=dialog` / `aria-modal` / `aria-live` 播报 / 初始焦点搜索框——不变。
- **snippet 敏感处理不变（安全 M-5 重申）**：搜索结果 snippet 为敏感 chat 内容子串，渲染路径保持**模板 mustache 插值转义**（`{{ hit.snippet }}`，非 v-html / 非 renderMarkdown）——虚拟化只改 DOM 节点数，**不改变** snippet 文本转义与「不落日志/导出」语义；实现时不得为省事改走 v-html。viewer items 于 close 时保留（既有语义，`historyViewer.store.ts` closeViewer 只清 error 不清 items）——本批不新增清理，记观察项。

### 4B. CyMarkdown 渲染缓存

**核心**：`renderMarkdown` 结果按 source 字符串键缓存，命中免 `marked.parse` + `DOMPurify.sanitize`。

- 模块级 `Map<string, string>`（source→HTML，**D7C-08 定案取 Map**）。因键为 string 普通值，`WeakMap` 不提供「弱引用回收」增益（string 不可 weak）；`Map` 更简单且语义正确，上界由「完成态 segment 数=会话内已渲染分段总数，量级有限 + 会话切换时清空」控制。
- **清空 hook**：`utils/markdown.ts` 暴露 `clearMarkdownCache()`；`message.store.ts` 的 `resetConversation`（`:130-142`）内调用——现有**全部**会话切换路径（conversation.store.ts activate/activateLocal/delete）都汇聚到 `resetConversation`，单一挂载点可覆盖。单测断言切换后缓存清空。
- CyMarkdown 完成态（`source` 未变）命中缓存；流式段 source 每次变未命中，仍走 80ms 防抖，行为不变。
- **缓存失效**：会话切换（`resetConversation`）清空缓存；渲染上下文（主题等，本批不涉及）不变故无需按上下文键。
- 纯函数 + 单测：`renderMarkdown` 对相同 source 两次调用，第二次命中缓存（断言 DOMPurify 不重复执行——用单测 spy 或计数）。

### 4C. 流式增量合并（**降级为观察项，本批不做**）

**判断（用户 2026-08-26 拍板）**：`toAssistantSegments()` 每 delta 全量重建的主收益已被 §4B 缓存吸收（CyMarkdown 对 source 未变的 segment 不再 re-parse）。§4C 剩余的「每 delta 全量 `map/filter/sort`」成本极低（segment 数通常≤5，O(k log k) 可忽略），而实现需复杂纪律（定稿不可变 + authoritative 覆写失效 + Vue 响应 + 排序复刻），风险/收益不成比例——**降级为观察项**，记入 §8 已知限制。

**若未来重访**（观察项）需满足 spec 已列纪律：segment「定稿」按「不会再被变更」判定（非 completed）；定稿对象不可原地变更（变更即建新对象保 Vue 响应）；`authoritative` 覆写时缓存失效重建；增量维护复刻 `(segmentIndex, deltaSequence)` 排序。本节不再列为 Task，留作观察项参考。

### 4D. 性能测量常驻门禁

**核心**：集成 suite + 松阈值，断言虚拟化后 DOM 节点有界 + JS 堆上限。

**① 测量断言（page.evaluate 读真实 Electron）**：
- JS 堆：`performance.memory.usedJSHeapSize`——接 `--enable-precise-memory-info`（可行 M-4：否则粗粒度近似、依赖 GC 周期）。**落点**：main 进程 `app.ready` 前 `app.commandLine.appendSwitch('enable-precise-memory-info')`（renderer 侧 `performance.memory` 才精确；当前无既有接线，main-window.ts:82 仅 webPreferences，index.ts:81-82 仅读 switch 无 appendSwitch——Task 6 补此落点）。
- DOM 节点：`document.querySelectorAll('.cy-history-item').length`（虚拟化后 ≤ 可视行×常数，不随 500 线性）+ 消息列表可视行数有界。
- **安全 M-3 显式承诺**：断言**仅限聚合计数**（`usedJSHeapSize` 字节尺寸 / `.cy-history-item` 节点数 / 可视行数），**绝不含** message text / segment 逐条长度 / 分段内容量——防测量演化为内容侧信道。单测/集成注释显式声明此边界。

**② 大 seed 场景**：
- `CYRENE_MOCK_HISTORY_LARGE`（历史查看器 500 项）——已存在，直接可用。
- `CYRENE_MOCK_HISTORY_LARGE` 大值 + 消息列表长会话（200 条混合消息）。
- 100 多分段回复：**新增 mock 多分段种子**（见 §4.5）。

**③ 松阈值**：
- 先跑实测（不含断言的测量跑），记录基线值；断言阈值 = 基线×1.5（防 CI 抖动）。阈值写入 spec 的集成测试注释，不硬编码 magic number 于逻辑。
- 阈值在「本批开发后实测」才定稿——测量驱动的断言在 spec 里描述取值方法，实际数字在 Task 7 前后填。

**④ 门禁触发与可靠性**：
- 集成测试 `test:integration` 常驻，无回归即绿。
- **可行 M-4**：堆断言固有抖动（JIT 预热/GC 时机/后台任务），单次快照易尖峰——**采样多次（≥3 次 rAF 间隔后取中位/最小稳定值），松阈值×1.5 缓解**；并将堆断言设为**告警（warn）非硬失败**（`test.skip` 或独立 `it` 标记），DOM 节点数断言为硬失败（虚拟化后确定性）。防「一旦抖动团队禁用整个门禁」失效。`performance.memory` 为 Chromium 非标准 API（弃用方向）——若将来 Electron 升级移除，门禁退化为仅 DOM 节点断言 + 告警注记（记观察项）。

### 4.5 mock 多分段种子

- 为「100 多分段回复」新增 mock 支持：**新增 `CYRENE_MOCK_MULTI_SEGMENT` env**（不复用 `CYRENE_MOCK_REPLY_FIXTURE`——它语义是「正文覆盖」非「分段数」，契约 L-2 不建议语义漂移）。
- **useMock 门控**（安全 M-4）：env 解析写成 `useMock ? parseMockMultiSegmentEnv(...) : undefined`，与 `cyreneMockReplyFixture` 同款——真实模式误设不注入；mock 生成的分段文本为可读确定性文本（如「模拟命中文本 N」），避免触发 base64-long-string 黑名单。
- 生成的回复 = 一个 assistant message + `N` 个 markdown/text segment（`segmentIndex` 0..N-1），`generation.completed` 后呈现。
- **回放耗时**（feasibility L-5）：mock `scheduleReplay` 定时器 = `index * emitDelayMs`（缺省 30ms），100 分段×数 delta → 数秒回放；测试用最小 `emitDelayMs`（或 env 调低）控制耗时，仅作测量场景不拉长常驻门禁。
- mock 单测钉住：分段数 `N`、segmentIndex 有序、无重复。

---

## 5. 契约 / schema / 通道

本批**不新增 IPC 通道、不新增 schema、不新增 ipc-security 白名单**（纯 renderer 性能优化 + 测量 + mock 扩展，无 Main↔Renderer 契约变更）。

- **无新增 invoke / push / preload 方法**。
- **无 schema / manifest 变更**（mock 多分段种子是 mock 行为，非 wire 契约——wire 仍是既有 BackendEvent 多分段结构，seed 只是生成更多 segment 实例）。
- **无 ipc-security 白名单变更**（安全 M-6 消歧注：此处「白名单」= ipc-security 权限白名单，与 §7「verify:sensitive allowlist 预计新增」不同所指——后者是敏感扫描 base64-long-string 检出 allowlist，非本批契约面）。

---

## 6. Task 分解（subagent 执行用）

### Task 1: 泛型化 virtual-window 数学内核 + 单测
- 泛型化 `estimateHeight/buildPrefix/computeWindow/captureAnchor/restoreScrollTop`（`<T>`，注入 estimator + keyFor + isAnchorable，见 §4A①）。
- 消息列表调用处保持兼容（`estimateHeight` 保留 `Message` 重载零改动；`buildPrefix` 经默认参数/重载传 `estimate: messageEstimate` + `keyFor: m=>m.messageId`、`captureAnchor` 传 `isAnchorable: ()=>true` + `keyFor: m=>m.messageId`、`restoreScrollTop` 仅传 `keyFor: m=>m.messageId`——逐函数对齐 §4A① 签名，契约 r2 注记）。
- 单测：泛型化后消息列表既有虚拟窗口行为回归绿 + 新泛型签名单测（keyFor/isAnchorable 注入正确性、估计函数差异化）。

### Task 2: 历史查看器虚拟化
- `groupedItems` → 扁平虚拟行 `rows`；泛型化组件用 `virtual-window` 渲染可视窗口。
- 锚点补偿改 data 层；重写 `history-viewer-layout.spec.ts` 失效断言。
- `CyHistoryResultItem` 高度估算 + 实测（sticker 缩略图行更高）。

### Task 3: CyMarkdown 渲染缓存 + 单测
- `utils/markdown.ts` 模块级 `Map<string, string>`（source→HTML，D7C-08）；命中免 `marked.parse` + `DOMPurify.sanitize`。
- 导出 `clearMarkdownCache()`；`message.store.ts` `resetConversation` 内调用（单一挂载点覆盖全部会话切换路径，安全 M-2）。
- 单测：相同 source 二次调用命中缓存、DOMPurify 不重复执行（spy/计数）；切换后缓存清空。

### Task 4: mock 多分段种子 + 单测
- MockBackend 新增 `CYRENE_MOCK_MULTI_SEGMENT` env（**useMock 门控**，安全 M-4），生成含 `N` 个 `public_reply` 分段的回复（`segmentIndex` 0..N-1）。
- **不**复用 `CYRENE_MOCK_REPLY_FIXTURE`（契约 L-2：它语义是正文覆盖非分段数）。
- 单测：分段数 N、segmentIndex 有序、无重复；mock 生成文本为可读确定性文本（避 base64 黑名单）。

### Task 5: 性能测量集成 suite
- 集成 suite + 松阈值：`CYRENE_MOCK_HISTORY_LARGE` 500 项 → 历史查看器 DOM 节点有界 + JS 堆上限；长会话 200 条 → 消息列表可视行有界。
- mock 多分段 100 分段 → 流式渲染不超阈值。
- 阈值 = 实测×1.5（Task 6 先跑无断言测量定基线，再填断言）。
- 堆断言采样≥3 次取稳定值 + **告警非硬失败**（可行 M-4）；DOM 节点断言为硬失败；接 `--enable-precise-memory-info`；断言注释显式声明仅聚合计数（安全 M-3）。

### Task 6: 全量门禁 + 文档同步
- 单测/集成/typecheck/lint/build/check:contract/verify:sensitive 全绿。
- 文档：doc 10/16（7C 状态注记 + 任务清单/验收门槛勾选）、doc 03（历史查看器虚拟化）、doc 11（**仅注记 Live2D 性能读数接入诊断页——测量驱动/观察项**）、doc 01/06（性能面）、doc 13（cross-review——若有新约定）、doc 17（mock 多分段 env `CYRENE_MOCK_MULTI_SEGMENT`）、README/CLAUDE.md 状态段、决策记录。

---

## 7. 验收标准（doc 16 §10 验收门槛映照）

| doc 16 验收 | 7C 落点 |
|---|---|
| 长会话、长流式、历史资源列表与 Live2D 性能 | 历史查看器虚拟化（500 项不虚化）+ CyMarkdown 缓存（多分段/长流式 re-parse）——长流式的副收益；§4C 增量合并降级观察项 |
| 200 条混合消息、100 个多分段回复、500 项历史资源操作正常 | Task 5 mock 多分段 + Task 6 测量 suite 断言；历史查看器虚拟化后 500 项 DOM 有界 |
| 长时间运行无明显持续内存增长 | Task 6 性能测量 suite 断言 JS 堆上限（测量驱动；若实测无病态增长则记观察项） |
| Live2D 关闭后 CPU/GPU 使用明显下降 | **维持现状 + rAF 停为代理证据**（一致 M-4 取舍）：本批以「rAF 帧循环断 + tick 早退」为代理，CPU/GPU 数值实测记 7D/后续；7C 测量 suite 复核 rAF 停（集成已测 + 本批复核）|
| 日志和诊断导出通过敏感信息扫描 | 无新秘密面（安全 M-6）：新测试/文档**预计触发 base64-long-string 类别命中**（≥40 连续 base64 可读串随 spec/测试文件出现），按 verify:sensitive **fail-loud 纪律补逐行核对 allowlist 条目**；非零新增 allowlist |

---

## 8. 已知限制 / 接受档

- **流式增量合并不做（§4C 降级观察项）**：§4B 缓存已解决「流式重复 re-parse」主瓶颈；§4C 剩余每 delta 全量 sort 成本极低（segment≤5）但需复杂纪律（定稿不可变 + authoritative 覆写失效 + Vue 响应），风险/收益不成比例。视图感知暂停（视口外 segment 不 re-parse）同样记观察项——两者留待重新评估。
- **长会话内存有界测量驱动**：若实测 byId/cache.snapshots/historyViewer.items 无病态增长，则记观察项不强行加上限；仅当测量证明确有问题才纳入（届时可能拆 7C 修复 commit 或记 7D）。
- **Live2D collapse 不 dispose**：资源常驻但 rAF 停（expand 无需重载，恢复快）。CPU/GPU 下降幅度非「释放资源级」，是「停渲染级」——测量验证的是 rAF 停，非资源释放。
- **历史查看器虚拟化后焦点陷阱/锚点**：跳过锚点恢复仅覆盖已加载行（虚拟化后未加载行无 DOM，锚点 data 层计算恢复——接受档）。
- **性能阈值**：松阈值×1.5 防 CI 抖动，但仍可能随机型/负载波动——阈值在 Task 6 实测后定稿，后续若 CI 常抖再放宽（记观察项）。
- **`performance.memory` 为非标准 API**（可行 M-4 次生，接受档）：Chromium 已标弃用方向，Electron/Chromium 升级可能移除、静默弄断堆门禁——本批堆断言设为告警非硬失败，若 API 消失则门禁退化为仅 DOM 节点断言 + 告警注记（记观察项）。堆采样多点取稳定值 + `--enable-precise-memory-info`，仍无法完全消除 JIT/GC 抖动。
- **CyMarkdown 缓存为敏感文本派生副本**（安全 M-1，接受档）：模块级 `Map<source, html>` 是 chat content 的二次常驻副本（renderer 堆内、post-sanitize、仅随会话切换清空）。不跨信任边界、不进日志/导出，但属敏感文本额外驻留——量级以「会话内渲染分段总数」为界，非新病态面；缓存键并入 DOMPurify 配置版本（当前静态常量故仅记观察项）。

---

## 9. 文档同步清单（Task 7 核验）

doc 10 §10（**7C 状态注记 + §10.2 完成标准勾选**）/16 §10（7C 状态注记 + §10 任务清单/验收门槛勾选——**本轮改「长会话/长流式/历史资源/Live2D 性能」「200 条/100 分段/500 项」「内存增长」「Live2D 下降」从 `[ ]` 转 `[x]`**）/03（**前端 UI 与交互设计——历史查看器虚拟化**，一致 M-3：doc 11 为设置中心非历史查看器，归 doc 03）/11（**仅注记 Live2D 性能读数接入诊断页（设置中心）——测量驱动/观察项**，非历史查看器虚拟化）/06（状态管理与本地存储——缓存/内存面）/01（Electron 架构——性能面）/13（cross-review——若有新约定）/17（mock 多分段 env `CYRENE_MOCK_MULTI_SEGMENT`）+ README + CLAUDE.md 状态段 + 决策记录。

**三态声明**：本批 = 代码批，Mock 驱动，**三态 = 已开发、未联调**；真实 Windows Electron 联调为批次后。

---

## 10. 参考

- Explore 摸底报告（`a9a657683231f9051` renderer 热点 + `a8f17b04b84eef2af` 内存/Live2D 接线）+ 主会话独立核实。
- 阶段 7 批次 A/B spec/plan（`docs/superpowers/specs|plans/2026-08-22|25-phase7-*`）。
- 「阶段 7（安全、稳定性与性能收敛）批次 B 决策记录」（`docs/review/2026-08-25-阶段7批次B-决策记录.md`）§8 已知限制。
- 「阶段 7 批次 A 决策记录」（`docs/review/2026-08-22-阶段7批次A-决策记录.md`）§13 未做项（Live2D 性能读数延 7C）。
- doc 16 §10、doc 10 §10.1。

---

## 附录：本批预置决策（D7C 记录，最终报告提出）

| # | 决策 | 依据 |
|---|---|---|
| D7C-01 | 测量门禁 = 集成 suite + 松阈值 | 真实 Electron 渲染进程可测，防回归最有效 |
| D7C-02 | 虚拟化 = 扁平虚拟行，header 为虚拟行 | 复用 virtual-window 内核，避免 sticky header 复杂度 |
| D7C-03 | markdown 缓存 = 模块级 Map | 键为 string 不可 weak，WeakMap 无增益；Map + 会话清空控制上界 |
| D7C-04 | 长流式 = **§4B 缓存解主瓶颈，§4C 增量合并降级观察项** | §4B 解决流式重复 re-parse；§4C 剩余 sort 成本低但实现复杂，风险/收益不成比例（用户拍板） |
| D7C-05 | 内存有界 = 测量驱动 | 先证后治，防过度工程 |
| D7C-06 | 虚拟列表内核 = 泛型化复用 | DRY，不各组件各自实现 |
| D7C-07 | Live2D collapse 不 dispose | 用户拍板，维持现状 |
| D7C-08 | markdown 缓存用 Map 非 WeakMap | string 键不可 weak，Map 语义正确 |
