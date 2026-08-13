# Windows Electron 第三次真实联调：前端阻断与修复闭环

**日期：** 2026-08-14（Asia/Shanghai）

**前端基线：** `6b27e2e1ebf4e6ba3e335352379892e7c2679da2`

**后端基线：** `73ac7a32415aa96bbec7687ae0c9e674ab675438`

**状态：** 修复提交后的 Windows Electron 复验已通过，B-01 十项全部取得真实证据。**B-01 已封口，阶段 3 可转为主线。**

后端完整证据报告：`/home/yomu/elysia-agent/docs/review/2026-08-14-Windows-Electron-第三次真实联调结果.md`

证据继承口径：原 B-01 #1–#9 在父提交 `05f5af0` 上执行；`6b27e2e` 只改变 WS 压缩选项、增加回归和本报告。修复后已在 `6b27e2e` 上重跑受影响的空闲文本、Renderer reload、取消和全轮诊断；mapper/schema/后端数据未变的工具身份、replay 和存量历史项沿用同一轮原始证据。

## 1. 已通过的真实 Electron 链路

- Windows Electron `43.3.0` / Chrome `150.0.7871.212`，RuntimeInfo=`REAL`，protocol=`2.0`，后端=`0.1.0+73ac7a3`。
- 会话 `conv_c658c8dc907f`中完成纯文本 ACK/流式/完成，UI、Pinia 和 REST 身份一致。
- 连续两次真实 `get_time`，两个 `callId`、tool `messageId`、timestamp 均非空且不同。
- 仅 reload Renderer 时 Main `connectionId` 不变，活动会话和 10 条 REST 历史恢复。
- UI 断开/重连后，tool 的 replay/REST/Store `messageId + createdAt + callId` 完全一致。
- Store 消息 ID 唯一，无 `<conversationId>:replay`，DOM 行数与 Store 一致。
- 在干净新 WS 上取消真实长生成：收到 `GENERATION_CANCELLED`，保留 28 字 partial，Store/UI=`interrupted`，无失败横幅或迟到 completed。
- 旧 `default` 最近 50 条可读，ID 非空无重复，仍有更多历史页。

## 2. [已关闭 P0] 空闲压缩 WS 的首个客户端业务帧会断连

### 影响

真实 Electron 连接静默一段时间后，发送 `text` 或 Renderer 恢复路径发送 `activate_session` 时，后端拒绝该 WS 帧并关闭连接：

```text
WS error: Received frame with non-zero reserved bits
```

前端会进入自动重连。若失败帧是用户文本，当次 `send()` 仍等待 ACK，15s 后以 `TIMEOUT` 失败，UI 会留下一条发送失败消息。这是核心聊天可靠性阻断，不能仅依赖用户重试。

本轮 Electron 真实发生 3 次：

```text
02:42:28.227
02:44:18.593
02:47:50.461
```

### 隔离复现

在 Ubuntu 本机直连同一后端，两个 Node `ws` 探针建连后静默 75s，再发送 `activate_session(default)`：

| 客户端选项 | 协商扩展 | 发送后 replay | close code |
|---|---|---:|---:|
| 默认 | `permessage-deflate` | 0 | `1002` |
| `perMessageDeflate:false` | 无 | 1 | `1000` |

该复现不经 Windows、SSH 或 Electron UI，因此已排除隧道传输破坏。

### 原始代码位置

`apps/desktop/src/main/transport/real-backend.ts:290`：

```ts
new WebSocket(wsBase, { headers })
```

Node `ws` 客户端默认启用 `permessage-deflate`。官方说明同时给出了显式关闭方式：<https://github.com/websockets/ws/blob/master/README.md#websocket-compression>

## 3. 处理方案（已完成）

1. 前端最小修复：真实 `ws` 工厂默认显式传入 `perMessageDeflate:false`，不改 `wsFactory` 测试注入契约。
2. 增加选项装配单测，并增加真实 `ws` + aiohttp 空闲后首帧回归；测试不得只用不协商压缩的 fake socket。
3. 后端可同时评估 `WebSocketResponse(..., compress=False)` 作为纵深防护。
4. 修复后使用新 SHA 重跑：
   - 连接空闲 75s 后发文本；
   - 连接空闲 75s 后 reload Renderer；
   - B-01 #8 取消；
   - B-01 #10 全轮诊断。

上述前端修复、回归用例和 Windows 真机复验已全部完成。服务端 `compress=False` 仅保留为可选纵深防护，不再阻断 B-01。

## 4. 修复实施状态

前端提交 `6b27e2e1ebf4e6ba3e335352379892e7c2679da2` 已完成最小修复：

- `RealBackend` 的默认真实 `ws` 连接显式设置 `perMessageDeflate:false`；测试注入的 `wsFactory` 契约未变。
- 新增真实本地 `WebSocketServer` 握手回归，断言客户端不发送 `Sec-WebSocket-Extensions`。
- 定向用例 `30/30`、全量单测 `527/527`、Electron 集成 `23/23`、typecheck、lint、production build 全部通过。
- 跨仓契约检查 `13/13`，字段级真实帧 `63` 条完整保留。

Windows Electron 同步该提交并重启后，新 Main 连接为 `conn_240807de609a`，复验结果：

- 静默 `76s` 后从 UI 发文本：ACK、流式、completed 和 REST 落库全部成功；user=`msg_8ebf7bd7321c43f78d28a3752e`，generation=`gen_af19f970902c47cd8a013beff1`，assistant=`msg_44de6ad927754b9b973f7f353e`。
- 再静默 `76s` 后 reload Renderer：Main `connectionId` 不变，活动会话自动恢复，REST `13` 条与 DOM `13` 行一致，ID 非空且唯一。
- 取消复验：generation=`gen_d2c2d545666c43b7a214fbbabd`，assistant=`msg_b134619e8cbc4cb58b406bf17f`，终止码=`GENERATION_CANCELLED`，UI=`interrupted`，保留 `62` 字 inner-voice partial，无迟到 completed。
- 修复后窗口仅建立 `1` 条 WS，`0` 次断连、`0` 条 warning/error、`0` 次 RSV 错误；Pinia `19/19` 唯一键，DOM `19` 行，`droppedEvents=0`。

本轮无错误/连接横幅、无发送失败标记、无 Renderer console/page error。
