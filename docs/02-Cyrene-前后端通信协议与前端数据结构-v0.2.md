# Cyrene 前后端通信协议与前端数据结构

**文档状态：** 维护中
**最后核验：** 2026-08-29
**适用阶段：** 阶段 2～8
**权威范围：** 前端领域契约与后端映射设计；现行 wire 事实以双方 contract、schema 和 adapter 为准
**初始文档日期：** 2026-08-03

> **状态说明：** 正文中的带日期实施/联调注记只代表当时快照；当前阶段、阻塞项和最近验证统一读取 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md)。

> 本文定义前端需要的稳定语义，不宣称现有后端已经使用相同 URL 或字段名。接入时由 `BackendAdapter` 把现有后端协议映射为本文的前端领域事件。

> **阶段 6 批次 C 同步（2026-08-21）：** §10.3 修正 `GET /api/tools/calls/{callId}` repo 状态枚举表述（**repo 9 值枚举非前端展示 8 态超集**——`result→succeeded`/`error→failed` 为后端固定翻译，`requested/awaiting_permission/timeout` 为本地态无 repo 对应）；§16.2 补 GET tools/calls 前端实现注记（real 已实现 + mock 降级 + reconnect 三分支映射，联调复核；`DesktopCallStatusSchema` 经 rest-schemas.ts 自包含导出，check:contract REST 段 15→16）。

> **阶段 4 批次 B（2026-08-16）同步：** §13.1 音频传输（BINARY 上行 + TTS base64 JSON 帧）、§13.2 直接语音、§13.3 输入法转写、§13.4 TTS 播放与 §19 语音行已按实际实现更新（领域契约以 `shared/contracts/voice.ts` / `events.ts` 为准）。语音链路为 Mock 驱动，标「**已开发、未联调**」；真实 Windows Electron（REAL）联调为验收方。`voice.error` 语音族错误路由（D-P15）、`dictation.start.sttProfileId`（D-P14）、后端 STT 一次性同意（D-P16）为本批新增口径。

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

> **实现口径注记（2026-09-14 复核，F-6）：** 上列 `FrontendBackendEvent` 是 **v0.2 设计命名，不是现行实现**——落地判别联合是 `BackendEvent`（`shared/contracts/events.ts:259-289`，**28 型**）。15 名中只有 `GenerationStartedEvent`/`GenerationDeltaEvent`/`GenerationCompletedEvent`/`GenerationFailedEvent`/`Live2DDirectiveEvent` 5 名与实现同名；其余 10 名（`ConnectionStateEvent`/`ConversationChangedEvent`/`ResourceChangedEvent`/`ModelProfileChangedEvent`/`VoiceInputEvent`/`DictationEvent`/`TtsPlaybackEvent`/`BackendErrorEvent`/`ToolCallEvent`/`ToolStatusEvent`）在 `src` **0 命中**。

> 实现 28 型的 `event` 名：`generation.started`/`segment.started`/`delta`/`segment.completed`/`completed`/`failed`、`switch_model.result`、`set_tts_voice.result`、`voice.transcript`、`voice_session.started|partial|turn|ack|ended`、`dictation.partial|final|cancelled`、`audio.session.started|ready|cancelled`、`voice.error`、`expression`、`live2d.directive`、`tool.request|started|completed`、`character.state.changed`、`character.catalog.changed`。连接状态不经 `BackendEvent`（走 `chat:state` 推送的 `ConnectionState`），会话与资源面走 REST 命令。原文保留以存设计口径。

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

> **批次 C 张力注记（2026-08-18，doc 05 §18 + doc 02 §12）：** 上表「未识别的可选字段应忽略」与 C3 冻结帧的 `.strict()` 整帧拒是两个**分层**口径，不冲突——**raw wire 层**（`main/transport/protocol-v2/raw-schemas.ts`）对 `live2d.directive` 等冻结帧用 `.strict()` **fail-closed 拒未知字段**（未知字段整帧拒 + 脱敏日志，防向后兼容漂移悄悄漏入）；**前端事件层**（`shared/schemas/events.ts` 镜像 + Renderer 消费）对**已通过**校验的合法帧里的**可选字段缺失**（`undefined` 不写键）按忽略处理。即「未知字段」在 raw 层拒绝、「已知但可选字段缺失」在事件层忽略，两层各司其职。

Main → Renderer 可以把多个已校验事件装入短时间片批次以减少 IPC 开销，但批次只是传输优化：每个事件仍保留自己的 `eventId/sequence`，Renderer 必须按批次内顺序逐项处理；不得把不同 `segmentId` 的文本拼成一个无法去重的伪事件。

**已确认说明（2026-08-08）：** 后端 v2 wire 事件是**扁平 JSON**（`{"type": "generation.delta", ...}`，无 `eventId/sequence/protocolVersion/occurredAt` 外壳）；上文的 `EventEnvelope` 是前端领域标准，由 `BackendAdapter` 在 Main 内解析 wire 后**盖戳补充**（`eventId/sequence` 单调生成、`occurredAt` 取接收时刻），再进 IPC。`protocolVersion` 取自握手 `server_info.protocol_version`（`2.0`），不为每条事件重复。

## 5. 连接与能力协商

### 5.1 已确认的后端 v2 握手（依据 §19 认证方式，frontend-handoff-v2 批次 7）

现有后端 v2 **不采用**下方旧版 JSON `ClientHello/ServerHello` 域握手，而是 **WS 握手头 + 三条连接帧**：

1. Electron Main 连 `/ws` 携带：`Authorization: Bearer <access_token>`（远程，本地空 token 为 fail-open）、`X-Protocol-Version: 2`、`X-Client-Platform: electron`（Desktop 工具桥定向投递标识）；
2. 建连后服务端依次下发：`session`（历史回放，含 `messages[]` + `token_stats?`）→ `server_info{protocol_version, server_version, features, services, connectionId?, build_sha?}` → `expression{expression, intensity?}`；
3. `server_info.features` 如实声明能力（`structured_generation`/`multi_conversation`/`desktop_runtime`/`dictation`/`voice_recording`/`voice_realtime`/`media_upload`，均为 bool），前端据此门控 UI，不超前实现；`connectionId` 仅 v2 + electron 下发（`conn_` 前缀），作为附件上传 `X-Client-Connection` 持有者校验头来源；`services.{llm,stt,tts}` 复用 per-service 形状（available/enabled/model/default）（**2026-09-14 复核，F-5**：前端当前只把 `character_profiles`/`character_state_stream` 归一为类型化开关，见 `src/main/transport/protocol-v2/character-rest-mapper.ts:65-69`；本行其余 feature 名未在 `src` 逐个门控，落地面见 §5.2 末注记）；
4. 多会话激活走 WS `activate_session{conversationId}` 或 REST `POST /api/sessions/{id}/activate`，服务端切 active 并重发该会话回放；未知会话 → `error{code: SESSION_NOT_FOUND}`。

`BackendAdapter.connect` 把上述握手归一为前端连接状态域（下方 5.2），不得把 `server_info`/`session`/`expression` 原始字段泄漏到 Vue 组件。

### 5.2 前端连接域模型（Adapter 输出，稳定语义）

```typescript
interface ConnectionState {
  status: "disconnected" | "connecting" | "connected" | "reconnecting" | "error";   // 2026-09-14 更正：原写 state: "idle"|…|"offline"|"failed"（实现字段名为 status，见本节末实现口径注记）
  protocolVersion?: string;   // server_info.protocol_version
  serverVersion?: string;     // server_info.server_version
  features?: BackendFeatureFlags;   // 2026-09-14 更正：实现是类型化对象 {characterProfiles, characterStateStream}，不是 string[]（wire character_* === true 才 true）
  connectionId?: string;      // server_info.connectionId（v2+electron）
  sessionId?: string;         // session 回放归属的活动会话
  resumeAccepted: false;      // **未落地**（2026-09-14 复核：src 0 命中）；“后端 v2 无断点续传（§16）”语义仍成立，但实现无此字段
}
```

协商失败时停止工具调用，但可以根据后端能力决定是否允许只读聊天降级。

> **实现口径注记（2026-09-14 复核，F-5）：** 落地形状见 `shared/contracts/backend.ts:14-32`——字段名 `status`（非 `state`）、类型化 `features?: BackendFeatureFlags`（`shared/contracts/character.ts:32-35`，仅 `character_profiles`/`character_state_stream` 两位，wire === true 才 true），另有 `serverUrl`/`connectionScopeId`/`activeConversationId`/`lastError`；本域经 `chat:state` 推送交付（preload `onChatState`）。`resumeAccepted` 未落地（`src` 0 命中），但“后端 v2 无断点续传”语义仍成立（§16.2）。

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

- `conversationId` ↔ 前端 `id`（默认 `"default"`，新建 `conv_<uuid4 hex[:12]>`）；`title` 可空（首条用户消息自动取前 20 字）；`messageCount` ↔ 前端会话的消息数（前端 `Conversation` 目前无此字段，可在 Adapter 补充；**2026-09-14 复核：至今未补充**，`Conversation` 实形见 `shared/contracts/conversation.ts:17-24`）；`updatedAt` ↔ 前端 `updatedAt`；
- 后端**额外提供 `active`**（是否当前活动会话）——前端 `Conversation` 需增补该字段，多会话高亮依赖它（**已被取代，2026-08-11 `e8bb3ee`**：该字段**未**加进 `Conversation`，活动会话改由连接态承载 `ConnectionState.activeConversationId`，见 `shared/contracts/backend.ts:27`；消费处 `renderer/src/stores/conversation.store.ts:443,454`）；
- 后端会话列表无 `lastMessagePreview`/`tokenUsage`/`lastModel`/`lastEmotion`；会话级 Token 累计经 `generation.completed.conversationUsage` 或 `session` 回放的 `token_stats` 获取，非列表接口直接给出。

> **C2 口径更正（2026-09-15 契约评审）：** 上句描述的是**后端把数据放在哪里**，它成立；但**前端目前的处置是"不消费"**，这一点此前没写，导致"可获取"被读成"已展示"。逐条实况：
> - **回复级 `usage`：已消费**——`generation.completed.usage` 写进 `Message.usage`，消息气泡据此显示 model/usage 元数据行。**2026-09-15 起回放路径也不再丢弃**（`session` 回放的 `SessionMessageItem.token_usage` 与 REST 归档 `Message.token_usage` 经同一映射点 `main/transport/protocol-v2/token-usage.ts` 落进 `Message.usage`；REST 侧该字段是自由形状 `dict[str,Any]`，按正向形状确认后才映射）。
> - **会话级累计：不消费（有意）**——`generation.completed.conversationUsage` 与 `session.token_stats` 在 `src/renderer` **均无消费方**（`conversationUsage` 全 renderer 0 命中），即界面上**没有**"已消耗 Token"展示。Adapters 层不为此建未使用的管道：**没有消费方的管道就是会腐烂的死代码**。将来要做展示时，管道与展示一起建（展示位置与口径属产品决定，未定）。
> - 与 §13 的 `EmotionState`/`ModelIdentity`/`TokenUsage.cachedInput` 等的处理同一条纪律：**文档不得把"字段存在"写成"功能存在"**。

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
type MessageStatus = "pending" | "acknowledged" | "streaming" | "completing" | "completed" | "interrupted" | "failed";   // 2026-09-14 更正：原列 5 值（pending/streaming/completed/failed/cancelled）；实现 7 值见 shared/contracts/message.ts:63-70

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

> **C12 口径补充（2026-09-15 契约评审）：** 归档 `parts` 的**校验严格度在两条路径上是有意不同的**，因为它对应后端**两份不同的形状**——
> REST 归档（`rest.py ArchivePart`）是 `parts: [{content: str}]`，故 `rest-schemas.ts` 按 **`content` 必填**校验（缺字段整页 `SCHEMA_VALIDATION_FAILED`）；
> WS 回放（`ws_message/_types.py: SessionMessageItem.parts: Optional[list[dict[str, str]]]`）是**自由形状**，故 `raw-schemas.ts` 只做 `z.array(z.unknown())`。
> 这不是"同一字段两套口径"的疏漏，而是两个来源各自的真值；**若后端把 WS 侧也收敛成 `ArchivePart`，这里应同步收紧**（否则 WS 侧会继续放行畸形 parts，而 REST 侧会整页失败——同一份数据两条路径两种命运）。

约束：

- 用户发送前生成 `clientMessageId`，重试时保持不变；
- 后端返回正式 `id` 后建立映射；
- `inner_voice` 与 `public_reply` 属于同一条 Assistant 消息，并与多个按句切分的分段共享同一个 `responseId/messageId`；
- Assistant 可见正文只保存在 `assistantSegments`；不得把相同的 Inner Voice/Public Reply 再复制到 `content`。`content` 用于用户、系统、工具消息及后端兼容数据，Adapter 必须在入 Store 前归一化；
- `segmentId + index` 标识同一回复内的句子或多媒体分段；`segment.completed` 不得让前端结束整条回复；
- `model` 表示该条回复实际使用的模型，不能只展示设置页当前选择；
- `emotion.intensity` 若存在必须规范化到 0～1；未知 `code` 以安全的“未知/原始标签”展示，不得被解释为 CSS 类、动作文件或资源路径；
- `tokenUsage` 同时支持回复级与会话级累计，前端不得用字符数冒充服务端 Token；（**C2 补充，2026-09-15**：回复级已消费并展示；会话级**当前无消费方、界面上不展示**，见 §12 的 C2 口径更正）
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
- `generation.segment.completed` **必发**（非可选）且携带 `content`（完整段/整句文本，public_reply 与 inner_voice 段都带）——前端无需拼 delta 即可渲染整句；Adapter 应透传该 `content`（前端 `SegmentCompletedEvent` **已建模** `content?: string`——`shared/contracts/events.ts:65`，阶段 2 块 A `8d880ac`（2026-08-10）起；2026-09-14 更正，见 §19 D-6）；
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

> **阶段 6 批次 A 注记（2026-08-20）**：上图为设计期领域模型；批次 A 落地为 `shared/contracts/tool.ts` 的 **`ToolCallRecord`**（`id = sourceCallId`（LLM tool_call_id）权威键、`desktopCallId?` 桥关联、`runtime` 三值、8 态展示 `ToolCallStatus`），`arguments` 不进领域事件（Main 侧 `redactToolArguments` 脱敏为 `inputSummary`）；客户端→服务端回传收敛为 `ToolStatusCommand`（wire `tool.status` 六态协议态，Main 组装、Renderer 不可见）。

> **阶段 6 批次 B 注记（2026-08-20）**：批次 B 落地 Main 工具服务/权限/四执行器/UI，领域层补充公开事件 **`PublicToolEvent`**（`id = sourceCallId` 权威键、`desktopCallId?` 桥关联、`runtime: 'desktop'` 收窄、`pathSummary?/dataFlowNote?/diff?/captureSources?/capturePreview?/attachmentCount?` 扩展字段；**无原始 arguments/paramHash/expiresAt/安全元数据**，D6B-09）。**Desktop 工具全生命周期归 Main tool-service**：real 路径 `handleFrame` 对 `tool.request` 加显式 `case`——FrameMapper 校验+脱敏产出仍存在（mapper 纯函数与批次 A 单测不变），但 **real-backend 不再把它 emit 给 renderer 事件管线**（raw `arguments/paramHash` 只在 Main），改路由 tool-service（D6B-08）；状态变化经新 IPC 推送通道 `tool:event` 下发 `PublicToolEvent` → toolStore。Backend 展示事件（`tool.started/tool.completed`）仍走既有 `chat:event` 管线（批次 A 现状不动）。**`tool.status`（wire 六态）发送方 = Main tool-status-sender**（F-6-10 落地）：Main 缓存每次请求的 `toolName/toolVersion/runtime/paramHash` → `adapter.submitToolResult`（real WS / mock 记录+归档）；附件经 `adapter.uploadToolAttachment`（real `POST /api/uploads/desktop/{callId}` + `X-Client-Connection: <connectionId>`，响应仅 `{url}` 本地回填 mimeType/label；mock 占位 URL 不上传）**先上传后回填 `attachments`**，上传时序在 `tool.status{running}` 之后、`result` 之前。详见 `docs/review/2026-08-20-阶段6批次B-决策记录.md`。

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
- 状态查询 `GET /api/tools/calls/{callId}` → `DesktopCallStatus`——**repo 9 值枚举** `pending/accepted/running/succeeded/failed/rejected/cancelled/expired/offline`，**不是前端 `ToolCall.status` 8 态展示态的超集**（`result→succeeded`、`error→failed` 为后端固定翻译；前端 `requested/awaiting_permission/timeout` 为本地态，无 repo 对应；`expired` 表达 `timeout` 语义）；`DesktopCallStatusSchema`（`.strict()` 镜像 `frontend_contract/contract.raw.ts`）+ `DesktopCallStatus` 类型经 `main/transport/protocol-v2/rest-schemas.ts` **自包含导出**（check:contract REST 段解析目标，REST 段 15→16）。**前端实现注记（阶段 6 批次 C，2026-08-21）**：`RealBackend.getToolCallStatus(callId)` 已实现（GET + Bearer + `safeParse`；缺省端点/连接断开/非 2xx/解析失败 → `null` 降级）；`MockBackend.getToolCallStatus` 恒 `null`（无端点，取舍记录）；tool-service `reconnect()` 对 awaiting 记录经注入 `queryStatus` 回调查询（mock 装配不注入 → 不查），映射定案：`expired→timeout`、`cancelled/rejected→cancelled`、其余/`null→保持本地态`（禁止自动执行）；真实链路联调验证归开发者批次后；
- 注册表 `GET /api/tools` → `ToolRegistryResponse{tools: ToolMetadata[], desktopAvailable}`，Electron 据此校验「只接受已注册工具和版本」；
- **后端审批** `tool_approval`（v1 后端工具）仅 v2 连接带 enrich 字段；Desktop 工具不走 `tool_approval`，由 Electron 本地授权（§10.2 语义不变）。

> **阶段 6 决策注记（2026-08-19 定案；后端 2026-08-20 已实现，前端待接入）：** 后端已新增 Server→Client `tool.started{callId(LLM tool_call_id), toolName, runtime(backend|desktop|local_worker), inputSummary?, generationId?, conversationId?}` 与 `tool.completed{callId, toolName, runtime, success, outputSummary?, error?, errorType?, durationMs?, truncated?, generationId?, conversationId?}`；v2 已停发 `action{tool_executing/tool_done}`（v1 不变）。`tool.request` 已新增必填 `sourceCallId`（LLM tool_call_id，后端生产路径非空）。前端统一领域键 = `sourceCallId`，`tool.request.callId`（桥 `call_*`）只作执行协议关联；`generation.completed` 不加 `tool_calls`、`finishReason` 不承载工具语义。完整更新点与后端门禁见 `docs/review/2026-08-19-阶段6-工具双轨统筹决策记录.md` §7。

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
  state?: "idle" | "listening" | "thinking" | "speaking" | "happy" | "sad" | "surprised";
  priority?: 0 | 1 | 2 | 3;
  durationMs?: number;
}
```

前端只把该结构视为表现建议：必须检查名称白名单、优先级和持续时间，后端不能提供本地资源路径或脚本。

> **批次 C 契约更正注记（2026-08-18，D5C-07）：** `state` 枚举由早前版本的**八值**更正为**七值**——**剔除 `error`**（上表已反映）。理由：`error`（优先级 3）为 **client 派生态**（doc 05 §6 error=3 必须 client 驱动），不可被后端任意注入覆盖 thinking/speaking；raw wire 层 `.strict()` 下携带 `state:'error'` 的帧会**整帧拒**（fail-closed，连合法 expression/motion 一并丢弃），此行为已在批次 C 决策记录明示。其余七值、`priority∈0-3`（客户端钳制 ≤1 作建议强度上限）、`durationMs∈[0,30_000]`（motion 以 15s 封顶）均为批次 C 冻结契约。wire 实发见 §19 映射表 `live2d.directive` 行。

**已确认映射（2026-08-08）：** 后端建连下发 `expression{expression, intensity?}`（当前心情）；流式中心情经 `generation.completed.mood` 落位；v1 `capabilities.live2d_static_image` 提供 Live2D 静态图路径（v2 由 `server_info.services` 取代 capabilities，静态图字段在 v1 保留）。`expression` 字段是心情**代码/标签**（如「开心」），不是 CSS 类或资源路径——前端经本地映射表转 `Live2DDirective`，未知代码以「未知/原始标签」安全展示（§7 约束同款规则）。

> **C11 口径更正（2026-09-15 契约评审）：** 上句「前端经本地映射表转 `Live2DDirective`」只对**带角色身份**的表现帧成立。实测实现（`main/transport/protocol-v2/frame-mapper.ts` 的 `expression` 分支）是：
> **带完整角色三元组**（`characterId`+`characterInstanceId`+`characterRevision`）→ 映射为表现事件；**没有身份**（迁移期旧后端、或建连握手那一帧）→ **整帧忽略（返回 null），且不告警**。
> 也就是说：**legacy 形态下建连的"当前心情"不会生效**，首屏心情要等第一条 `generation.completed.mood`。这是**有意保留**的旧语义（原注释写「忽略握手帧」），多角色设计稿 §CHAR-FE-10 只记录了 `features.characterProfiles=true` 时的丢弃口径，未记 legacy 分支——本节把它补上，避免把「已忽略」读成「已映射」。
> 若将来要在 legacy 下也生效，需要先决定它的归属（无身份的全局表现 vs 写入连接态的 `initialExpression`），而不是直接放开 mapper 的判据。

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
  // ⚠️ 2026-09-14 更正（与 doc 11 §2.1 同源，由 review 发现）：本块以下字段名在代码中**不存在**——
  // `credentialOwner` / `openai_compatible` / `custom_rest` / `bundled_local` 于 apps/desktop/src 全量 grep **0 命中**。
  // 真实落地类型是 `ModelProfile`（apps/desktop/src/shared/contracts/model.ts:9-23）：`source: built_in|custom`、
  // `models: string[]`、`endpointLabel?`、`baseUrl?`、`builtIn`。**阅读本块时以代码为准**；逐字段对照见 doc 11 §2.1 的更正说明。
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
  insertMode: "append" | "replace_selection";   // 2026-09-14 更正：原写 "cursor" | "append"（与 §13.3 及实现不符；shared/contracts/voice.ts:56）
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

**音频输入（WS BINARY 上行）：** 输入描述符收敛为**唯一支持格式**（P4-B 定稿，`shared/contracts/voice.ts`）：

```typescript
type AudioCodec = "pcm_s16le";   // wire 唯一支持；不符 → error{CONTRACT_VALIDATION}，不建会话

interface AudioInputDescriptor {
  codec: "pcm_s16le";
  sampleRate: 16000;
  channels: 1;
}
```

前端采集即默认格式，各 `start` 控制帧不带 `audio` 字段（契约上可带，缺省按默认）。其后 PCM 原始字节以 WS **BINARY 帧**上行（`send(Uint8Array)`，无描述符/块元数据 JSON 帧）；单帧上限 `MAX_AUDIO_CHUNK_BYTES` = 1 MiB（2026-09-14 更正：原写 `MAX_CHUNK_BYTES`；实见 `src/main/voice/voice-handlers.ts:22`）（Main 单向通道 `voice:audio-chunk` 运行时校验，超限丢弃 + warn）；**网络 chunk 无需 640B 对齐**（后端跨 chunk 重组 640B/20ms VAD 帧）。实时链路背压经 `voice_session.ack{seq}`（seq = 服务端已收 BINARY 帧序数）：前端最大未确认 200 帧（≈4s @ 50帧/s，含 1s ack 周期余量）超窗本地暂停采集不丢帧、ack 恢复，无 ack 5s 兜底恢复。

**TTS 播放（base64 JSON 帧）：** TTS 不下发二进制，`data` 以 base64 内嵌普通事件 JSON——`audio_start{stream_id, format(wav|mp3), sampleRate?, durationMs?}` → `audio{stream_id, seq, data(base64), is_final}` ×N → `audio_end{stream_id, format?}` / `audio_cancelled{stream_id}`；**`is_final` 恒 false，终止由 `audio_end` 判定，不得依赖**。完成语义与取消规则见 §13.4。

**原始音频生命周期：** 录音 BINARY 上行与 TTS 二进制均**不落盘、不入消息**；录音试听走 Renderer AudioContext 本地回放（内存 AudioBuffer），TTS 二进制仅 Main 内存 + MediaService `tts-live` 短期缓存（TTL 5min，惰性清理参照 `tts-preview`）。录音、实时输入、输入法转写与 TTS 使用不同会话键：`recordingId`（record）/ `sessionId`（realtime）/ `clientRequestId`（dictation）/ `stream_id`（TTS 播放）。

### 13.2 直接语音输入

普通录音输入和实时语音会话都属于直接语音交互。STT 可以提供字幕，但字幕不会修改文字输入框。**状态：已实现（阶段 4 批次 B，Mock 驱动，标「已开发、未联调」；真实 Windows Electron（REAL）联调为验收方）**——三种语音模式经 `BackendAdapter` 真实 WS 命令 + Renderer 麦克风采集 + voiceStore 编排全链路落地。领域契约见 `shared/contracts/voice.ts`，核心形状：

```typescript
// —— 普通录音（voice.record.* + BINARY + commit/discard） ——
interface VoiceRecordStartInput { recordingId: string }   // wire voice.record.start 仅 {recordingId, audio?}（无 conversationId；会话归属在 commit）
interface VoiceCommitInput {
  recordingId: string; text: string; conversationId: string
  clientRequestId: string; clientMessageId: string
}
// 事件：voice.transcript{recordingId, text, emotion?}（PENDING 字幕）

// —— 实时语音会话（voice_session.* 全态 + 背压） ——
interface RealtimeVoiceStartInput { sessionId: string; conversationId?: string }
// 事件：voice_session.started{sessionId, conversationId?} / partial{sessionId, turnId, segmentIndex, text}
//      / turn{sessionId, turnId, messageId, conversationId?, text} / ack{sessionId, seq} / ended{sessionId, reason}
```

普通模式停止后生成待发送的音频输入，由用户确认发送；实时模式在用户明确启动的会话中按后端 VAD/断句规则自动提交语音轮次。字幕只能进入字幕状态，不得合并到 `ConversationDraft.text`。

**已确认映射（wire，protocol-v2 §12，直接语音两种模式均 v2-only；输入法转写见 §13.3）：**

- **普通录音**：`voice.record.start{recordingId(rec_)}` → BINARY PCM ×N（全段缓冲，不 VAD）→ `voice.record.stop{recordingId}` → `voice.transcript{recordingId, text, emotion?}`（PENDING 字幕）→ `voice.commit{recordingId, text, clientRequestId, clientMessageId?, conversationId?}`（幂等，text 为确认文本）→ `user_message.ack` + generation.*；`voice.discard{recordingId}` 取消——**可取消任意未提交阶段（RECORDING/TRANSCRIBING/PENDING）且幂等成功**：IDLE 迟到/重复 discard 亦成功、不发 `VOICE_RECORDING_NOT_FOUND`；不要求先 stop、不调 STT、不产 transcript、不触发 generation（依赖配套后端修订 **BE-S4-RUN-P0-01**，状态机语义修订、wire schema 无新增字段）；**旧口径「RECORDING 态先 stop 再 discard」「IDLE 迟到 discard → `VOICE_RECORDING_NOT_FOUND`」已废弃**；空转写不发 `voice.transcript`（`< 640B` 视为空转写）；录音 >600s → `error{VOICE_RECORDING_TOO_LONG}`；stop 时 STT 已关 → `error{STT_UNAVAILABLE}`；音频**不落盘、不入消息**；
- **实时语音**：`voice_session.start{sessionId(vs_), conversationId?}` → `voice_session.started{sessionId, conversationId?}` → BINARY PCM（VAD 分段）→ `voice_session.partial{sessionId, turnId, segmentIndex, text}`（字幕）→ `voice_session.turn{sessionId, turnId, messageId, conversationId?, text}`（自动提交触发 generation，多轮只响应最后一轮为预期）→ pause/resume/stop/cancel → `voice_session.ended{sessionId, reason(stopped|cancelled|timeout|stt_disabled)}`；`voice_session.ack{sessionId, seq}` 背压（§13.1）；300s 无音频 → `ended{timeout}`；wire `pause/resume` 帧契约存在但本批 UI 只暴露 stop/cancel，背压由前端本地 `PcmCapture.pause()` 控制（D-P3）；
- **语音族错误路由（D-P15）**：`voice.commit` 违规 → `user_message.ack{rejected}`；`voice.record.start/stop/discard` 与 `voice_session.*`/`dictation.*`/`audio.cancel` 违规 → `error{code}`；已有活动会话再 start → `VOICE_SESSION_CONFLICT`；`agent.stt` 未启用 → `STT_UNAVAILABLE`；未知 sessionId/recordingId → `VOICE_SESSION_NOT_FOUND`/`VOICE_RECORDING_NOT_FOUND`。real-backend 对 `VOICE_ERROR_CODES`（`STT_UNAVAILABLE`/`STT_PROFILE_NOT_FOUND`/`VOICE_SESSION_CONFLICT`/`VOICE_SESSION_NOT_FOUND`/`VOICE_RECORDING_TOO_LONG`/`VOICE_RECORDING_NOT_FOUND`/`DICTATION_NOT_FOUND`/`PLAYBACK_NOT_FOUND`）**额外** emit `voice.error{code, message}`（经既有 `onError` 日志/审计保留），connectionStore 对这类码**不展示全局连接错误横幅**（语音错误是会话级预期错误，非连接级）。

### 13.3 输入法转写

**状态：已实现（阶段 4 批次 B，Mock 驱动，标「已开发、未联调」）**。wire 契约：`dictation.start{clientRequestId, sttProfileId?}` → BINARY PCM ×N（VAD 分段）→ `dictation.partial{text}`（累积字幕）→ `dictation.stop{clientRequestId}` → `dictation.final{clientRequestId, text}`（**只回文字、零消息副作用**）→ 前端写草稿；`dictation.cancel` → `dictation.cancelled`。领域契约形状（`shared/contracts/voice.ts`）：

```typescript
interface DictationStartInput { clientRequestId: string; sttProfileId?: string }
interface DictationStopInput { clientRequestId: string }
// 事件：dictation.partial{text} / dictation.final{clientRequestId, text} / dictation.cancelled{clientRequestId}
```

`sttProfileId` = `<provider>/<model>`，缺省用全局活动 STT，会话内快照不改全局活动（D-8 已确认）；profile 不存在 / runtime=desktop|local → `error{STT_PROFILE_NOT_FOUND}`。按住期间采集临时音频，松开后只把 `dictation.final.text` 按 `dictationInsertMode`（`append` 追加草稿末尾 / `replace_selection` 替换当前选区——P4-B 子集；**光标级插入列为后续**）写入当前聊天草稿，不创建语音 `MessagePart`，也不自动发送。它经 `settingsStore.dictation.sttProfileId` 独立选择兼容 STT Profile（**本地设置，非激活选择数据源，D-P14**）；若执行位置为后端，**首个 backend-STT 语音操作前弹一次性同意**（「音频将发送至后端识别（本机不保留）」，「不再提示」持久化 `voice.consentBackendStt`，D-P16）；本机或 Local Worker 执行时展示模型可用性、下载和资源占用。取消、失败或会话切换不得把残余音频或文字写到其他会话。

### 13.4 TTS 播放

**状态：已实现（阶段 4 批次 B，Mock 驱动，标「已开发、未联调」）**。TTS 播放为**整段缓冲**（后端默认非流式合成，`audio_start` → `audio_end` 收齐后播，不做边收边播）。领域事件（`shared/contracts/events.ts`）：

```typescript
interface AudioSessionStartedEvent { streamId: number; format?: "wav" | "mp3" }
interface AudioSessionReadyEvent  { streamId: number; url: string; durationMs?: number; format?: "wav" | "mp3" }
interface AudioSessionCancelledEvent { streamId: number }
```

整段 TTS 经 MediaService `tts-live` 媒体路由播放（`<audio>` cyrene:// URL，Renderer 只持有 URL 不接触二进制）；`autoReadReply` 是**本地播放门**（D-P1，关 → 丢弃 `audio.session.ready` 不播放），不联动 `set_service('tts')`。切换消息、停止生成或用户点击停止时，必须取消对应 `stream_id`、清空未播放缓冲。TTS 默认只朗读 Public Reply，不把 Inner Voice 发送给 TTS Provider（后端行为，前端不干预）。

**已确认映射（wire，protocol-v2 §12.5）：** 后端 TTS 播放 wire 以 `stream_id` 为 playback ID（全链路统一键）：

- `audio_start{stream_id, format(wav/mp3), sampleRate?, durationMs?}` → `audio{stream_id, seq, data(base64), is_final}` ×N → `audio_end{stream_id, format?}`（**format 契约可缺省、缺省 wav**；**字节全发 ≠ 播完**，播放完成由前端本地 `onended` 判定，不引入上行回执）；`audio`/`audio_end` 原始帧不进 BackendEvent（Main 内解码缓冲后 emit `audio.session.*`）；
- 取消：客户端 `audio.cancel{stream_id}`（v2-only **全局**播放操作）→ 服务端 `audio_cancelled{stream_id}`（前端清理孤儿 chunk）；未知/已结束 stream_id → 可忽略良性 `error{PLAYBACK_NOT_FOUND}`（前端忽略，不展示）；
- 前端 `stream_id` ↔ wire `stream_id`；二进制数据走 `data` 字段（base64 JSON 帧，见 §13.1），不另建附件；新 `audio_start` 到达即 supersede 旧 stream（后端中断语义）；播放 `onended` 清播放态、`onerror`（如 mock 占位 URL 404）同样清态防播放态卡死（D-P8）。

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
- 关键码：认证 `AUTH_REQUIRED`/`AUTH_INVALID`（401）；会话 `SESSION_NOT_FOUND`（404）/`SESSION_PROTECTED`（409，删除 `default` 禁删）；生成 `GENERATION_PROVIDER_UNAVAILABLE`/`GENERATION_TIMEOUT`（retryable）/`GENERATION_CANCELLED`/`INTERNAL`；语音 `VOICE_SESSION_CONFLICT`/`VOICE_SESSION_NOT_FOUND`/`STT_UNAVAILABLE`/`DICTATION_NOT_FOUND`/`VOICE_RECORDING_TOO_LONG`/`VOICE_RECORDING_NOT_FOUND`（**IDLE 迟到 discard 幂等成功，不再产生**——BE-S4-RUN-P0-01；现保留码含义为「另一普通录音活跃时 mismatch recordingId 拒绝」）；附件 `ATTACHMENT_NOT_FOUND`/`SIGNATURE_EXPIRED`/`INVALID_SIGNATURE`/`UNSUPPORTED_MEDIA_TYPE`/`TOO_MANY_FILES`/`STORAGE_UNAVAILABLE`/`QUEUE_FULL`；Profile `PROFILE_IN_USE`/`PROFILE_INVALID_RUNTIME`/`PROFILE_RUNTIME_NOT_BACKEND`/`SSRF_BLOCKED`；限流 `RATE_LIMITED`/`CONNECTION_LIMITED`/`REQUEST_TOO_LARGE`。

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

> **阶段 6 批次 C 注记（2026-08-21）**：`GET /api/tools/calls/{callId}` 前端实现已落地——real 侧 `RealBackend.getToolCallStatus`（`DesktopCallStatusSchema` 解析，repo 9 值枚举与 `rest-schemas.ts` 导出见 §10.3；缺省端点/连接断开/非 2xx/解析失败 → `null` 降级）、mock 侧恒 `null`（无端点）、tool-service `reconnect()` 对 `awaiting_permission` 记录经注入 `queryStatus` 回调查询（mock 装配不注入 → 不查）；映射定案：`expired→timeout`、`cancelled/rejected→cancelled`、其余/`null` → **保持本地状态**（禁止自动执行，纪律延续「重连不自动重投」）；真实链路联调验证归开发者批次后。

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
| tool.request | Main Tool Service / Tool Store | Desktop 调用注册、本地风险重算、权限窗；Renderer 只收脱敏公开事件（**批次 A 已落地**：raw schema 校验 + `redactToolArguments` 脱敏，原始 arguments 永不进 Renderer；**批次 B 已落地**：real 路径不再 emit 给 renderer 事件管线——handleFrame 显式 case 路由 tool-service 全生命周期（D6B-08），经 `tool:event` 推送 `PublicToolEvent`） |
| tool.started | Tool Store | 按 `sourceCallId` 创建/推进统一 `ToolCallRecord`；Backend Runtime 只读卡片（**批次 A 已落地**：领域事件映射 + 归档配对数据源；**批次 B 已落地**：toolStore 归一化 + 双区渲染） |
| tool.completed | Tool Store | 服务端完成确认，按 `sourceCallId` 合并；Desktop 终态由本地状态机裁决（**批次 A 已落地**：领域事件映射；**批次 B 已落地**：toolStore 本地状态机裁决优先，D6B-21） |
| tool.status | Tool Store | 更新工具卡片（契约与 mock 发送面批次 A 已就绪；**批次 B 已落地**：Main tool-status-sender 缓存组装发送，经 `adapter.submitToolResult`（real WS / mock 记录+归档），附件先 `uploadToolAttachment` 后回填） |
| live2d.directive | Live2D Store | 校验后映射表现 |
| model.profile.changed | Model Service Store | 更新 LLM/STT/TTS Profile 与当前选择 |
| voice.caption | Voice Store | 更新直接语音会话的临时或最终字幕，不修改草稿 |
| voice.input.ready | Voice/Attachment Store | 建立待发送录音输入 |
| dictation.final | Voice/Conversation Store | 将最终听写文字插入目标会话草稿 |
| tts.playback.changed | Voice/Live2D Store | 更新缓冲、播放、停止和口型联动状态 |
| error | 对应请求 Store | 转换为可展示错误 |

> **事件名实现口径（2026-09-14 复核，F-6）：** 本表是**设计映射**；实际到达 Renderer 的领域事件名以 `BackendEvent` 为准（见 §3.2 注记）。上表 `connection.changed`/`conversation.changed`/`resource.changed`/`tool.call`/`model.profile.changed`/`voice.caption`/`voice.input.ready`/`tts.playback.changed` 8 名在 `src` **0 命中**。

> 现行对应：连接态 → `chat:state` 推送（`ConnectionState`）；会话/资源 → REST 命令（`listConversations`/`getMessages`/`queryChatHistory`；资源只作为 `ChatHistoryItem.resource` 出现，无独立领域事件）；模型 Profile → `switch_model.result`/`set_tts_voice.result`；工具 → `tool.request`/`tool.started`/`tool.completed`；语音字幕与待发送录音 → `voice_session.partial`/`voice.transcript`；TTS 播放 → `audio.session.started`/`ready`/`cancelled`。表中 `tool.status` 一行是 Client→Server **wire 命令**（`src/main/transport/protocol-v2/raw-types.ts:394`），不是领域事件。

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
| 工具调用字段 | Server→Client `tool.request{callId(call_), toolName, toolVersion, runtime(desktop), arguments, reason?, riskLevel(safe/medium/high), permissionRequired, approvalAuthority(client), paramHash(规范化 arguments SHA-256), expiresAt, requestId?}`；注册表 `GET /api/tools` → `ToolRegistryResponse{tools: ToolMetadata[16], desktopAvailable}`；`desktop.command.run` 不注册。**阶段 6 增量（后端已实现 + 批次 A 已接入）**：必填 `sourceCallId`（LLM tool_call_id，前端统一领域键）；`requestId` 由 `ctx.trace_id` 填充 | `ToolCallRecord`（**批次 A 定名**：统一领域记录，`id = sourceCallId` 权威键，`desktopCallId?` 桥关联；事件经 `redactToolArguments` 脱敏，原始 arguments/安全元数据不进 Renderer） |
| Backend 工具生命周期（后端已实现 + 批次 A 已接入） | Server→Client `tool.started{callId(LLM tool_call_id), toolName, runtime(backend/desktop/local_worker), inputSummary?, generationId?, conversationId?}` / `tool.completed{callId, toolName, runtime, success, outputSummary?, error?, errorType?, durationMs?, truncated?, generationId?, conversationId?}`；v2 停发 `action{tool_executing/tool_done}`（v1 不变；**前端对 `action` 按「已知忽略」兼容帧建模，不告警、不作工具状态源**） | `tool.started/tool.completed` → `toolStore`（批次 A：领域事件映射 + 归档 `Message.toolCalls` 配对，卡片渲染归批次 B） |
| 工具结果接口 | Client→Server `tool.status{callId, status(accepted/rejected/running/result/error/cancelled), toolName, toolVersion, runtime, paramHash, output?, error?, attachments?, executionSummary?}`（toolName/version/runtime/paramHash 不一致即篡改拒绝）；查询 `GET /api/tools/calls/{callId}` → `DesktopCallStatus`；桌面附件 `POST /api/uploads/desktop/{callId}`（`X-Client-Connection` 持有者校验） | `submitToolResult` |
| 附件上传流程 | `POST /api/uploads`（multipart `files[]` + `kind`?，魔数真值校验，≤10 文件，image 10MB/video 50MB/audio 20MB/file 20MB，聚合 64MB）→ `AttachmentUploadResponse{attachments: AttachmentInfo{attachmentId, kind, mime, size, url, signedUrl?, filename}}`；签名下载 `GET /api/attachments/{id}?sig=&exp=`（免 Bearer，Range/206）；签发 `GET /api/attachments/{id}/sign`（Bearer）；消息关联 `attachments: AttachmentRef[]` / `stickerId` | `AttachmentRef` |
| LLM/STT/TTS Profile 配置接口 | `GET/POST /api/providers` → `ProvidersResponse{llm, stt, tts, custom, unconfigured}`（条目含 `credentialConfigured` / `runtime` / `capabilities`）；WS `switch_model{service, model}` / `set_service{service, enabled}`；TTS `GET /api/tts/voices` + `POST /api/tts/preview` + WS `set_tts_voice{voice}` | `ModelProfile` |
| 自定义模型新增/编辑/删除 | `POST /api/providers`（custom 条目，同名更新；`api_key` 一次性提交入 Secret Store **永不读回**，非 backend runtime 带 key → 400 `PROFILE_INVALID_RUNTIME`）；删除激活中 profile → 409 `PROFILE_IN_USE` | `UpsertCustomModelProfileCommand` |
| 模型连接测试与切换接口 | `POST /api/providers/test`（base_url 非空一律 SSRF 校验）→ `ProviderTestResult{ok, latency_ms?, error?, detail?}`；切换经 WS `switch_model` / `set_tts_voice` → `switch_model_result` / `set_tts_voice_result{ok, error?}` | `ModelProfileTestResult` |
| 输入法转写专用 STT 选择 | **契约已确认（后端 `556117a`）**：`dictation.start.sttProfileId`（`<provider>/<model>`，缺省用全局活动 STT），会话内快照不改全局活动 STT | `settingsStore.dictation.sttProfileId`（**本地设置，D-P14**；缺省不带 → 全局活动 STT） |
| 输入法转写 | WS `dictation.start{clientRequestId, sttProfileId?}` → BINARY PCM（VAD 分段）→ `dictation.partial{text}`（累积字幕）→ `dictation.stop{clientRequestId}` → `dictation.final{clientRequestId, text}`（**只回文字、零消息副作用**）→ 前端写草稿；`dictation.cancel` → `dictation.cancelled` | `startDictation`/`stopDictation`/`cancelDictation`（BackendAdapter）；`dictation.partial` → `voiceStore`（字幕）；`dictation.final` → `settingsStore.applyDictationInsert` → `draftStore`（append / replace_selection，不建消息不发送） |
| 普通录音输入与发送确认 | WS `voice.record.start{recordingId(rec_)}` → BINARY PCM ×N（全段缓冲）→ `voice.record.stop{recordingId}` → `voice.transcript{recordingId, text, emotion?}` → `voice.commit{recordingId, text, clientRequestId, clientMessageId?, conversationId?}` → `user_message.ack` + generation.*（复用字幕文本不重转写）；`voice.discard{recordingId}` | `startRecordVoice`/`commitVoice`/`discardVoice`（BackendAdapter）；`voice.transcript` → `voiceStore`（待发送字幕，不写草稿） |
| 实时语音字幕、断句与轮次提交 | WS `voice_session.start{sessionId(vs_), conversationId?}` → `voice_session.started{sessionId, conversationId?}` → BINARY PCM（VAD 分段）→ `voice_session.partial{sessionId, turnId, segmentIndex, text}`（字幕）→ `voice_session.turn{sessionId, turnId, messageId, conversationId?, text}`（自动提交触发 generation）→ pause/resume/stop/cancel → `voice_session.ended{sessionId, reason(stopped/cancelled/timeout/stt_disabled)}`；`voice_session.ack{sessionId, seq}` 背压 | `voice_session.started/partial/ack/ended` → `voiceStore`（实时状态+字幕）；`voice_session.turn` → `messageStore`（后端预分配 messageId 装配 user 消息） |
| TTS 整段音频、取消和完成 | WS `audio_start{stream_id, format(wav/mp3), sampleRate?, durationMs?}` → `audio{stream_id, seq, data(base64), is_final}` ×N → `audio_end{stream_id, format?}`（format 缺省 wav；字节全发≠播完，完成由前端 `onended` 判定）；`audio.cancel{stream_id}`（全局）→ `audio_cancelled{stream_id}` | `audio.session.started/ready/cancelled` → `voiceStore`（TTS 播放门 D-P1；`autoReadReply` 关则丢弃不播放） |
| 语音族错误路由 | WS `error{code}`（语音族码：`STT_UNAVAILABLE`/`STT_PROFILE_NOT_FOUND`/`VOICE_SESSION_CONFLICT`/`VOICE_SESSION_NOT_FOUND`/`VOICE_RECORDING_TOO_LONG`/`VOICE_RECORDING_NOT_FOUND`/`DICTATION_NOT_FOUND`/`PLAYBACK_NOT_FOUND`）→ real-backend **额外** emit `voice.error{code, message}`（D-P15，`onError` 日志/审计保留）；connectionStore 对语音族码不展示全局连接横幅 | `voice.error` → `voiceStore.error`（语音 UI 展示；`PLAYBACK_NOT_FOUND` 良性忽略） |
| Live2D 表现指令（批次 C 冻结，**无条件记录**） | **raw 帧类型**：`{"type":"live2d.directive","expression"?,"motion"?,"state"?,"priority"?(0\|1\|2\|3),"durationMs"?}`（**扁平帧，无 payload 子对象**）；后端当前**不发**该帧（桩化开发），若收到按冻结契约解析——raw-schema `.strict()` 未知字段/越界（含 `state:'error'`）**整帧拒** | **前端事件**：`Live2DDirectiveEvent`（`event:'live2d.directive'` + 扁平字段透传，`eventId/sequence` 经 envelope 盖戳）→ `live2dStore.handleDirective`：`state` 七值校验、`priority` 客户端钳制 ≤1（建议强度上限）、`durationMs` ∈[0,30_000]（motion 15s 封顶）、白名单三层（controller/adapter/Main）；state → `stateSource.pushDirective` 建议强度仲裁（永不覆盖 client 2/3 级现实态）、expression → `setExpression(file):boolean`、motion → `playMotion(file,priority,durationMs):boolean`；无效/未命中忽略 + 脱敏日志；**无新增 IPC 通道**（走既有 `chat:event` push + preload `parseBackendEvent` 校验） |
| 重连/续传方式 | **无断点续传**；重连后 WS `session` 回放历史；生成中断由客户端据回放判断（消息无对应 `generation.completed` → 视为中断 → 用新 `clientRequestId` 重发）；补充 `GET /api/sessions/{id}/pending`（pendingMessages / pendingApprovals）+ `GET /api/sessions/{id}/generations`（GenerationStatus） | `resume` |
| 错误结构 | WS `error` 帧 / `ErrorMessage{message, code?, requestId?, retryable?, details?}`；REST `ProtocolError{code, message, retryable, requestId, error(=message 别名), details}`；`generation.failed{code, message, retryable, details}`；ACK rejected 带 `error{code, message, retryable}`；40 码目录见 protocol-v2 §9.1 | `PublicError` |

### 19.1 字段差异与 Adapter 桥接项

下表记录 wire 字段与前端领域字段的命名/形状差异，`BackendAdapter` 落地时必须在 Main 内桥接，不得让 wire 原始字段泄漏进 Vue 组件：

| # | wire 字段 | 前端领域字段 | 桥接说明 |
|---|---|---|---|
| D-1 | `generationId`（gen_） | `responseId` / `generationId` | 后端已弃用 `responseId`，**别名 generationId**；前端两字段并存时以 generationId 为准 |
| D-2 | `generation.delta.delta` | `GenerationDeltaEvent.text` | 增量文本改名；语义不变（段内累计、`deltaSequence` 排序） |
| D-3 | `generation.completed.mood` | `emotion`（EmotionState） | 心情字段改名；**F-1（联调前整改）：** mood 为 LLM 自由文本（真实值如「开心」「平静」），前端经 `normalizeEmotionCode`（`renderer/live2d/state-source.ts`）本地归一为 `MoodEmotion`（`happy/sad/surprised`，中英文别名表见 doc 05 §7/§18；未命中保持 `undefined`→`idle`） |
| D-4 | `generation.completed.usage{turn_total, rounds[]}` | `TokenUsage`（source=`provider_reported`） | 按 generation 去重由 `generationId` 保证；rounds 为 provider 逐轮明细 |
| D-5 | `generation.completed.conversationUsage{total, byModel}` | `conversationUsage`（source=`server_aggregate`） | 会话级累计来自服务端，非前端累加 |
| D-6 | `generation.segment.completed.content` | `AssistantSegment.text` | 后端整段文本为权威，无需拼 delta；前端 `SegmentCompletedEvent` **已含** `content?: string`（`shared/contracts/events.ts:65`；`frame-mapper.ts:235` 条件透传；2026-09-14 更正，原文为“当前未含 content”），Adapter 透传或用其覆盖累积 |
| D-7 | `MessageChannel` 含 `status` 通道 | `SegmentChannel` 仅 inner_voice/public_reply | 后端预留 `status` 通道；Adapter 需映射或过滤，不得丢字段 |
| D-8 | `dictation.start.sttProfileId`（`<provider>/<model>`，可选） | `dictationSttProfileId` | 后端已加独立字段（`556117a`），契约已确认；缺省用全局活动 STT，会话内快照不改全局活动 STT；前端直接透传即可，无需 start 前切换 |
| D-9 | `generation.completed.finishReason` 限 stop/tool_calls | 前端消息状态 completed | 取消/错误统一走 `generation.failed`，前端不得从 `state idle` 推断完成 |
| D-10 | `server_info.features` / `services` | 连接能力快照 | 各 feature 如实声明；前端据 `features` 门控 UI，不超前实现 |

**数据来源与记录：** 交接包 `frontend-handoff-v2` 批次 7（`docs/electron-backend-protocol-v2.md` v0.6、`frontend_contract/`、`traces/ws-v2-*.jsonl`）；后端侧 `556117a` 已为 `dictation.start` 增加 `sttProfileId`（`<provider>/<model>`，缺省用全局活动 STT），**D-8 关闭（契约已确认）**；无剩余待后端确认项。**批次 C 注记（2026-09-14 更正）：** `live2d.directive` **已不是"前端超集帧"**——对权威后端实测，该帧**已在后端 `ServerMessage` 判别联合内**（属前端有意滞后、只 warn 不报错的 6 型之一，见 §19.2）。本句原文"后端 `frontend_contract` 当前未含该帧类型"依据的是**过期读数**，且所引"`check:contract` WS 28/28 通过"是批次 7 时点的数字——**口径本身也是错的**：该门禁只核对"前端已认的帧型"，**结构上不可能发现"后端新增、前端未认"的帧**，故"通过"不能用来论证后端未含某帧。契约为前端冻结（raw 帧类型 + 前端事件字段映射见上表），后端实发时按冻结契约对齐即可。E-03 凭据所有权契约已确认（后端 Secret Store `data/secrets/` + `credentialConfigured` 只读；desktop/local 凭据归 Electron），可按「已开发、未联调」推进阶段 1。

### 19.2 帧类型覆盖清单（契约门禁的观测口径）

**权威来源（与本表读数同等重要）：** 后端契约的权威副本**只有两个**——X99（`yomu@192.168.1.18:~/elysia-agent`，经 SSH 取回）与后端交接包。**本机若出现后端克隆，一律不得作为核验来源**：它不会自我声明过期，且可能只是部分副本；用它跑 `check:contract` 会得到**形态正确但来源错误**的读数（实测过一次 `36/36 + 16/16` 的假绿，只有 exit code 与"(0 条来自后端契约文件)"能揭示）。用户于 2026-09-14 已删除本机那份克隆，但**规则保留**——详见 [决策记录](review/2026-09-14-契约门禁对权威后端核验与文档漂移收口-决策记录.md) §3。

**基线：** 2026-09-15 对权威后端复测（后端 `099f38b9`，经 X99 取回 `frontend_contract/` + `traces/ws-v2-*.jsonl`）——此为本节第二次核验（首测 2026-09-14 为 `fc57b16d`），结论一致；命令与口径见 [决策记录](review/2026-09-14-契约门禁对权威后端核验与文档漂移收口-决策记录.md)。**建立本表的直接动因**：这三处此前在本文档**一次都没出现**——`typing`、`character.state.changed`、`character.catalog.changed`（全文检索 0 命中），即“代码已认、文档未记”的静默漂移。

后端 `ServerMessage` 判别联合实测 **42 型**。**算式（2026-09-15 更正）：`42 = 36 门禁核对面 + 6 后端有而前端滞后`**——初稿曾写“42 = 36 + 1 前端私有 + 6 推迟”，算术上 36+1+6=43 已自相矛盾，归类上也错（那“1”不是前端私有，见下表第 2 行）。前端口径另见下表：

<!-- ▼ FRAME-INVENTORY：机器校验锚点，勿改动本行格式。格式为「`WS_V2_FRAME_TYPES`(N)`: <反引号包裹的类型，逗号分隔>`」；
     由 tests/unit/contract-doc-frame-inventory.spec.ts 与 scripts/check-backend-contract.mjs 的 WS_V2_FRAME_TYPES 做**集合相等**比对。
     增删白名单类型时必须同步本行，否则该门禁变红（这正是补上的"文档 ↔ 代码"守护）。 -->
**白名单清单（机器校验）：** `WS_V2_FRAME_TYPES`(37)：`server_info`、`session`、`expression`、`user_message.ack`、`error`、`generation.started`、`generation.segment.started`、`generation.delta`、`generation.segment.completed`、`generation.completed`、`generation.failed`、`state`、`typing`、`delta`、`message`、`token_usage`、`switch_model_result`、`set_tts_voice_result`、`voice.transcript`、`voice_session.started`、`voice_session.partial`、`voice_session.turn`、`voice_session.ack`、`voice_session.ended`、`dictation.partial`、`dictation.final`、`dictation.cancelled`、`audio_start`、`audio`、`audio_end`、`audio_cancelled`、`tool.request`、`tool.started`、`tool.completed`、`action`、`character.state.changed`、`character.catalog.changed`

| 类别 | 型数 | 说明 |
|---|---|---|
| 门禁核对面（前端已认且后端实有） | **36** | `check:contract` 实测 `36/36`；traces 里 `ws-v2-*.jsonl` 磁盘上 **14 个**，脚本按 `!n.includes('-legacy-')` **只读 12 个**，共 **88 条帧**解析后逐字段相等（另有 2 条合成探针 → 门禁报“90 条”） |
| 前端已认、后端 `ServerMessage` 未检出 | **1** | `character.catalog.changed`（多角色 FE-A 为“两侧任一就绪即可对拍”预先入白名单；门禁只做子集判定，故**不会**因前端多认而报错）。**2026-09-15 实测**：该名在整个后端副本的 `contract.schema.json`/`contract.raw.ts`/`ws_message/*.py`/`rest.py` 中 **0 命中**，仅存在于后端设计文档 |
| 后端有、前端有意滞后（只 warn） | **6** | `capabilities`、`command`、`live2d.directive`、`service_mode_result`、`transcription`、`wake` |

**前端侧另有 12 型 client→server 帧**（后端在 `ClientMessage` 联合内，门禁不比对 client 帧，故不计入上表任何一类）：`audio.cancel`、`dictation.start/stop/cancel`、`tool.status`、`voice.commit`、`voice.discard`、`voice.record.start/stop`、`voice_session.start/stop/cancel`。前端 raw-schemas 去重后共 **50 型** = 36 核对面 + 1 `character.catalog.changed` + 1 `live2d.directive`（后端已转为 deferred、前端已实现）+ 12 client→server。

**⚠️ 已被 2026-09-15 复测取代（原文保留）：** 初稿在此写“另有三型**不在** `ServerMessage` 联合内……`typing`（兼容帧）、`character.state.changed`（多角色角色状态帧）、`character.catalog.changed`”。**实测三型中只有 `character.catalog.changed` 不在**：`typing` 与 `character.state.changed` **都在** `ServerMessage` 内，且正是 36/36 里被逐字段检查的两型（证据：`frontend_contract/ws_message/chat.py:118`、`character.py:22`、`contract.schema.json:18040`/`:18013` 的 discriminator mapping）。原句还与上一段自相矛盾（上段说 36，此句又说其中两型不计入 42）。**该散文句无门禁守护**——`contract-doc-frame-inventory.spec.ts` 只守白名单那一行的集合相等，故这类描述只能靠复测发现。

**三条必须与上表同时读的口径：**

1. **两边都取不到 ≠ 通过。** 门禁是**子集判定**：`36/36` 只证明"前端已认的 36 型在后端仍存在且逐字段未变"，**证明不了**"后端没有新增帧"。新增帧会先落进上表第 3 类的 warn 口径。
2. **前 6 型的名单本身也会漂移。** 这 6 型是从后端判别联合现算的；`live2d.directive` 就是**新增进来的**——原脚本注释只列了 5 型且漏掉它，本节"数据来源与记录"注记还据此写成"后端未含该帧"（2026-09-14 已更正）。改白名单时须同步本表。
3. **"文档 ↔ 代码"这一段现已由门禁守着（2026-09-14 起）。** 本表与 `WS_V2_FRAME_TYPES` 由 `tests/unit/contract-doc-frame-inventory.spec.ts` 做**集合相等**校验（双向 + 顺序 + 声明条数，另查每个类型都真有 `type: z.literal`）。**本节初稿曾写"没有被任何门禁守着"——那句已被取代**：三型漂移正是从那个缺口里长出来的，该缺口现已补上；REST 段的对应守护见 §19.3。

### 19.3 REST 目标模型清单（契约门禁的观测口径）

`check:contract` 的 REST 段**不是**按帧型核对，而是按「后端 `rest.py` 模型 ↔ 前端 `rest-schemas.ts`」逐模型比对字段名/必填性（role 枚举取子集）。本节的清单就是那 16 个模型——**它是"文档 ↔ 代码"的 REST 半边**：WS 段由 §19.2 守，REST 段由本节守，两者的守护者都是 `tests/unit/contract-doc-frame-inventory.spec.ts`。

**建立动因**：与 §19.2 同源——`check:contract` 只比"代码 ↔ 后端"，于是"代码认了、文档没记"的 REST 模型同样会静默漂移。此前这 16 个模型**只存在于脚本的 `REST_TARGET_MODELS` 常量里**，本文档没有任何机器可校验的落点。

<!-- ▼ REST-INVENTORY：机器校验锚点，勿改动本行格式。格式为「`REST_TARGET_MODELS`(N)`: <反引号包裹的后端模型名，逗号分隔>`」；
     由 tests/unit/contract-doc-frame-inventory.spec.ts 与 scripts/check-backend-contract.mjs 的 REST_TARGET_MODELS 做**集合相等**比对。
     增删目标模型时必须同步本行，否则该门禁变红。 -->
**REST 目标模型清单（机器校验）：** `REST_TARGET_MODELS`(16)：`SearchMessageItem`、`SearchMessagesResponse`、`MessageContextResponse`、`AttachmentInfo`、`AttachmentUploadResponse`、`AttachmentSignResponse`、`StickerEntry`、`StickerListResponse`、`ProviderEntry`、`CustomProvider`、`ProvidersResponse`、`ProviderTestResult`、`TtsVoiceEntry`、`TtsVoicesResponse`、`TtsPreviewResult`、`DesktopCallStatus`

口径与 §19.2 同款，须一并读：

1. **子集判定的边界同样适用**：16/16 只证明"这 16 个模型的字段形状在后端仍成立"，**证明不了**"后端没有新增 REST 模型"。
2. **一个后端模型可对多个前端 schema**：`AttachmentInfo` 与 `AttachmentUploadResponse` 共用 `RestAttachmentUploadResponseSchema`（前者取 `shape.attachments.element`）⇒ 16 个后端模型对 **15 个**前端 schema，**不是一一映射**，比对时不可假设等长。
3. **本清单的守护键是后端模型名**（`REST_TARGET_MODELS` 的键），不是前端 schema 名——前端 schema 改名不影响本门禁。

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
