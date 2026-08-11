# Cyrene 阶段 2 真实联调整改·批次 B 最终报告：真实连接编排

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段2真实联调前端整改清单.md` 批次 B（FE-P1-03 / FE-P1-04 / FE-P1-05 / FE-P2-01）
**HEAD：** main（spec 5c9e21f、plan a2ca1b3、实现 59753f1..739408d 共 10 commits、F1 修复 ab17294、文档 107bd20 + F2 补录）
**验证基线：** **400 单测（40 files）+ 22 集成（5 files）** + `pnpm typecheck` + `pnpm lint` + `pnpm build` 全绿
**状态：** 四项全部落地并经 SDD 全分支最终 review（opus）PASS；仍标「已开发、未联调」（B-01 到位后进入真实联调）

---

## 1. 批次概览

批次 A 解决连接入口与 ACK 错误路径后，批次 B 处理连接成功后的编排与运行时健壮性。第三方 review 指出四类问题（会话初始化时序 / 会话切换守卫 / 错误链 / 超时门控），按整改清单批次 B 全部处理，每项走完整 SDD 流程（spec→code-review 3 轮闭环→plan→code-review 2 轮闭环→subagent 逐任务实施→task review→全分支最终 review）：

```text
FE-P1-03 连接后会话初始化 ─▶ FE-P1-04 conversation/epoch 守卫 ─▶ FE-P1-05 可见错误链与脱敏日志 ─▶ FE-P2-01 超时·取消·门控
   (replay/list 时序一致)         (切会话不串台/迟到事件不污染)        (错误可见可追踪/非法帧只进脱敏)     (握手/REST 不悬挂/未就绪禁操作)
```

**流程执行：** spec 经 code-review 3 轮（整改覆盖 7 findings + 设计一致性 12 findings + 复查 3 新问题 N1/N2/N3 + 4 minor），32 findings 全整合（v3）；plan 经 code-review 2 轮（可执行性审查 2 critical/6 important/5 minor + 接口核验 8 findings），21 findings 全整合（v3）；subagent 10 任务全部 TDD 实施 + task review 逐任务闭环；SDD 全分支最终 review（opus）PASS，1 Important（F1 conversationStore.error 只写不清）已修复 + 8 minor 按 triage 记录。

## 2. 交付详情

### 2.1 FE-P1-03：连接后会话初始化时序

| 项 | 内容 |
|---|---|
| 编排方 | renderer 装配层（`main.ts` onChatState connected → `conversationStore.onConnected(connectionId)`） |
| `onConnected` | 幂等（同 connectionId / Mock 无 connectionId 只初始化一次）；重连分支（有 currentId）只 safeList + reconcile 活动会话；首连分支 safeList → `ready` 置位 → 同步 activeId 激活 |
| replay/list 时序 | `messageStore.pendingReplay` 纯缓冲 + `onActiveConversationAppeared` 活动会话晚到补激活（`server_info` 先 connected、session 帧后到）：三种时序（list 先 / replay 先 / activeConversationId 晚于决策）结果一致且历史完整 |
| 就绪门控 | `ready` 在 safeList 完成后置位（不依赖 activate，避免晚到时序卡死）；空后端 currentId 留空显示空态 |
| 挂载策略 | 移除 `CyConversationList` onMounted 无条件 `list()`（未连接不再产生 unhandled Promise） |

### 2.2 FE-P1-04：conversation/epoch 守卫

| 项 | 内容 |
|---|---|
| 归属守卫 | `generationByConversation`（generationId→conversationId）表：`generation.started`（唯一带 conversationId）校验并记录；中间事件（delta/segment/completed/failed 无 conversationId）查表判归属，非当前会话丢弃 + `guardDropEvent`（console.warn + 计数，不记正文） |
| replay 守卫 | `loadReplay` 校验 currentId：匹配合并 / 未设纯缓冲 / 不匹配丢弃；`applyPendingReplay` 无论匹配与否清空（防残留） |
| activate epoch | 模块级递增数字，最新请求才提交 currentId/历史/error；迟到响应不覆盖快切换 |
| send ack 竞态 | `migrateKey` 开头守卫：乐观消息已被切会话清掉则不重插 |
| 断线清理 | `handleConnectionStateChange` 断线分支清理 `local-*` pending 用户消息（防重连后同消息渲染两次），插在 in-flight 早退之前 |

### 2.3 FE-P1-05：可见错误链、协议告警与脱敏日志

| 项 | 内容 |
|---|---|
| `onProtocolWarning` | Main 接 `diagnostics.logger` **warn 级**：固定 code + sanitize(message) + mode + serverVersion/protocolVersion；不记聊天正文/Token/原始整帧 |
| `onError` | Main `logger.error`（sanitize）+ 新 `PushChannels.error`（chat:error）推送 renderer；`extractPublic` 从 details 提取 backendCode/retryable/requestId（兼容 `backendCode` 与 `code` 两种写法） |
| renderer 消费 | `connectionStore.error` 结构化展示（连接失败保持 error 态不再回 disconnected）；`setState` connected/reconnecting 清 error；CyConnectionPanel + CyChatInput banner 展示 |
| 限流口径 | 429/RATE_LIMITED 走重连退避 + 「重连中」提示，不新增 `RATE_LIMITED` 领域码（避免码扩散） |

### 2.4 FE-P2-01：超时、取消与门控

| 项 | 内容 |
|---|---|
| 握手超时 | `handshakeTimeoutMs` 默认 10s（可注入）：用户 connect() 超时 fail-fast error；自动重连超时走退避；connect() 开头清旧 reconnect/handshake timer（防双 socket） |
| REST 超时 | `restTimeoutMs` 默认 10s + AbortController：超时→`TIMEOUT`；**disconnect 主动 abort→`NOT_CONNECTED`**（不误报超时） |
| 取消 | disconnect 遍历 `activeControllers` abort + 清握手/重连 timer；`setEndpoint` endpoint 变化联动 `adapter.disconnect()`（旧 WS/REST 取消） |
| 门控 | `canSend` = connected && ready；会话管理按钮 = connected && ready && !busy（busy 防重复）；无离线队列（断线禁用发送） |

## 3. 关键决策汇总（spec §6，D1–D24）

1. **D1 消息内存策略（用户拍板）**：单会话全局 byId/order，切换清空重建（选项 A；按 conversation 分桶留阶段 3）。
2. **D2 初始化编排方**：renderer 装配层（Main 不拥有 Vue UI 状态）。
3. **D3 onMounted 策略**：移除无条件 list，统一由连接成功初始化。
4. **D4 replay/list 时序**：pendingReplay 纯缓冲 + onActiveConversationAppeared 晚到补激活。
5. **D5 非当前会话事件**：丢弃 + renderer 协议告警（不记正文）。
6. **D6 epoch 机制**：递增数字（IPC 无法真正取消，renderer 防呆）。
7. **D7 generation 中间事件归属**：generationByConversation 映射表（events.ts 只有 started 带 conversationId）。
8. **D8 onProtocolWarning**：logger warn 级，固定 code + 帧信息 + mode + build，经 sanitize。
9. **D9 onError 路由**：logger error + chat:error 推送 → connectionStore.error。
10. **D10 超时常量**：握手 10s / REST 10s（可注入）；ACK 15s 已有。
11. **D11 门控范围**：canSend 加 connected；会话管理按钮未连接禁用；store 吞错进 error。
12. **D12 离线队列**：不实现队列，断线发送禁用。
13. **D13 初始化就绪门控**：ready 全流程完成才 true；门控 = connected && ready。
14. **D14 setEndpoint 联动取消**：endpoint（origin/baseUrl）变化先 adapter.disconnect()。
15. **D15 活动会话晚到补激活**：onActiveConversationAppeared 补 activate（替代初版 C1 自足，解决 pendingReplay 孤儿 + 不引入 ready 死锁 + 保证历史完整）。
16. **D16 send ack 竞态守卫**：migrateKey 旧 key 已清不重插。
17. **D17 disconnect abort 语义**：aborted && disconnected → NOT_CONNECTED，否则 TIMEOUT。
18. **D18 重连 reconcile**：重连分支比较 currentId 与 activeConversationId，不一致切过去。
19. **D19 断线清理 local-***：handleConnectionStateChange 清理 pending 乐观消息。
20. **D20 限流口径**：429 走重连退避，不新增领域码。
21. **D21 renderer 丢弃事件取舍**：console.warn + 计数，不进 Main 脱敏日志（领域守卫非协议层）。
22. **D22 会话操作 busy**：操作期间置位，按钮禁用防重复。
23. **D23 重连握手超时**：自动重连 10s/次最坏 ~60s 到 error，接受（有「重连中」提示）。
24. **D24 应用退出取消 in-flight**：不做进程级强制（进程退出即回收），显式列为已决策推迟。

## 4. 验收

**SDD 全分支最终 review（opus）：PASS。** 四项 FE 整改实现完整、跨层一致、无 Critical；独立复跑受影响单测 + typecheck 通过。唯一 Important（F1 conversationStore.error 只写不清）已修复（ab17294）并复查确认。

**门禁实测：** typecheck ✅ / lint ✅ / **400 单测（40 files）** ✅ / **22 集成（5 files）** ✅ / build ✅。

第三方按整改清单批次 B 的验收见后续独立验收报告（docs/superpowers/2026-08-12-phase2-realconn-batchB-acceptance.md）。

## 5. 已知限制（记录，待后续批次/联调）

- **重连 reconcile 竞态（F2，低概率）**：`activeConversationId` 晚于 safeList 到达时重连分支可能跳过 reconcile，无重试；记录为已知限制。
- **chat:error 推送携带未 sanitize 的原始 message（F3）**：logger 侧已 sanitize，push 侧为原始值（匹配 spec §4.3.1）；若后端 error message 回声正文/Token 会透传 UI 不落日志，联调前评估。
- **connect() 覆盖旧 socket 不 close（F4，既有模式）**：自动重连挂起时手动 connect 可能遗留孤儿 socket，其迟到 close/error 可砸状态；触发窗口窄，无数据损坏。
- **disconnect timer 断言强度不足（F5）**：real-backend 测试不等待越过超时截止点观测 timer 清除；实现正确，测试可加强。
- **remove 与 epoch 不协调（超范围遗留）**：删除激活会话期间 in-flight activate 迟到响应可能重插孤儿消息；UI busy 门控下实际难触发。
- **门控 computed 无单测（M5）**：canSend/canAct 为组件逻辑，验收以集成断言/人工兜底。
- **批次 C 待推进**：FE-P2-02 IPC/replay 运行时 Schema、FE-P2-03 夹具跨仓库、FE-P2-04 文档漂移。

## 6. 文档同步

- `docs/16` 变更记录追加批次 B 完整描述（四项 FE + 决策摘要 + 已知限制 + M5 门控说明）；头部状态与阶段视图更新（399 单测 + 22 集成）。
- `README.md` 状态行更新为「阶段 2 三块 + 批次 A/B 已落地」。
- 仍标「已开发、未联调」——B-01 真实环境到位后按 README「真实模式联调」小节进入联调。

---

**批次 B 完成。** 四项整改全部落地并经 SDD 全分支最终 review PASS（400 单测 + 22 集成 + typecheck/lint/build 全绿）。下一步：批次 C（IPC/replay Schema / 夹具跨仓库 / 文档漂移），随后 B-01 真实联调。
