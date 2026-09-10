# Cyrene 阶段 2 批次最终报告：核心聊天纵向闭环

**日期：** 2026-08-11
**批次：** 阶段 2 三块（2A 领域契约+raw wire / 2B RealBackend / 2C Store+IPC+UI）
**HEAD：** main（35 commits，dfb89ae..HEAD）
**验证基线：** **315 单测** + `pnpm typecheck` + `pnpm lint` + `pnpm build` 全绿
**状态：** 三块全部落地并全量验证；**「已开发、未联调」**（真实后端联调待 B-01）

---

## 1. 批次概览

阶段 2 目标「核心聊天纵向闭环」= 用真实后端 wire 打通「发送 → 流式 → 渲染」完整用户链路。三块按依赖序推进，每块走完整 SDD 流程（brainstorm → spec → code-review → plan → review → subagent 执行 → task review → 最终 whole-branch review → 文档同步 → 合并）：

```text
2A 领域契约+raw wire ──▶ 2B RealBackend(REST/WS) ──▶ 2C Store+IPC+UI
   (P0「回复为空」)        (真实连接/会话/历史)        (发送→流式→渲染)
```

**三块最终 review 结论：** 2A PASS；2B 需修复（F1-F7）已闭环；2C 需修复（P1-1~3 + P2）已闭环。无遗留阻塞项。

## 2. 交付详情

### 2.1 块 A：领域契约修复 + raw wire 层

**目标：** 修 P0「回复为空」——后端 `segment.completed.content` 权威文本被丢弃、delta 无 channel/kind、Token 结构不符。

| 项 | 内容 |
|---|---|
| 领域契约 | `GenerationSegmentStartedEvent` 新增（方案 A）；`SegmentCompletedEvent` 加 `kind/content?`（权威文本）；`GenerationCompletedEvent` 加 `messageId?/finishReason?` + `conversationUsage: ConversationTokenUsage`；`GenerationFailedEvent` 加 `retryable/details`；`TokenUsage.rounds?`；`ProtocolWarning` |
| raw wire 层 | `protocol-v2/raw-types`/`raw-schemas`（判别 `type` + `.strict()`）+ `frame-mapper`（status 过滤/fail-closed/告警/eventId·sequence 本地生成） |
| StreamAccumulator | 权威 content 规则（docs/18 §4.3 七条）+ `segment.started` 建段 + 迟到 delta 告警 |
| fixtures | `domain/`（领域，Mock 消费）+ `wire-v2/`（raw wire 4 场景 + manifest 锚定 `beeba577`）+ 两层校验 |
| 测试 | 231 单测（182 基线 + 49 新增）|

**关键决策：** zod 4.4.3 双参 record（单参推断 `Record<number,unknown>` 已废弃）；status 段 meta 保留（供迟到 delta 过滤）；`round_num` 用 `.nonnegative()`（后端 int 无下限）。

### 2.2 块 B：RealBackend REST/WS v2 Adapter

**目标：** 真实 REST + WebSocket v2 适配器，消费 2A 的 raw schema/FrameMapper，产出领域模型。

| 项 | 内容 |
|---|---|
| WS 连接 | `/ws` 握手 header 精确 `X-Protocol-Version: "2"`/`X-Client-Platform: electron`/Bearer；`server_info.protocol_version` 检查 `"2.0"`（fail-closed）；`session→server_info→expression` 处理 + 回放缓冲归属 |
| REST 映射 | `rest-types`/`rest-schemas`（混合命名 `message_id`/`_id` + strict）+ `rest-mapper`（`Message.tool?` 元数据、`_id` cursor 分页、回放项 mood→emotion） |
| 会话/历史 | list/get/create/rename/delete/activate + `getConversationMessages`（before 倒序归一化/after 正序）；`BackendAdapter` 接口扩展 |
| 发送/停止 | `sendMessage` → WS `text` + `user_message.ack` 关联（accepted/rejected/15s 超时）；`interrupt` |
| 心跳/重连 | 断线指数退避（1s×2 上限 30s，6 次 → error）+ `unexpected-response` 400/401/403 fail-fast、429/503 瞬态重连 |
| 测试 | 265 单测（+34：rest-schemas/rest-mapper/real-backend）|

**关键决策：** 握手两层取值（请求头 `"2"` / wire `"2.0"`）；`chat:replay` 通道承载 `onSessionReplay`（2C 定方案 a）；告警码收编 `ProtocolWarningCode`；`disconnect()` reject 挂起 connect；版本不符关 socket。

### 2.3 块 C：Store + IPC 事件推送 + 聊天 UI

**目标：** 打通「发送 → 流式 → 渲染」，Renderer 从静态壳到动态聊天。

| 项 | 内容 |
|---|---|
| IPC 事件通道 | `chat:event`（领域 BackendEvent）/`chat:state`（ConnectionState）/`chat:replay`（onSessionReplay 回放）+ `ipcMain.handle` chat 命令（IpcResult 信封 + request schema，response `z.unknown()` P0） |
| desktopApi | chat 11 方法 + 3 订阅（`parseBackendEvent`/类型守卫 + 取消函数 + unwrap 信封）+ `index.d.ts` 类型 |
| Pinia 三 store | `connectionStore`（状态 push）/`conversationStore`（列表/激活/历史 cursor）/`messageStore`（StreamAccumulator 流式应用 + 乐观发送 + cancel 乐观 `interrupted` + 断线处理 + `loadReplay`） |
| UI | `CyMarkdown`（marked + entity 归一化消毒）/`CyMessageBubble`（双通道折叠 + Token·模型·心情 chips + failed 角标）/`CyChatInput`（IME 守卫 + 停止 + 失败横幅）/`CyChatView`（空态/流式占位/断线横幅/连接控件）/`CyConversationList` |
| 对 2B 加性修改 | `ConnectionState` 迁 shared、`getConnectionState`、`onConnectionStateChange`、`MessageStatus.completing` |
| 测试 | 315 单测（+46）|

**关键决策：** token 不经 Renderer（Main 读凭据存储，`requireToken` 控制 mock 免 token）；`setDesktopApi` 注入机制；`chat:state` 定死 push 不轮询；`chat:replay` 生产侧接线（`onSessionReplay→pushReplay`）。

## 3. 关键中途决策汇总（跨块）

1. **zod 4.4.3 双参 record**：单参 `z.record(value)` 推断 `Record<number,unknown>` 已废弃 → 全部双参（2A/2B）。
2. **status 段 meta 保留**：completed 后保留 meta 供迟到 delta 过滤返回 null（普通段清理）。
3. **`server_info.protocol_version` 检查 `"2.0"`**：请求头 `"2"` 是 `TRANSPORT_VERSION`，wire 是 `PROTOCOL_VERSION`——两层取值。
4. **`chat:replay` 通道**：`onSessionReplay`（重连回放核心数据路径）经第三推送通道到 `loadReplay`。
5. **对 2B 加性修改**：`ConnectionState`/`ConnectionStatus` 迁 `shared/contracts/backend.ts`（preload/renderer 共享类型）、`BackendAdapter.getConnectionState`、`RealBackendOptions.onConnectionStateChange`、`MessageStatus.completing`。
6. **token 安全**：`chat:connect` 由 Main 读 `BACKEND_TOKEN_KEY`（safeStorage），Renderer 只传 serverUrl；`getToken` 为 async（`CredentialStore.getCredential`）。
7. **markdown 消毒**：`marked` + scoped sanitize（危险标签/`on*`/协议剥离 + entity 归一化防嵌套编码 + unquoted 分支）；CSP `script-src 'self'` 为第一道防线。
8. **response schema `z.unknown()`**（P0）：不新建领域响应 schema，阶段 7 安全收敛统一细化。
9. **`renameConversation` 单对象载荷**：IPC registry arity 约束。
10. **`messageStore` 断线/取消终态**：`cancel()` 乐观置 `interrupted`（`generation.failed{CANCELLED}` 幂等不降级）；断线且 in-flight → interrupted；迟到同代事件（`activeGenerationId` 守卫）丢弃防复活。

## 4. 批次验收（对照 doc 16 阶段 2 验收门槛）

| 验收项 | 状态 |
|---|---|
| 使用真实后端完成「新建会话 → 发送 → 流式回复」 | **未联调**（B-01 未到位；Mock 驱动全链路已打通，标「已开发、未联调」） |
| 同一回复只显示一组头像、时间与操作区 | ✅ 领域模型单一父消息 + UI 按消息渲染 |
| 分段完成不提前结束父回复（只有 `generation.completed` 结束） | ✅ 2A Accumulator 七条规则 + 2C store 终态 |
| 重复、乱序与迟到增量不产生重复或污染 | ✅ 2A deltaSequence/缺口缓冲 + 权威 content 覆盖 + 2C generationId 守卫 |
| 停止与断线保留已生成内容 | ✅ cancel 乐观 interrupted 保留；断线 in-flight → interrupted 保留已提交段 |
| Inner Voice 缺失时不显示空区域 | ✅ `toAssistantSegments` 过滤空段 + 消息级流式占位 |
| UI 组件不引用后端原始字段 | ✅ store 消费领域 `BackendEvent`/`Message`，UI 只读 store |

**工程验收：** 315 单测 + typecheck + lint + build 全绿；三块每块 1 spec + 1 plan 文档提交；每块最终 whole-branch review 闭环；doc 16/18/06 同步。

## 5. 剩余外部输入（阻塞真实联调/后续阶段）

| ID | 项 | 影响 |
|---|---|---|
| **B-01** | 真实后端测试环境（地址/端口/Token） | **阶段 2 联调前提**——三块全部「已开发、未联调」；联调时以实际部署 SHA 更新 `wire-v2` manifest 与断言 |
| G-01/G-02 | Live2D SDK 许可 + 模型（阶段 5） | 外部输入 |
| H-01 | 主验收平台（建议 Windows 11 x64） | 阶段 8 |
| H-04 | Windows 签名证书 + Linux 包格式 | 阶段 8 |

## 6. 已知限制（记录于各块 spec §10 / ledger）

- **`chat:replay`**：生产侧已接线（P1-1 修复），但 RealBackend 路径未经真实联调验证（B-01 后验证）。
- **response schema `z.unknown()`**：响应数据形状不校验，阶段 7 收紧（`unwrap` 也需同步加数据守卫）。
- **`interrupt` 非定向**：后端无 generationId，`cancelGeneration` 的 generationId 仅日志关联。
- **Markdown scoped 消毒器**：非 DOM 级净化（DOMPurify 留待按需），CSP 兜底；`java&#x09;script:` 等制表符编码靠 CSP。
- **多代并发**：单 accumulator 设计，前代 in-flight 时新 `generation.started` 弃置旧代（P0 可接受，真实串行生成）。
- **组件无单测**：UI 逻辑由 store 单测兜底，视觉/交互留阶段 3 E2E（Playwright）。

## 7. 后续建议

1. **手动 push**：本地领先 origin/main 较多（阶段 2 共 35 commits），remote 无凭据，需用户手动 push。
2. **真实联调**（B-01 到位后）：三块 Adapter/领域层经真实后端验证，更新 manifest/断言；`CYRENE_BACKEND=real` 切换 RealBackend（已接线）。
3. **下一步阶段 3**：完整聊天/历史/多媒体（历史查看器、附件上传、搜索、代码复制、代码高亮）——或先联调。
4. **阶段 7 收口**：response schema 细化、`unwrap` 数据守卫、Markdown 净化升级、IPC 攻击面集成测试扩展（白名单已更新为 18 键）。

---

**批次完成。** 阶段 2 三块（A/B/C）全部落地，315 单测全绿，完整链路打通（Mock 驱动），真实联调待 B-01。
