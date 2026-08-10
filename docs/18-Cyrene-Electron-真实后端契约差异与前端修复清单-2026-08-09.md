# Cyrene Electron：真实后端契约差异与前端修复清单

> 审计日期：2026-08-09
>
> 文档用途：交给 Claude Code 直接据此修改 Electron 前端；不是产品畅想稿，也不是历史协议摘要。
>
> 后端审计基线：`/home/yomu/elysia-agent` @ `911bbe004338bd0c2634db6cdb1913fb1de1c2f4`
>
> 前端审计基线：`/home/yomu/elysia-frontend` @ `4bc7f01d75c7c05331d2779cdfcacbc326fd4d45`

> **状态注记（2026-08-10）：** 本清单指向的前端基线早于阶段 1 批次（块 A/B/C，安全骨架 + 凭据/日志 + 集成测试），阶段 1 未触及 transport/领域层，故文中契约缺口**仍全部有效**、归属阶段 2（真实 Adapter 联调）。其中指出的 **doc 02 §19 两处错误（`before={messageId}` 应为 `before={_id}`、批次 7 状态）已于 2026-08-10 修正**；其余按 §16 阶段 A→D 顺序在阶段 2 实施。

> **状态注记（2026-08-11）：阶段 2 块 A（领域契约修复 + raw wire 层）已实施并合并。** §3 两层类型、§4 P0（`SegmentCompletedEvent.kind/content` 权威文本）、§5 fixture 分离（`fixtures/domain/` 领域 + `fixtures/wire-v2/` raw wire + manifest，锚定 `beeba577`）、§8 generation 全映射（新增 `GenerationSegmentStartedEvent`、frame-mapper 补 channel/kind/conversationId/fail-closed）、§9 Token 结构（`usage.rounds` + `ConversationTokenUsage{total,byModel}`）已按本清单落地，231 单测 + typecheck/lint/build 全绿，标注「已开发、未联调」。设计见 `docs/superpowers/specs/2026-08-10-phase2-contract-raw-wire-design.md` + `plans/2026-08-10-phase2-contract-raw-wire.md`。**§16 阶段 B（连接/REST/会话，即块 2B）为下一步**；§7 session 回放归属、§10 `_id` 分页游标随 2B 实施（后端已补 `SessionMessage.conversationId` 与 `MessagesPageResponse.cursor`，见 spec §1.1）。

## 1. 结论与执行边界

后端为 Electron 实现的 WebSocket v2、多会话 REST、Desktop 工具桥、三种语音模式、模型/TTS/STT 设置、附件与恢复查询主体已经存在，后端专项测试通过。当前主要问题不是“后端没有实现”，而是新 Electron 前端尚未建立可执行的 raw-wire 适配层，并且现有领域类型、Mock fixture 与真实后端之间存在多处结构差异。

当前状态可以概括为：

- 后端 v2 功能主干可用；
- Electron 前端目前只有 `BackendAdapter` 接口和 `MockBackend`，没有真实 REST/WS Adapter；
- Mock fixture 使用的是前端理想领域事件，不是后端真实 wire；
- 现有前端测试全部通过，但无法证明真实后端可接入；
- 文本聊天接入有会导致“回复为空”的 P0 问题；
- 语音阶段有会导致 STT 静默失败的 P0 格式问题；
- 历史分页、会话绑定、Token、Desktop 工具还存在 P1 契约缺口。

本文把事项分为三类：

1. **前端现在必须修改**：Claude Code 可以在 Electron 仓库内完成；
2. **前端必须显式适配**：后端 wire 合理，不应要求后端迎合前端领域命名；
3. **需要后端后续补强**：前端不得自行虚构字段或行为，应保留兼容策略并等待后端更新。

## 2. 契约权威顺序

发生冲突时，按以下顺序判断后端真实行为：

1. `/home/yomu/elysia-agent/frontend_contract/` 中的 Pydantic wire 模型；
2. `/home/yomu/elysia-agent/core/input/`、`Module/output/` 等真实发送/接收点；
3. `/home/yomu/elysia-agent/docs/electron-backend-protocol-v2.md`；
4. Electron 前端设计文档；
5. 历史 traces 与 Mock fixture。

特别注意：

- `/home/yomu/elysia-agent/docs/archive/frontend-handoff-v2/` 已明确归档，只能参考，不能作为当前契约；
- 归档 `ws-v2-session.jsonl` 仍是 `token_stats.by_model`，当前真实 wire 已是 `token_stats.byModel`；
- 后端 `frontend_contract` 生成的 TypeScript 快照目前仍在旧 Vue 目录 `frontend/src/types/contract.generated.ts`，Electron 仓库没有消费该快照；
- 前端 `docs/02-...` 的 §19 虽记录了部分差异，但底部仍写着批次 7 交接基线；当前后端已经包含批次 8a/8b/8c 变化；
- 后端本地 `main` 在审计时领先 `origin/main` 11 个提交。联调时必须记录实际后端 SHA，不能只写“main”。

## 3. 必须建立两层类型，禁止混用

Electron 前端需要明确分成两层：

### 3.1 Raw wire 层

只描述后端实际发送/接收的 JSON，保留后端原始命名：

- 判别字段是 `type`，不是 `event`；
- 增量字段是 `delta`，不是 `text`；
- `generation.completed` 使用 `messageId`，没有 `responseId`；
- `mood` 不是 `emotion`；
- `usage` 是 `{turn_total, rounds[]}`；
- raw frame 没有 `eventId`、`sequence`；
- REST 消息使用 `message_id`、`session_id`、`timestamp`、`_id` 等字段。

建议新增独立文件，例如：

```text
apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts
apps/desktop/src/main/transport/protocol-v2/raw-types.ts
apps/desktop/src/main/transport/protocol-v2/frame-mapper.ts
apps/desktop/src/main/transport/real-backend.ts
```

raw frame 必须先通过 raw Zod schema，再交给 mapper。当前 `parseBackendEvent()` 校验的是已经归一化后的领域事件，**不能直接用于后端 JSON**。

### 3.2 前端领域层

Renderer/Store 继续消费 `event`、`text`、`emotion` 等前端友好结构，但所有补字段、改名和派生行为只能发生在 Main 进程 Adapter 中。

Adapter 应承担：

- `type -> event`；
- `delta -> text`；
- `mood -> emotion`；
- `generationId -> responseId` 兼容别名；
- 从 `generation.segment.started` 缓存 `channel/kind`，用于补全后续 delta；
- 从活动会话上下文补齐可缺省的 `conversationId`；
- 为当前连接生成本地 `eventId/sequence`；
- 将 raw Token 数据转换为领域 Token 类型；
- REST snake_case 到领域 camelCase；
- 错误信封归一化；
- 记录协议告警，不能静默捏造数据。

## 4. P0：`segment.completed.content` 丢失会让回复为空

### 4.1 后端真实行为

后端分段完成帧为：

```json
{
  "type": "generation.segment.completed",
  "generationId": "gen_...",
  "segmentId": "seg_...",
  "segmentIndex": 0,
  "channel": "inner_voice",
  "kind": "text",
  "content": "完整分段文本",
  "conversationId": "conv_..."
}
```

`content` 是该分段的权威完整文本。它虽然在 Pydantic 模型中为可缺省兼容字段，但当前 inner voice/public reply 的完成发送路径会携带它。

存在两种不能依赖 delta 的正常情况：

1. inner voice 当前发送 `segment.started + segment.completed(content)`，可以完全没有 `generation.delta`；
2. TTS 开启时，public reply 的文字 delta 会被抑制，完整文字主要由 `segment.completed.content` 交付。

代码证据：

- `/home/yomu/elysia-agent/frontend_contract/ws_message.py:355`
- `/home/yomu/elysia-agent/Module/output/manager.py:427`
- `/home/yomu/elysia-agent/core/cognitive/loop.py:1330`

后端默认配置中 TTS 为启用状态，因此这不是罕见边界场景。

### 4.2 当前前端错误

当前前端：

- `SegmentCompletedEvent` 没有 `kind` 和 `content`；
- `SegmentCompletedEventSchema` 会丢弃这两个字段；
- `StreamAccumulator.applySegmentCompleted()` 把 `kind` 硬编码为 `text`；
- completed 只设置 `completed = true`，不落权威文本；
- Mock 为 inner voice 人为生成了 delta，掩盖了真实行为。

涉及文件：

- `apps/desktop/src/shared/contracts/events.ts`
- `apps/desktop/src/shared/schemas/events.ts`
- `apps/desktop/src/shared/domain/stream-accumulator.ts`
- `apps/desktop/src/main/fixtures/streaming-reply.jsonl`

### 4.3 必须修改

领域事件至少改为：

```ts
export interface SegmentCompletedEvent extends BackendEventEnvelope {
  event: 'generation.segment.completed'
  generationId: string
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind
  content?: string
}
```

Accumulator 规则：

- `content !== undefined` 时，把它作为权威值覆盖 `committedText` 与 `renderText`；
- 不得用 truthy 判断，因为空字符串也可能是合法完成内容；
- 权威 content 到达后清除该段的 `pendingChunks`，不能让早先缺失的 delta 把父回复永久卡在 `completing`；
- 使用事件真实 `kind`，不得硬编码 `text`；
- `content` 缺省时保留已累计 delta；
- completed 后的迟到 delta 应忽略并记录协议告警，不能再次改变已完成权威文本；
- `generation.segment.completed` 只完成一个 segment；只有 `generation.completed` 才完成父消息。

### 4.4 必须新增测试

至少覆盖：

1. inner voice 只有 started/completed、零 delta，最终仍有文字；
2. public reply 只有 completed(content)、零 delta，最终仍有文字；
3. delta 只到一半，completed(content) 覆盖为完整文本；
4. delta 乱序/有缺口，completed(content) 清除缺口并能完成父消息；
5. completed 不带 content 时保留 delta 拼接结果；
6. completed content 为空字符串时正确覆盖；
7. completed 后迟到 delta 不污染结果；
8. kind 为 `markdown` 时不会被改成 `text`。

## 5. P0：当前 Mock 不是后端 wire，必须增加 raw fixture

当前 `streaming-reply.jsonl` 是领域事件，包含后端不存在的字段：

- `event`；
- `eventId`；
- `sequence`；
- `responseId`；
- delta 中的 `channel/kind/text`；
- `{input, output, total}` 形式的 `conversationUsage`。

它适合测试 Renderer/Store，但不能测试 Main Adapter。

必须保留两类 fixture，名称上明确区分：

```text
fixtures/domain/streaming-reply.jsonl
fixtures/wire-v2/handshake.jsonl
fixtures/wire-v2/chat-no-delta-inner-voice.jsonl
fixtures/wire-v2/chat-tts-public-completed-only.jsonl
fixtures/wire-v2/chat-failed.jsonl
fixtures/wire-v2/session-replay.jsonl
```

wire fixture 应直接来自当前 `frontend_contract` 或当前后端测试构造，不能复制归档 traces。每个 fixture 头部或旁边 manifest 记录：

```json
{
  "backendCommit": "911bbe004338bd0c2634db6cdb1913fb1de1c2f4",
  "protocol": "2",
  "serverProtocolVersion": "2.0"
}
```

CI 至少做两层验证：

1. raw fixture 能通过 RawFrameSchema；
2. raw fixture 经 mapper 后能通过当前 `BackendEventSchema` 并正确推进 Store/Accumulator。

## 6. WebSocket 建连与握手映射

### 6.1 请求要求

WebSocket 地址：`/ws`

必须发送：

```http
X-Protocol-Version: 2
X-Client-Platform: electron
Authorization: Bearer <token>   # 后端配置 AGENT_ACCESS_TOKEN 时必需
```

注意：握手头必须是精确字符串 `2`。发送 `2.0` 或其他值时，当前后端会静默走 v1。Adapter 必须 fail closed：若没有收到合法 v2 `server_info`，应报告协议不兼容，不可继续按 v2 工作。

### 6.2 建连帧顺序

当前后端顺序：

1. `session`
2. `server_info`
3. `expression`

`server_info` 包含：

- `protocol_version`
- `server_version`
- `features`
- `services`
- Electron 连接的 `connectionId`
- `build_sha`

后端 raw frame 没有统一的 `eventId`、`sequence`、`timestamp` 外壳。前端如需要这些字段，应在每次连接内部生成：

- `sequence`：按实际收帧顺序单调递增；
- `eventId`：例如 `${connectionId ?? localConnectionId}:${sequence}`；
- 这些 ID 只是本地连接内排序键，不得声称能跨重连去重或断点续传。

## 7. P1：`session` 回放没有会话 ID

后端 `SessionMessage` 当前只有：

```json
{
  "type": "session",
  "messages": [],
  "token_stats": {
    "total": 0,
    "byModel": {}
  }
}
```

它没有 `conversationId` 或 `sessionId`，但前端 `BackendSession` 要求：

```ts
interface BackendSession {
  sessionId: string
  protocolVersion: string
  serverUrl: string
}
```

这会导致重连回放无法可靠归属会话。并且 `session` 比 `server_info` 更早到达，Adapter 必须允许先缓冲回放。

### 7.1 前端临时兼容方案

- 将连接身份与活动会话身份分离；建议把 `BackendSession.sessionId` 改成可表达以下语义的结构：

```ts
interface BackendConnection {
  connectionId?: string
  activeConversationId?: string
  protocolVersion: string
  serverVersion?: string
  buildSha?: string
  serverUrl: string
}
```

- 用 `GET /api/sessions` 返回条目的 `active: true` 解析活动会话；必要时分页查找；
- 在活动会话 ID 未解析前缓存 `session.messages`，解析后再归一化进 Store；
- 如果 UI 已明确选定会话，可先调用 REST activate，再通过 WS `activate_session` 获取回放；
- 不得把 `connectionId` 当作 conversation ID；
- 不得凭消息 ID 前缀猜测 conversation ID。

### 7.2 后端应补强

后端后续应给 `SessionMessage` 增加 `conversationId`。这是最干净、无歧义且可向后兼容的解决办法。在后端字段上线前，前端仍需保留字段可缺省兼容。

证据：

- `/home/yomu/elysia-agent/frontend_contract/ws_message.py:253`
- `/home/yomu/elysia-agent/core/input/ws_handler.py:83`
- `apps/desktop/src/shared/contracts/backend.ts:5`

## 8. Generation raw wire 到领域事件的完整映射

### 8.1 `generation.started`

后端：

```json
{
  "type": "generation.started",
  "generationId": "gen_...",
  "messageId": "msg_...",
  "conversationId": "conv_...",
  "requestId": "...",
  "model": "..."
}
```

前端映射：

- `event = type`
- `responseId = generationId`，不是 `messageId`
- `messageId` 保持后端值
- `conversationId` 缺省时用当前 generation/活动会话上下文补齐；无法补齐则协议错误，不能填空字符串

### 8.2 `generation.segment.started`

后端会先发送：

```json
{
  "type": "generation.segment.started",
  "generationId": "gen_...",
  "segmentId": "seg_...",
  "segmentIndex": 0,
  "channel": "inner_voice",
  "kind": "text",
  "conversationId": "conv_..."
}
```

当前前端 `BackendEvent` 联合没有该事件，但 delta raw frame 又不携带 `channel/kind`。因此真实 Adapter 无法仅凭 delta 构造当前 `GenerationDeltaEvent`。

必须二选一，推荐方案 A：

- **方案 A（推荐）**：增加 `GenerationSegmentStartedEvent`、Zod schema 和 accumulator 分支；收到时创建 segment；
- 方案 B：只在 Adapter 内缓存 `{generationId, segmentId} -> {segmentIndex, channel, kind}`，不向领域层发 started。

无论选择哪种，找不到 segment 元数据时不得默认成 `public_reply/text`，应记录明确协议错误。

### 8.3 `generation.delta`

后端：

```json
{
  "type": "generation.delta",
  "generationId": "gen_...",
  "segmentId": "seg_...",
  "segmentIndex": 0,
  "deltaSequence": 0,
  "delta": "文本增量",
  "conversationId": "conv_..."
}
```

Adapter：

- `text = delta`
- `channel/kind` 来自对应 `segment.started` 缓存
- `segmentIndex` 应与缓存一致；不一致时记录协议告警并以 started 元数据为准

### 8.4 `generation.segment.completed`

- 保留 `channel`、`kind`、`content`；
- `content` 按第 4 节作为权威文本；
- 清理对应 segment 元数据缓存只能在完成帧映射结束后进行。

### 8.5 `generation.completed`

映射规则：

- `responseId = generationId`
- 建议领域事件也保留 `messageId`
- `emotion = mood`
- `finishReason`、`completeness` 不应无声丢弃；即使 UI 暂时不用，也应保留在领域元数据或日志中
- 这是唯一成功终态
- `state: idle` 不是 generation 完成信号

### 8.6 `generation.failed`

后端错误是平铺字段：

```json
{
  "type": "generation.failed",
  "generationId": "gen_...",
  "messageId": "msg_...",
  "code": "GENERATION_TIMEOUT",
  "message": "...",
  "retryable": true,
  "details": {},
  "conversationId": "conv_..."
}
```

前端当前只保留 `{code, message}`。应至少保留 `retryable/details`，并保留已接收的 partial segments。`GENERATION_CANCELLED` 也是 failed 终态，不应映射成 completed。

### 8.7 `status` channel

后端 `MessageChannel` 还预留 `status`，前端 `SegmentChannel` 只有 `inner_voice/public_reply`。Raw schema 应接受后端枚举全集；领域 mapper 可以显式过滤 `status` 或映射到独立状态事件，但不能因为未知于 UI schema 就让整个 WS 解析失败。

## 9. P1：Token 结构不一致，禁止虚构 input/output

### 9.1 单次 generation usage

后端：

```json
{
  "usage": {
    "rounds": [
      {
        "model": "...",
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120,
        "cached_tokens": 0,
        "reasoning_tokens": 0,
        "round_num": 1
      }
    ],
    "turn_total": 120
  }
}
```

前端 `TokenUsage` 可以这样映射：

- `input = sum(rounds[].input_tokens)`
- `output = sum(rounds[].output_tokens)`
- `total = turn_total`
- `source = provider_reported`
- 若 `sum(total_tokens) != turn_total`，记录协议告警但保留服务端 `turn_total`
- 不要丢弃 rounds；设置页或诊断页以后会需要模型/缓存/推理拆分

### 9.2 会话累计 usage

后端真实形状：

```json
{
  "conversationUsage": {
    "total": 2100,
    "byModel": {
      "model-a": 2100
    }
  }
}
```

`session.token_stats` 也是 `{total, byModel}`。

当前前端要求 `{input, output, total}`，后端没有提供累计 input/output，Adapter 无法诚实推导。必须修改领域类型，例如：

```ts
interface ConversationTokenUsage {
  total: number
  byModel: Record<string, number>
  source: 'server_aggregate'
}
```

禁止：

- 把 total 任意拆成 input/output；
- 使用字符数估算后标记为后端数据；
- 延续当前 Mock 中虚构的 `{input: 1200, output: 900, total: 2100}`。

涉及文件：

- `apps/desktop/src/shared/contracts/events.ts`
- `apps/desktop/src/shared/schemas/events.ts`
- `apps/desktop/src/shared/domain/stream-accumulator.ts`
- `apps/desktop/src/main/fixtures/streaming-reply.jsonl`

## 10. P1：会话历史分页游标被混淆

### 10.1 后端真实语义

接口：

```http
GET /api/sessions/{conversationId}/messages?before=<cursor>&limit=50
GET /api/sessions/{conversationId}/messages?after=<messageId>&limit=50
```

两个参数语义不同：

- `before` 必须是消息归档的 Mongo `_id`，即 24 位十六进制 ObjectId；非法值返回 400 `CONTRACT_VALIDATION`；结果倒序；
- `after` 是稳定业务 `message_id`，即 `msg_...`；结果正序；
- 响应为 `{messages, has_more, total}`，没有显式 cursor；
- 每条 REST 消息同时带 `_id` 与 `message_id`。

代码证据：

- `/home/yomu/elysia-agent/core/input/session_routes.py:544`
- `/home/yomu/elysia-agent/core/storage/message_repo.py:297`
- `/home/yomu/elysia-agent/frontend_contract/rest.py:237`

前端 `docs/02-...` §19 当前写成 `before={messageId}`，这是错误描述，需要同步修正。

### 10.2 前端必须修改

- Raw REST Message schema 必须保留 `_id`；
- 首次/更早分页收到倒序列表，入 UI 前按时间正序归一化；
- 在反转前记录 raw 最后一条/最旧一条的 `_id`，作为 `nextCursor`；
- 下一页把该 opaque cursor 原样传给 `before`；
- 增量刷新才使用最新稳定 `messageId` 传给 `after`；
- 不得把 `_id` 暴露为 UI 的 `messageId`；
- `GetConversationQuery` 当前只有 `conversationId`，无法表达历史分页。需要扩展 `before/cursor/limit`，或新增明确的 `getConversationMessages()`；
- `MessagesPage.nextCursor` 是 Adapter 派生字段，后端响应本身没有 cursor。

必须测试：

1. `_id` cursor 原样往返；
2. `msg_...` 不会被用作 `before`；
3. 两页倒序 raw 数据合并后 UI 顺序稳定；
4. 页间消息去重以稳定 `message_id` 为准；
5. `after=msg_...` 的正序增量不会被再次反转。

## 11. P1：Desktop 工具结果接口不完整

后端 `tool.request` 会提供并要求前端回显：

- `callId`
- `toolName`
- `toolVersion`
- `runtime`
- `paramHash`
- `arguments`
- `riskLevel`
- `permissionRequired`
- `approvalAuthority`
- `expiresAt`

客户端回传 raw frame：

```json
{
  "type": "tool.status",
  "callId": "call_...",
  "status": "result",
  "toolName": "desktop.screenshot.capture",
  "toolVersion": "1.0.0",
  "runtime": "desktop",
  "paramHash": "...",
  "output": "...",
  "attachments": [
    {"url": "/uploads/...", "mimeType": "image/png", "label": "screenshot"}
  ],
  "executionSummary": "..."
}
```

当前前端 `ToolResult` 只有 `callId/status/summary`，无法满足后端校验，也不能传截图/文件结果。

必须修改：

- Main 进程缓存每个 `tool.request` 的 `toolName/toolVersion/runtime/paramHash/expiresAt`；
- 回传时使用缓存原值，不允许 Renderer 自由修改这些安全字段；
- 前端 `completed -> result`；
- 前端 `failed/timeout -> error`，timeout 使用明确错误码和 message；
- `rejected/cancelled` 可直接映射；
- `accepted/running` 是过程状态，不能只在最终结果接口里表示；
- `result` 支持 `output/attachments/executionSummary`；
- `error` 支持 `{code, message}`；
- 截图/文件先上传 `POST /api/uploads/desktop/{callId}`，请求带握手获得的 `X-Client-Connection: <connectionId>`，再回传后端托管 URL；
- `executionSummary` 不得包含本地绝对路径或敏感数据。

后端桥已经有连接持有者、`paramHash` 防篡改、重复回传与离线语义测试；前端不要绕过这些约束。

证据：

- `/home/yomu/elysia-agent/frontend_contract/ws_message.py:816`
- `/home/yomu/elysia-agent/core/desktop/bridge.py`
- `apps/desktop/src/shared/contracts/backend.ts:96`

## 12. P0（语音阶段）：输入音频格式必须固定

### 12.1 后端实际只接受

```text
codec: pcm_s16le
sampleRate: 16000
channels: 1
sample type: signed Int16 little-endian
recommended chunk: 20 ms 的整数倍
20 ms frame: 320 samples = 640 bytes
```

后端 WebRTC VAD：

- 小于 640 字节的 chunk 被判为非语音；
- 非 640 字节整数倍的尾部不会进入 VAD 帧判断；
- ordinary recording、realtime、dictation 都把收到的 BINARY 当原始 PCM，不识别 WebM/Opus/WAV 容器头；
- v2 在没有活动 voice session 时会直接丢弃 BINARY。

证据：

- `/home/yomu/elysia-agent/core/input/audio_buffer.py:1`
- `/home/yomu/elysia-agent/core/input/audio_buffer.py:30`
- `/home/yomu/elysia-agent/core/input/audio_buffer.py:175`
- `/home/yomu/elysia-agent/core/input/voice_sessions.py:1`

### 12.2 Electron 前端必须实现

- 不得把 `MediaRecorder` 默认产生的 WebM/Opus 直接发给 WS；
- 不得把 WebAudio 的 48kHz Float32Array 直接发给 WS；
- 使用 AudioWorklet 或等价实时处理：下混为 mono、重采样到 16kHz、clamp 后转换为 signed Int16 LE；
- 按 640 字节或其整数倍发 WS BINARY；
- stop 前 flush 剩余样本时应补齐或按明确策略处理，不能随机丢尾；
- 音频格式描述可以保留在前端内部类型中，但当前后端 start 控制帧不接受 descriptor，不要把未经支持的字段当作已协商成功；
- WS BINARY 没有内置 sessionId，归属依赖当前连接的唯一活动语音模式；禁止并发启动 recording/realtime/dictation。

### 12.3 当前前端语音接口还缺少模式语义

当前 `startVoiceInput({conversationId}) -> {sessionId}` 无法区分：

- ordinary recording：客户端生成 `recordingId: rec_...`，控制帧为 `voice.record.*`；
- realtime：客户端生成 `sessionId: vs_...`，控制帧为 `voice_session.*`。

建议领域接口显式增加 `mode: 'recorded' | 'realtime'`，返回对象也保留 mode。`stopVoiceInput` 必须据 mode 发送不同控制帧，不能只凭 ID 猜测。

### 12.4 必须新增测试

- 48k Float32 -> 16k mono Int16 LE 的确定性转换；
- chunk 长度始终为 640 的整数倍；
- 正负满幅、静音、clipping 和 NaN 的转换；
- 使用真实短语音 PCM fixture 与后端 VoiceSessionManager 做集成测试；
- 未 start 时不发送 BINARY；
- stop/cancel 后不再发送 BINARY；
- 三种模式冲突正确显示 `VOICE_SESSION_CONFLICT`。

## 13. P1：Dictation 的 STT Profile 目前是全局切换

前端：

```ts
interface StartDictationInput {
  conversationId: string
  sttProfileId: string
}
```

后端：

```json
{"type":"dictation.start","clientRequestId":"..."}
```

后端没有 `conversationId`、`sessionId` 或 `sttProfileId`，使用当前活动 STT。当前兼容流程只能是：

1. 必要时 `switch_model{service:"stt", model: ...}`；
2. 等待成功结果；
3. 再发送 `dictation.start{clientRequestId}`；
4. 把 `clientRequestId` 作为本次 dictation 的前端会话标识；
5. stop/cancel 使用同一 `clientRequestId`。

这个流程会改变聊天/实时语音使用的全局 STT，也可能与其他客户端竞争。前端应明确展示或限制，不得假装 dictation 拥有隔离 profile。

后端后续建议给 `dictation.start` 增加可选 `sttProfileId`，在 dictation session 内快照解析，不改变全局活动 STT。

证据：

- `/home/yomu/elysia-agent/frontend_contract/ws_message.py:783`
- `/home/yomu/elysia-agent/core/input/ws_handler.py:1021`
- `apps/desktop/src/shared/contracts/backend.ts:81`

## 14. REST 与回放消息归一化注意事项

Main Adapter 必须处理以下差异：

- REST `message_id -> Message.messageId`；
- REST `session_id -> Message.conversationId`；
- REST `timestamp -> Message.createdAt`；
- session replay item 没有 `session_id`，使用已解析的活动 conversation ID；
- assistant 历史中的 `inner_voice/content/content_type` 要归一化为 `assistantSegments`，不能又复制到 `Message.content`；
- tool role 的 `tool_call_id/name/success/error/...` 不能按普通文本丢弃；
- REST 第一页/`before` 页为倒序，Store 内统一正序；
- `message_id` 是去重键，`_id` 只作为历史游标；
- `SessionDetail.messages` 也是倒序第一页；
- optional 字段缺省与显式 null 要按 raw schema 区分，不能用宽泛 `any` 吞掉。

## 15. 其他协议硬化事项

### 15.1 前端必须做

- 所有 REST 与 WS 外部数据均经过 raw Zod 校验；
- 未知可选字段可保留/忽略，未知 `type` 应记录并安全跳过，不能关闭整个应用；
- 已知 `type` 的必填字段错误要形成可诊断协议错误；
- WS/REST 都发送同一 Bearer token；
- 认证失败不无限重连；
- `server_info.features/services` 是 UI 能力门控事实来源；
- 重连没有断点续传，不能把本地 sequence 当服务端 resume cursor；
- generation 成功仅由 `generation.completed` 判定；
- 取消/错误由 `generation.failed` 判定；
- ACK rejected 不创建 generation；
- 同一 `clientRequestId` 重试必须保持内容摘要一致。

### 15.2 后端后续应做，前端不要伪造

- `SessionMessage` 增加 `conversationId`；
- 历史响应增加显式 opaque `nextCursor`，或让 `before` 同时兼容 `_id/messageId`；
- voice start 增加可验证的音频 descriptor 或在协议中固定并声明格式；
- dictation start 增加独立 STT profile；
- 所有 Client -> Server WS frame 统一经 Pydantic 判别联合校验；当前不少入口仍手工 `data.get()`；
- 协议版本不兼容时显式拒绝，而不是把未知版本静默降级为 v1；
- 发布 Electron 可消费的版本化 schema/生成包，并给 schema 加版本或 hash；
- 用当前契约生成新的 golden traces，归档 traces 不再进入测试。

## 16. Claude Code 建议修改顺序

### 阶段 A：先让真实文本聊天不会丢内容

1. 新增 raw v2 schemas/types；
2. 实现 WS frame mapper；
3. 增加 `generation.segment.started` 领域处理；
4. 给 completed 增加 `kind/content`；
5. 修复 StreamAccumulator 权威 content 规则；
6. 修复 generation completed/failed 映射；
7. 分离 raw fixture 与 domain fixture；
8. 增加零 delta/TTS 场景测试。

### 阶段 B：接通连接、会话和 REST 历史

1. 实现 Bearer + 两个 v2 header；
2. 处理 `session -> server_info -> expression`；
3. 分离 connectionId 与 activeConversationId；
4. 实现 session 回放缓冲与归属；
5. 实现 REST snake_case 映射；
6. 保留 `_id` opaque cursor；
7. 修复倒序分页与增量正序；
8. 修正 Token usage 类型与映射。

### 阶段 C：Desktop 工具

1. 扩展 ToolRequest/ToolStatus 领域模型；
2. 在 Main 缓存安全元数据；
3. 实现状态映射；
4. 实现 desktop upload + connection owner header；
5. 覆盖 result/error/rejected/cancelled/timeout/重复回传测试。

### 阶段 D：语音

1. 区分 recorded/realtime/dictation；
2. 实现 AudioWorklet 重采样与 PCM 编码；
3. 实现 640 字节倍数 chunker；
4. 对接三种状态机；
5. 明确 dictation 全局 STT 临时限制；
6. 用真实 PCM fixture 做前后端集成测试。

## 17. 建议直接修改的前端文件

现有文件：

```text
apps/desktop/src/shared/contracts/events.ts
apps/desktop/src/shared/contracts/message.ts
apps/desktop/src/shared/contracts/backend.ts
apps/desktop/src/shared/schemas/events.ts
apps/desktop/src/shared/domain/stream-accumulator.ts
apps/desktop/src/main/transport/backend-adapter.ts
apps/desktop/src/main/transport/mock-backend.ts
apps/desktop/src/main/fixtures/streaming-reply.jsonl
docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md
```

建议新增：

```text
apps/desktop/src/main/transport/real-backend.ts
apps/desktop/src/main/transport/protocol-v2/raw-types.ts
apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts
apps/desktop/src/main/transport/protocol-v2/frame-mapper.ts
apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts
apps/desktop/src/main/fixtures/wire-v2/*.jsonl
apps/desktop/src/main/transport/__tests__/frame-mapper.test.ts
apps/desktop/src/main/transport/__tests__/rest-mapper.test.ts
```

具体目录可以按当前工程规范调整，但 raw wire 与 domain contract 不得继续放在同一个模糊 schema 中。

## 18. 禁止采用的“快速修复”

- 不要要求后端为 inner voice/TTS 伪造 delta；completed content 本来就是权威事实源；
- 不要继续使用当前领域 Mock 冒充后端 wire 联调；
- 不要从归档 traces 复制 `by_model`；
- 不要把 `messageId` 传给历史 `before`；
- 不要丢弃 REST `_id` 后再尝试客户端拼 cursor；
- 不要虚构会话累计 input/output；
- 不要把 `connectionId` 当 conversation ID；
- 不要发送 `X-Protocol-Version: 2.0`；
- 不要将 WebM/Opus/WAV/48k Float32 直接作为 WS BINARY；
- 不要从 `state idle` 推断 generation completed；
- 不要让 Renderer 构造 `paramHash/toolVersion/runtime` 等 Desktop 安全字段；
- 不要用 `any` 或宽松 `.passthrough()` 掩盖已知 wire 字段错误。

## 19. 最低验收标准

文本聊天可以标记“真实后端已联调”前，必须满足：

- 使用真实后端 raw frames，而不是领域 Mock；
- 握手精确发送 v2/electron headers；
- `session -> server_info -> expression` 能处理；
- inner voice 零 delta 时可显示；
- TTS 开启、public reply 零 delta 时可显示；
- segment completed content 能覆盖不完整/乱序 delta；
- 多 segment 仍按 `segmentIndex` 排序；
- generation completed/failed 是唯一终态来源；
- conversation usage 不再伪造 input/output；
- 重连回放能绑定明确活动会话，或清晰暴露当前后端缺口；
- 历史 `before` 使用 `_id`，多页顺序与去重正确；
- raw schema、mapper、domain schema、accumulator 四层都有测试；
- fixture 标注后端 commit；
- `pnpm typecheck` 与 `pnpm test` 通过。

语音可以标记“真实后端已联调”前，还必须满足：

- 实际发送 16k/mono/pcm_s16le；
- chunk 是 640 字节整数倍；
- recorded/realtime/dictation 控制帧不混用；
- 用真实 PCM fixture 跑过后端集成；
- 未 start、stop 后、cancel 后不会继续发送 BINARY；
- 明确记录 dictation STT profile 当前是全局切换限制。

Desktop 工具可以标记“真实后端已联调”前，还必须满足：

- 回传原始 toolName/toolVersion/runtime/paramHash；
- status 映射符合后端六态；
- result/error/attachments/executionSummary 完整；
- 上传使用 `X-Client-Connection`；
- Renderer 无法篡改安全元数据；
- 超时、拒绝、取消、重复回传与重连状态均有测试。

## 20. 本次审计验证记录

后端运行的针对性测试集合覆盖：

- `frontend_contract/tests`
- structured generation/output manager
- WebSocket v2/会话路由
- Desktop bridge/registry/upload
- voice/audio buffer/voice sessions
- 相关 storage/recovery 测试

结果：

```text
576 passed, 1 warning
```

唯一 warning 来自 `webrtcvad` 间接导入已废弃的 `pkg_resources`，与本次契约问题无关。

同时验证：

```text
python -m frontend_contract --check   PASS
Ruff                                 PASS
Pyright                              0 errors
Electron pnpm typecheck              PASS
Electron pnpm test                   6 files / 39 tests PASS
```

这些结果说明双方各自代码质量门禁正常，但也进一步证明：必须增加跨仓库 raw-wire replay/contract test，否则“两边都绿、接起来失败”的风险不会被现有 CI 捕获。
