# Electron v2 Windows 二次真实联调：前端整改清单

**日期：** 2026-08-13

**前端联调基线：** `/home/yomu/elysia-frontend` `main@db6d127616e840b90d8ab45a76608d215aa9604f`

**后端联调基线：** `/home/yomu/elysia-agent` `main@88ee650125db681b2289296dbaf8551a1c44fb56`

**Windows 运行时：** Electron 43.3.0 / Chrome 150.0.7871.212；Renderer `http://localhost:5173/`

**联调拓扑：** Ubuntu 运行后端；Windows 运行 Electron；Windows 通过本地端口转发访问后端

**复现会话：** `conv_036c872c7c55`（`B-01 修复后回归 2026-08-13 2c7c55`）

**后端配套清单：** `/home/yomu/elysia-agent/docs/review/2026-08-13-Windows-Electron-二次真实联调后端整改清单.md`

**交接范围：** 本文只要求修改前端仓库。后端 WS replay 漏发工具消息身份字段的问题见后端配套清单。

## 1. 结论

这轮真实联调确认以下主链已经工作：

- Windows Electron 与 Ubuntu 后端认证、握手和连接；
- 旧 `default` 会话历史读取，50 条消息 ID 非空且无重复；
- 新建/激活会话；
- 纯文本发送、accepted ACK、双通道回复和 completed；
- 真实 `get_time` 工具调用；
- 主动停止生成，最终显示 `interrupted`；
- 手动断开、重新连接和活动会话恢复。

但二次联调又确认了三个前端问题：

1. Renderer reload 后没有从仍在运行的 Main 主动恢复连接状态和活动会话；
2. replay 缺失身份字段时，fallback 主键会碰撞，并会与随后到达的 REST 正式消息形成重复；
3. 前端把取消码写成 `CANCELLED`，真实后端和正式契约使用 `GENERATION_CANCELLED`。

因此当前准确口径是：

> 文本、工具和手动取消 happy path 已可用，但刷新/恢复和取消终态仍有确定缺陷。完成本文与后端配套清单并复跑恢复链路后，才能把 B-01 标记为“已真实联调通过”。

## 2. 问题总表

| ID | 优先级 | 问题 | 直接影响 | 状态 |
|---|---:|---|---|---|
| FE-INT2-P0-01 | P0 | Renderer 启动时不水合 Main 当前连接状态 | Renderer reload/HMR/崩溃恢复后界面错误显示未连接、无会话，必须手工断开重连 | 待修复，阻断 B-01 封口 |
| FE-INT2-P1-01 | P1 / 跨层 | replay 缺 ID 时统一 fallback 为 `${conversationId}:replay` | 多条消息互相覆盖；同一工具结果再经 REST 到达时重复 | 待修复；后端补正式 ID 是主修，前端补防御 |
| FE-INT2-P1-02 | P1 | 取消终态只识别 `CANCELLED`，不识别 `GENERATION_CANCELLED` | 不同事件时序下可能错误标为 failed，并残留“发送失败”横幅 | 待修复，纳入 B-01 取消回归 |

## 3. 已通过的真实链路

### 3.1 连接和健康状态

- Electron 显示 `REAL`、后端版本 `0.1.0+88ee650`、协议 `2.0`；
- 后端 `/health` 正常；
- `/ready` 返回 `chatReady=true`、`fullReady=true`；
- Mongo、Milvus 和幂等依赖均 ready。

### 3.2 纯文本

请求：

```text
【B-01 修复后文本回归】请不要调用任何工具，只回复：B-01 修复后文本联调成功
```

结果：

```text
B-01 修复后文本联调成功
```

generation `gen_21769f343a884a6aaa9f7eb2f0` 完整收到 started、双通道 segment 和 completed；REST 中 user / assistant ID 正常。

### 3.3 真实工具调用

`get_time` 实际执行成功：

```text
tool_call_id = call_00_8TBYMy3a8SKsXlHnVjgX8457
message_id   = msg_7c0c72b0a8ef42ad942d4f8237
content      = 2026-08-13 21:15:31 CST
```

最终公开回复正常显示。

### 3.4 主动取消

长文本生成 `gen_c3b39f0752c64bafbfbce2b8fe` 被真实点击“停止生成”：

- 后端发出 `generation.failed / GENERATION_CANCELLED`；
- 前端本轮最终状态为 `interrupted`；
- 停止按钮消失；
- 连接保持正常；
- 没有 completed 将已中断消息复活。

本轮之所以表现正确，是乐观取消和迟到事件守卫命中了有利时序；第 6 节说明为什么代码仍需修复。

## 4. FE-INT2-P0-01：Renderer reload 不恢复 Main 状态

### 4.1 真实复现

前置状态：

- Main 中 Adapter 已连接；
- 活动会话为 `conv_036c872c7c55`；
- 文本和工具调用已经完成；
- UI 正常显示“已连接”。

只 reload Renderer，不退出 Electron Main。reload 后：

```text
window.desktopApi.getConnectionState()
→ status = connected
→ activeConversationId = conv_036c872c7c55
```

但界面同时显示：

```text
暂无会话
未连接
新会话,开始对话
```

随后调用真实 `disconnect()` 再 `connect()`，Main 产生新的状态 push，界面才恢复。这证明后端和 Main 没有丢连接，丢失的是新 Renderer 的 Pinia 状态。

### 4.2 根因

[`apps/desktop/src/renderer/src/main.ts`](../../apps/desktop/src/renderer/src/main.ts) 只注册未来事件：

```ts
onChatEvent
onChatState
onChatReplay
onChatError
```

注册完成后没有读取 Main 当前状态。Renderer 创建新的 Pinia 时，`connectionStore.state` 默认是：

```ts
{ status: 'disconnected' }
```

Main 已经在 reload 前发出的 `connected` push 不会重放给新 Renderer。

[`connection.store.ts`](../../apps/desktop/src/renderer/src/stores/connection.store.ts) 虽然存在 `refreshState()`，但生产启动路径没有调用。并且仅调用当前实现的 `refreshState()` 仍不完整：它只覆盖 `connectionStore.state`，没有执行原 `onChatState` 回调中的：

- `messageStore.handleConnectionStateChange(s)`；
- `conversationStore.onConnected(s.connectionId)`；
- `conversationStore.onActiveConversationAppeared(s.activeConversationId)`。

所以不能只在 `main.ts` 随手加一行 `void connectionStore.refreshState()` 就视为完整修复。

### 4.3 必须修改

1. 把 push 和启动 snapshot 的状态消费收敛为同一个编排函数，例如 `applyChatState(s)`；该函数统一负责：

   - `connectionStore.setState(s)`；
   - `messageStore.handleConnectionStateChange(s)`；
   - connected 时初始化会话列表；
   - 恢复活动会话并拉取首屏历史。

2. Renderer 启动时先注册订阅，再调用 `getConnectionState()` 获取 Main 当前 snapshot，并通过同一个编排函数应用。
3. 处理 snapshot 与实时 push 的竞态：若请求期间已经收到更新的 push，迟到 snapshot 不得把新状态覆盖回旧状态。当前 `ConnectionState` 无 sequence，可用“订阅后是否收到过 push”的启动代次守卫，或在 Main 增加可比较的状态版本。
4. snapshot 获取失败要进入公开错误/诊断路径，但不得自动清除 Main 凭据或制造断开操作。
5. 正常 Renderer reload 不应主动 `disconnect/connect`；Main 连接、connectionId 和后端活动会话应原样保留。

### 4.4 验收测试

- [ ] Main 在 Renderer 创建前已经 connected，新 Renderer 启动后自动显示 connected；
- [ ] connected snapshot 触发 list → active conversation → replay/REST 首屏完整初始化；
- [ ] disconnected snapshot 不制造假 connected；
- [ ] snapshot 等待期间收到 reconnecting/connected/error push，迟到 snapshot 不覆盖新状态；
- [ ] Renderer reload 后无需点“断开/连接”，会话和历史自动恢复；
- [ ] reload 不创建第二条 WS 连接、不更换 Main 当前 connectionId；
- [ ] 普通首次启动和用户主动连接路径无回归；
- [ ] 为 Renderer bootstrap 编排增加可自动执行的单测或集成测试，不能只测孤立的 `refreshState()`。

## 5. FE-INT2-P1-01：replay fallback 身份碰撞与重复

### 5.1 真实运行时证据

重连后，同一条 `get_time` 工具结果在 Pinia 中出现两次：

| 来源 | messageId | createdAt | tool.callId |
|---|---|---|---|
| WS session replay | `conv_036c872c7c55:replay` | 空字符串 | `call_00_8TBYMy3a8SKsXlHnVjgX8457` |
| REST 首屏 | `msg_7c0c72b0a8ef42ad942d4f8237` | `2026-08-13T13:15:31.557518+00:00` | 同上 |

两条记录的 tool 名、内容、成功状态和 callId 相同。后端 REST 历史是 6 条，前端 store 是 7 条。

当前 UI 尚未实现正式工具卡片，tool role 会落成空的 assistant 风格行，所以重复表现为额外的空 `Cyrene · completed` 消息，而不是工具正文重复。

### 5.2 后端主因

后端 WS replay 的 tool item 漏发 `message_id/timestamp`。该主因必须按后端配套清单修复。前端不能通过随机生成 ID 掩盖后端契约缺口。

### 5.3 前端缺陷

[`rest-mapper.ts`](../../apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts) 当前使用：

```ts
messageId: src.message_id ?? `${convId}:${src.timestamp ?? 'replay'}`
```

当 `message_id` 和 `timestamp` 都缺失时，同一会话所有这类消息都会变成：

```text
<conversationId>:replay
```

其后果有两种：

1. 多条缺身份 replay 消息在 `byId` 中互相覆盖；
2. replay fallback 与稍后 REST 正式 ID 不同，同一逻辑消息保留两份。

注释称该 fallback 为“缺省可复现本地 id”，但“每次得到同一个字符串”只满足可复现，不满足消息级唯一性和跨来源一致性。

### 5.4 必须修改

后端修复落地后，推荐同步收紧前端 v2 replay 边界：

1. `RawSessionMessageItem` / Zod schema 对持久化 user、assistant、tool 消息要求非空 `message_id/timestamp`；
2. 无身份项按协议错误处理并记录不含正文的安全诊断，不再进入 store；
3. `RestMapper` 的正式 v2 路径不得继续使用共享的 `${convId}:replay` 主键；
4. 如果产品必须保留 legacy replay 兼容，应建立显式 legacy mapper：

   - tool 至少使用稳定 `tool_call_id` 作为派生输入；
   - 不使用随机 ID；
   - 无法构造唯一稳定身份时宁可丢弃单条并告警，不得让多条消息共享同一 key；
   - 后续 REST 正式消息到达时，应按明确的 legacy identity 迁移/替换 fallback，而不是并存。

5. 后端字段修复和前端 schema 收紧应由字段级跨仓契约门禁共同守住。

前端防御不能替代后端正式 ID；双方都完成后，正常 v2 流不应实际走 legacy fallback。

### 5.5 验收测试

- [ ] 含两条 tool 结果的合法 replay 使用两个正式、不同的 `msg_*` ID；
- [ ] replay 与 REST 先后以相同 ID 到达，store 最终只有一条逻辑消息；
- [ ] replay 先到、REST 后到和 REST 先到、replay 后到两种顺序都去重；
- [ ] 缺 ID/timestamp 的 v2 tool item 不会生成共享 `<conversationId>:replay` key；
- [ ] legacy 兼容若保留，两条不同 `tool_call_id` 不碰撞，同一条重复 replay ID 稳定；
- [ ] DOM 不再因同一工具结果出现额外空消息行；
- [ ] fixture 必须覆盖真实后端 tool replay 形状，不能只覆盖 user/assistant。

## 6. FE-INT2-P1-02：取消错误码与真实契约不一致

### 6.1 真实证据

本次主动取消收到：

```text
type         = generation.failed
generationId = gen_c3b39f0752c64bafbfbce2b8fe
code         = GENERATION_CANCELLED
retryable    = false
```

这是后端 `frontend_contract/errors.py` 和 WS 契约中使用的正式稳定码。

前端 [`message.store.ts`](../../apps/desktop/src/renderer/src/stores/message.store.ts) 当前只识别：

```ts
event.error.code === 'CANCELLED'
```

而前端 [`chat-cancelled.jsonl`](../../apps/desktop/src/main/fixtures/wire-v2/chat-cancelled.jsonl) 也使用了并非真实 wire 的 `CANCELLED`，所以 Mock/fixture 测试无法发现差异。

### 6.2 为什么本次 UI 仍然正确

`cancel()` 会乐观把消息设为 `interrupted` 并清空 `activeGenerationId`。本轮后端 failed 事件到达时，迟到事件守卫没有再处理该事件，所以最终 UI 正确。

但以下时序仍有风险：

1. `GENERATION_CANCELLED` 在 cancel IPC Promise 返回前被消费；
2. 由后端或断线语义触发取消，而不是先走本地乐观 cancel；
3. 后续重构改变 cancel reply 与 WS failed 的先后顺序。

此时 `failAssistant()` 会把正式取消码当作普通失败：

- 消息先进入 `failed`；
- `lastError` 被设置；
- 即使随后乐观逻辑改回 `interrupted`，错误横幅仍可能残留。

此外当前函数即便遇到它所识别的 `CANCELLED`，仍会无条件写 `lastError`，与用户主动取消不应展示“发送失败”的 UX 不一致。

### 6.3 必须修改

1. 以 `GENERATION_CANCELLED` 为正式取消码。
2. 如确实需要兼容旧 fixture/旧后端，可以集中定义 helper 同时识别 `GENERATION_CANCELLED` 和 legacy `CANCELLED`，但不能继续只识别后者。
3. 取消终态统一处理为：

   - assistant status = `interrupted`；
   - 清理 active generation；
   - 保留已经收到的 partial segments；
   - 不设置普通发送失败 `lastError`；
   - 迟到 delta/completed/failed 不得复活或降级状态。

4. 把 `chat-cancelled.jsonl` 更新为真实 `GENERATION_CANCELLED` 并同步相关断言；若用本次真实帧替换占位 trace，再据实更新 manifest 的 `backendCommit/verified`。只有 raw schema 本身发生变化时才重算 `schemaHash`。
5. 不要求后端把正式错误码改成 `CANCELLED`。

### 6.4 验收测试

- [ ] `generation.failed{code:GENERATION_CANCELLED}` 直接到达时，消息为 interrupted 且无错误横幅；
- [ ] failed 在 cancel IPC resolve 前到达，最终仍为 interrupted 且无 `lastError`；
- [ ] 本地乐观 cancel 先完成、failed 后到，状态不变且无错误横幅；
- [ ] 已收到的 partial segments 在取消后保留；
- [ ] 迟到 completed 不把 interrupted 改回 completed；
- [ ] `GENERATION_TIMEOUT`、provider unavailable 等非取消错误仍为 failed 并显示公开错误；
- [ ] 真实 Electron 再取消一次长生成，抓到正式码并通过上述断言。

## 7. 建议实施顺序

前后端可以并行修改，最终按以下顺序验证：

1. 后端补齐 WS replay tool 的 `message_id/timestamp` 并收紧契约；
2. 前端完成 Renderer 启动 snapshot 水合与竞态守卫；
3. 前端移除共享 replay fallback，补 legacy 防御或按新 v2 契约拒绝；
4. 前端统一 `GENERATION_CANCELLED` 语义和 fixture；
5. 双方自动化门禁通过后，使用更新后的双方进程做一次短回归。

## 8. B-01 最小复跑清单

- [ ] 冻结并记录更新后的前后端 SHA；
- [ ] 启动 Electron 并连接，确认 REAL / protocol 2.0 / 后端版本；
- [ ] 创建会话，发送一条纯文本并完成；
- [ ] 调用两次真实工具，记录两个 callId 和 messageId；
- [ ] Renderer reload，界面无需手工操作即恢复 connected、活动会话和历史；
- [ ] 断开再连接，WS replay 与 REST 对每个工具使用相同 ID；
- [ ] Pinia 中每个 callId 只对应一条消息，无 `<conversationId>:replay`；
- [ ] 发送长请求并停止，收到 `GENERATION_CANCELLED`，UI 为 interrupted 且无失败横幅；
- [ ] 旧 `default` 历史继续能打开；
- [ ] 诊断中没有由本轮场景产生的 schema、协议或未处理 Promise 错误。

全部通过后，才把项目状态从“已验证/联调中”更新为“B-01 已真实联调”，再推进阶段 3。

## 9. 自动化门禁

前端提交前至少执行：

```text
pnpm test
pnpm typecheck
pnpm lint
pnpm --filter @cyrene/desktop check:contract
pnpm build
```

涉及 Renderer bootstrap 的测试应包含真实 Main/Preload 推送装配或等价的可测 bootstrap 模块；仅新增 store 孤立单测不足以关闭 FE-INT2-P0-01。

## 相关文档

| 文档 | 内容 |
|---|---|
| [首次真实联调前端问题清单](2026-08-13-Windows-Electron-首次真实联调前端问题清单.md) | 首轮 state/typing 与单写者范围问题 |
| [首次联调封口修复报告](2026-08-13-首次联调封口问题修复报告.md) | 首次真实运行前的自动化和契约门禁 |
| [阶段 2 真实联调整改清单](2026-08-11-阶段2真实联调前端整改清单.md) | RealBackend、Store、IPC、回放和聊天 UI 的前置整改 |
