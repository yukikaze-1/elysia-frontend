# Cyrene 前后端通信协议与前端数据结构

**文档版本：** v0.2  
**文档状态：** 已按后端交接包（frontend-handoff-v2 **批次 7 时点**）填写 §19 对齐表 / 待真实事件联调确认；**注意：后端 local main 已领先至批次 8a/8b/8c（`frontend_contract` 单源），批次 7 交接包已归档仅参考**——新旧差异与真实后端契约审计见 `docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md`
**适用范围：** Electron 客户端与现有 Agent 后端  
**文档日期：** 2026-08-03
**最后复核日期：** 2026-08-08

> 本文定义前端需要的稳定语义，不宣称现有后端已经使用相同 URL 或字段名。接入时由 `BackendAdapter` 把现有后端协议映射为本文的前端领域事件。

---

## 1. 目标

- 为会话、消息、流式生成、附件和工具调用建立统一前端数据模型；
- 明确请求、事件、确认、错误、取消和恢复规则；
- 支持后端工具与 Desktop Runtime 工具同时存在；
- 避免重连导致重复消息、重复写文件或重复截图；
- 允许现有后端协议在不改动 UI 的情况下被适配。

## 2. 通信职责划分

推荐语义划分如下，实际传输方式可由适配器调整：

| 语义 | 推荐方式 | 说明 |
|---|---|---|
| 获取会话列表与历史 | HTTPS | 易分页、缓存和重试 |
| 创建、重命名、删除会话 | HTTPS | 普通请求响应 |
| 用户发送消息 | WSS | 与生成生命周期共用连接 |
| AI 流式增量 | WSS 或 SSE | Adapter 统一转成 `generation.delta` |
| 工具调用和结果 | WSS | 双向、可取消、需要关联 ID |
| 状态和心跳 | WSS | 连接健康和任务进度 |
| 附件上传下载 | HTTPS | 避免大二进制占用事件流 |

如果现有后端全部使用 WebSocket，仍应在逻辑层区分请求响应、单向事件和流式事件。

## 3. 协议适配层

### 3.1 两层模型

```text
现有后端原始消息
        ↓ decode + validate
Main 中的 BackendAdapter
        ↓ normalize
公开前端领域事件（经 Preload）
        ↓
Store / UI / Desktop Runtime
```

前端领域模型使用稳定命名；原始字段只存在于 Adapter 内部。

### 3.2 Adapter 输出

```typescript
type FrontendBackendEvent =
  | ConnectionStateEvent
  | ConversationChangedEvent
  | GenerationStartedEvent
  | GenerationDeltaEvent
  | GenerationCompletedEvent
  | GenerationFailedEvent
  | ToolCallEvent
  | ToolStatusEvent
  | ResourceChangedEvent
  | Live2DDirectiveEvent
  | ModelProfileChangedEvent
  | VoiceInputEvent
  | DictationEvent
  | TtsPlaybackEvent
  | BackendErrorEvent;
```

## 4. 统一事件外壳

推荐前端标准事件结构：

```typescript
interface EventEnvelope<TType extends string, TPayload> {
  protocolVersion: string;
  eventId: string;
  type: TType;
  occurredAt: string;
  conversationId?: string;
  requestId?: string;
  callId?: string;
  sequence?: number;
  payload: TPayload;
}
```

JSON 示例：

```json
{
  "protocolVersion": "1.0",
  "eventId": "evt_01J...",
  "type": "generation.delta",
  "occurredAt": "2026-08-03T12:00:00.000Z",
  "conversationId": "conv_123",
  "requestId": "gen_123",
  "sequence": 8,
  "payload": {
    "messageId": "msg_456",
    "delta": "继续生成的文本"
  }
}
```

约束：

- `eventId` 全局唯一，用于事件去重；
- `requestId` 关联一次普通请求或生成；`callId` 专用于工具调用；
- 同一流中的 `sequence` 单调递增；
- 时间统一使用 UTC ISO 8601；
- 未识别的可选字段应忽略并记录调试日志；
- 未识别的事件类型不得自动执行任何本地能力。

Main → Renderer 可以把多个已校验事件装入短时间片批次以减少 IPC 开销，但批次只是传输优化：每个事件仍保留自己的 `eventId/sequence`，Renderer 必须按批次内顺序逐项处理；不得把不同 `segmentId` 的文本拼成一个无法去重的伪事件。

**已确认说明（2026-08-08）：** 后端 v2 wire 事件是**扁平 JSON**（`{"type": "generation.delta", ...}`，无 `eventId/sequence/protocolVersion/occurredAt` 外壳）；上文的 `EventEnvelope` 是前端领域标准，由 `BackendAdapter` 在 Main 内解析 wire 后**盖戳补充**（`eventId/sequence` 单调生成、`occurredAt` 取接收时刻），再进 IPC。`protocolVersion` 取自握手 `server_info.protocol_version`（`2.0`），不为每条事件重复。

## 5. 连接与能力协商

### 5.1 已确认的后端 v2 握手（依据 §19 认证方式，frontend-handoff-v2 批次 7）

现有后端 v2 **不采用**下方旧版 JSON `ClientHello/ServerHello` 域握手，而是 **WS 握手头 + 三条连接帧**：

1. Electron Main 连 `/ws` 携带：`Authorization: Bearer <access_token>`（远程，本地空 token 为 fail-open）、`X-Protocol-Version: 2`、`X-Client-Platform: electron`（Desktop 工具桥定向投递标识）；
2. 建连后服务端依次下发：`session`（历史回放，含 `messages[]` + `token_stats?`）→ `server_info{protocol_version, server_version, features, services, connectionId?, build_sha?}` → `expression{expression, intensity?}`；
3. `server_info.features` 如实声明能力（`structured_generation`/`multi_conversation`/`desktop_runtime`/`dictation`/`voice_recording`/`voice_realtime`/`media_upload`，均为 bool），前端据此门控 UI，不超前实现；`connectionId` 仅 v2 + electron 下发（`conn_` 前缀），作为附件上传 `X-Client-Connection` 持有者校验头来源；`services.{llm,stt,tts}` 复用 per-service 形状（available/enabled/model/default）；
4. 多会话激活走 WS `activate_session{conversationId}` 或 REST `POST /api/sessions/{id}/activate`，服务端切 active 并重发该会话回放；未知会话 → `error{code: SESSION_NOT_FOUND}`。

`BackendAdapter.connect` 把上述握手归一为前端连接状态域（下方 5.2），不得把 `server_info`/`session`/`expression` 原始字段泄漏到 Vue 组件。

### 5.2 前端连接域模型（Adapter 输出，稳定语义）

```typescript
interface ConnectionState {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "offline" | "failed";
  protocolVersion?: string;   // server_info.protocol_version
  serverVersion?: string;     // server_info.server_version
  features?: string[];        // 由 server_info.features 展开（布尔 → 名称列表）
  connectionId?: string;      // server_info.connectionId（v2+electron）
  sessionId?: string;         // session 回放归属的活动会话
  resumeAccepted: false;      // 后端 v2 无断点续传（§16）
}
```

协商失败时停止工具调用，但可以根据后端能力决定是否允许只读聊天降级。

## 6. 会话数据结构

```typescript
interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
  status: "idle" | "generating" | "error";
  unreadCount?: number;
  tokenUsage?: TokenUsage;
  lastModel?: ModelIdentity;
  lastEmotion?: EmotionState;
  metadata?: Record<string, unknown>;
}

interface ConversationPage {
  items: Conversation[];
  nextCursor?: string;
  hasMore: boolean;
}
```

**已确认映射（2026-08-08，rest.py `SessionSummary`）：** 后端会话 wire 为 `SessionSummary{conversationId, title?, messageCount, updatedAt, active}`：

- `conversationId` ↔ 前端 `id`（默认 `"default"`，新建 `conv_<uuid4 hex[:12]>`）；`title` 可空（首条用户消息自动取前 20 字）；`messageCount` ↔ 前端会话的消息数（前端 `Conversation` 目前无此字段，可在 Adapter 补充）；`updatedAt` ↔ 前端 `updatedAt`；
- 后端**额外提供 `active`**（是否当前活动会话）——前端 `Conversation` 需增补该字段，多会话高亮依赖它；
- 后端会话列表无 `lastMessagePreview`/`tokenUsage`/`lastModel`/`lastEmotion`；会话级 Token 累计经 `generation.completed.conversationUsage` 或 `session` 回放的 `token_stats` 获取，非列表接口直接给出。

前端需要的逻辑操作：

| 操作 | 输入 | 输出 |
|---|---|---|
| 列出会话 | cursor、limit、query | `ConversationPage` |
| 获取会话 | conversationId、messageCursor?、messageLimit | `ConversationDetail`（会话与一页消息） |
| 获取消息上下文 | conversationId、messageId、before、after | 包含目标消息的 `MessagePage` |
| 查询聊天历史 | scope、query?、localDate?、timeZone、category、cursor、limit | `ChatHistoryPage` |
| 获取会话资源 | conversationId、mediaType?、cursor、limit | `ConversationResourcePage` |
| 创建会话 | 可选标题、agentId | `Conversation` |
| 重命名 | conversationId、title | 更新后的会话 |
| 删除 | conversationId | 成功确认 |

具体 URL 由后端适配器配置。

## 7. 消息数据结构

```typescript
type MessageRole = "user" | "assistant" | "system" | "tool";
type MessageStatus = "pending" | "streaming" | "completed" | "failed" | "cancelled";

interface Message {
  id: string;
  responseId?: string;
  clientMessageId?: string;
  conversationId: string;
  role: MessageRole;
  content?: MessagePart[];
  assistantSegments?: AssistantSegment[];
  model?: ModelIdentity;
  emotion?: EmotionState;
  tokenUsage?: TokenUsage;
  status: MessageStatus;
  createdAt: string;
  updatedAt?: string;
  error?: PublicError;
}

type MessagePart =
  | { type: "text"; text: string }
  | { type: "markdown"; markdown: string }
  | { type: "image"; attachmentId: string; alt?: string }
  | { type: "video"; attachmentId: string; durationMs?: number; posterAttachmentId?: string }
  | { type: "sticker"; stickerId: string; packId?: string; alt?: string }
  | { type: "file"; attachmentId: string; name: string }
  | { type: "audio"; attachmentId: string; durationMs?: number }
  | { type: "tool_call"; callId: string }
  | { type: "tool_result"; callId: string; summary?: string };

interface AssistantSegmentBase {
  segmentId: string;
  index: number;
  status: "streaming" | "completed" | "failed";
}

type AssistantSegment =
  | (AssistantSegmentBase & { channel: "inner_voice"; kind: "text" | "markdown"; text: string })
  | (AssistantSegmentBase & { channel: "public_reply"; kind: "text" | "markdown"; text: string })
  | (AssistantSegmentBase & { channel: "public_reply"; kind: "image" | "video" | "audio" | "file"; attachmentId: string })
  | (AssistantSegmentBase & { channel: "public_reply"; kind: "sticker"; stickerId: string; packId?: string })
  | (AssistantSegmentBase & { channel: "public_reply"; kind: "link"; url: string; label?: string });

interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cachedInput?: number;
  source: "provider_reported" | "server_aggregate" | "client_sum";
}

interface ModelIdentity {
  provider: string;
  model: string;
  displayName: string;
}

interface EmotionState {
  code: string;
  label: string;
  intensity?: number;
  source?: "model" | "rule" | "user";
}

interface MessagePage {
  items: Message[];
  nextCursor?: string;
  hasMore: boolean;
  order: "oldest_first";
  snapshotId?: string;
}

interface GetConversationQuery {
  conversationId: string;
  messageCursor?: string;
  messageLimit: number;
}

interface ConversationDetail {
  conversation: Conversation;
  messages: MessagePage;
}

interface MessageContextQuery {
  conversationId: string;
  messageId: string;
  before: number;
  after: number;
}
```

**已确认映射（2026-08-08，后端归档 wire 见 rest.py `Message`）：** 后端历史/搜索/资源接口返回的归档消息是**扁平 dict**，并非上面前端 `Message` 形状，字段为 `{role, parts, content, content_type?, inner_voice?, tool_calls?, token_usage?, message_id, timestamp, session_id, metadata, _id}`：

- `message_id` ↔ 前端 `messageId`（`msg_`）；`timestamp` ↔ `createdAt`；`_id` 为 Mongo 归档 ID（游标基准）；
- `inner_voice` 是**字符串**（整段内心独白），`content` 是 parts 列表或纯文本，`content_type` 是「内容类型 → 序号」映射；`tool_calls` 为工具消息字段；
- Adapter 必须把 `inner_voice` + `content` 归一化为前端 `assistantSegments[]`（inner_voice 段 + public_reply 段），**不得把归档 `inner_voice` 原文当独立字段展示**；归档消息无 `status/segmentId`，状态由 Adapter 按有无完成事件推导；
- 前端 `Message.status` 枚举含 `interrupted`；后端归档无此字段，由 Adapter 在重连回放时依据「消息无对应 `generation.completed`」推导（§16）。

约束：

- 用户发送前生成 `clientMessageId`，重试时保持不变；
- 后端返回正式 `id` 后建立映射；
- `inner_voice` 与 `public_reply` 属于同一条 Assistant 消息，并与多个按句切分的分段共享同一个 `responseId/messageId`；
- Assistant 可见正文只保存在 `assistantSegments`；不得把相同的 Inner Voice/Public Reply 再复制到 `content`。`content` 用于用户、系统、工具消息及后端兼容数据，Adapter 必须在入 Store 前归一化；
- `segmentId + index` 标识同一回复内的句子或多媒体分段；`segment.completed` 不得让前端结束整条回复；
- `model` 表示该条回复实际使用的模型，不能只展示设置页当前选择；
- `emotion.intensity` 若存在必须规范化到 0～1；未知 `code` 以安全的“未知/原始标签”展示，不得被解释为 CSS 类、动作文件或资源路径；
- `tokenUsage` 同时支持回复级与会话级累计，前端不得用字符数冒充服务端 Token；
- `cachedInput` 是 `input` 的子集，不重复加到 `total`；正常情况下 `total = input + output`，后端字段不满足时 Adapter 记录协议告警而不是在 UI 静默修正；
- 客户端只展示后端明确提供的 `inner_voice` 产品字段，不从内部推理、调试日志或其他隐藏字段推断内容；
- `inner_voice` 使用独立、可折叠的低强调区域，`public_reply` 是主要回复；
- P0 的 `inner_voice` 只接受 `text/markdown`；多媒体、表情和链接分段只允许进入 `public_reply`，避免隐藏区承载不可见下载或播放行为；
- 复制整条消息时需要让用户选择复制 Public Reply 或同时包含 Inner Voice；
- Markdown 原文保存，渲染结果不写入 Store；
- 二进制内容使用附件 ID，不放入 WebSocket JSON。

## 8. 用户发送消息

```typescript
interface SendMessageCommand {
  clientRequestId: string;
  clientMessageId: string;
  conversationId: string;
  content: MessagePart[];
  replyToMessageId?: string;
  requestedAgentId?: string;
}
```

前端行为：

1. 校验输入和附件状态；
2. 以 `pending` 乐观插入用户消息；
3. 发送命令；
4. 收到确认后绑定服务端消息 ID；
5. 未收到确认时允许使用同一 `clientRequestId` 重试；
6. 后端必须据此避免创建重复用户消息。

**已确认映射（2026-08-08，ws_message.py `V2TextMessage`）：** 后端 v2 发送 wire 为

```json
{"type":"text","content":"纯文本","clientRequestId":"req_…","clientMessageId":"msg_…"?,"conversationId":null?,"attachments":[…AttachmentRef]?,"stickerId":"st_…"?}
```

- `clientRequestId` **必填**（幂等键，缺省 → `user_message.ack{status:rejected, error:{code:CONTRACT_VALIDATION}}`）；`clientMessageId` 可缺省；
- 纯文本走 `content` 字符串；附件/表情走 `attachments: AttachmentRef[]` / `stickerId`（`st_` 前缀），与 content 可共存或独立（附件/sticker-only 消息触发生成）；**v2 不使用上面前端 `content: MessagePart[]` 多模态数组**（多模态走 v1 兼容路径）——Adapter 把前端的附件引用拆分到 `attachments`/`stickerId` 字段；
- 后端返回 `user_message.ack{messageId, clientRequestId, clientMessageId?, conversationId?, receivedAt, status(accepted/rejected), error?}`；rejected 时 `error{code, message, retryable}`；相同 `clientRequestId` + 同内容摘要重发原 ACK 不重复生成，异摘要 → 400 `CONTRACT_VALIDATION`。

## 9. 流式生成事件

### 9.1 开始

```typescript
interface GenerationStartedPayload {
  generationId: string;
  messageId: string;
  responseId: string;
  inReplyToMessageId?: string;
  model?: ModelIdentity;
  emotion?: EmotionState;
}
```

### 9.2 分段开始与增量

```typescript
interface GenerationSegmentBasePayload {
  generationId: string;
  messageId: string;
  responseId: string;
  segmentId: string;
  segmentIndex: number;
}

type GenerationSegmentStartedPayload =
  | (GenerationSegmentBasePayload & {
      channel: "inner_voice";
      kind: "text" | "markdown";
    })
  | (GenerationSegmentBasePayload & {
      channel: "public_reply";
      kind: "text" | "markdown" | "image" | "video" | "audio" | "file" | "sticker" | "link";
    });

interface GenerationDeltaBasePayload {
  generationId: string;
  messageId: string;
  responseId: string;
  segmentId: string;
  segmentIndex: number;
  deltaSequence: number;
  delta: string;
}

type GenerationDeltaPayload =
  | (GenerationDeltaBasePayload & {
      channel: "inner_voice" | "public_reply";
      kind: "text" | "markdown";
    })
  | (GenerationDeltaBasePayload & {
      channel: "status";
      kind: "status";
    });
```

后端按句切分时，每个句子使用独立 `segmentId`，但一次 AI 回复的所有句子必须共享 `responseId`。前端先按 `segmentIndex` 排列分段，再按 `deltaSequence` 合并同一分段的字符增量；不得按事件到达次数创建多条 Assistant 消息。`inner_voice` 和 `public_reply` 可以交错到达，仍以全局 `segmentIndex` 保持产品展示顺序。`status` 只显示公开状态摘要，不进入最终消息正文。

可选 `generation.segment.completed` 只把目标分段标为完成，允许流式处理器立即发送下一句；它不改变父消息的 `streaming` 状态。

### 9.3 完成

```typescript
interface GenerationCompletedPayload {
  generationId: string;
  messageId: string;
  responseId: string;
  finishReason: "stop" | "tool_calls";
  completedChannels?: Array<"inner_voice" | "public_reply">;
  usage?: TokenUsage;
  conversationUsage?: TokenUsage;
  model?: ModelIdentity;
  emotion?: EmotionState;
}
```

完成事件是整条逻辑回复的唯一结束信号。若后端不支持 `responseId`，适配器必须稳定地用 `messageId` 作为分组键；若后端只提供句子完成事件，必须补充父级完成语义或由适配器根据明确的终止事件映射，不能靠静默超时猜测。

若 `generation.completed` 到达时仍存在已知序列缺口，前端先进入“完成待校验”状态并请求续传/补页；在限定恢复窗口后仍缺失时，保留现有内容并标记“回复可能不完整”，不能假装完整，也不能因完成事件丢弃迟到但经验证属于缺口的增量。

`usage` 表示本次生成的实际用量；`conversationUsage` 表示后端定义的会话累计用量，不等于“当前上下文窗口大小”。优先展示后端累计值；后端未提供时，前端只能对去重后的已完成 generation 做明确标注为“本机累计”的求和，不能把重复完成事件、重试失败或字符估算计入真实 Token。

### 9.4 失败

```typescript
interface GenerationFailedPayload {
  generationId: string;
  messageId?: string;
  error: PublicError;
  retryable: boolean;
}
```

**已确认映射（2026-08-08，ws_message.py + traces/ws-v2-chat.jsonl）：** 后端 v2 流式 wire 与上文领域形状的差异汇总：

- 事件类型 `generation.started` / `generation.segment.started` / `generation.delta` / `generation.segment.completed` / `generation.completed` / `generation.failed` 与上文一一对应；
- **`responseId` 弃用，wire 一律用 `generationId`**（§19 D-1）；`segmentIndex` 全局单调（跨 inner_voice/public_reply 递增）；`delta` 携带段内增量（`deltaSequence` 段内 0 起）；
- `generation.segment.completed` **必发**（非可选）且携带 `content`（完整段/整句文本，public_reply 与 inner_voice 段都带）——前端无需拼 delta 即可渲染整句；Adapter 应透传该 `content`（前端 `SegmentCompletedEvent` 当前未建模此字段，见 §19 D-6）；
- `generation.completed` 是唯一终态：`finishReason` 仅 `stop`/`tool_calls`，取消/错误统一走 `generation.failed`（`GENERATION_CANCELLED`/`GENERATION_PROVIDER_UNAVAILABLE`/`GENERATION_TIMEOUT`/`INTERNAL`）；前端**不得**从 `state idle` 推断回复结束（§19 D-9）；
- 通道枚举含 `status`（预留）；`MessageChannel = inner_voice | public_reply | status`，前端 `SegmentChannel` 不含 status，Adapter 需映射/过滤（§19 D-7）；
- 完成事件载荷：`usage{turn_total, rounds[]}` + `conversationUsage?{total, byModel}` + `model`（实际模型快照）+ `mood`（心情）+ `completeness`（P0 恒 `complete`），见 §19 D-3~D-5。

## 10. 工具调用数据结构

```typescript
type ToolRuntime = "backend" | "desktop" | "local_worker";
type ToolRisk = "safe" | "medium" | "high";

interface ToolCall {
  callId: string;
  conversationId: string;
  parentMessageId?: string;
  toolName: string;
  runtime: ToolRuntime;
  arguments: unknown;
  reason: string;
  riskLevel: ToolRisk;
  permissionRequired: boolean;
  approvalAuthority: "backend" | "client";
  expiresAt?: string;
  status:
    | "requested"
    | "awaiting_permission"
    | "running"
    | "completed"
    | "failed"
    | "rejected"
    | "cancelled"
    | "timeout";
}
```

### 10.1 Desktop Runtime 请求

前端收到后依次执行：

1. 验证事件外壳；
2. 检查工具是否已注册；
3. 使用工具专属 Schema 校验 `arguments`；
4. 重新计算本地风险等级，不能只相信后端值；
5. 进入权限流程；
6. 执行、取消或拒绝；
7. 返回结构化结果；
8. 写入脱敏审计记录。

### 10.2 Backend Runtime 请求

前端不执行，只消费可选的 `tool.status` 和最终结果摘要。若后端明确发送由用户决定的服务端审批，`approvalAuthority` 为 `backend`，前端可以展示“服务器操作审批”并把决定回传后端，但不得把它当作 Desktop 本地授权或写入本地目录/命令 Grant。后端内部敏感参数不得发送给客户端。

### 10.3 工具结果

```typescript
interface ToolResult {
  callId: string;
  runtime: ToolRuntime;
  success: boolean;
  result?: unknown;
  attachments?: AttachmentRef[];
  error?: PublicError;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
```

工具输出同样需要专属 Schema。超大内容或图片使用附件，不直接塞入 `result`。

**已确认映射（2026-08-08，protocol-v2 §10 + rest.py）：** 后端 Desktop 工具桥与上文领域形状对齐情况：

- 四个 P0 Desktop 工具已注册（`desktop.file.select/read/write` + `desktop.screen.capture`，`runtime="desktop"`、`approvalAuthority="client"`）；**`desktop.command.run` 未注册**——与本项目范围一致；
- Server→Client 请求 wire `tool.request{callId, toolName, toolVersion, runtime, arguments, reason?, riskLevel(safe/medium/high), permissionRequired, approvalAuthority, paramHash, expiresAt, requestId?}`；`paramHash` = 规范化 `arguments` 的 SHA-256，**Electron 回传时不得篡改**（不一致后端即拒绝）；
- Client→Server 回传 `tool.status{callId, status(accepted/rejected/running/result/error/cancelled), toolName, toolVersion, runtime, paramHash, output?, error?, attachments?, executionSummary?}`；`result`/`error`/`rejected`/`cancelled` 为终态，`accepted`/`running` 仅推进状态；桌面附件先 `POST /api/uploads/desktop/{callId}` 上传（带 `X-Client-Connection` 头）再回填 `attachments[]`；
- 状态查询 `GET /api/tools/calls/{callId}` → `DesktopCallStatus`，repo 枚举比前端 `ToolCall.status` 多 `expired/offline`（服务端半终态）；`timeout` 语义后端以 `expired` 表达；
- 注册表 `GET /api/tools` → `ToolRegistryResponse{tools: ToolMetadata[], desktopAvailable}`，Electron 据此校验「只接受已注册工具和版本」；
- **后端审批** `tool_approval`（v1 后端工具）仅 v2 连接带 enrich 字段；Desktop 工具不走 `tool_approval`，由 Electron 本地授权（§10.2 语义不变）。

## 11. 附件

```typescript
interface AttachmentRef {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

interface PendingAttachment {
  localId: string;
  source: "picker" | "drag_drop" | "paste";
  displayName: string;
  size: number;
  mediaType: string;
  status: "selected" | "uploading" | "ready" | "failed" | "cancelled";
  progress?: number;
  remote?: AttachmentRef;
}

interface ConversationResourceBase {
  resourceId: string;
  conversationId: string;
  messageId: string;
  responseId?: string;
  segmentId?: string;
  createdAt: string;
}

type ConversationResource =
  | (ConversationResourceBase & {
      type: "image" | "video" | "audio" | "file";
      attachment: AttachmentRef;
      thumbnailAttachmentId?: string;
    })
  | (ConversationResourceBase & {
      type: "sticker";
      stickerId: string;
      packId?: string;
      thumbnailAttachmentId?: string;
    })
  | (ConversationResourceBase & {
      type: "link";
      url: string;
      label?: string;
    });

interface ConversationResourcePage {
  items: ConversationResource[];
  nextCursor?: string;
  hasMore: boolean;
}

type ChatHistoryScope =
  | { type: "conversation"; conversationId: string }
  | { type: "all_conversations" };

interface ChatHistoryQuery {
  scope: ChatHistoryScope;
  query?: string;
  localDate?: string;
  timeZone: string;
  category: "all" | "image_video" | "sticker" | "file" | "audio" | "link";
  cursor?: string;
  limit: number;
}

interface ChatHistoryItem {
  hitId: string;
  conversationId: string;
  messageId: string;
  responseId?: string;
  segmentId?: string;
  senderLabel: string;
  snippet?: string;
  resource?: ConversationResource;
  createdAt: string;
  sortKey: string;
}

interface ChatHistoryPage {
  items: ChatHistoryItem[];
  nextCursor?: string;
  hasMore: boolean;
  snapshotId?: string;
}
```

上传流程：选择文件 → 本地校验 → 用户确认上传 → 获取上传信息 → 上传 → 校验结果 → 获得附件 ID → 发送消息引用。

**已确认映射（2026-08-08，protocol-v2 §13 + rest.py）：** 后端附件体系完整落地，与上文领域形状对齐：

- 上传 `POST /api/uploads`（multipart `files[]` + 可选 `kind`，**魔数真值校验**，≤10 文件，image 10MB / video 50MB / audio 20MB / file 20MB，聚合 64MB）→ `AttachmentUploadResponse{attachments: AttachmentInfo{attachmentId, kind, mime, size, url, signedUrl?, filename}}`；
- 前端 `AttachmentRef{id,name,mediaType,size}` 对应 wire `AttachmentInfo`；`sha256` 后端**不回传**（上传时服务端落 sha256，响应无该字段），前端如需完整性由本地计算；
- 下载 `GET /api/attachments/{id}?sig=&exp=`（**免 Bearer，签名即授权**，原生 Range/206）；渲染层对稳定路径 `/api/attachments/{id}` 经 `GET /api/attachments/{id}/sign`（Bearer）拿 24h 短签 URL，缓存 + 过期重取，**前端不接触 `ATTACHMENT_SIG_SECRET`、不自行算签名**；
- 消息关联 wire `attachments: AttachmentRef{attachmentId, kind, mime}[]`（kind/mime 为提示值）+ `stickerId`（`st_` 前缀，走公开静态 `/static/stickers/{id}.png`，非附件）；发送时服务端以 `attachments` 集合记录为准；
- `ConversationResource` 对应 REST `GET /api/sessions/{id}/resources?category=image|link|video|audio|file|sticker` → `ResourceItem{messageId, timestamp, kind, url}`（附件项为稳定路径，渲染层经签发解析）；后端 `ResourceItem` 无 `resourceId/segmentId`，前端由 `messageId` 跳转来源。

拖拽只是附件选择入口：`drop` 后先创建 `PendingAttachment(source: "drag_drop")`，不得立即上传或发送。点击选择、拖拽和粘贴必须走相同的大小、类型、数量、路径脱敏、取消和上传状态机。

本地绝对路径不得出现在发给后端的消息正文中。

历史消息、统一聊天历史查看器和资源分类均使用不透明游标分页。查看器使用同一 `ChatHistoryQuery` 支持当前会话/全部会话、关键词、本地自然日和分类组合过滤。`localDate` 使用 `YYYY-MM-DD`，必须同时传 IANA `timeZone`；Adapter 将其转换为后端需要的半开时间区间 `[start, nextDayStart)`，避免 UTC 跨日错误。向上加载更早消息时返回稳定排序键，前端据此保持滚动锚点。搜索命中必须返回可跳转的 `messageId`，分段命中尽量同时返回 `segmentId`；资源和表情项应能跳回来源消息。`snapshotId` 可用于避免查询期间新消息导致分页重复或漏项。

## 12. Live2D 指令

```typescript
interface Live2DDirective {
  expression?: string;
  motion?: string;
  state?: "idle" | "listening" | "thinking" | "speaking" | "happy" | "sad" | "surprised" | "error";
  priority?: 0 | 1 | 2 | 3;
  durationMs?: number;
}
```

前端只把该结构视为表现建议：必须检查名称白名单、优先级和持续时间，后端不能提供本地资源路径或脚本。

**已确认映射（2026-08-08）：** 后端建连下发 `expression{expression, intensity?}`（当前心情）；流式中心情经 `generation.completed.mood` 落位；v1 `capabilities.live2d_static_image` 提供 Live2D 静态图路径（v2 由 `server_info.services` 取代 capabilities，静态图字段在 v1 保留）。`expression` 字段是心情**代码/标签**（如「开心」），不是 CSS 类或资源路径——前端经本地映射表转 `Live2DDirective`，未知代码以「未知/原始标签」安全展示（§7 约束同款规则）。

## 13. 模型服务与语音数据结构

设置页面管理 LLM、STT 和 TTS 三类模型服务。输入法转写是 STT 的独立使用场景配置，可以选择与直接语音输入不同的 STT Profile，但不是第四种模型服务类型。

模型执行位置与工具调用 Runtime 是两个不同概念。模型侧使用独立类型 `ModelExecutionLocation`；只有模型随后发出工具调用时，才进入 `ToolRuntime` 状态机。

```typescript
type ModelServiceType = "llm" | "stt" | "tts";
type ModelExecutionLocation = "backend" | "desktop" | "local_worker";

interface ModelProfile {
  id: string;
  type: ModelServiceType;
  displayName: string;
  source: "built_in" | "custom";
  provider: string;
  model: string;
  protocol: "openai_compatible" | "custom_rest" | "local_worker" | "bundled_local";
  executionLocation: ModelExecutionLocation;
  endpointLabel?: string;
  credentialOwner: "backend" | "desktop_main" | "local_worker" | "none";
  credentialStatus: "missing" | "configured" | "expired";
  enabled: boolean;
  capabilities?: string[];
}

interface UpsertCustomModelProfileCommand {
  profileId?: string;
  type: ModelServiceType;
  displayName: string;
  provider: string;
  model: string;
  protocol: "openai_compatible" | "custom_rest" | "local_worker" | "bundled_local";
  executionLocation: ModelExecutionLocation;
  endpoint?: string;
  credentialInput?: { value: string; replaceExisting: boolean };
  capabilities?: string[];
  makeActive?: boolean;
}

interface ActiveModelSelection {
  llmProfileId?: string;
  voiceSttProfileId?: string;
  ttsProfileId?: string;
  dictationSttProfileId?: string;
}

interface TestModelProfileCommand {
  profileId: string;
  testKind: "connectivity" | "inference" | "transcription" | "synthesis";
}

interface ModelProfileTestResult {
  profileId: string;
  success: boolean;
  latencyMs?: number;
  sampleText?: string;
  audioAttachmentId?: string;
  error?: PublicError;
}

interface DictationSettings {
  enabled: boolean;
  sttProfileId: string;
  language?: string;
  insertMode: "cursor" | "append";
  discardAudioAfterFinal: true;
}
```

前端读取凭据状态，不在普通响应中取回已保存的密钥明文。自定义 LLM/STT/TTS Profile 的创建、更新、测试、激活和删除使用独立命令；创建和更新必须幂等，密钥作为一次性输入提交并在成功或失败后从 Renderer 表单清除。凭据交给 `credentialOwner` 对应的安全边界保存，不能因切换 Profile 在后端、Main 和 Worker 之间复制。

`executionLocation: "desktop"` 表示在用户电脑侧执行：远程自定义 Provider 请求由 Main 代理并保管凭据；纯本地模型可以在经过校验的本地或渲染 Worker 中运行。Renderer 不得获得远程 Provider 密钥，也不得从聊天内容动态加载模型代码。

**已确认映射（2026-08-08，protocol-v2 §11 + rest.py）：** 后端 `/api/providers` 提供三类 Profile（llm/stt/tts）+ 自定义端点，与上文领域形状对齐：

- `GET/POST /api/providers` → `ProvidersResponse{llm, stt, tts, custom, unconfigured}`；条目含 `models` + `credentialConfigured`（后端 Secret Store 或 env 已配置 / local 恒 true）+ `runtime`（内置恒 `backend`；custom 可 `backend/desktop/local_worker`）+ `capabilities`；
- 前端 `ModelProfile.credentialStatus(missing/configured/expired)` ↔ 后端 `credentialConfigured`（bool）；`id` ↔ provider 键（内置名或 `custom/{name}`）；`executionLocation` ↔ `runtime`；**凭据一次提交入后端 Secret Store（`data/secrets/`，0600 + gitignore）永不读回**，与前端「凭据只写不可读」约束一致；
- 保存 `POST /api/providers`（custom 同名更新幂等；backend 条目 `base_url` 必填 + SSRF 校验）；测试 `POST /api/providers/test`（`base_url` 非空一律 SSRF 校验）→ `ProviderTestResult{ok, latency_ms?, error?, detail?}`；切换 WS `switch_model{service, model}` / `set_service{service, enabled}` / `set_tts_voice{voice}`；
- 删除激活中 profile → 409 `PROFILE_IN_USE`；非 backend runtime 携带 `api_key` → 400 `PROFILE_INVALID_RUNTIME`；对 desktop/local 条目执行后端 test/switch → 400 `PROFILE_RUNTIME_NOT_BACKEND`（后端不代理本机 Profile，与本项目「Desktop Profile 密钥归 Electron」一致）；
- TTS 声音 `GET /api/tts/voices`（含 `current`/`source`）+ 试听 `POST /api/tts/preview`（固定短文本，不读真实聊天）。

### 13.1 音频传输公共结构

```typescript
type AudioCodec = "pcm_s16le" | "opus" | "webm_opus" | "wav" | "mp3" | "aac";

interface AudioStreamDescriptor {
  sessionId: string;
  codec: AudioCodec;
  sampleRate: number;
  channels: 1 | 2;
  chunkDurationMs?: number;
}

interface AudioChunkMeta {
  sessionId: string;
  sequence: number;
  durationMs: number;
  isFinal: boolean;
}
```

JSON 只传描述符、控制事件和块元数据；原始音频使用附件上传或与 `sessionId/sequence` 关联的受控二进制帧，不能 Base64 塞入普通事件 JSON。实时链路必须定义最大未确认块数、背压、乱序/丢块、暂停、取消和最终块规则。普通录音优先走附件上传；录音、实时输入、输入法转写和 TTS 使用不同 `sessionId/playbackId`。

### 13.2 直接语音输入

普通录音输入和实时语音会话都属于直接语音交互。STT 可以提供字幕，但字幕不会修改文字输入框。

```typescript
interface VoiceInputSession {
  sessionId: string;
  mode: "recorded" | "realtime";
  sttProfileId?: string;
  state: "starting" | "listening" | "processing" | "ready_to_send" | "active" | "completed" | "failed" | "cancelled";
}

interface VoiceCaptionEvent {
  sessionId: string;
  kind: "partial" | "final";
  text: string;
  sequence: number;
  startedAtMs?: number;
  endedAtMs?: number;
}

interface RecordedVoiceInputReadyEvent {
  sessionId: string;
  attachmentId: string;
  durationMs: number;
  caption?: string;
}
```

普通模式停止后生成待发送的音频输入，由用户确认发送；实时模式在用户明确启动的会话中按已确认的 VAD/断句规则提交语音轮次。`VoiceCaptionEvent` 只能进入字幕状态，不得合并到 `ConversationDraft.text`。

**已确认映射（2026-08-08，protocol-v2 §12，三种语音均 v2-only）：** 后端把「唯一 WS BINARY → VAD 自动提交」链路拆成三种隔离模式，与上文领域形状对齐：

- **普通录音**：`voice.record.start{recordingId(rec_)}` → BINARY PCM（全段缓冲，不 VAD）→ `voice.record.stop{recordingId}` → `voice.transcript{recordingId, text, emotion?}`（PENDING 字幕）→ `voice.commit{recordingId, text, clientRequestId, clientMessageId?, conversationId?}`（幂等，text 为确认文本）→ `user_message.ack` + generation.*；`voice.discard{recordingId}` 丢弃；音频**不落盘、不入消息**；
- **实时语音**：`voice_session.start{sessionId(vs_), conversationId?}` → `voice_session.started{sessionId, conversationId?}` → BINARY PCM（VAD 分段）→ `voice_session.partial{sessionId, turnId, segmentIndex, text}`（字幕）→ `voice_session.turn{sessionId, turnId, messageId, conversationId?, text}`（自动提交触发 generation，多轮只响应最后一轮为预期）→ pause/resume/stop/cancel → `voice_session.ended{sessionId, reason(stopped|cancelled|timeout|stt_disabled)}`；`voice_session.ack{sessionId, seq}` 背压；
- **输入法转写**：`dictation.start{clientRequestId}` → BINARY PCM → `dictation.partial{text}`（累积字幕）→ `dictation.stop{clientRequestId}` → `dictation.final{clientRequestId, text}`（**只回文字、零消息副作用**）→ 前端据此写草稿；`dictation.cancel` → `dictation.cancelled`；
- 无活动会话再 start → `VOICE_SESSION_CONFLICT`；`agent.stt` 未启用 → `STT_UNAVAILABLE`；未知 sessionId → `VOICE_SESSION_NOT_FOUND`（见 §14 错误目录）。

### 13.3 输入法转写

```typescript
interface DictationSession {
  sessionId: string;
  sttProfileId: string;
  executionLocation: ModelExecutionLocation;
  state: "holding" | "transcribing" | "completed" | "failed" | "cancelled";
  discardAudioAfterFinal: true;
}

interface DictationFinalEvent {
  sessionId: string;
  text: string;
  insertMode: "cursor" | "append";
}
```

输入法转写按住期间采集临时音频，松开后只把 `DictationFinalEvent.text` 写入当前聊天草稿，不创建语音 `MessagePart`，也不自动发送。它通过 `dictationSttProfileId` 选择兼容 STT Profile；若执行位置为后端，开始前必须明确提示音频将离开设备；本机或 Local Worker 执行时展示模型可用性、下载和资源占用。取消、失败或会话切换不得把残余音频或文字写到其他会话。

### 13.4 TTS 播放

```typescript
interface TtsPlaybackSession {
  playbackId: string;
  messageId?: string;
  profileId: string;
  delivery: "attachment" | "stream";
  state: "starting" | "buffering" | "playing" | "paused" | "completed" | "failed" | "cancelled";
  audio?: AudioStreamDescriptor;
  attachmentId?: string;
}

interface TtsChunkEvent {
  playbackId: string;
  sequence: number;
  durationMs: number;
  isFinal: boolean;
}
```

整段 TTS 通过音频附件播放；流式 TTS 使用有序二进制块和独立缓冲区。切换消息、停止生成或用户点击停止时，必须取消对应 `playbackId`、清空未播放缓冲并把 Live2D 嘴部值平滑归零。TTS 默认只朗读 Public Reply，不把 Inner Voice 发送给 TTS Provider。

**已确认映射（2026-08-08，protocol-v2 §12.5）：** 后端 TTS 播放 wire 以 `stream_id` 为 playback ID（全链路统一键）：

- `audio_start{stream_id, format(wav/mp3), sampleRate?, durationMs?}` → `audio{stream_id, seq, data(base64), is_final}` ×N → `audio_end{stream_id}`（**字节全发 ≠ 播完**，播放完成由前端本地 `onended` 判定，不引入上行回执）；
- 取消：客户端 `audio.cancel{stream_id}`（v2-only **全局**播放操作）→ 服务端 `audio_cancelled{stream_id}`（前端清理孤儿 chunk）；未知/已结束 stream_id → 可忽略良性 `error{PLAYBACK_NOT_FOUND}`；
- 前端 `TtsPlaybackSession.playbackId` ↔ wire `stream_id`；`TtsChunkEvent.sequence` ↔ wire `seq`；二进制数据走 `data` 字段（base64），不另建附件。

## 14. 错误结构

```typescript
interface PublicError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
}
```

建议前端统一识别：

```text
AUTH_FAILED
AUTH_EXPIRED
PROTOCOL_UNSUPPORTED
INVALID_PAYLOAD
CONVERSATION_NOT_FOUND
GENERATION_INTERRUPTED
CAPABILITY_UNAVAILABLE
PERMISSION_DENIED
TOOL_TIMEOUT
TOOL_CANCELLED
TOOL_EXECUTION_FAILED
FILE_CONFLICT
ATTACHMENT_TOO_LARGE
UPLOAD_FAILED
RATE_LIMITED
SERVER_UNAVAILABLE
```

`message` 用于展示安全、简短的说明；调试细节通过 `traceId` 关联后端日志。

**已确认映射（2026-08-08，protocol-v2 §9.1 + rest.py `ProtocolError`）：** 后端已有统一错误信封与 **40 码目录**：

- wire 形状：WS `error` 帧 / `ErrorMessage{message, code?, requestId?, retryable?, details?}`；REST `ProtocolError{code, message, retryable, requestId, error(=message 兼容别名), details}`；`generation.failed{code, message, retryable, details}`；`user_message.ack{rejected}` 带 `error{code, message, retryable}`；
- 前端 `PublicError.code` 应**透传后端稳定错误码**（如 `AUTH_REQUIRED`/`SESSION_NOT_FOUND`/`CONTRACT_VALIDATION`/`GENERATION_CANCELLED`/`SSRF_BLOCKED`/`ATTACHMENT_NOT_FOUND`/`STORAGE_UNAVAILABLE` 等），上文「建议统一识别」清单是前端语义分类参考；Adapter 在 Main 内做「后端码 → 前端语义」映射表，不得让 40 个原始码散落进组件；
- `retryable` 由后端提供（真值），前端重试策略依此判断；`requestId`/`traceId` 关联日志与幂等排查（WS 侧 `ErrorMessage.requestId` 可缺省，批次 7）；
- 关键码：认证 `AUTH_REQUIRED`/`AUTH_INVALID`（401）；会话 `SESSION_NOT_FOUND`（404）/`SESSION_PROTECTED`（409，删除 `default` 禁删）；生成 `GENERATION_PROVIDER_UNAVAILABLE`/`GENERATION_TIMEOUT`（retryable）/`GENERATION_CANCELLED`/`INTERNAL`；语音 `VOICE_SESSION_CONFLICT`/`VOICE_SESSION_NOT_FOUND`/`STT_UNAVAILABLE`/`DICTATION_NOT_FOUND`/`VOICE_RECORDING_TOO_LONG`；附件 `ATTACHMENT_NOT_FOUND`/`SIGNATURE_EXPIRED`/`INVALID_SIGNATURE`/`UNSUPPORTED_MEDIA_TYPE`/`TOO_MANY_FILES`/`STORAGE_UNAVAILABLE`/`QUEUE_FULL`；Profile `PROFILE_IN_USE`/`PROFILE_INVALID_RUNTIME`/`PROFILE_RUNTIME_NOT_BACKEND`/`SSRF_BLOCKED`；限流 `RATE_LIMITED`/`CONNECTION_LIMITED`/`REQUEST_TOO_LARGE`。

## 15. 确认、顺序和幂等

- 每个客户端命令具有稳定的 `clientRequestId`；
- 每个事件具有唯一 `eventId`；
- 每个生成和工具调用具有独立 `requestId` 或 `callId`；
- 同一流使用 `sequence` 检测缺失和乱序；
- 重复事件只更新确认状态，不重复产生副作用；
- `desktop.file.write`、截图和上传等副作用操作必须按 `callId` 幂等；
- 已拒绝的调用重连后保持拒绝，不重新弹窗；
- 参数相同但 `callId` 不同，仍视为新的请求并重新授权。

## 16. 重连与恢复

### 16.1 连接状态

```text
idle → connecting → connected
           ↓            ↓
         failed ← reconnecting
                         ↓
                       offline
```

### 16.2 恢复规则（已按后端 v2 现状确认，2026-08-08）

- 指数退避并加入随机抖动；认证失败不无限自动重试；
- **后端 v2 无断点续传（protocol-v2 §6）**：重连后经 WS `session` 回放获取历史（消息含稳定 `messageId`，与 ACK/completed 对齐），**不携带** `sessionId`/事件 ID 续流；
- **中断判定**：v2 源连接在生成中断开 → 服务端取消在途 generation（部分消息保留）；客户端据回放判断——回放中消息未见对应 `generation.completed` → 视为中断，用**新 `clientRequestId`** 重新生成；
- 流式消息保留已接收内容并标记「连接中断」；`pending` 用户消息经 `GET /api/sessions/{id}/pending`（pendingMessages 按会话 + pendingApprovals 全局）查询确认状态；
- generation 在途/终态状态可经 `GET /api/sessions/{id}/generations` / `GET /api/generations/{gid}` 查询；
- 待授权工具调用重连后先经 `GET /api/tools/calls/{callId}` 查询状态，禁止自动执行；重连**不自动重投**执行请求（防重复副作用），仅可查/可重传 result；
- Main 进程重启后不恢复未经用户重新确认的高风险操作。

## 17. 前端事件处理规则

| 事件 | 目标模块 | 主要动作 |
|---|---|---|
| connection.changed | App Store | 更新在线状态 |
| conversation.changed | Conversation Store | 合并会话摘要 |
| generation.started | Chat Store | 创建流式消息 |
| generation.segment.started | Chat Store | 在父回复内创建有序分段 |
| generation.delta | Chat Store | 按 `segmentId/deltaSequence` 追加增量 |
| generation.segment.completed | Chat Store | 只完成目标分段 |
| generation.completed | Chat/Conversation Store | 完成父回复并更新消息/会话 Token、模型和心情 |
| generation.failed | Chat Store | 保留内容并展示错误 |
| resource.changed | Resource Store | 合并会话媒体、表情、文件和链接索引 |
| tool.call | Tool Store / Main | 注册调用并路由 Runtime |
| tool.status | Tool Store | 更新工具卡片 |
| live2d.directive | Live2D Store | 校验后映射表现 |
| model.profile.changed | Model Service Store | 更新 LLM/STT/TTS Profile 与当前选择 |
| voice.caption | Voice Store | 更新直接语音会话的临时或最终字幕，不修改草稿 |
| voice.input.ready | Voice/Attachment Store | 建立待发送录音输入 |
| dictation.final | Voice/Conversation Store | 将最终听写文字插入目标会话草稿 |
| tts.playback.changed | Voice/Live2D Store | 更新缓冲、播放、停止和口型联动状态 |
| error | 对应请求 Store | 转换为可展示错误 |

## 18. 安全规则

- 只连接配置的 HTTPS/WSS 服务；
- 不因调试需要忽略 TLS 错误；
- Token 不放入 URL 查询参数或普通日志；
- 所有 JSON 均设置大小和深度限制；
- Markdown 和链接经过安全处理；
- 工具参数不能包含可执行代码并要求客户端解释执行；
- 后端声明 `permissionRequired: false` 不覆盖本地权限策略；
- Desktop/Local Worker 调用的 `approvalAuthority` 必须为 `client`；Backend 调用不得借用本地范围授权；
- 模型服务凭据不通过普通模型 Profile 返回到 Renderer，模型执行位置与工具 Runtime 不混用；
- 语音原始数据、转写和 Inner Voice 默认不进入普通日志；
- 未注册工具、未知 Runtime 和未知高风险事件默认拒绝。

## 19. 与现有后端对齐清单

下表“现有后端值”依据后端交接包 **`frontend-handoff-v2`（批次 7 时点）** 填写：协议契约以 `docs/electron-backend-protocol-v2.md`（v0.6，40 错误码）为准，wire 字段形状以 `frontend_contract/`（ws_message.py / rest.py，Pydantic 单源包）为准，真实轨迹见 `frontend-handoff-v2/traces/`。状态：已记录、**已真实联调**（B-01 2026-08-14 十项复跑通过，见 `docs/review/2026-08-14-Windows-Electron-第三次真实联调前端阻断.md`）。

| 核对项 | 现有后端值 | 前端映射 |
|---|---|---|
| 认证方式 | WS/REST 均 Bearer：`Authorization: Bearer <access_token>`（`AGENT_ACCESS_TOKEN` 配置时匿名 401；本地空 token 为 fail-open）；WS 建连附加 `X-Protocol-Version: 2` + `X-Client-Platform: electron`；建连帧 `session → server_info{protocol_version, server_version, features, services, connectionId, build_sha} → expression` | `BackendAdapter.connect` |
| 会话列表接口 | `GET /api/sessions`（cursor/limit/search，items 带 `active`）/ `POST /api/sessions`（创建 `conv_<uuid4>`）→ `SessionListResult{sessions, has_more, cursor}`；兼容旧 `GET /api/messages` 全库 `_id` 游标 | `listConversations` |
| 历史消息接口 | `GET /api/sessions/{id}/messages`（`before` 倒序 keyset + `has_more` + `total`）；`GET /api/sessions/{id}/messages?after={messageId}` 正序增量 | `getConversation` |
| 历史消息游标与稳定排序键 | 会话内 `before={_id}`（Mongo 24 位十六进制 ObjectId，倒序 keyset）/ `after={messageId}`（`msg_` 稳定业务键，正序增量）；会话列表 cursor = base64(`updated_at\|session_id`)；消息稳定键 `messageId`（`msg_`），`_id` 仅作历史游标不暴露为 UI messageId | `MessagePage.nextCursor` |
| 按消息 ID 获取上下文 | `GET /api/messages/{mid}/context?conversationId&before=5&after=5` → `MessageContextResponse{anchor, before, after, conversationId}` | `getMessageContext` / `MessageContextQuery` |
| 会话搜索/聊天历史查询接口 | `GET /api/search/messages`（`query/conversationId/date_from/date_to/timezone/category/cursor/limit`，上限 100）→ `SearchMessagesResponse{items, has_more, cursor}`（cursor=base64(`timestamp\|_id`)；item 含 `responseId` best-effort） | `listConversations` / `ChatHistoryPage` |
| 会话多媒体资源接口 | `GET /api/sessions/{id}/resources`（`category=image\|link\|video\|audio\|file\|sticker`）→ `ResourceListResponse{items{messageId, timestamp, kind, url}, has_more, cursor}`；附件项为稳定路径，渲染层经签发端点解析签名 URL | `ConversationResourcePage` |
| 用户消息发送 | WS v2 `{"type":"text","content","clientRequestId"(必填幂等键),"clientMessageId"?,"conversationId"?,"attachments"?,"stickerId"?}` → `user_message.ack{messageId, clientRequestId, clientMessageId?, conversationId?, receivedAt, status(accepted/rejected), error?}`；相同 `clientRequestId` + 同摘要重发原 ACK 不重复生成 | `sendMessage` |
| 流式传输方式 | WS（`X-Protocol-Version: 2`，非 SSE/HTTP）；`generation.*` 事件帧 | `generation.*` |
| 消息增量字段 | `generation.delta{generationId, segmentId, segmentIndex, deltaSequence(段内 0 起), delta, conversationId?}` | `GenerationDeltaPayload` |
| Inner Voice 字段与增量规则 | `generation.segment.started/completed` 带 `channel:"inner_voice"`、`kind:"text"/"markdown"`；增量走 `generation.delta`；`segment.completed.content` 携带整段文本 | `channel: inner_voice` |
| Public Reply 字段与增量规则 | `channel:"public_reply"`；一段 = 一句（PRD BE-022），每句独立 `segmentId` 与全局 `segmentIndex`；`segment.completed.content` 携带整句文本，客户端无需拼 delta | `channel: public_reply` |
| 句子分段 ID、顺序和父回复完成事件 | `segmentId`(seg_) / `segmentIndex`(全局单调) / `generationId`(gen_；**`responseId` 弃用，别名 generationId**)；`generation.completed` 是唯一终态（`finishReason` 限 stop/tool_calls），取消/错误走 `generation.failed` | `responseId/segmentId/segmentIndex` |
| 消息/会话 Token、实际模型和心情字段 | `generation.completed{usage:{turn_total, rounds[{model, input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens, round_num, timestamp}]}, conversationUsage?{total, byModel}, model(实际模型快照), mood, completeness}` | `TokenUsage/ModelIdentity/EmotionState` |
| 停止生成接口 | WS `{"type":"interrupt"}` → `generation.failed{code:GENERATION_CANCELLED}` + `state interrupted` → `idle`；迟到增量被服务端停止 | `cancelGeneration` |
| 工具调用字段 | Server→Client `tool.request{callId(call_), toolName, toolVersion, runtime(desktop), arguments, reason?, riskLevel(safe/medium/high), permissionRequired, approvalAuthority(client), paramHash(规范化 arguments SHA-256), expiresAt, requestId?}`；注册表 `GET /api/tools` → `ToolRegistryResponse{tools: ToolMetadata[16], desktopAvailable}`；`desktop.command.run` 不注册 | `ToolCall` |
| 工具结果接口 | Client→Server `tool.status{callId, status(accepted/rejected/running/result/error/cancelled), toolName, toolVersion, runtime, paramHash, output?, error?, attachments?, executionSummary?}`（toolName/version/runtime/paramHash 不一致即篡改拒绝）；查询 `GET /api/tools/calls/{callId}` → `DesktopCallStatus`；桌面附件 `POST /api/uploads/desktop/{callId}`（`X-Client-Connection` 持有者校验） | `submitToolResult` |
| 附件上传流程 | `POST /api/uploads`（multipart `files[]` + `kind`?，魔数真值校验，≤10 文件，image 10MB/video 50MB/audio 20MB/file 20MB，聚合 64MB）→ `AttachmentUploadResponse{attachments: AttachmentInfo{attachmentId, kind, mime, size, url, signedUrl?, filename}}`；签名下载 `GET /api/attachments/{id}?sig=&exp=`（免 Bearer，Range/206）；签发 `GET /api/attachments/{id}/sign`（Bearer）；消息关联 `attachments: AttachmentRef[]` / `stickerId` | `AttachmentRef` |
| LLM/STT/TTS Profile 配置接口 | `GET/POST /api/providers` → `ProvidersResponse{llm, stt, tts, custom, unconfigured}`（条目含 `credentialConfigured` / `runtime` / `capabilities`）；WS `switch_model{service, model}` / `set_service{service, enabled}`；TTS `GET /api/tts/voices` + `POST /api/tts/preview` + WS `set_tts_voice{voice}` | `ModelProfile` |
| 自定义模型新增/编辑/删除 | `POST /api/providers`（custom 条目，同名更新；`api_key` 一次性提交入 Secret Store **永不读回**，非 backend runtime 带 key → 400 `PROFILE_INVALID_RUNTIME`）；删除激活中 profile → 409 `PROFILE_IN_USE` | `UpsertCustomModelProfileCommand` |
| 模型连接测试与切换接口 | `POST /api/providers/test`（base_url 非空一律 SSRF 校验）→ `ProviderTestResult{ok, latency_ms?, error?, detail?}`；切换经 WS `switch_model` / `set_tts_voice` → `switch_model_result` / `set_tts_voice_result{ok, error?}` | `ModelProfileTestResult` |
| 输入法转写专用 STT 选择 | **无独立字段（待对齐）**：后端 `dictation.start` 仅带 `clientRequestId`，转写用**当前活动 STT**；前端 `dictationSttProfileId` 需在 start 前经 `switch_model{service:"stt"}` / `set_service` 切到目标 STT | `dictationSttProfileId` / `DictationSettings` |
| 普通录音输入与发送确认 | WS `voice.record.start{recordingId(rec_)}` → BINARY PCM ×N（全段缓冲）→ `voice.record.stop{recordingId}` → `voice.transcript{recordingId, text, emotion?}` → `voice.commit{recordingId, text, clientRequestId, clientMessageId?, conversationId?}` → `user_message.ack` + generation.*（复用字幕文本不重转写）；`voice.discard{recordingId}` | `VoiceInputSession` / `RecordedVoiceInputReadyEvent` |
| 实时语音字幕、断句与轮次提交 | WS `voice_session.start{sessionId(vs_), conversationId?}` → `voice_session.started{sessionId, conversationId?}` → BINARY PCM（VAD 分段）→ `voice_session.partial{sessionId, turnId, segmentIndex, text}`（字幕）→ `voice_session.turn{sessionId, turnId, messageId, conversationId?, text}`（自动提交触发 generation）→ pause/resume/stop/cancel → `voice_session.ended{sessionId, reason(stopped/cancelled/timeout/stt_disabled)}`；`voice_session.ack{sessionId, seq}` 背压 | `VoiceCaptionEvent` / 后端轮次事件映射 |
| TTS 整段/流式音频、取消和完成 | WS `audio_start{stream_id, format(wav/mp3), sampleRate?, durationMs?}` → `audio{stream_id, seq, data, is_final}` ×N → `audio_end{stream_id}`（字节全发≠播完，完成由前端 `onended` 判定）；`audio.cancel{stream_id}`（全局）→ `audio_cancelled{stream_id}` | `TtsPlaybackSession` / `TtsChunkEvent` |
| 重连/续传方式 | **无断点续传**；重连后 WS `session` 回放历史；生成中断由客户端据回放判断（消息无对应 `generation.completed` → 视为中断 → 用新 `clientRequestId` 重发）；补充 `GET /api/sessions/{id}/pending`（pendingMessages / pendingApprovals）+ `GET /api/sessions/{id}/generations`（GenerationStatus） | `resume` |
| 错误结构 | WS `error` 帧 / `ErrorMessage{message, code?, requestId?, retryable?, details?}`；REST `ProtocolError{code, message, retryable, requestId, error(=message 别名), details}`；`generation.failed{code, message, retryable, details}`；ACK rejected 带 `error{code, message, retryable}`；40 码目录见 protocol-v2 §9.1 | `PublicError` |

### 19.1 字段差异与 Adapter 桥接项

下表记录 wire 字段与前端领域字段的命名/形状差异，`BackendAdapter` 落地时必须在 Main 内桥接，不得让 wire 原始字段泄漏进 Vue 组件：

| # | wire 字段 | 前端领域字段 | 桥接说明 |
|---|---|---|---|
| D-1 | `generationId`（gen_） | `responseId` / `generationId` | 后端已弃用 `responseId`，**别名 generationId**；前端两字段并存时以 generationId 为准 |
| D-2 | `generation.delta.delta` | `GenerationDeltaEvent.text` | 增量文本改名；语义不变（段内累计、`deltaSequence` 排序） |
| D-3 | `generation.completed.mood` | `emotion`（EmotionState） | 心情字段改名 |
| D-4 | `generation.completed.usage{turn_total, rounds[]}` | `TokenUsage`（source=`provider_reported`） | 按 generation 去重由 `generationId` 保证；rounds 为 provider 逐轮明细 |
| D-5 | `generation.completed.conversationUsage{total, byModel}` | `conversationUsage`（source=`server_aggregate`） | 会话级累计来自服务端，非前端累加 |
| D-6 | `generation.segment.completed.content` | `AssistantSegment.text` | 后端整段文本为权威，无需拼 delta；前端 `SegmentCompletedEvent` 当前未含 content，Adapter 需透传或用其覆盖累积 |
| D-7 | `MessageChannel` 含 `status` 通道 | `SegmentChannel` 仅 inner_voice/public_reply | 后端预留 `status` 通道；Adapter 需映射或过滤，不得丢字段 |
| D-8 | `dictation.start` 无 STT Profile 字段 | `dictationSttProfileId` | 后端用活动 STT，前端需在 start 前切换；**待后端确认是否加独立字段** |
| D-9 | `generation.completed.finishReason` 限 stop/tool_calls | 前端消息状态 completed | 取消/错误统一走 `generation.failed`，前端不得从 `state idle` 推断完成 |
| D-10 | `server_info.features` / `services` | 连接能力快照 | 各 feature 如实声明；前端据 `features` 门控 UI，不超前实现 |

**数据来源与记录：** 交接包 `frontend-handoff-v2` 批次 7（`docs/electron-backend-protocol-v2.md` v0.6、`frontend_contract/`、`traces/ws-v2-*.jsonl`）；后端侧未动。剩余待后端确认项：`dictationSttProfileId`（D-8）；E-03 凭据所有权契约已确认（后端 Secret Store `data/secrets/` + `credentialConfigured` 只读；desktop/local 凭据归 Electron），可按「已开发、未联调」推进阶段 1。

完成这张表并通过真实事件联调后，才可以把本文状态从“待与现有后端核对”改为“已对齐 / 可作为工程契约基线”。

## 20. 协议验收标准

- [ ] 所有后端输入通过运行时 Schema；
- [ ] UI 不依赖后端原始字段；
- [ ] 消息发送和工具副作用均可幂等重试；
- [ ] 流式消息支持乱序检测和中断保留；
- [ ] 同一 `responseId` 下的连续句子只创建一条 Assistant 消息，并按 `segmentIndex` 展示；
- [ ] 分段完成与父回复完成语义不同，Inner Voice/Public Reply 可交错但不会拆成多条消息；
- [ ] 回复级与会话级 Token、实际模型和心情字段来源明确；
- [ ] 图片、视频、音频附件、资源分页和来源消息跳转字段完整；
- [ ] 历史懒加载、会话搜索和聊天历史组合查询均有游标或稳定排序语义；
- [ ] LLM、STT、TTS Profile 可以读取、测试并切换；输入法转写可以独立选择兼容 STT Profile；
- [ ] 聊天历史可以按关键词、日期和分类组合分页，结果可跳转来源消息；
- [ ] 输入法转写的最终文字、取消和模型执行位置数据去向事件可区分，且不会形成语音消息；
- [ ] 三种类型的自定义 LLM/STT/TTS Profile 可以新增、编辑、测试、激活和删除，凭据不可读回；
- [ ] 拖拽文件与点击选择共用同一附件状态机，drop 不自动上传或发送；
- [ ] 直接语音的字幕、录音输入和实时语音轮次不会写入文字草稿；
- [ ] 输入法转写的最终文字只进入草稿，不创建语音消息或自动发送；
- [ ] 实时输入与流式 TTS 的二进制分帧、序号、背压、取消和完成语义明确；
- [ ] Desktop Runtime 调用必须经过本地权限判断；
- [ ] 大内容通过附件传输；
- [ ] 重连不会重复写文件、重复截图或重复创建消息；
- [ ] 与现有后端对齐表已填写并通过联调。
