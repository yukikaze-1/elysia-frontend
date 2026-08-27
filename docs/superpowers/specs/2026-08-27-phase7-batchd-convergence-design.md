# 阶段 7 批次 D（7D 收口收敛）设计文档

> **For agentic workers:** 本文档为设计 spec（binding）。实现将按 `superpowers:writing-plans` 产出 plan 后经 subagent-driven development 执行。
>
> **状态：** 待 review（spec review 轮次 0）
> **日期：** 2026-08-27
> **Base：** `bd2d313`（阶段 7 批次 C 真实联调验收 HEAD）
> **三态：** 本批次为 Mock 驱动实现——完成后标记「已开发、未联调」，真实 Windows Electron 联调归开发者批次后执行。

---

## 0. 结论（TL;DR）

阶段 7 共四批：**7A 安全收敛** → **7B 稳定性** → **7C 性能基线** → **7D 清理与集中修复收口**。前三批已落地并真实联调通过。

7D 的独特定位是**「收口批」而非「新功能批」**——它接收 A/B/C 三批在「不在范围」段反复推给 7D 的候选。**现状核实后发现：绝大多数候选已由 7A/6C 落地，7D 真正缺的是「策略确认 + 少量真实改良 + 收口记录」。** 7D 范围按用户拍板收敛为五块：

| 块 | 内容 | 性质 |
|---|---|---|
| **A. 临时附件/录音/缓存上限确认** | 确认无落盘、无磁盘清理面 + 补内存卫生（File 强引用释放）；**缓存上限已落地（草稿 100KB×50 + 离线 20 会话，阶段 3/4）——7D 仅确认 + 文档化** | 确认 + 少量内存卫生 |
| **B. F-11 审批历史策略确认** | 读面 7 天（产品语义）与存面 30 天（审计合规）分开记录 + tool-history.ts 注释 + 文档化 | 文档 + 注释 |
| **C. 观察项重开（真实改良×2）** | ① 视图感知暂停（视口外 completed segment 不渲染 markdown）② Live2D 帧耗时/帧率数值读数接入诊断页 | 功能（用户拍板重开） |
| **D. 阶段 7 收口** | Blocker/Critical 为 0 确认 + 安全发布清单通过（第 11/18 项证据缺口登记） | 记录 + 勾选 |
| **E. 文档同步** | doc 10/12/16 + README + CLAUDE + 三态状态整理 | 文档 |

**不在 7D 范围（用户拍板，此前的决策不推翻）：**

- **D-08 资源保存/下载/缓存/过期清理策略** → **不做**（用户 2026-08-27 明确排除。阶段 3 锁定附件 P0 仅展示不落盘；引入资源落盘是「网盘思维」+ 原 P2 产品决策，非阶段 7 收敛性质。文档标注为「记录不做 + 理由」）。
- **§4C 流式增量合并**、**长会话内存有界**（无病态增长记观察项）→ 维持观察项（7C 用户拍板，不重开）。
- **`performance.memory` 退化** → 只记录（若 Chromium 移除则门禁退化为仅 DOM 断言）。

---

## 1. 背景与目标

### 1.1 阶段 7 全流程节奏

doc 10 §10 阶段 7 还剩两项未完成，这两项就是 7D 的法定职责：

1. **日志轮转、缓存上限、临时附件与录音清理**（doc 16 行 418 `[~]`）
2. **集中修复 Blocker、Critical 与主要回归问题**（doc 16 行 419 `[ ]`）

以及 doc 10 §10.2 仍未勾选的**全流程收口**两项：
- **Blocker/Critical 为 0**
- **安全发布清单通过**（7A 已产出 20 项核对表；第 11 项 Endpoint SSRF=后端职责、第 18 项发布包完整性=阶段 8 签名联动为证据缺口）

### 1.2 现状核实（主会话独立核对，决定 7D 性质）

**关键发现：大部分「候选」已落地，7D 缺的是「确认 + 口径」而非「实现」。**

| 候选 | 现状（已核实） | 7D 真正缺什么 |
|---|---|---|
| 日志清理 | ✓ 已落地：轮转 5MB×3、日志目录管理/打开/清理（7A） | 已足 |
| 审计保留 30 天 | ✓ 已落地：`AUDIT_RETENTION_DAYS=30` + `auditFilesToDelete()` 清理 | 已足 |
| 诊断导出审计段 | ✓ 已落地：30 天窗口全量 + 15MiB 截断 + `truncatedAudit` + sha256 | 已足 |
| 工具/审批历史 | ✓ 已落地：`tool-history.ts` `HISTORY_DAYS=7`/`HISTORY_MAX=200` 回读上限 + `tool:history`/`tool:grants`/`tool:grant-revoke` + 审计 export | **读面 7 天 vs 存面 30 天口径未确认**（读面=产品语义，存面=审计合规，见 D2） |
| **缓存上限** | ✓ 已落地（阶段 3/4）：草稿 `DRAFT_MAX_BYTES=100KB`/`DRAFT_MAX_ENTRIES=50`、离线缓存 20 会话——doc 16 行 418 注记已在 7B 正文记录 | **「缓存上限」属确认 + 文档化**（已落地，无新增）——doc 16 行 418 由 `[~]`→`[x]`（见 D1/D2 同态：确认 + 记录） |
| 临时附件清理 | **无落盘**——`PendingAttachment` 内存态待发队列，附件不经 `__cyrene-media` 落盘（阶段 3 锁定 P0 不保存） | **语义不清**：没落盘就没有清理，需确认「无落盘=无需清理」+ 补内存卫生（见 D1） |
| **录音清理** | **无落盘**——阶段 4 锁定「保留录音」不在批，音频不写盘 | 同上：无落盘，需确认 + 内存 session 结束释放（见 D1） |

### 1.3 范围（7D in-scope，按用户拍板）

见 §0 表格 A~E。**C 块（视图感知暂停 + Live2D 读数）是本批唯一的真实功能改良**。

---

## 2. 用户拍板决策点（记录进决策记录，全部按推荐方案）

| # | 决策点 | 用户拍板 | 落点 |
|---|---|---|---|
| **D7D-01** | 临时附件/录音清理 | **方案 A：确认无落盘=无需磁盘清理 + 补内存卫生**（不引入录音临时落盘、不引入附件落盘——后者即 D-08 已排除） | §4A |
| **D7D-02** | F-11 审批历史保留口径 | **方案 A：读面 7 天是产品语义（「审批历史看最近 7 天」），存面 30 天是审计合规（安全/诊断），两者目的不同、不必拉平** | §4B |
| **D7D-03** | 观察项是否重开 | **方案 B：重开「视图感知暂停」+「Live2D 数值读数」两个真实改良**（尊重 7C 对 §4C/内存有界的降级拍板，不重开；这两个是「收敛」的自然延续，非新 P0） | §4C |
| **D7D-04** | Blocker/Critical 判定口径 | **以「阶段 7 全程 + 7D 实测跑通 → 无新 Blocker/Critical」为准**；历史遗留（`message_id=""` 后端阻断、Live2D `Failed to fetch` 观察项）登记但不算 Blocker/Critical | §4D |

**已排除（记录不做，不因本批重开）**：D-08 资源落盘/缓存清理（用户 2026-08-27 明确不做）；§4C 流式增量合并（7C 用户拍板降级）；长会话内存有界（7C 测量驱动无病态增长）；`performance.memory` 退化（只记录）。

---

## 3. 现状与缺口（Explore 摸底 + 主会话独立核实）

### 3.1 临时附件内存卫生（面 A，真实缺口）

`apps/desktop/src/renderer/src/stores/attachment.store.ts`（阶段 3 G3）：
- `fileByLocalId: Ref<Record<string, { file?: File; bytes?: ArrayBuffer }>>`（`:16`）——**持 File/ArrayBuffer 强引用**。
- `kindByLocalId: Ref<Record<string, AttachmentKind>>`（`:14`）。
- **`remove(localId)`（`:123-126`）只经 `attachmentQueueReducer` 的 `remove` action 清 `pendingById/order`**，**`kindByLocalId`/`fileByLocalId` 对应 key 残留**——单个附件移除后其 File/ArrayBuffer 强引用一直驻留，直到 `clearOnSent()`（`:128-132`）/`clear()`（`:134-140`）才全量清空。
- **无 `URL.revokeObjectURL`**（全 renderer grep 零命中）——附件无 Blob URL 生成（预览走 `__cyrene-media` 代理 + 原生缩放），故无 Blob URL 泄漏面；但**File/ArrayBuffer 强引用是真实驻留点**。

**缺口：** `remove(localId)` 需同步清 `kindByLocalId[localId]` 与 `fileByLocalId[localId]`——单个移除即时释放引用。

### 3.2 录音内存卫生（面 A，真实缺口）

`apps/desktop/src/renderer/src/stores/voice.store.ts`：
- 录音 session 用 `activeRecordingId`（`:275` `rec_${crypto.randomUUID()}`）；`startRecord`（`:278`）/`stopRecord`（`:317`）/`discardRecord`（`:355`）/`commitRecord`。
- `reset()`（`:522`）在断线/会话切换时清态（`:544` 返回 `reset`）。
- **无 Blob URL**（音频流式走 `audio.session` 事件 + `voice:audio-chunk` 单向守卫，不经 createObjectURL）——无 Blob URL 泄漏面。

**缺口：** 录音不落盘、无 Blob URL，**内存卫生实际集中于「录制的音频数据引用」**——需核对 `replayRecord`/待发送条目的音频引用在 reset/commit/discard 后是否释放。**若已释放（renderer 无音频内嵌引用），则面 A 录音侧仅为确认性记录。**

### 3.3 F-11 审批历史（面 B，口径确认）

`apps/desktop/src/main/tools/tool-history.ts`：
- `HISTORY_DAYS = 7`（`:20` F-4：天数边界）——**读面**：`readAuditEvents` 按文件名倒序取最近 N 天（`:57` cutoff）。
- `HISTORY_MAX = 200`（`:21`）——合并结果总量上限（逐文件流式读满即停）。
- **存面**：审计文件本身保留 **30 天**（`diagnostics-service.ts:34` `AUDIT_RETENTION_DAYS=30` + `auditFilesToDelete()`）。

**口径分裂：** app 内「审批历史」只读最近 7 天（200 条），诊断导出含 30 天工具事件。**非 bug**——读面是产品语义（7 天足够用户查看近期授权记录），存面是审计合规（30 天安全留存）。7D 确认不拉平，文档化。

### 3.4 视图感知暂停（面 C ①，真实功能）

`apps/desktop/src/renderer/src/utils/virtual-window.ts`：
- `computeWindow(prefix, scrollTop, viewportHeight, overscanPx)`（`:94-105`）——`overscanPx=0` 时返回**严格可视窗口**（无 overscan）；当前 `CyMessageList.vue:37` 用 `OVERSCAN_PX=400` 得到含 overscan 的渲染窗口。
- **区分「预渲染（overscan）行」与「真正可见行」的方式现成**：再调一次 `computeWindow(prefix, scrollTop, viewportHeight, 0)` 得严格窗口。

`apps/desktop/src/renderer/src/components/CyMessageBubble.vue`：
- segment 渲染点 `:99-115`（`:100` 是 markdown segment，`:102` sticker、`:104-113` 媒体）。
- **只接 `props: { message }`，无 index/可见性 prop**（`:11`）。
- `publicSegments`/`innerVoiceSegments` 是 `computed`（`:19-28`）——对 `channel` 过滤 + 排序。
- **渲染对 `seg.completed` 无分支**（completed/streaming 都走同一 `<CyMarkdown :source="segmentText(seg)">`）；CyMarkdown 内部 `renderMarkdown` 可命中缓存（同 source 文本）。

`apps/desktop/src/renderer/src/stores/message.store.ts`：
- `patchAssistant`（`:99-103`）流式事件时只刷新 `m.assistantSegments = acc.toAssistantSegments()`；`finalizeAssistant`（`:106-115`）`generation.completed` 时才 `m.status = s.status`。
- 分段级完成状态在 `AssistantSegment.completed`（`contracts/message.ts:48`）。

**缺口：** 视口外 completed segment 全量渲染——100 分段单条回复渲染 100 个 `.cy-segment`（perf-gate ② `.cy-segment==MULTI_SEGMENT_N` 断言，7C 记录为观察项）。

### 3.5 Live2D 数值读数（面 C ②，真实功能）

`apps/desktop/src/renderer/src/live2d/perf.ts`（阶段 5 批次 C C2）：
- `FrameBudget`（`:22`）——私有 `emaCost`（`:25`），`feedCost(costMs)`（`:64-84`）喂 EMA 一阶平滑；`autoTarget`（`:27`）auto 模式目标帧率（60|30）。
- **`emaCost` 是现成帧耗时数据源，但无公开 getter 暴露读数**。

`apps/desktop/src/renderer/src/live2d/controller.ts`：
- `tick()`（`:209-221`）——`if (!budget.shouldDraw(now)) return`（`:215`），draw 帧 `budget.feedCost(performance.now() - t0)`（`:220`）。`ready && visible` 才跑。
- `budget` 为私有成员。**无 getStats 透传**。

`apps/desktop/src/renderer/src/stores/live2d.store.ts`：
- `setVisibility`（`:267`）/`tick()`（`:426-434`）/`ensureController()`（`:186`）——`controller` 私有。
- `return`（`:481-483`）暴露 `{ models, status, modelId, ..., tick, handleDirective, ... }`——**无 `getStats`-like**。

`apps/desktop/src/renderer/src/components/CyDiagnosticsPane.vue`：
- `:240-241`「Live2D 性能」占位：`不可用——帧耗时统计未导出（FrameBudget 读数为 controller 私有，本批不做 API 扩展——确定性口径，归 7C 性能批次）`（testid `diag-dev-perf`）。**7A 遗留 D7A-06 的 Live2D 读数**。

**缺口：** 给 `FrameBudget` 加 `getStats()`（返回 `{ emaCostMs, autoTargetFps, mode }`）→ controller 加透传 → live2dStore 暴露 → CyDiagnosticsPane 展示。**闭合 D7A-06 遗留。**

---

## 4. 设计决策

### 4A. 临时附件/录音清理（D7D-01，面 A）

**核心：附件/录音不落盘，无磁盘清理面；7D 只补内存卫生 + 确认记录。**

#### 4A.1 附件内存卫生（真实补点）

`attachment.store.ts` 的 `remove(localId)` **补齐**清除 `kindByLocalId[localId]` 与 `fileByLocalId[localId]`。**现状 remove 仅 `uploading` 短路 + `commit`（attachment.store.ts:123-126）；7D 补两个 `delete`（目标形态如下）：**

```ts
function remove(localId: string): void {
  if (uploading.value) return   // 上传中禁止移除（spec §4.3）
  commit({ type: 'remove', localId })
  delete kindByLocalId.value[localId]   // 7D 新增：单个移除即时释放强引用
  delete fileByLocalId.value[localId]
}
```

- **理由**：单个附件移除后立即释放其 File/ArrayBuffer 引用，不等 `clearOnSent`/`clear`。多处添加多个大附件再逐个移除的场景，此补点避免驻留累积。
- **边界（M-3）**：`uploading.value === true` 时 `remove` 短路不清队列也不清引用（上传中禁止移除，spec §4.3）——**本补点只收紧「非上传中单个移除」**；上传中断的条目（`cancelUpload` 路径不调 `remove`）其引用释放由 `clearOnSent`/`clear` 兜底（既有行为，非本补点目标）。**plan 不得实现一个上传中也清引用的 remove**（会破坏上传流）。
- **单测**：`attachment.store.spec.ts` 增用例——addFiles → remove → `fileByLocalId[localId]` 与 `kindByLocalId[localId]` 均为 undefined，且不清其它 localId。
- **确认记录**：附件无 Blob URL 泄漏（预览走 `__cyrene-media` 代理 + 原生缩放，无 createObjectURL）；附件不落盘（阶段 3 锁定 P0 不保存）→ **无磁盘清理面**。

#### 4A.2 录音内存卫生（核对 + 确认）

- **核对**：`voice.store.ts` 无 Blob URL（音频流式走 `audio.session` 事件 + `voice:audio-chunk` 单向守卫）。`replayRecord`/待发送条目持音频数据引用。
- **确认**：录音不落盘（阶段 4 锁定「保留录音」不在批）→ **无磁盘清理面**。录制中临时音频（`activeRecordingId` 关联的 session）经 `discard/commit/reset` 收敛——**7D 核对 reset/commit/discard 后无残留音频引用；若已释放则仅确认性记录，不新增代码**。

### 4B. F-11 审批历史策略（D7D-02，面 B）

**核心：读面 7 天与存面 30 天目的不同，不拉平，文档化。**

- **读面 7 天**（`tool-history.ts` `HISTORY_DAYS=7` + `HISTORY_MAX=200`）：产品语义——「审批历史/工具日志在设置页看最近 7 天（200 条）」。
- **存面 30 天**（`diagnostics-service.ts` `AUDIT_RETENTION_DAYS=30`）：审计合规——审计 JSONL 安全留存 30 天，诊断导出含 30 天全量。
- **结论**：两者目的不同（产品显示 vs 安全/合规留存），**不必拉平**。7D 在 `tool-history.ts` 注释 + doc 16 F-11 行 + doc 04 文档化此口径。

### 4C. 观察项重开（D7D-03，面 C）

#### 4C.1 视图感知暂停（真实改良①）

**目标：视口外 completed segment 不渲染 markdown（减少长会话中大量 markdown 回复滚动出视口后的 parse/DOM 成本，闭合 7C 观察项「视图感知暂停」）。**

> **修正（2026-08-27，review 澄清）：视图感知的真实价值域是「长会话多短 markdown 回复滚动」——旧回复滚出视口后其 markdown 不再立即 parse。** 单条 100 分段回复**恒跨视口**（行高 ~3000px > 721px 视口），`rowVisible()` 恒 true，视图感知对该行不生效——**不是**「100 分段」的优化。故 mock 长会话种子（`seedSyntheticHistory`）的 assistant 消息**须补 `assistantSegments`（markdown 段，`completed: true`）**，使长会话含大量带 `.cy-segment` 的短回复，滚动出视口后视图感知真实生效且有可验证差异（见 §4C.3 mock 支撑）。perf-gate ③（长会话）现有断言只数行/垫片不塌、不读 segment 内容，补 markdown 段不破坏 ③。

```
层：CyMessageList.vue（可见性下传）→ CyMessageBubble.vue（segment 级门控，不改 CyMarkdown 内部）
```

**设计（钉死机制，消除歧义）：**

1. **`CyMessageList.vue`** —— **不新增第二个 computed**，在现有 `win` computed 里同时暴露严格可见区间（`computeWindow` 两次调用同前缀，O(log n) 二分成本可忽略；共享 `prefix/scrollTop/viewportHeight`）：

   ```ts
   const win = computed(() => {
     const w = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
     const strict = computeWindow(prefix.value, scrollTop.value, viewportHeight.value, 0)  // 7D：严格可见窗口（无 overscan）
     return {
       startIndex: w.startIndex, endIndex: w.endIndex,
       paddingTop: w.paddingTop, paddingBottom: w.paddingBottom,
       visibleIds: items.value.slice(w.startIndex, w.endIndex + 1).map((m) => m.messageId),
       strictStartIndex: strict.startIndex,   // 7D：真正可见行区间
       strictEndIndex: strict.endIndex,
     }
   })
   ```

   `visibleIds`（含 overscan 渲染集）保持不变；`strictStartIndex/strictEndIndex` 是**真正可见行区间**（无 overscan）。

2. **可见性下传（钉死：传 `visible` 布尔，用循环内 index 判定，不 findIndex）** —— 渲染循环改为 `v-for="(id, i) in win.visibleIds"`，用循环位置 `i` 换算全局 index（`win.startIndex + i`），与 `[win.strictStartIndex, win.strictEndIndex]` 直接比较：

   ```html
   <!-- 原：<div v-for="id in win.visibleIds" :key="id" :ref="...class="cy-vlist-row"> -->
   <div v-for="(id, i) in win.visibleIds" :key="id" :ref="...class="cy-vlist-row">
     <CyMessageBubble :message="messageStore.byId[id]" :visible="rowVisible(win.startIndex + i)" />
   </div>
   ```
   ```ts
   /** 全球行 index 是否落在严格可见窗口（无 overscan）——不 findIndex，直接比较循环内 index */
   function rowVisible(globalIdx: number): boolean {
     return globalIdx >= win.value.strictStartIndex && globalIdx <= win.value.strictEndIndex
   }
   ```

   注：`win.startIndex + i` 即「该行在 `items` 中的全局 index」，与严格窗口区间共享同源 prefix——无需反查 `messageId`。

3. **`CyMessageBubble.vue`** —— 新增 `props.visible: boolean`（默认 `true`，父级不传则全渲染——兼容其它消费方）。对 **`!props.visible && seg.completed`** 的 markdown segment（`isTextSegment(seg)` 分支 `:100`）：

   - **仍渲染 `<CyMarkdown>`（DOM 结构/`.cy-segment` 容器稳定）但 `:source="''"`**（空串 → `renderMarkdown('')` 空 HTML —— 组件挂载但内容空）。
   - **`seg.completed === false`（streaming）恒不受门控**——流式中必须实时渲染，`visible` 不生效。
   - **non-text segment**（sticker/媒体/`[kind 分段]` 占位）恒渲染，不受门控（无 parse 成本）。
   - **可见性翻转**：`visible` 从 `false→true` 时把空 `:source` 换回 `segmentText(seg)`——**CyMarkdown 的 `watch(() => props.source)` 自动触发真渲染**（`:19`），无需改 CyMarkdown。

   ```html
   <!-- 原：<CyMarkdown v-if="isTextSegment(seg)" class="cy-segment" :source="segmentText(seg)" /> -->
   <CyMarkdown
     v-if="isTextSegment(seg)"
     class="cy-segment"
     :source="needsDeferredRender(seg) ? '' : segmentText(seg)"
   />
   ```
   ```ts
   function needsDeferredRender(seg: AssistantSegment): boolean {
     return !props.visible && seg.completed === true
   }
   ```

**关键：`seg.completed` 是分段级完成信号（`contracts/message.ts:48`），与消息级 `message.status` 解耦**——视口外 completed segment 内容已定（不变），可安全延迟渲染；streaming segment 必须实时。

**设计权衡（须明确记录）：**

- **取舍**：视图感知暂停让「100 分段」从**先渲染**变成**视口内先渲染 + 滚动出视口时延迟**——但**单条回复行本身**仍是 1 个 `.cy-vlist-row`（虚拟化不裁剪行内 segment）。改良改变的是「行内 segment 的 markdown parse 是否在渲染瞬间执行」而非「行数」。
- **关键边界（B-1 定案，不改变断言语义）**：视图感知暂停**只影响「滚动出视口后的行」的延迟渲染，不改「视口内完成态回复」的全量渲染语义**。到 perf-gate ②采样时 `generation.completed` 已达成（`.toMatch(/completed/)`），且断言目标行是新发的**底部回复（在视口内）**——对该完成态回复，N 段**全部立即渲染**（「滚动出视口才延迟」对正在视口内且已完成的最新回复不生效）。故 `expect(r.dom).toBe(MULTI_SEGMENT_N)` **保持成立，断言值不回退**；只在注释把「观察项：全量无条件渲染」翻转为「视图感知已落地：仅在滚动出视口时延迟，视口内完成态字符串全量渲染」。
- **行高估算衔接**：completed segment 空 source 渲染时行高按估高（`estimateItemHeight`），可见换真 source 后行高变化由**既有 ResizeObserver 实测 + pendingCompensation** 补偿（消息列表已有机制，不自造）——空 source 高度 0 vs 真渲染高度非 0，翻转那帧 `onRowResized` 的 `delta = h - prev` 补偿该跳变（prev 为 0 时补偿空→真差值）。
- **安全**：延迟渲染仍走 post-sanitize 的 `renderMarkdown`（空 source 不引入新净化面）；snippet/正文不进日志导出（既有纪律不变）。
- **标注**：这是「收敛」的自然延续（先渲染 parse/DOM 成本降低），非新 P0。

#### 4C.2 Live2D 数值读数（真实改良②）

**目标：闭合 D7A-06——把 `FrameBudget.emaCost`（帧耗时）+ `autoTarget`（帧率）接入「开发与诊断」页 Live2D 性能区块。**

```
层：FrameBudget.getStats() → Live2DController.getStats() → live2dStore → CyDiagnosticsPane.vue:240-241
```

**设计：**

1. **`FrameBudget.getStats()`**：

   ```ts
   /** 性能读数（D7D）：暴露帧耗时 EMA + 当前目标帧率 + 模式——诊断页「Live2D 性能」数据源。 */
   getStats(): { emaCostMs: number; autoTargetFps: number | null; mode: PerformanceMode } {
     return { emaCostMs: this.emaCost, autoTargetFps: this.mode === 'auto' ? this.autoTarget : null, mode: this.mode }
   }
   ```

2. **`Live2DController.getStats()`** —— 透传 `budget.getStats()`（controller 持私有 `budget`；`budget` 恒构造非空——不判 null，空读数为构造默认值）。**返回类型与 FrameBudget.getStats 同**：`{ emaCostMs, autoTargetFps, mode }`。

3. **`live2dStore`** —— 暴露 `getStats()`。**「无读数」判定唯一来源 = store 层判 `status !== 'ready'`**（M-1 定案）：

   ```ts
   /** 性能读数（D7D）：仅在 ready 态返回（否则 null——诊断页无读数）。controller 缺失/未 ready → null。 */
   function getStats(): Live2dFrameStats | null {
     if (status.value !== 'ready' || !controller) return null
     return controller.getStats()
   }
   ```

   - **理由**：`budget` 恒构造非空，controller.getStats() 在模型未 ready/从未画帧时返回**构造默认值**（emaCost=0、autoTarget=60）——若直接透传，诊断页会显示一个**从未真实画帧的 0ms 读数**，误导。故在 store 层判 `status !== 'ready'` 显式返回 null，**「无读数」只看 status，不看 getStats 返回值**。

4. **`CyDiagnosticsPane.vue` :240-241** —— 替换「不可用」占位为**只读读数**：

   ```
   Live2D 性能
   帧耗时（EMA）：X.X ms   [目标帧率：60/30fps]   [模式：balanced/auto/...]
   ```

   - 读数来自 `live2dStore.getStats()`（纯 renderer 读 store，无新 IPC——诊断页已读 store，见 §3.5 诊断页数据来源）。
   - **无读数判定**：`live2dStore.getStats() === null`（store 层已判 status）→ 显示「Live2D 未启动（无读数）」，与既有占位语义一致但更准确。

**设计权衡（须明确记录）：**

- **读取时取值（钉死）**：诊断页「Live2D 性能」显示**当前瞬时**帧耗时 EMA + 目标帧率 + 模式——**诊断页打开时读取 live2dStore 的当前值渲染**，**不引入周期性推送**（避免新 IPC 通道 + renderer 常驻轮询）。诊断页打开时若 Live2D 未 ready，`getStats()` 返回 null → 显示未启动；不设轮询，用户重新打开诊断页即刷新。
- **无模型语义（M-1 定案，见设计 3）**：`live2dStore.getStats()` 在 `status !== 'ready'` 时**显式返回 null**（store 层判 status，非透传 controller 构造默认值）——诊断页只判 `getStats() === null` 即「Live2D 未启动（无读数）」，不显示误导性的 0ms/60fps 构造默认值。
- **不含 `performance.memory`**：诊断页「Live2D 性能」只展示 Live2D 帧性能读数（帧耗时/帧率），不做内存面板——`performance.memory` 由 7C perf-gate 承担（非标准 API，记录观察项），超本批范围。

#### 4C.3 mock 支撑：长会话种子 assistant 消息补 markdown 段（视图感知差异化断言的前提）

**问题：** 视图感知的价值域是「长会话多短 markdown 回复滚动」——但 `seedSyntheticHistory`（`mock-backend.ts:446-459`）生成的 assistant 消息**只有 `content`、无 `assistantSegments`**，渲染出空的 `.cy-response-cluster`（无 `.cy-segment`）。长会话**没有**可被门控的 markdown segment；单条 100 分段（`CYRENE_MOCK_MULTI_SEGMENT`）又恒跨视口、`rowVisible()` 恒 true、视图感知不生效。**现有 mock 无法正向验证视图感知。**

**修法：** `seedSyntheticHistory` 的 assistant 消息**补 `assistantSegments`**——每条 assistant 消息带 1 个 `{ channel: 'public_reply', kind: 'markdown', text: '模拟命中文本 N', completed: true }` 段（content 保留作兜底）：

```ts
// mock-backend.ts seedSyntheticHistory（assistant 分支补 assistantSegments）
out.push({ ...base(role), ...(role === 'assistant'
  ? { assistantSegments: [{ segmentId: `run2-seg-${...}`, segmentIndex: 0, channel: 'public_reply', kind: 'markdown', text: `模拟命中文本 ${i + 1}`, completed: true }] }
  : {}) })
```

**效果：**
- 长会话成为「大量带 `.cy-segment` 的短 completed markdown 回复」——滚动出视口后视图感知对其生效（空 source 延迟），滚回视口换真源。
- perf-gate ③ 现有断言（行数 ≤60 + 垫片不塌）**只数 `.cy-vlist-row`、不读 segment 内容**，补 markdown 段不破坏 ③ 语义。
- 视图感知差异化断言（§5.3）：长会话滚动出视口的行 `.cy-segment` **内容为空**（空 source 被门控），视口内行内容非空（换真源）。

**已知边界（记录）：** 长会话种子的 assistant 消息从「纯 content 文本」变「含 1 个 markdown 段」——视觉上多一个 markdown 渲染。doc 06 §性能注记提及该种子为 mock 确定性，非用户内容（`模拟命中文本 N`），不进日志/导出（既有纪律）。此变更是**测试支撑**，不改真实会话渲染路径。

**核心：记录 + 勾选，无代码。**

1. **Blocker/Critical 为 0（判定口径钉死）**：
   - **判定依据：以「阶段 7 全程（7A/7B/7C 各批验收通过）+ 7D 实测跑通 → 无新 Blocker/Critical」为准**。
   - 历史遗留**登记但不算** Blocker/Critical：后端 `message_id=""` 阻断（前端非空校验保持，四种改法全拒——7A 记录）、Live2D 真机 `Failed to fetch` 观察项（7B 记录）、`.corrupt-*` 保留（7B 有界保留已落地）。
   - **收口动作**：doc 10 §10.2 + doc 16 §10 验收门槛「Blocker/Critical 为 0」由 `[ ]`→`[x]`，附判定说明（上述依据）。

2. **安全发布清单通过**：
   - 7A 已产出 20 项核对表（`docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`）。
   - 第 11 项（Endpoint SSRF 面）→ **后端职责**（前端不做，登记为非前端缺陷）。
   - 第 18 项（发布包完整性 ASAR 校验）→ **阶段 8 签名联动**（登记非本批）。
   - **收口动作**：核对表第 11/18 项标注「非前端/阶段 8 联动」结论 + 确认其余 18 项通过；doc 07 §17 发布安全门槛逐项核对同步。

### 4E. 文档同步（面 E）

- doc 10 §10 / doc 12 §10 / doc 16 §10、§11 进度表——7D 状态注记 + 任务清单勾选 + 验收门槛勾选。
- doc 06 §性能 + doc 04 §7.4——附件/录音内存卫生 + 审批历史口径。
- doc 05 §Live2D 读数注记——数值读数已接入（D7A-06 闭合）。
- README / CLAUDE.md——7D 状态段 + 阶段 7 全流程收口结论。
- 决策记录：`docs/review/2026-08-27-阶段7批次D-决策记录.md`（新）。

---

## 5. 验收标准（对应 doc 16 / doc 10 §10.2）

### 5.1 面 A——临时附件/录音/缓存上限确认

| 验收 | 7D 落点 | 结果 |
|---|---|---|
| 临时附件清理 | `remove(localId)` 补清 `kindByLocalId`/`fileByLocalId` + 单测 + 确认无 Blob URL/落盘 | 通过 |
| 录音清理 | 核对 reset/commit/discard 无残留音频引用 + 确认不落盘无 Blob URL | 通过（若已释放则确认性记录） |
| 缓存上限 | doc 16 行 418「缓存上限」由 `[~]`→`[x]`（已落地确认：草稿 100KB×50 + 离线 20 会话，阶段 3/4）+ doc 06 文档化 | 通过 |

### 5.2 面 B——F-11 审批历史

| 验收 | 7D 落点 | 结果 |
|---|---|---|
| 审批历史保留/清理/导出策略确认 | tool-history.ts 注释 + doc 16 F-11 + doc 04 文档化读面 7 天/存面 30 天 | 通过 |

### 5.3 面 C——视图感知 + Live2D 读数

| 验收 | 7D 落点 | 结果 |
|---|---|---|
| 长会话视图感知（视口外 completed segment 延迟渲染） | CyMessageList 严格窗口下传 `rowVisible`（循环内 index 判定）+ CyMessageBubble `needsDeferredRender`（视口外 completed segment 空 source 延迟渲染，streaming 门控豁免）+ mock 长会话种子 assistant 补 markdown 段 + **perf-gate ③尾差异化断言**（滚出视口的行 `.cy-segment` 内容空、视口内非空）+ ② `toBe(N)` 保持仅翻转注释 + 单测 | 通过 |
| Live2D 性能读数接入诊断页 | FrameBudget.getStats() + controller 透传 + live2dStore.getStats() + CyDiagnosticsPane:240-241 替换占位（读取时取值）+ 单测 + 集成断言 | 通过 |

### 5.4 面 D——阶段 7 收口

| 验收 | 7D 落点 | 结果 |
|---|---|---|
| Blocker/Critical 为 0 | doc 10/16 勾选 + 判定说明 | 通过 |
| 安全发布清单通过 | 核对表第 11/18 项标注结论 + 其余 18 项确认通过 | 通过 |

---

## 6. 三态与已知限制

- **三态 = 已开发、未联调**（真实 Windows Electron 联调为批次后独立项）。
- **视图感知暂停**：行内 segment 仍不经虚拟窗口裁剪（单条回复行本身是 1 个 `.cy-vlist-row`），改良的是「行内 markdown segment 是否立即 parse」——长会话中滚动出视口的旧 markdown 回复延迟渲染（空 source），视口内回复恒全量渲染。**单条 100 分段回复恒跨视口（`rowVisible()` 恒 true），视图感知对其不生效——不是该特性的优化对象**（见 §4C.1 修正）。若滚动性能不佳（占位→可见→渲染的抖动），保留「completed segment 缓存命中」兜底（CyMarkdown 缓存已吸收重复 parse）。
- **Live2D 读数**：诊断页读取时取值，非持续记录；无 Live2D 模型（`status !== 'ready'`）→ 显示「未启动（无读数）」。
- **附件/录音**：不落盘、无 Blob URL；仅内存卫生补点（remove 清引用）——非新磁盘清理面。

---

## 7. 定义完成（DoD）

- typecheck + lint 通过；外部输入运行时 schema（本批无新外部输入，仅 store/组件内部逻辑）。
- 单测：attachment.store 补 remove 清引用用例；FrameBudget.getStats() 单测。
- 集成：性能 suite（perf-gate.spec.ts）②断言同步更新 + 新增视图感知断言；诊断页 Live2D 读数集成断言。
- 文档：doc 10/12/16 + README + CLAUDE + doc 04/05/06 同步 + 决策记录。
- 三态：标记「已开发、未联调」。
- 无新增敏感面：视图感知延迟渲染走既有 post-sanitize renderMarkdown；Live2D 读数仅帧耗时/帧率元数据（无正文/参数）。

---

## 8. 提交链

本批计划按 6 任务拆分（spec/plan 见 `docs/superpowers/specs|plans/2026-08-27-phase7-batchd-convergence-*`）。任务粒度按「面」切分（A/B 轻、C 功能、D 记录、E 文档）。
