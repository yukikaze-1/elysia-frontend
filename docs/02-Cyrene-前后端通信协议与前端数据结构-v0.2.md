# Cyrene 前后端通信协议与前端数据结构

**文档版本：** v0.2  
**文档状态：** 首轮 Review 已修订 / 待与现有后端核对  
**适用范围：** Electron 客户端与现有 Agent 后端  
**文档日期：** 2026-08-03
**最后复核日期：** 2026-08-04

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

## 5. 连接与能力协商

### 5.1 客户端 Hello

```typescript
interface ClientHello {
  clientId: string;
  clientVersion: string;
  protocolVersions: string[];
  platform: "windows" | "linux";
  arch: "x64" | "arm64";
  capabilities: ClientCapability[];
  resume?: {
    sessionId: string;
    lastEventId?: string;
  };
}

interface ClientCapability {
  name: string;
  version: string;
  runtime: "desktop" | "local_worker";
  availability: "available" | "disabled" | "unavailable";
}
```

### 5.2 服务端 Hello

```typescript
interface ServerHello {
  sessionId: string;
  protocolVersion: string;
  serverVersion?: string;
  heartbeatIntervalMs: number;
  maxEventBytes: number;
  features: string[];
  resumeAccepted: boolean;
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
  finishReason: "stop" | "cancelled" | "length" | "tool" | "error";
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

普通模式停止后生成待发送的音频输入，由用户确认发送；实时模式在用户明确启动的会话中按已确认的 VAD/断句规则提交语音轮次。`VoiceCaptionEvent` 只能进入字幕状态，不得合并到 `ConversationDraft.text`。实时语音的自动断句和轮次提交仍需与现有后端对齐。

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

### 16.2 恢复规则

- 指数退避并加入随机抖动；
- 认证失败不无限自动重试；
- 重连携带 `sessionId` 和最后确认的事件 ID；
- 无法续传时重新拉取当前会话；
- 流式消息保留已接收内容并标记“连接中断”；
- `pending` 用户消息通过 `clientRequestId` 查询确认状态；
- 待授权工具调用重连后先查询状态，禁止自动执行；
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

接入前逐项填写“现有值”和“前端映射”：

| 核对项 | 现有后端值 | 前端映射 |
|---|---|---|
| 认证方式 | 待填写 | `BackendAdapter.connect` |
| 会话列表接口 | 待填写 | `listConversations` |
| 历史消息接口 | 待填写 | `getConversation` |
| 历史消息游标与稳定排序键 | 待填写 | `MessagePage.nextCursor` |
| 按消息 ID 获取上下文 | 待填写 | `getMessageContext` / `MessageContextQuery` |
| 会话搜索/聊天历史查询接口 | 待填写 | `listConversations` / `ChatHistoryPage` |
| 会话多媒体资源接口 | 待填写 | `ConversationResourcePage` |
| 用户消息发送 | 待填写 | `sendMessage` |
| 流式传输方式 | 待填写 | `generation.*` |
| 消息增量字段 | 待填写 | `GenerationDeltaPayload` |
| Inner Voice 字段与增量规则 | 待填写 | `channel: inner_voice` |
| Public Reply 字段与增量规则 | 待填写 | `channel: public_reply` |
| 句子分段 ID、顺序和父回复完成事件 | 待填写 | `responseId/segmentId/segmentIndex` |
| 消息/会话 Token、实际模型和心情字段 | 待填写 | `TokenUsage/ModelIdentity/EmotionState` |
| 停止生成接口 | 待填写 | `cancelGeneration` |
| 工具调用字段 | 待填写 | `ToolCall` |
| 工具结果接口 | 待填写 | `submitToolResult` |
| 附件上传流程 | 待填写 | `AttachmentRef` |
| LLM/STT/TTS Profile 配置接口 | 待填写 | `ModelProfile` |
| 自定义模型新增/编辑/删除 | 待填写 | `UpsertCustomModelProfileCommand` |
| 模型连接测试与切换接口 | 待填写 | `ModelProfileTestResult` |
| 输入法转写专用 STT 选择 | 待填写 | `dictationSttProfileId` / `DictationSettings` |
| 普通录音输入与发送确认 | 待填写 | `VoiceInputSession` / `RecordedVoiceInputReadyEvent` |
| 实时语音字幕、断句与轮次提交 | 待填写 | `VoiceCaptionEvent` / 后端轮次事件映射 |
| TTS 整段/流式音频、取消和完成 | 待填写 | `TtsPlaybackSession` / `TtsChunkEvent` |
| 重连/续传方式 | 待填写 | `resume` |
| 错误结构 | 待填写 | `PublicError` |

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
