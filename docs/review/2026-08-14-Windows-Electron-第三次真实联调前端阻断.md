# Windows Electron 第三次真实联调：前端阻断

**日期：** 2026-08-14（Asia/Shanghai）

**前端基线：** `05f5af0b80a3f88f4fd13a8dd7a6ef535a640d64`

**后端基线：** `73ac7a32415aa96bbec7687ae0c9e674ab675438`

**状态：** B-01 第 1–9 项已取得真实证据；第 10 项因 WS 压缩连接空闲后协议错误失败。**未封口，阶段 3 不得升为主线。**

后端完整证据报告：`/home/yomu/elysia-agent/docs/review/2026-08-14-Windows-Electron-第三次真实联调结果.md`

## 1. 已通过的真实 Electron 链路

- Windows Electron `43.3.0` / Chrome `150.0.7871.212`，RuntimeInfo=`REAL`，protocol=`2.0`，后端=`0.1.0+73ac7a3`。
- 会话 `conv_c658c8dc907f`中完成纯文本 ACK/流式/完成，UI、Pinia 和 REST 身份一致。
- 连续两次真实 `get_time`，两个 `callId`、tool `messageId`、timestamp 均非空且不同。
- 仅 reload Renderer 时 Main `connectionId` 不变，活动会话和 10 条 REST 历史恢复。
- UI 断开/重连后，tool 的 replay/REST/Store `messageId + createdAt + callId` 完全一致。
- Store 消息 ID 唯一，无 `<conversationId>:replay`，DOM 行数与 Store 一致。
- 在干净新 WS 上取消真实长生成：收到 `GENERATION_CANCELLED`，保留 28 字 partial，Store/UI=`interrupted`，无失败横幅或迟到 completed。
- 旧 `default` 最近 50 条可读，ID 非空无重复，仍有更多历史页。

## 2. [P0] 空闲压缩 WS 的首个客户端业务帧会断连

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

### 当前代码位置

`apps/desktop/src/main/transport/real-backend.ts:290`：

```ts
new WebSocket(wsBase, { headers })
```

Node `ws` 客户端默认启用 `permessage-deflate`。官方说明同时给出了显式关闭方式：<https://github.com/websockets/ws/blob/master/README.md#websocket-compression>

## 3. 建议处理

1. 前端最小修复：真实 `ws` 工厂默认显式传入 `perMessageDeflate:false`，不改 `wsFactory` 测试注入契约。
2. 增加选项装配单测，并增加真实 `ws` + aiohttp 空闲后首帧回归；测试不得只用不协商压缩的 fake socket。
3. 后端可同时评估 `WebSocketResponse(..., compress=False)` 作为纵深防护。
4. 修复后使用新 SHA 重跑：
   - 连接空闲 75s 后发文本；
   - 连接空闲 75s 后 reload Renderer；
   - B-01 #8 取消；
   - B-01 #10 全轮诊断。

复验前不得将阶段 2 标为“已真实联调”。

## 4. 修复实施状态

Ubuntu 前端工作区已完成最小修复：

- `RealBackend` 的默认真实 `ws` 连接显式设置 `perMessageDeflate:false`；测试注入的 `wsFactory` 契约未变。
- 新增真实本地 `WebSocketServer` 握手回归，断言客户端不发送 `Sec-WebSocket-Extensions`。
- 定向用例 `30/30`、全量单测 `527/527`、typecheck、lint、production build 均通过。

Windows Electron 当前仍是修复前启动的主进程（`connectionId=conn_e7ac4895eabb`），Linux 工作区改动未触发 Windows 端 Main 重载。因此本节只记录“实施+静态/本地动态门禁通过”，B-01 状态仍不变；待 Windows 同步且重启后再补 75s 空闲真实复验。
