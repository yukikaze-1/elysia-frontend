# Cyrene 二次真实联调整改：最终报告（Renderer 水合 + replay 身份防御 + 取消码统一）

**日期：** 2026-08-13
**依据：** `docs/review/2026-08-13-Windows-Electron-二次真实联调前端整改清单.md`（FE-INT2-P0-01 / FE-INT2-P1-01 / FE-INT2-P1-02）
**HEAD：** main（spec 4cb2a66、plan 313c663、T1 a9a9b0d、T2 cbd0b82+eb95afb、T3 a68891a、文档同步 a153f07、最终 review 修复 4b86e73）
**验证基线：** **526 单测（47 files）+ 23 集成（6 files）** + `pnpm typecheck` + `pnpm lint` + `pnpm build` + `check:contract`(13/13 + 字段级 63 帧) + `pnpm package` + `verify:artifact -- --smoke` 全绿
**状态：** 三项全部落地并经 SDD 全分支最终 review（opus）PASS + 第三方验收 agent **3/3 达成**；仍标「已开发、未联调」（B-01 正式验收未通过——首次与二次真实联调均已执行 2026-08-13，P0/P1/RISK 修复完成，B-01 复跑 10 项需真实后端环境）

---

## 1. 批次概览

二次真实联调（Windows Electron + Ubuntu 后端，backend@88ee650）确认文本/工具/手动取消 happy path 已工作，但确认三个前端问题需修复后才能把 B-01 标记「已真实联调」。本批走完整 SDD 流程（spec→code-review 2 轮闭环→plan→code-review 2 轮闭环→subagent 逐任务实施→task review 逐任务闭环→全分支最终 review→验收 agent）：

```text
FE-INT2-P0-01 Renderer 水合编排 ─▶ FE-INT2-P1-01 replay 身份防御 ─▶ FE-INT2-P1-02 取消码统一
   (applyChatState + 启动代次守卫)      (schema 收紧 + 移除共享 fallback)    (GENERATION_CANCELLED + 取消终态)
```

**流程执行：** spec 经 code-review 2 轮闭环（事实核验 2 提案缺陷 + 覆盖 2 部分缺口 + 设计 2 typecheck 级缺陷 + 3 验收补强 + 复核 7/7 + 1 措辞精度，全整合 v3）；plan 经 code-review 2 轮闭环（可执行性实测 T1-T3 全流程 + 5 缺陷（mockApi onChatError/rest-mapper 私有 assemble/jsonl 单行/byId.get/双微任务冲刷）+ 覆盖 2 缺口 + 设计 3 修正 + 复核 9/9 + 1 任务边界，全整合 v2）；subagent 3 任务全部 TDD 实施 + task review 逐任务闭环（T1/T2/T3 各 Spec ✅/Quality ✅）；SDD 全分支最终 review（opus）PASS，无 Critical/Important，2 项 Minor 全部修复。

## 2. 交付详情

### 2.1 FE-INT2-P0-01：Renderer 启动水合编排（决策 D1）

| 项 | 内容 |
|---|---|
| 统一编排 | 新增 `renderer/src/bootstrap.ts`：`createRendererBootstrap(api, stores).register()`——`applyChatState` 统一消费 push 与启动 snapshot（setState + handleConnectionStateChange + connected 时 onConnected + onActiveConversationAppeared），非孤立 `refreshState()` |
| 启动水合 | `main.ts` 重构：setDesktopApi + createRendererBootstrap(...).register()；先注册 4 订阅（含 onChatError 补入 `DesktopApiLike`）再 `getConnectionState()` snapshot 经同一编排应用 |
| 竞态守卫 | `stateEpoch` 启动代次守卫：snapshot 等待期间收到 push → epoch 变 → 迟到 snapshot 丢弃（D1，不改 ConnectionState 契约） |
| 失败路径 | snapshot 拒绝 → setError(UNKNOWN)，不清凭据、不制造断开 |
| 验收 | connected/disconnected/竞态丢弃/拒绝 4 场景 + 订阅注册 5 用例（`renderer-bootstrap.spec.ts`，DI fake api/stores） |

### 2.2 FE-INT2-P1-01：replay 身份契约防御（决策 D2）

| 项 | 内容 |
|---|---|
| schema 收紧 | `RawSessionMessageItemSchema` 的 `message_id`/`timestamp` 改必填（`z.string().min(1)`）；TS 类型同步收紧 `RawSessionMessageItem`（raw-types）+ `MessageSource`（rest-mapper） |
| 无身份帧 | 缺字段使 session 帧 parse 失败 → `RAW_FRAME_INVALID` 协议错误（replay 不进 store），REST 首屏（activate→getMessages）恢复 |
| 移除 fallback | `rest-mapper.ts:49` 改 `messageId: src.message_id`，共享 `${convId}:replay` 主键彻底移除；不造随机 ID |
| fixture | 新增 `chat-replay-tool.jsonl`（user/assistant/tool 全形状 + 正式 `msg_*` ID + timestamp，单行 JSON）入 `NEW_FIXTURES`+`replayFixtures`；manifest verified:false+unverified；schemaHash 不变（指纹不下探嵌套元素，实测 96fc24c8 保持） |
| 验收 | 缺身份帧失败、两条 tool 不同 msg_* ID、无共享 key、两种到达顺序 byId 去重、两 tool_call_id 不碰撞（raw-schemas/rest-mapper/message.store spec） |

### 2.3 FE-INT2-P1-02：取消码统一（决策 D3）

| 项 | 内容 |
|---|---|
| 正式码 | `isCancellationCode(code)` 识别 `GENERATION_CANCELLED`（正式）+ legacy `CANCELLED`；不要求后端改码 |
| 取消终态 | `failAssistant`：取消 → `interrupted` + **不设 lastError**（用户取消不展示「发送失败」）+ 保留 partial；非取消（GENERATION_TIMEOUT）→ failed + lastError；`activeGenerationId` 清理保留（applyEvent 双保险）；迟到 delta/completed/failed 由守卫丢弃不复活 |
| fixture | `chat-cancelled.jsonl` code → `GENERATION_CANCELLED`（manifest 不动——schemaHash 未变、verified:false 保持） |
| 验收 | 7 用例（直接到达/交错时序/乐观 cancel 后到/partial 保留/迟到 completed 不复活/legacy 兼容/非取消错误） |

## 3. 关键决策汇总

本批三项决策由我按推荐定案（用户拍板「全修，按你推荐的来」）：**D1** P0-01 竞态守卫=启动代次 epoch 守卫（前端侧，不改 ConnectionState 契约）；**D2** P1-01 防御=严格契约收紧 + 移除共享 fallback（无身份帧协议错误由 REST 恢复，不造随机 ID）；**D3** P1-02 正式码=GENERATION_CANCELLED + legacy helper + 取消终态统一。

**review 修复轮补充：** spec 轮修复 2 typecheck 级缺陷（`DesktopApiLike` 类型路径/`onChatError` 缺失、TS 类型未同步收紧）+ 2 部分缺口（B-01 复跑 10 项补全、legacy mapper 记录未来）+ 3 验收补强（两种顺序去重、交错时序、断言同步）；plan 轮修复 5 缺陷（3 个既有 store spec mockApi 补 onChatError、rest-mapper 测试用公开 `toDomainMessageFromReplay`、jsonl 单行、`byId.value[messageId]` 非 `.get()`、reject 用例双微任务冲刷）+ 任务边界补全 + 过渡期降级记录；最终 review 修 2 Minor（状态行补二次联调记录、replay 身份过渡期降级入 README）。

## 4. 验收

**SDD 全分支最终 review（opus）：PASS。** 5 实现 commit 完整覆盖 spec §4.1-4.3 三项；独立压测 3 点（bootstrap 编排/epoch 守卫时序、replay 身份 schema 收紧+fallback 移除+fixture 映射、取消码双码+终态）全过；无 Critical/Important，2 项 Minor 全部修复。

**门禁实测（控制器复跑）：** typecheck ✅ / lint ✅ / **526 单测（47 files）** ✅ / **23 集成（6 files）** ✅（xvfb）/ build ✅ / check:contract **13/13 type + 字段级 63 帧** ✅ / package ✅ / **verify:artifact -- --smoke ✅**（本批动 renderer bootstrap + main，打包路径已复跑）。

**第三方验收 agent：3/3 达成。** FE-INT2-P0-01（§4.3 五条 + §4.4 八条）、FE-INT2-P1-01（§5.4 五条 + §5.5 七条）、FE-INT2-P1-02（§6.3 五条 + §6.4 七条）逐条源码核对（文件:行号证据），§9 自动化门禁实跑全绿，无未达成项。B-01 最小复跑 §8 全 10 项如实标注需真实后端环境执行（headless 沙箱不可实跑）。

## 5. 已知限制（记录，待后续批次/联调）

- **B-01 复跑 10 项 headless 不可本批实跑**：真实 Electron reload 恢复 / replay-REST 同 ID / 真实取消捕获等清单 §8 全 10 项，需 Windows Electron + Ubuntu 真实后端环境（backend@88ee650 修复后）执行。
- **replay 严格契约过渡期降级**：后端配套清单落地前，session 帧整帧拒收使 `activeConversationId` 失去 WS 来源 → **过渡期首次连接的活动会话需用户点击激活**（重连/已激活场景不受影响）；B-01 复跑 ⑤reload 恢复与 ⑥replay-REST 同 ID 依赖后端修复先落地。已写入 README「真实模式联调」。
- **指纹不下探嵌套元素**：`rawSchemasFingerprintFor` 只读顶层字段签名，数组元素级变更不被捕获（D2 收紧不重算 manifest）——既有指纹机制局限，记录不修。
- **取消码 legacy 兼容**：`CANCELLED` 保留于 helper；不要求后端改码。
- **工具结果 UI**：正式工具卡片留阶段 3；当前 tool role 落空 assistant 风格行。
- **B-01 正式验收未通过**：首次与二次真实联调均已执行（2026-08-13），P0/P1/RISK 问题修复完成，但 B-01 联调门禁（清单 §8 全 10 项）待真实后端环境到位后执行；仍标「已开发、未联调」。

## 6. 文档同步

- `README.md` / `CLAUDE.md` / `docs/16` 更新到二次联调整改批次落地状态（526 单测 + 23 集成 + check:contract 13/13 + 二次联调已执行 + replay 身份过渡期降级），保留「已开发、未联调」。
- `docs/superpowers/specs|plans/2026-08-13-realint2-fix-*` 为设计与实施文档。

---

**二次真实联调整改完成。** 三项整改全部落地并经 SDD 全分支最终 review PASS（526 单测 + 23 集成 + check:contract 13/13 + package + verify:artifact --smoke 全绿）+ 第三方验收 3/3。二次联调确认的 P0（Renderer 水合）与两个 P1（replay 身份、取消码）已关闭；下一步：后端配套清单修复落地后执行 B-01 最小复跑（清单 §8 全 10 项）+ 阶段 3 完整聊天/历史/多媒体。
