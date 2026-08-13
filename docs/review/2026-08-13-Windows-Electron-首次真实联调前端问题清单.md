# Electron v2 Windows 首次真实联调：前端问题清单

**日期：** 2026-08-13

**前端审查基线：** `/home/yomu/elysia-frontend` `main@0236a97b783c66b55c6a20aeb0511136f5d774d9`

**后端联调基线：** `/home/yomu/elysia-agent` `main@bd03c4178b61ced2470ca82f00f637af94212e97`

**联调拓扑：** Ubuntu 运行后端；Windows 运行 Electron；Electron DevTools CDP 仅通过回环隧道用于本次测试

**后端配套报告：** `/home/yomu/elysia-agent/docs/review/2026-08-13-Windows-Electron-首次真实联调后端问题清单.md`

**性质：** 本文记录真实联调后确认的前端问题和待决风险；本文不包含源码修复。

## 1. 结论

前端主链没有发现新的阻断性缺陷。Windows Electron 已真实通过：

- endpoint 配置、凭据读取、v2 认证握手和连接状态；
- 新会话创建/激活、文本乐观消息到 accepted ACK 的 key 迁移；
- `inner_voice` / `public_reply` 流式分段、完成态、模型、Token、情绪展示；
- 自动标题和新会话 REST 历史；
- 主动取消后的 `interrupted/已中断`，没有被迟到事件复活；
- 断开、重连、session replay 和 UI 恢复；
- 后端 `SESSION_PROTECTED` 等结构化错误的可见展示。

当前确认的前端代码问题只有一个：后端真实发送的 `state` / `typing` 帧被前端严格 raw schema 当作未知帧，持续记录 `RAW_FRAME_INVALID`。它目前不破坏聊天 UI，但会污染诊断信号并掩盖真正的协议漂移。

另有一个仅在故意接入第二个 WS 客户端时观察到的顺序风险。单 Electron 正常路径没有复现，是否修代码取决于产品是否支持同会话多客户端并发，因此本文将其列为“待复现/待契约决策”，不是本轮联调阻断项。

注意：旧 `default` 会话打不开的直接原因是后端归档工具消息 `message_id=""`。前端的非空校验是正确的，禁止通过放宽该校验来绕过后端缺陷。

## 2. 问题总表

| ID | 优先级 | 问题 | 直接影响 | 状态 |
|---|---:|---|---|---|
| FE-INT-P1-01 | P1 | `state` / `typing` 合法后端帧被记为 `RAW_FRAME_INVALID` | 诊断日志持续产生假阳性，真实协议错误更难识别 | 待修复，非聊天阻断 |
| FE-INT-RISK-01 | P2 / 风险 | 第二客户端向同会话发消息时，当前 Electron 可能先看到 assistant generation、看不到对应外部 user 消息 | 多客户端视图可能暂时出现因果顺序不完整 | 待复现、待范围决策 |

## 3. FE-INT-P1-01：`state` / `typing` 被误判为非法帧

### 3.1 真实联调证据

使用与 Electron 相同的 v2 请求头连接真实后端，捕获一轮纯文本请求的原始 WS 流：

- 共捕获 16 帧；
- `session`、`server_info`、`user_message.ack` 和 6 个 generation 相关帧等 12 帧通过前端 `parseRawFrame()`；
- 4 帧校验失败，恰好是 2 个 `state` 和 2 个 `typing`；
- 所有 generation 帧都成功映射为领域事件，聊天结果本身正确。

当前代码链：

1. [`raw-schemas.ts`](../../apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts) 的 `RawFrameSchema` 只包含 11 类帧，没有 `state` / `typing`；
2. [`raw-types.ts`](../../apps/desktop/src/main/transport/protocol-v2/raw-types.ts) 的 `RawFrame` 联合也没有这两类；
3. [`real-backend.ts`](../../apps/desktop/src/main/transport/real-backend.ts) 在 schema 失败时统一记录 `RAW_FRAME_INVALID / 帧校验失败`；
4. 后端的正式 wire 契约和输出通道均定义并发送 `StateMessage`、`TypingMessage`，所以它们不是随机未知帧。

### 3.2 影响

- 每轮生成都可能产生多条假协议告警；
- 诊断文件、开发控制台和未来告警指标被噪声占据；
- 真正的字段缺失、未知帧或协议漂移仍使用同一 `RAW_FRAME_INVALID`，排障时无法快速区分；
- 如果未来把协议告警升级为健康状态或上报指标，正常聊天会被错误计为异常。

当前没有证据表明这两类帧导致断连、丢 generation 或 UI 错误，因此优先级为 P1，而不是 P0。

### 3.3 建议修复

推荐把它们建模为“已知但当前有意忽略的兼容帧”，不要在 schema 之前按字符串特判跳过：

```ts
interface RawState {
  type: 'state'
  state: string
}

interface RawTyping {
  type: 'typing'
  typing: boolean
}
```

具体要求：

1. 在 raw types 和 Zod discriminated union 中加入严格 schema；
2. 在 `handleFrame()` 中显式 no-op，或在产品确实需要时映射到独立状态域；不要误映射成 generation 事件；
3. 合法 `state` / `typing` 不产生 `RAW_FRAME_INVALID`，字段类型错误的同名帧仍必须告警；
4. 未知帧仍 fail-closed 为 `RAW_FRAME_INVALID`，不能把整个 schema 改成 passthrough；
5. raw schema 指纹、manifest、wire fixtures 和 `check:contract` 的目标集合随实现同步更新，并记录为何从当前 11 类扩展；
6. 如果 renderer 暂时完全不消费这两个状态，明确写注释说明“契约识别 + 有意忽略”，避免后来开发者误删。

### 3.4 验收测试

- [ ] `parseRawFrame({type:'state', state:'thinking'})` 通过；
- [ ] `parseRawFrame({type:'typing', typing:true})` 通过；
- [ ] `state` 缺字段、`typing` 使用字符串等畸形载荷仍失败；
- [ ] `RealBackend` 收到合法两帧不 emit generation 事件、不报 protocol warning、不断连；
- [ ] 未知 `type` 仍报告 `RAW_FRAME_INVALID`；
- [ ] raw schema 单测、real-backend 单测、wire fixture、字段级契约深比较和 `check:contract` 通过；
- [ ] 对真实后端再跑一轮文本生成，诊断中不再出现由 `state` / `typing` 引起的 `RAW_FRAME_INVALID`。

## 4. FE-INT-RISK-01：同会话第二客户端的因果顺序

### 4.1 当前证据边界

本次为了抓取原始 v2 帧，在 Electron 保持连接时又建立了一个手工 WS 客户端，并让第二客户端向同一活动会话发送消息。此时 Electron UI 曾短暂出现 user/assistant 视觉顺序不自然。

但需要明确：

- 单 Electron 自己发送、接收、取消、重连的正常路径没有复现；
- 观察发生在刻意制造的双客户端场景；
- 当时还包含一次“生成忙时再次 activate”的错误帧，不能仅凭一次 UI 观察断言为稳定前端缺陷；
- 当前产品是否承诺多个客户端同时操作同一会话，尚未在本轮冻结。

因此这项不能直接按已确认 bug 修改排序算法，必须先做可重复实验和契约决策。

### 4.2 为什么前端可能出现该现象

当前 [`message.store.ts`](../../apps/desktop/src/renderer/src/stores/message.store.ts) 的顺序数组按消息首次 `upsert` 的到达顺序追加：

- 本 Electron 自己发送时，会先插入本地 optimistic user 消息，ACK 后迁移到服务端 ID；
- 其他客户端发送时，本 Electron 没有对应的本地 optimistic user 消息；
- 后端广播的 `generation.started` 足以让本 Electron立即创建 assistant 消息，但当前事件不携带可重建外部 user 消息所需的完整正文；
- 对应 user 消息通常要等下一次 REST 增量或 session replay 才进入本地 store。

这更像“多客户端事件契约缺少 user committed 广播”与前端到达序合并策略共同形成的跨层风险，单纯按本地时间重新排序不一定能恢复正确因果关系。

### 4.3 先决策，再实施

#### 若多客户端同会话不在当前产品范围

- 在联调/产品文档明确“单活动桌面客户端/单写者”约束；
- 前端对无法关联本地请求的 generation 可保留现状、记录低级别诊断，或按产品决定提示“来自其他客户端”；
- 不把本项纳入首次单客户端 B-01 阻断门禁。

#### 若必须支持多客户端同会话

需要前后端共同设计因果链，至少满足以下一种：

1. 后端在 `generation.started` 前广播带稳定 `messageId`、会话 ID 和正文的 user committed 事件；
2. generation 帧携带足够的触发 user message 引用，前端在渲染 assistant 前做可靠的 REST 增量补齐；
3. 提供会话级单调 sequence，前端按服务端顺序合并实时事件、optimistic 消息和 replay。

不要仅在前端用 `createdAt` 强行全量排序：客户端时钟、服务端时间和事件到达时间不是同一时钟，且当前 generation 事件并不提供对应 user 消息的完整排序锚点。

### 4.4 复现/验收矩阵

- [ ] 两个真实 v2 客户端连接同一会话，A、B 分别发送一条带唯一标记的消息；
- [ ] 记录两端原始帧、领域事件、store `order` 和最终 DOM 顺序；
- [ ] 重复发送、两端近同时发送、其中一端取消、其中一端断线重连；
- [ ] 若宣称支持多客户端，两端最终都保持每个 user 在其 assistant 之前，且 replay 后无重复、无重排跳动；
- [ ] 若不支持，第二写者必须有明确约束或可理解行为，不能静默展示一条没有对应 user 上下文的 assistant 回复。

## 5. 明确不是前端修复项的后端阻断

旧 `default` 会话的 REST 历史包含 `message_id=""` 的工具消息，前端因此抛出：

```text
[SCHEMA_VALIDATION_FAILED] 会话消息响应校验失败
```

以下前端改法均不可接受：

- 把 `RestMessageSchema.message_id` 从 `z.string().min(1)` 放宽为空字符串；
- 为每次 REST 响应随机生成 ID；
- 把所有空 ID 工具消息映射到同一个 fallback key；
- 丢弃坏消息后假装整页成功。

原因是 `messageId` 同时承担前端 `byId` 主键、去重、replay 合并和稳定排序职责。放宽后会把明确的契约失败变成更隐蔽的数据覆盖。该问题必须按后端配套报告修复新写入并稳定迁移历史数据。

## 6. 修复后门禁

前端本轮完成标准：

- [ ] FE-INT-P1-01 自动化与真实后端回归全部通过；
- [ ] `state` / `typing` 不再污染协议错误诊断，真正未知/畸形帧仍可见；
- [ ] `pnpm --filter @cyrene/desktop check:contract` 及项目既有测试、lint、typecheck 通过；
- [ ] 保持 REST `message_id` 非空校验不变；
- [ ] FE-INT-RISK-01 已完成范围决策；若当前不支持多客户端，文档化即可，不阻塞单客户端联调；
- [ ] 后端完成空 ID 修复后，Electron 可打开旧 `default`、执行新工具调用并在重连后稳定回放。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [首次联调封口问题修复报告](2026-08-13-首次联调封口问题修复报告.md) | 本次真实运行前的前端封口修复与自动化门禁 |
| [阶段 0/1 首次联调前复核清单](2026-08-11-阶段0与阶段1首次联调前复核整改清单.md) | 基础设施、IPC、安全、Mock 隔离与产物门禁 |
| [阶段 2 真实联调整改清单](2026-08-11-阶段2真实联调前端整改清单.md) | raw wire、领域映射、会话与流式 UI 的前置整改项 |
