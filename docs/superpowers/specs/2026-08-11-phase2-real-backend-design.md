# 阶段 2 块 B：RealBackend —— REST/WS v2 Adapter —— 设计

**日期：** 2026-08-11
**状态：** 已 code-review（第 1 轮干净；P0-1 `server_info.protocol_version` 应查 `"2.0"`、P1-1 raw 层扩展 ack/error、P1-2 回放形状、P1-3 tool 元数据 + 全部 P2/P3 已修并复核通过）
**关联：** [2A spec](2026-08-10-phase2-contract-raw-wire-design.md)（raw wire 层/FrameMapper/Accumulator 已落地）、[docs/18 §16 阶段 B](../18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md)、[doc 16 §5 阶段 2](../16-Cyrene-前端实施任务清单与进度跟踪.md#L228)、[doc 02 §19 对齐表](../02-Cyrene-前后端通信协议与前端数据结构-v0.2.md)
**后端契约基线：** `/home/yomu/elysia-agent` @ `beeba5776413dde9761375c2fd9541d6636f180d`（REST `session_routes.py`/`frontend_contract/rest.py`、WS `ws_handler.py`/`frontend_contract/ws_message.py`）

---

## 1. 背景与目标

2A 在纯逻辑层修好了领域契约、raw wire schema、FrameMapper、StreamAccumulator 与 wire fixtures（231 单测全绿），但 **没有真实网络层**：`BackendAdapter` 接口只有 `MockBackend` 实现，UI 无法连真实后端。本块（2B）实现 **`RealBackend`**——真实 REST + WebSocket v2 适配器，落在 Main 进程，消费 2A 的 raw schema/FrameMapper，把后端 wire 转成领域 `BackendEvent`/领域模型供给后续 Store（2C）。

目标（docs/16 阶段 2 任务 ①②⑤ + docs/18 阶段 B）：
1. **连接**：WS `/ws` 建连 + 精确握手头（`X-Protocol-Version: 2` / `X-Client-Platform: electron` / `Authorization: Bearer <token>`），版本协商 fail-closed；
2. **握手帧处理**：`session → server_info → expression`；`session` 回放缓冲与活动会话归属；
3. **会话**：REST 列表/详情/创建/重命名/删除 + WS `activate_session` 激活；
4. **历史**：REST `before`/`after` 分页（`_id` opaque cursor）、倒序归一化、`after` 增量正序；
5. **发送/停止**：WS `text`（`clientRequestId` 幂等）+ `user_message.ack` 确认；`interrupt` → `generation.failed{CANCELLED}`；
6. **心跳/重连**：断线检测 + 指数退避重连 + 重新握手回放。

**本块不实现**：Store/UI（2C）、Desktop 工具（阶段 6）、语音（阶段 4）、dictation（阶段 4）。真实联调待 B-01（测试环境地址），本块标记「已开发、未联调」。

### 1.1 后端契约已核实（`beeba577`）

| 项 | 确认 |
|---|---|
| WS 端点 | `/ws`；握手头 `X-Protocol-Version: "2"`（精确值，其余显式值 → 400 不降级，`resolve_protocol_version`）、`X-Client-Platform: electron`、`Authorization: Bearer`（`AGENT_ACCESS_TOKEN` 配置时必需） |
| 建连帧序 | `session`(带 `conversationId`+`messages`+`token_stats`) → `server_info`(protocol_version/server_version/features/services/connectionId/build_sha) → `expression` |
| WS 心跳 | 后端 `heartbeat=30s` 发 ping、`receive_timeout=60s` 关僵尸连接（Node `ws` 库自动回 pong） |
| WS 客户端帧 | `text{content, clientRequestId, clientMessageId?, conversationId?}`、`interrupt`、`activate_session{conversationId}`(v2 only) |
| 发送确认 | `user_message.ack{messageId, clientRequestId, clientMessageId?, conversationId?, receivedAt, status: accepted/rejected, error?}` |
| REST 会话 | `GET/POST /api/sessions`、`GET/PATCH/DELETE /api/sessions/{conversationId}`、`POST /api/sessions/{conversationId}/activate` |
| REST 分页 | `GET /api/sessions/{id}/messages?before=<_id>&limit=50`(倒序)/`?after=<_id>`(正序)；畸形游标 400 `CONTRACT_VALIDATION`；响应 `{messages, has_more, total, cursor}`(cursor=raw 最末 `_mongo_id`) |
| REST pending | `GET /api/sessions/{id}/pending` → `{pendingMessages[], pendingApprovals[]}`（重连恢复） |
| 错误信封 | `ProtocolError{code, message, retryable, requestId, error(=message), details}` |

## 2. 范围

| 项 | 内容 |
|---|---|
| 依赖 | `apps/desktop` 新增 `ws` + `@types/ws`（Main 进程 WS 客户端库） |
| RealBackend | `src/main/transport/real-backend.ts`：实现 `BackendAdapter` 接口；WS 连接生命周期 + REST 调用 + 事件推送 |
| REST raw 层 | `protocol-v2/rest-types.ts` + `rest-schemas.ts`（REST wire 类型/校验，保留混合命名 `message_id`/`_id`）+ `rest-mapper.ts`（→ 领域模型） |
| 领域契约 | `shared/contracts/message.ts` 加 `Message.tool?`（tool 消息元数据，docs/18 §14）；`BackendAdapter` 接口扩展（见 §5.4）；raw 层扩展 `user_message.ack`/`error` 两帧（见 B-12） |
| 会话/历史映射 | REST `SessionSummary`/`Message`/`MessagesPageResponse` → 领域 `Conversation`/`Message`/`MessagePage`；`_id` opaque cursor 保留 |
| WS 帧消费 | 复用 2A `parseRawFrame` + `FrameMapper` → 领域 `BackendEvent` → `subscribe` handler |
| 连接生命周期 | 握手 fail-closed、心跳、断线检测、指数退避重连（断线后当前生成的中断语义由 2C 状态机基于 `ConnectionState` 处理；RealBackend **不伪造** `generation.failed`） |
| 发送/停止/激活 | `sendMessage` → WS `text`+ack；`cancelGeneration` → WS `interrupt`；`activateConversation` → WS `activate_session`（REST activate 辅助） |
| 文档 | doc 16 阶段 2 勾选连接/会话/历史项（标「已开发、未联调」）；docs/18 阶段 B 标注 |

**非目标（后续块/阶段）：** Pinia Store 与 UI（2C，消费 RealBackend）；`getMessageContext`/搜索/资源/**generation 状态查询**（`GET /api/sessions/{id}/generations`，阶段 3 断线恢复）；模型服务/语音（阶段 4）；Desktop 工具（阶段 6）。

## 3. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| B-1 | WS 客户端库 | **`ws` npm 包**（Electron main 标准 WS 库，内置 ping/pong 自动应答；`@types/ws` devDep）。不用 undici（无 WS）、不用 electron net（底层）。版本锁 8.x |
| B-2 | REST raw 层位置 | `protocol-v2/rest-types.ts` + `rest-schemas.ts` + `rest-mapper.ts`（与 raw wire 同目录，禁止混入领域层） |
| B-3 | 接口扩展 | `BackendAdapter` 新增 `activateConversation(id): Promise<{conversationId}>` 与 `getConversationMessages(input: ConversationMessagesQuery): Promise<MessagePage>`（`GetConversationQuery` 保持详情用途；分页用新方法，docs/18 §10.2） |
| B-4 | 连接配置 | `ConnectInput{serverUrl, token?}` 现有形状不变；`token` 由 2C 从凭据存储取；2B 只消费 |
| B-5 | 事件流 | 复用 2A `FrameMapper`（每连接一个实例，`connectionId` 注入）；`session/server_info/expression` 帧 mapper 返回 null，由 RealBackend 直接处理（缓冲/连接元数据） |
| B-6 | session 回放归属 | `session.conversationId` 存在即用；缺省（旧后端）时缓冲 `messages` 至活动会话解析（**REST `GET /api/sessions` 的 `active:true` 条目**；勿用 `server_info.connectionId`——连接身份 ≠ 会话 ID，后端无按 connectionId 查会话的端点） |
| B-7 | 重连 | 断线 → 指数退避（1s 起 ×2，上限 30s）→ 重新握手 → 重新 session 回放；重连期间 `generation.failed` 语义由 2C 状态机处理；`onProtocolWarning` 接日志 |
| B-8 | 分页 | `before` 用 `_id`（倒序，入 UI 前按时间正序归一化）；`after` 用 `_id`（正序增量）；畸形游标 400 → `CyreneError(CONTRACT_VALIDATION)`；`nextCursor` 用响应 `cursor` 原样 |
| B-9 | 错误映射 | REST `ProtocolError`/`ApiFail` → `CyreneError`（保留 code/message/retryable）；WS `error` 帧 → `onError` 公开错误回调（§5.3 分派）+ `onProtocolWarning` |
| B-10 | 状态公开 | RealBackend 暴露 `getConnectionState(): ConnectionState`（`disconnected/connecting/connected/reconnecting/error` + 细节），2C connectionStore 消费；本块只定义类型 |
| B-11 | 标记 | 真实联调未做（B-01 未到位）→ **「已开发、未联调」**；单测用 Mock WS 服务（Node http + ws 库起本地伪后端）+ REST Mock |
| B-12 | raw 层扩展 | **2B 扩展 `raw-types`/`raw-schemas` 纳入 `user_message.ack` 与 `error` 两帧**（2A 判别 union 只含 9 类无此二者；不做则 sendMessage 的 ack 关联与 WS 错误上报失效）。二者由 RealBackend 直接处理（不产生领域事件，FrameMapper 返回 null，同 session/server_info 模式）：`user_message.ack` 按 `clientRequestId` 关联 pending sendMessage；`error` 路由到公开错误回调 |

**实施中新增决策：** 按目标指令追加到 §10 与最终报告。

## 4. 目标结构

```text
apps/desktop/src/main/transport/
├── backend-adapter.ts              # 修改:新增 activateConversation + getConversationMessages
├── mock-backend.ts                 # 不变
├── protocol-v2/
│   ├── raw-types.ts / raw-schemas.ts / frame-mapper.ts   # 2A 既有
│   ├── rest-types.ts               # 新增:REST wire 类型(混合命名)
│   ├── rest-schemas.ts             # 新增:REST zod schema
│   └── rest-mapper.ts              # 新增:REST wire → 领域模型
└── real-backend.ts                 # 新增:RealBackend 实现 BackendAdapter
apps/desktop/tests/unit/
├── rest-schemas.spec.ts            # 新增
├── rest-mapper.spec.ts             # 新增
├── real-backend.spec.ts            # 新增(Mock WS 服务 + REST Mock)
└── (既有)
apps/desktop/tests/fixtures/rest/   # 新增:REST wire 夹具(可选,rest-mapper 测试内联亦可)
```

## 5. 关键实现

### 5.1 REST wire 类型与 schema（`rest-types.ts` / `rest-schemas.ts`）

基于 `frontend_contract/rest.py`（保留混合命名）。REST schema 用 `.strict()`（与 raw wire 一致，拒绝未知键）。

```typescript
// rest-types.ts —— 关键类型(完整列表见 plan)
export interface RestSessionSummary {
  conversationId: string
  title?: string
  messageCount: number
  updatedAt: string
  active: boolean
}
export interface RestSessionListResult { sessions: RestSessionSummary[]; has_more: boolean; cursor?: string }
export interface RestSessionDetail { session: RestSessionSummary; messages: RestMessage[]; active: boolean }
export interface RestMessage {
  role: string
  parts?: { content: string }[]
  content?: unknown
  content_type?: Record<string, number[]>
  inner_voice?: string
  tool_calls?: unknown[]
  token_usage?: unknown
  message_id: string
  timestamp: string
  session_id?: string
  metadata?: Record<string, unknown>
  _id?: string                       // Mongo 归档 ID(wire 键为 _id)
  tool_call_id?: string
  tool_name?: string
  success?: boolean
  error?: string
  error_type?: string
  duration_ms?: number
  truncated?: boolean
}
export interface RestMessagesPageResponse { messages: RestMessage[]; has_more: boolean; total: number; cursor?: string }
export interface RestSessionActivateResult { activeConversationId: string }
export interface RestPendingQueryResponse { pendingMessages: { messageId: string; snippet: string; createdAt: string }[]; pendingApprovals: unknown[] }
```

- `rest-schemas.ts`：对应 zod（判别不需要；每模型 `.strict()`）；`_id` 用 `z.string().optional()`（archive 消息恒有，临时可选）。
- `RestMessageSchema` 的 `content`/`tool_calls`/`token_usage`/`metadata` 用 `z.unknown()`（2B 只做结构校验，精确类型阶段 3）。

### 5.2 REST mapper（`rest-mapper.ts`）—— REST wire → 领域模型

```typescript
export interface RestMapperOptions { onProtocolWarning?: (warning: ProtocolWarning) => void }

export class RestMapper {
  /** REST Message → 领域 Message(assistant 可见正文单一来源:assistantSegments;content 仅 user/tool) */
  toDomainMessage(raw: RestMessage): Message
  /** WS session 回放项(RawSessionMessageItem)→ 领域 Message;与 RestMessage 字段差异见下 */
  toDomainMessageFromReplay(raw: RawSessionMessageItem, conversationId: string): Message
  /** SessionSummary → 领域 Conversation */
  toConversation(raw: RestSessionSummary): Conversation
  /** MessagesPageResponse → 领域 MessagePage(保留 _id cursor;before 页倒序归一化为时间正序) */
  toMessagePage(raw: RestMessagesPageResponse, opts: { direction: 'before' | 'after' }): MessagePage
}
```

**回放项(`RawSessionMessageItem`)与 REST `RestMessage` 字段差异**（两者都归一化到领域 `Message`，逻辑共用 `_assembleMessage`）：回放项 tool 名是 `name`（REST 是 `tool_name`）、多 `mood`、`message_id`/`timestamp` 可缺省、无 `_id`/`session_id`、`content` 可为判别 `ContentPart[]`——`toDomainMessageFromReplay` 处理这些差异，`session_id`/`message_id` 缺省时由调用方注入 `conversationId`/生成稳定本地 id（`2C` Store 层按 `messageId` 去重，缺省 id 需可复现）。

映射要点：
- `message_id` → `messageId`；`session_id` → `conversationId`（缺省时由调用方注入）；`timestamp` → `createdAt`；`inner_voice`/`parts`/`content` → assistant 消息组装 `assistantSegments`（`role==='assistant'` 时：`content` 纯文本 → 单 `public_reply/text` 段；`inner_voice` → 单 `inner_voice/text` 段；`parts[]` → markdown 段）。`role==='user'` → `content`（拼接 parts 或 content）；`role==='tool'` → `content`。
- `_id` → `nextCursor`（`has_more` 时用响应 `cursor`；**缺省 cursor 且 `has_more` 时**用 raw 最末条 `_id`（反转前的最旧条，before 方向正确）；`has_more=false` 时无 cursor）。
- `before` 页：raw 倒序 → `items` 按 `(_id, timestamp)` 正序归一化（`_id` ObjectId 单调，作稳定排序键；同刻不漂移）；`after` 页：已正序，不反转。
- 领域 `Message.status`：归档消息 → `completed`（assistant 有 segments）/`completed`（user/tool）。
- `role==='tool'` 时除 `content` 外，保留 `tool_call_id`/`name`/`success`/`error`/`error_type`/`duration_ms`/`truncated` 到领域 `Message.tool?`（docs/18 §14 禁止按普通文本丢弃）。
- assistant 段组装**优先级**：`inner_voice` 独立成 `inner_voice/text` 段；`content` 纯文本 → 单 `public_reply/text` 段；`parts[]`（`_archive_to_client` 对纯文本同时产出 `content` 与 `parts`）→ **`content` 优先，`parts` 仅当 `content` 非纯文本/缺失时**（防同一文本重复成两条段）。
- 页间去重以 `messageId` 为准（Store 层 2C 保证；mapper 输出不重复即可）。

### 5.3 RealBackend（`real-backend.ts`）—— 实现 `BackendAdapter`

```typescript
export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  serverUrl?: string
  protocolVersion?: string
  serverVersion?: string
  connectionId?: string
  activeConversationId?: string
  lastError?: string
}

export interface RealBackendOptions {
  fetchImpl?: typeof fetch          // 测试注入
  now?: () => number                // 测试注入(退避/心跳)
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike   // 测试注入
  onProtocolWarning?: (warning: ProtocolWarning) => void
  onSessionReplay?: (conversationId: string, messages: Message[]) => void   // session 回放投递(2C 接入)
  onError?: (error: CyreneError) => void   // WS error 帧/连接错误公开回调
}
```

生命周期（`connect` 内部）：
1. 校验 `serverUrl`/`token`（缺 token 时按后端 `AGENT_ACCESS_TOKEN` 配置 fail 或尝试无认证——**2B 默认要求 token，缺省抛 `NOT_CONNECTED` 语义错误**，2C 从凭据存储取）；
2. `wsFactory` 建连 `{wsBase}/ws`（`serverUrl` 的 `http(s)://` → `ws(s)://` 协议转换，路径拼接 `/ws`），请求头注入 `X-Protocol-Version: "2"`、`X-Client-Platform: "electron"`、`Authorization: Bearer <token>`；
3. 收帧 → `parseRawFrame`（fail → `onProtocolWarning` + 丢弃该帧，不 kill 连接）；按 type 分派：
   - **generation 帧** → `FrameMapper.mapFrame` → 领域事件 → `emit`（`subscribe` handler）；
   - **`session`/`server_info`/`expression`** → RealBackend 处理（缓冲/连接元数据）；
   - **`user_message.ack`** → 按 `clientRequestId` 关联 pending sendMessage（见下）；无 pending 关联 → 告警忽略；
   - **`error` 帧**（`activate_session` 的 `SESSION_NOT_FOUND`、认证/限流等）→ `onError` 公开错误回调 + `onProtocolWarning`；
4. `server_info.protocol_version` 非 `"2.0"` → fail-closed（抛 `PROTOCOL_MISMATCH`，不按 v1 工作）。**注意两层取值**：请求头 `X-Protocol-Version` 用精确 `"2"`（`resolve_protocol_version` 只认 `"2"`），而 wire 上 `server_info.protocol_version` 是展示层 `"2.0"`（后端 `PROTOCOL_VERSION`）——检查目标是 `"2.0"`；`ConnectionState.protocolVersion` 记录 `"2.0"`；
5. `session` 帧：`conversationId` 存在 → 立即归一化缓冲的 `messages` 回放（`RestMapper.toDomainMessageFromReplay` → 领域 `Message[]` → 经 `onSessionReplay(conversationId, messages)` 回调投递，2C 接入）；缺省 → 缓冲 `messages` 至活动会话解析（见 B-6），解析后按同一回调投递。

**connect resolve**：握手完成（`server_info` 到达）→ resolve 返回 `BackendSession{sessionId: connectionId ?? 'local', protocolVersion: '2.0', serverUrl}`（`sessionId` 记录**连接身份**，非会话 ID；活动会话经 `getConnectionState().activeConversationId` 暴露——connectionId 不当作 conversationId，docs/18 §7.1）。

REST 方法（`fetchImpl`，`baseUrl = serverUrl`；**所有请求统一注入 `Authorization: Bearer <token>`**，与 WS 同 token——后端 auth 中间件护 `/api/*`，docs/18 §15.1）：
- `listConversations({cursor, limit})` → `GET /api/sessions?cursor=&limit=` → `RestMapper.toConversation` 数组 + `hasMore/nextCursor`；
- `getConversation({conversationId})` → `GET /api/sessions/{id}` → `ConversationDetail`（详情 + 第一页消息；**首页 `query_page` 倒序，入详情前按 `(_id, timestamp)` 正序归一化**）；
- `getConversationMessages({conversationId, before?, after?, limit})` → `GET /api/sessions/{id}/messages?...`（默认 limit 50）→ `RestMapper.toMessagePage`；
- `createConversation({title?})` → `POST /api/sessions`；
- `renameConversation(id, title)` → `PATCH`（接口若无，2B 扩展——见 §5.4）；
- `deleteConversation(id)` → `DELETE /api/sessions/{id}`；
- `activateConversation(id)` → `POST /api/sessions/{id}/activate`（响应 `{activeConversationId}` → 结果 `{conversationId: activeConversationId}`）+ 发起 WS `activate_session{conversationId}`（connected 时；触发新会话回放）；**resolve 时机 = REST 完成即 resolve**（简化契约，Task 5 实施定：回放**异步**经 `onSessionReplay` 投递，2C 以该回调渲染，不等待回放帧；B-G6 记录）；
- `sendMessage(input)` → WS `text{content, clientRequestId, conversationId}`（`clientMessageId` 可选）→ 注册 pending（keyed by `clientRequestId`）→ 等待 `user_message.ack`：accepted → resolve `ClientRequestRef{clientRequestId, serverMessageId}`；rejected → 抛 `CyreneError`（带 ack `error` 的 code/message）；超时（15s，`now()` 注入）→ 抛 `CyreneError(TIMEOUT)` 并清 pending；
- `cancelGeneration({generationId})` → WS `interrupt`（**非定向**：后端 `InterruptMessage` 仅 `{type:"interrupt"}`，无 generationId——语义为打断当前生成；`generationId` 参数仅日志关联）；
- `queryChatHistory`/`getMessageContext` → 阶段 3（本块 `NOT_IMPLEMENTED` 抛错，不 Mock 假装）。

心跳/重连：
- `ws` 库自动回 pong；网络层 `ws.on('close'/'error')`（连接中断）→ 状态 `reconnecting`，指数退避重连（1s 起 ×2 上限 30s，`now()` 注入测试时间），重连成功 → 重新握手 + 回放；超过 6 次 → `error` 状态；
- **非 101 升级响应区分**：`ws` 库的 `unexpected-response`（HTTP 400 协议拒绝/401/403 认证失败）→ fail-fast 置 `error` 状态，**不重连**（认证/协议错误重试无意义，docs/18 §15.1）；
- `disconnect()` → 主动关闭，状态 `disconnected`，清定时器与 pending。

### 5.4 BackendAdapter 接口扩展

```typescript
// backend-adapter.ts 新增
export interface ConversationMessagesQuery {
  conversationId: string
  before?: string    // _id opaque cursor(倒序)
  after?: string     // _id opaque cursor(正序增量)
  limit?: number
}
export interface ActivateConversationResult { conversationId: string }

export interface BackendAdapter {
  // …既有…
  getConversationMessages(input: ConversationMessagesQuery): Promise<MessagePage>
  activateConversation(conversationId: string): Promise<ActivateConversationResult>
  renameConversation(id: string, title: string): Promise<Conversation>
}
```

`MockBackend` 同步实现新方法（空实现/内存会话，保持接口一致）。

### 5.5 测试策略

| 文件 | 覆盖 |
|---|---|
| `rest-schemas.spec.ts` | 合法/非法：RestSessionSummary/Message/MessagesPageResponse 各字段、`.strict()` 拒绝未知键、`_id` 可选 |
| `rest-mapper.spec.ts` | `toDomainMessage`（user/assistant/tool 三种 role 组装、inner_voice/parts/content）、`toConversation`、`toMessagePage`（before 倒序归一化、after 不反转、nextCursor 用响应 cursor/最末 `_id`） |
| `real-backend.spec.ts` | **本地 Mock WS 服务**（Node `http` + `ws` 库起伪后端）：握手 header 断言（`X-Protocol-Version: "2"`/`X-Client-Platform`/Bearer）、`session→server_info→expression` 处理、事件推送（经 FrameMapper）、`text`+`user_message.ack`（accepted resolve / **rejected → `CyreneError`** / 超时）、`interrupt`、`activate_session`、断线重连（注入 `now()`/`wsFactory`）、**`unexpected-response`(400/401) → fail-fast 不重连**、REST 方法（`fetchImpl` mock，含 **`before`/`after`/`limit` 参数透传、400 `CONTRACT_VALIDATION` → `CyreneError`**）、**缺 `conversationId` 旧后端回放缓冲归属**、版本不兼容（`server_info.protocol_version` 非 `"2.0"`）fail-closed |
| 既有 | 231 单测不回归；`mock-backend` 新方法可调用 |

**验证命令**：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。

## 6. 错误处理与安全

- **fail-closed**：`server_info.protocol_version`（wire 展示层，值 `"2.0"`）非 `"2.0"` → `PROTOCOL_MISMATCH`，不按 v1 静默工作；握手失败明确报错。
- **Token 不经 Renderer**：`token` 由 2C 从凭据存储经 IPC 取，RealBackend 只持引用；日志脱敏（2A/块 B 既有 sanitize）。
- **REST 错误信封**：`ProtocolError`/`ApiFail` → `CyreneError`（code/message/retryable 保留），不吞不伪造。
- **WS 帧未知/畸形**：`parseRawFrame` fail → 告警 + 丢弃，不 kill 连接（避免单个坏帧断连）；`FrameMapper` 抛 `PROTOCOL_MISMATCH`（如 delta 无 meta）→ 记录 + 按 2B 承接点 I-1 处理（默认 catch 降级告警，不断连）。
- **重连安全**：指数退避上限 30s；不无限重试（超过 N 次报 error 状态）。
- **测试隔离**：Mock WS 服务只起在测试临时端口，不触碰真实后端。

## 7. 测试策略总览

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单测（本块） | vitest node env | rest-schema/rest-mapper/real-backend（Mock WS + fetch 注入） |
| 单测（既有） | vitest | 231 项不回归；mock-backend 新方法 |
| 联调 | — | 真实后端联调待 B-01（本块标「已开发、未联调」） |

## 8. 验收标准

1. `real-backend.ts` 实现 `BackendAdapter`（含新方法）；`ws` 依赖落地；
2. **握手**：请求头 `X-Protocol-Version: "2"`（精确）/`X-Client-Platform: electron`/Bearer；`server_info.protocol_version !== "2.0"` → `PROTOCOL_MISMATCH` fail-closed；
3. **握手帧**：`session` 缓冲/归属、`server_info` 元数据、`expression` 忽略；`connectionId` 不当作 conversationId；
4. **事件推送**：WS 帧经 `parseRawFrame` → `FrameMapper` → `subscribe` handler（复用 2A 链路）；未知/畸形帧不 kill 连接；
5. **REST 会话/历史**：list/get/create/rename/delete/activate + 分页 `_id` cursor（before 倒序归一化、after 不反转、畸形游标 400 → `CyreneError`）；
6. **发送/停止**：`text`+`clientRequestId`+`user_message.ack` 关联（accepted resolve / rejected 抛错 / 超时兜底）、`interrupt`；WS `error` 帧路由 `onError`；
7. **心跳/重连**：断线检测 + 指数退避 + 重新握手回放（测试注入时间/wsFactory）；
8. `rest-schemas`/`rest-mapper`/`real-backend` 三套单测全绿；既有 231 不回归；typecheck/lint/build 过；
9. 本块标记「已开发、未联调」；doc 16 阶段 2 勾选；docs/18 阶段 B 标注。

## 9. 风险与预案

| 风险 | 预案 |
|---|---|
| `ws` 库行为与后端 aiohttp 心跳差异（ping/pong 时序） | Mock WS 服务复现 30s ping；`now()` 注入测试时间；真实联调以 B-01 验证 |
| REST Message 混合命名（`message_id`/`_id`）映射错误 | `rest-mapper.spec` 用后端契约构造样例逐字段断言；`_id` 恒保留为 cursor |
| `session.conversationId` 缺省（旧后端）缓冲归属复杂 | B-6 明确降级路径；后端已补该字段（2A spec §1.1 确认） |
| Mock WS 服务复杂度高（真实 aiohttp 语义模拟） | Mock 只覆盖本块契约路径（握手/帧/ack/activate）；不模拟 FSM 内部 |
| 分类器/主模型间歇不可用（本环境） | 窗口内批量执行；doc 17 §15 已记录 |

## 10. 已知限制与接受项

| # | 限制 | 影响/处理 |
|---|---|---|
| B-G1 | 真实联调未做（B-01 未到位） | 标「已开发、未联调」；Mock WS + REST mock 驱动测试；docs/18 要求联调时记录实际后端 SHA |
| B-G2 | `getMessageContext`/搜索/资源 → `NOT_IMPLEMENTED` | 阶段 3 实现；本块不 Mock 假装 |
| B-G3 | `sendMessage` 的 `user_message.ack` 超时语义 | 块内 15s 超时兜底（`now()` 注入，§5.3）；2C 决定 UI 层展示 |
| B-G4 | 重连后的 pending/generation 恢复查询 | 本块只做重新握手回放；pending 查询（`GET /api/sessions/{id}/pending`）接入留 2C（断线恢复 UX） |
| B-G5 | 模型服务/语音/Desktop 工具方法在 RealBackend 抛 `NOT_IMPLEMENTED` | 阶段 4/6 实现；接口存在但未接真实 |
| B-G6 | **实施中新增决策** | ① `CyreneErrorCode` 扩展 `TIMEOUT`/`NOT_FOUND`/`AUTHENTICATION_FAILED`（ack 15s 超时 / REST 404 / 认证失败）；② REST 400 `CONTRACT_VALIDATION` → `CyreneError(INVALID_INPUT)`（现有枚举无 CONTRACT_VALIDATION）；③ `RestMapper.toDomainMessage`/`toMessagePage` 加 `conversationId?` 参数（REST 消息 `session_id` 缺省时由调用方注入）；④ `activateConversation` resolve = **REST 完成即 resolve**，回放异步经 `onSessionReplay` 投递（不等待回放帧，2C 以回调渲染）；⑤ REST 方法需先 `connect`（`serverUrl` 已设），connect 前调用抛 `NOT_CONNECTED` guard；⑥ 告警码收编：`RAW_FRAME_INVALID`/`SESSION_BUFFER_REPLACED`/`ACK_UNKNOWN_CLIENT_REQUEST_ID`/`WS_ERROR_FRAME`/`MAPPER_ERROR` 并入 `ProtocolWarningCode`（Task 5 落地） |
