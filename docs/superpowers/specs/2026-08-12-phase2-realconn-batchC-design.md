# Cyrene 阶段 2 真实联调整改·批次 C：边界与联调门禁（IPC/replay 运行时 Schema / 夹具跨仓库 / 文档漂移）设计

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段2真实联调前端整改清单.md` 批次 C（FE-P2-02 / FE-P2-03 / FE-P2-04）
**审查对象基线：** `main@9f62f60`（批次 A/B 落地后 HEAD）
**范围：** Electron 阶段 2 文本聊天纵向链路的边界加固（Main / Preload / shared schemas / wire fixtures / 文档）
**目的：** 联调前补齐 IPC/response/replay 运行时校验、夹具跨仓库门禁与文档同步，使双方「各自单测都绿但 wire 不兼容」的风险被显式暴露。本批完成后仍标「已开发、未联调」。
**决策：** 批次 C 六项决策已定案——E2/E1/F1/F3/F4/G2（见 §6），其中 E2/F3/F1/G2 为用户拍板，E1/F4 为推荐。
**文档状态：** v3 定稿（经 code-review 三轮闭环：事实核验 3 + 整改覆盖 5 + 设计一致性 12 + 复查 7 新问题 N1–N7，2 critical/7 important/14 minor 全整合；含 zod v4 契约核验与领域契约核验）

---

## 1. 背景与目标

批次 A（连接/凭据/ACK 错误）与批次 B（真实连接编排：初始化/守卫/错误链/超时门控）已落地，400 单测 + 22 集成 + typecheck/lint/build 全绿，第三方验收 4/4。批次 C 处理联调前最后的边界与门禁：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-P2-02 | P2 | IPC 成功响应和 replay payload 校验过宽 | Main→Preload→Renderer 边界有完整运行时保障；replay 单条非法有明确策略 |
| FE-P2-03 | P2 | wire fixtures 锚定旧后端 SHA，缺少跨仓库契约门禁 | 补全缺失场景；manifest 带 schemaHash/verified 门禁；本地跨仓库脚本交叉检查 |
| FE-P2-04 | P2 | README、CLAUDE.md、进度数字和联调命令过期 | 文档同步到真实状态，仍保留「已开发、未联调」 |

**完成标准**（对照 review 第 5 节，本批范围）：
- IPC 成功响应经共享 Zod Schema 校验（Main + Preload 双层）；
- replay 单条消息非法逐条丢弃 + 告警，不整批拒绝；
- fixtures 补全整改清单建议场景；manifest 记录 schemaHash/verified；schema 变更强制 manifest 更新；
- 本地跨仓库脚本可读后端 `frontend_contract` 交叉检查 frame type 覆盖；
- README / CLAUDE.md / docs/16 同步到真实状态；
- typecheck、lint、400+ 单测、22+ 集成测试、build 全绿；
- 文档仍标记「已开发、未联调」。

## 2. 范围（本批 vs 后续）

**本批做：** FE-P2-02（IPC/response/replay 运行时 Schema）、FE-P2-03（夹具场景补全 + manifest 门禁 + 跨仓库脚本）、FE-P2-04（文档漂移同步）。

**本批不做**：
- 阶段 3+：附件、搜索、历史查看器、模型/语音、Live2D、工具执行；
- 真实联调（B-01 到位后）；后端 SHA 冻结前不把 manifest 更新成未实际运行过的 SHA（整改约束）；
- 后端真实 raw frames 样例过前端 parser 的**自动**检查（需后端提供样例，B-01 联调首日落地，见 §4.2.3 门禁设计）；
- `BackendAdapter`/`ConnectInput` 接口层改造（批次 A 决策 8 推迟项，非本批需要）。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `preload/desktop-api.ts:88-95` | `unwrap<T>(res)` 只验信封，成功 `data` 形状不验 | 边界缺运行时保障（整改 FE-P2-02） |
| `preload/desktop-api.ts:98-114` | `isConnectionState` 只查 status；`isReplayPayload` 只查 `messages` 是数组 | 字段级校验缺失 |
| `main/chat/chat-handlers.ts:26-27` | `responseEnvelope = z.unknown()` | 成功响应 data 不校验（批次 A 留的阶段 7 收敛项，本批收） |
| `main/ipc/executor.ts:29-30` | responseSchema 校验失败返回 `{ code:'UNKNOWN', message:'内部错误' }`；`SCHEMA_VALIDATION_FAILED` 仅用于请求参数 | 契约不符时 UI 只见通用「内部错误」，无法暴露 wire 不兼容（本批需改 executor） |
| `shared/schemas/events.ts` | 已有 `parseBackendEvent` + `TokenUsageSchema` | 可扩展领域响应 schema，token 结构复用 |
| `src/main/fixtures/wire-v2/` | 4 组 jsonl + manifest `{backendCommit, protocol, serverProtocolVersion}` 写死 `beeba577` | 锚定旧 SHA；缺 rejected 空 messageId / QUEUE_FULL / STORAGE_UNAVAILABLE / cancelled / 重连 replay / 完整 server_info 等场景 |
| `tests/unit/wire-fixtures.spec.ts:37-43` | manifest 断言写死 `backendCommit === 'beeba577…'` | schema 变更不触发 manifest 更新门禁 |
| `CLAUDE.md`（"What this repository is" 约第 4 行、Commands 约第 110 行） | 仍写「只有设计文档，没有代码/package.json/git repo」「命令 None exist yet」 | 严重误导新的 Claude Code 会话 |
| `README.md` / `docs/16` | 批次 A/B 已部分更新（399+22） | 批次 C 后需再同步（400+） |

### 3.2 技术约束（重要）

**后端 `frontend_contract` 位置**：`/home/yomu/elysia-agent/frontend_contract/`（version.py、errors.py、ws_message.py）本机可读；**CI 环境无该路径**——跨仓库检查只能做本地脚本（dev/联调前跑），不能进 CI 硬依赖。

**zod v4（4.4.3）契约**（已实测）：
- **`z.ZodTypeAny` 不存在**（v4 d.ts 无此声明），泛型约束必须用 `import { type ZodType } from 'zod'`（`<T extends z.ZodType>`）。
- **无 `.toJSON()`**，`JSON.stringify(schema)` 因循环引用抛错——`rawSchemasFingerprint` 不能靠 schema JSON 化。
- **可行**：`RawFrameSchema._def.options.map(o => o.shape.type.value)` 稳定取判别 type 集合；`o.shape` 的 `Object.keys()` 稳定取字段名。

**领域契约（`shared/contracts/message.ts`）**（关键，本批 F1 修正依据）：
- `Message.content?: string`（**可选**）；CLAUDE.md 明确「assistant 可见正文唯一来源是 `assistantSegments`，不得写入 content，content 只用于 user/system/tool」。
- `AssistantSegment = { segmentId; segmentIndex; channel; kind; text?: string; completed: boolean }`——**`text`（可选）而非 `content`（必填）、`completed`（必填）而非 `folded`**。
- `restMapper.assemble()`（rest-mapper.ts）对 assistant 角色**从不设置 content**；tool 角色会产出 `tool` 字段。
- `Conversation = { id; title; updatedAt; preview? }`——**无 `unread`**。

**FrameMapper 对 session 帧返回 `null`**（`wire-fixtures.spec.ts:78-84`）——两层校验（raw + mapper→domain）**不覆盖 replay 消息的 MessageSchema**；replay 消息的领域校验需单独交叉检查（见 §5.1 I5 修复）。

**executor 响应校验现状**：`createIpcHandler` 已支持按命令传 responseSchema（chat-handlers 现有机制），但响应校验失败返回 `UNKNOWN/内部错误`——本批改为 `SCHEMA_VALIDATION_FAILED` + zod 摘要 + 日志（C2）。

**批次 A 决策 8**：`ConnectInput`/`BackendAdapter.connect` 接口不动；本批同样不触碰接口层。

**manifest 门禁语义**：`schemaHash` 必须是「前端 raw-schemas 当前状态的确定性指纹」——schema 变更 → 指纹变 → wire-fixtures.spec 断言失败 → 强制更新 manifest（联调前禁止 schema 与 fixture 漂移）。`verified: false` 标记前端构造场景（未实际运行后端），后端 SHA 冻结后统一置 verified 并更新 backendCommit。

## 4. 设计

### 4.1 FE-P2-02：IPC/response/replay 运行时 Schema

#### 4.1.1 共享领域响应 Schema（`shared/schemas/ipc-response.ts` 新建）

在 `shared/schemas/` 下新增 `ipc-response.ts`，**严格镜像 `shared/contracts` 类型**（C1 修正）：

```ts
import { z } from 'zod'
import { TokenUsageSchema } from './events'   // N3:usage 复用事件层 token 结构
export const ConnectionStateSchema = z.object({
  status: z.enum(['disconnected', 'connecting', 'connected', 'reconnecting', 'error']),
  serverUrl: z.string().optional(),
  protocolVersion: z.string().optional(),
  serverVersion: z.string().optional(),
  connectionId: z.string().optional(),
  activeConversationId: z.string().optional(),
  lastError: z.string().optional()
})
export const BackendSessionSchema = z.object({
  sessionId: z.string().min(1), protocolVersion: z.string().min(1), serverUrl: z.string().min(1)
})
export const ClientRequestRefSchema = z.object({
  clientRequestId: z.string().min(1), serverMessageId: z.string().optional()
})
export const ActivateConversationResultSchema = z.object({ conversationId: z.string().min(1) })
export const RuntimeInfoSchema = z.object({ mode: z.enum(['real', 'mock']), packaged: z.boolean() })
export const EndpointResponseSchema = z.object({ endpoint: z.string().optional() })

// MessageSchema 严格镜像 contracts/message.ts(C1):content 可选、assistantSegments 用 text?/completed、
// tool 字段、usage 复用 events.ts 的 TokenUsageSchema(M5)
export const AssistantSegmentSchema = z.object({
  segmentId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  channel: z.enum(['inner_voice', 'public_reply']),
  kind: z.enum(['text', 'markdown', 'image', 'video', 'audio', 'file', 'sticker', 'link']),
  text: z.string().optional(),
  completed: z.boolean()
})
export const MessageSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().optional(),   // 可选:assistant 正文在 assistantSegments,content 仅 user/system/tool
  status: z.enum(['pending', 'acknowledged', 'streaming', 'completing', 'completed', 'failed', 'interrupted']),
  createdAt: z.string(),
  clientMessageId: z.string().optional(),
  assistantSegments: z.array(AssistantSegmentSchema).optional(),
  tool: z.unknown().optional(),     // tool 消息元数据(rest-mapper assemble 会产出)
  usage: TokenUsageSchema.optional(),   // 复用 events.ts TokenUsageSchema(契约 Message.usage 即 TokenUsage;N3)
  model: z.string().optional(),
  emotion: z.string().optional()
})
export const ConversationSchema = z.object({
  id: z.string().min(1), title: z.string(), updatedAt: z.string(), preview: z.string().optional()   // 无 unread(契约无)
})
// 泛型用 <T extends z.ZodType>(zod v4 无 ZodTypeAny,I2)
export const PageSchema = <T extends z.ZodType>(itemSchema: T) => z.object({
  items: z.array(itemSchema), hasMore: z.boolean(), nextCursor: z.string().optional()
})
export const MessagePageSchema = PageSchema(MessageSchema)   // 只留泛型版(M5:与 PageSchema(MessageSchema) 同义)
export const ReplayPayloadSchema = z.object({ conversationId: z.string().min(1), messages: z.array(MessageSchema) })
```

`shared/schemas/index.ts` 追加 `export * from './ipc-response'`。**废弃 `main/ipc/channels.ts` 的 `runtimeInfoResponseSchema`/`endpointResponseSchema` 两份拷贝**（M3），改引 shared 版。

#### 4.1.2 Main handler 校验成功响应 + executor 错误码修正（C2）

**改 executor**（`main/ipc/executor.ts:29-30` + **签名**）：responseSchema 校验失败从 `{ code:'UNKNOWN', message:'内部错误' }` 改为 `SCHEMA_VALIDATION_FAILED` + 字段摘要 + 日志。**`createIpcHandler` options 扩展为 `{ sanitize, channel, logger? }`**（现仅 `{ sanitize }`；N1——logger/channel 不在现作用域，不扩展会编译失败）：

```ts
// createIpcHandler(requestSchema, responseSchema, fn, { sanitize, channel, logger })
if (!out.success) {
  const summary = out.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}:${i.message}`).join('; ')
  logger?.error('ipc:response-invalid', { channel, summary })   // 脱敏:只记字段路径摘要,不记 data 全文
  return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: `响应校验失败: ${summary}` } }
}
```

- **chat-handlers 调用处传 `channel: IpcChannels.chatXxx`**（各 `handle` 调 createIpcHandler 时传对应通道名）；
- **装配面（`main/ipc/handlers.ts`）给 chat 注册注 `logger`**（凭据面已注入 logger，chat 面补齐，来源 `diagnostics.logger`）。`Logger.error(code, fields?)` 接口本身匹配，不改 logger。

这使「后端返回形状与前端契约不符」在 Main 边界以 `SCHEMA_VALIDATION_FAILED` + 字段摘要**显式暴露**，不再静默放行或报通用「内部错误」。

**chat-handlers 各命令传入对应 responseSchema**（`responseEnvelope = z.unknown()` 弃用）：

| 命令 | responseSchema |
|---|---|
| chatGetState | `ConnectionStateSchema` |
| chatConnect | `BackendSessionSchema` |
| chatSend | `ClientRequestRefSchema` |
| chatActivate | `ActivateConversationResultSchema` |
| chatCreate / chatRename | `ConversationSchema` |
| chatListConversations | `PageSchema(ConversationSchema)` |
| chatGetMessages | `MessagePageSchema` |
| chatGetEndpoint | `EndpointResponseSchema`（`{ endpoint?: string }`） |
| chatSetEndpoint（M3 补） | `z.object({ endpoint: z.string() })`（必填，chat-service 恒返回；N7 省事方案避免放宽 preload 返回类型） |
| chatGetRuntimeInfo | `RuntimeInfoSchema` |
| chatDisconnect / chatCancel / chatDelete | `z.undefined()`（成功 data 为 undefined） |

#### 4.1.3 Preload 防御性解析（E1 双层）

- **`unwrap<T>(res, schema: z.ZodType<T>)`**（M4：schema 与 T 编译期绑定）：`ok:true` 时 `data` 做 `schema.safeParse`，失败抛 `[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败`（防御性，正常路径不触发）。**preload 各方法按 §4.1.2 表格镜像传 schema**；void 命令传 `z.undefined()`。**preload `setEndpoint` 返回类型保持 `{ endpoint: string }`**（N7 省事方案：chatSetEndpoint 用必填 schema `z.object({ endpoint: z.string() })`，不放宽返回类型，避免波及 `preload/index.d.ts`、`desktop-api.types.ts`、`tests/integration/helpers/desktop-api.d.ts` 三处镜像声明与 `CyConnectionPanel` 消费）。
- **`isConnectionState`** 升级为基于 `ConnectionStateSchema` 的纯守卫（safeParse 判 success，保留 type guard 签名）。
- **replay 校验拆两层（I3）**——保持守卫纯化、过滤结果可达 handler：
  - `isReplayPayload(v): v is ReplayPayload`：纯结构守卫（conversationId string + messages 数组），不变更 payload。
  - 新增 `filterReplayMessages(payload): ReplayPayload`：对 `messages` 逐条 `MessageSchema.safeParse`，非法条目丢弃 + `console.warn('cyrene:replay:drop-invalid-message', { conversationId, index })`，合法保留。
  - `onChatReplay` 订阅回调改为：`if (isReplayPayload(payload)) handler(filterReplayMessages(payload))`——**过滤结果到达 handler，非法条目被逐条丢弃（E2，用户拍板：不整批拒绝）**。
- **畸形信封兜底（M1）**：补一条单测「`{ok:true}` 缺 data / `{ok:false}` 缺 error 不因 `as IpcResult<T>` 强转而静默通过」（invoke 强转仅类型层，运行时由 unwrap 兜底，M1 记入 spec）。

#### 4.1.4 验收对应

- Main handler 对成功响应形状校验（改错形状 → `SCHEMA_VALIDATION_FAILED` + 字段摘要 + 日志）；
- preload unwrap 防御性校验 data（schema 与 T 绑定）；
- replay 单条非法 → 该条丢弃 + `cyrene:replay:drop-invalid-message` 告警，其余保留；整批合法正常送达；
- ConnectionState / ReplayPayload 字段级校验（非法丢弃 + warn）；
- 含 assistant 消息（无 content、带 assistantSegments 的 text?/completed）通过校验（C1 防误丢）。

### 4.2 FE-P2-03：夹具跨仓库门禁

#### 4.2.1 补全夹具场景（F1，用户拍板：全部补齐）

`apps/desktop/src/main/fixtures/wire-v2/` 新增 7 组 jsonl + manifest（前端按已知 wire 构造的 `verified: false` 场景）：

| 场景 | 内容要点 |
|---|---|
| `rejected-ack-empty-messageid.jsonl` | `user_message.ack` + `status:"rejected"` + `messageId:""` + `QUEUE_FULL`（真实 wire，批次 A 修复后应过 parseRawFrame） |
| `rejected-ack-storage-unavailable.jsonl` | rejected + `STORAGE_UNAVAILABLE` + `retryable:true` |
| `server-info-full.jsonl` | 完整 `server_info`（`features:{idempotency_durable:true,...}` + `services:{...}` + `build_sha` + `connectionId`） |
| `chat-replay-nonempty.jsonl` | session replay 非空消息（assistant 带 assistantSegments、无 content） |
| `chat-cancelled.jsonl` | generation 流 + `generation.failed{code:"CANCELLED"}` |
| `chat-reconnect-replay.jsonl` | 断线重连后的 session replay（消息去重语义） |
| `chat-no-delta-public-reply.jsonl` | public_reply 无 delta（仅 segment.completed 权威 content） |

**replay 消息交叉校验（I5 修复）**：由于 FrameMapper 对 session 帧返回 null（两层校验不覆盖 replay 的 MessageSchema），新增的 `chat-replay-*` 场景除 raw 层外，**必须**在 wire-fixtures.spec 中对 `frame.messages` 逐条跑 `restMapper.toDomainMessageFromReplay(...)` → `MessageSchema.safeParse` 断言通过——把真实映射输出与 schema 绑起来，使 C1 类形状错误能被夹具门禁发现（§5.1）。

#### 4.2.2 manifest 扩展与 schemaHash 门禁（F4 + F3 + I4/I6 指纹）

manifest 结构扩展：

```jsonc
{
  "backendCommit": "beeba5776413dde9761375c2fd9541d6636f180d",  // 既有 4 组保留；新增 7 组为 "unverified"
  "protocol": "2",
  "serverProtocolVersion": "2.0",
  "schemaHash": "<sha256>",        // 新增：前端 raw-schemas 当前指纹
  "verified": false,               // 新增：true=后端实际运行生成；false=前端构造(未联调)
  "scenario": "rejected-ack-empty-messageid"  // 新增(可选)：场景标识
}
```

- **schemaHash 指纹（I4，zod v4 可行方案）**：`raw-schemas.ts` 新增 `rawSchemasFingerprint(): string`——**从 discriminated union 的 `_def` 推导**：
  ```ts
  const types = RawFrameSchema._def.options.map((o) => o.shape.type.value).sort()
  const fieldSig = ([k, s]: [string, unknown]) => {
    const d = s as { _def?: { type?: string; entries?: Record<string, unknown>; values?: unknown[] } }
    const vals = d._def?.entries ? Object.keys(d._def.entries).sort().join(',') : (d._def?.values ?? []).join(',')
    return `${k}:${d._def?.type}:${vals}`   // N6:zod v4 判别用 _def.type(小写 string/enum/optional)+ entries/values,非 v3 的 typeName(恒 undefined)
  }
  const fields = RawFrameSchema._def.options.map((o) => ({
    type: o.shape.type.value,
    fields: Object.entries(o.shape).map(fieldSig).sort()
  }))
  return sha256(JSON.stringify({ types, fields }))   // node:crypto
  ```
  同时导出 **`RAW_FRAME_TYPES` 也从 `_def.options` 推导**（I6：非手写常量，防漂移）。测试断言「`RAW_FRAME_TYPES` 恒等于 union 推导集合」+「同 schema 指纹恒等、改 schema 指纹变化」（§5.1）。
- **门禁**：`wire-fixtures.spec.ts` manifest 断言改为：`schemaHash === rawSchemasFingerprint()`（每个 fixture 一致）+ `verified` 为 boolean + 既有 4 组 `backendCommit` 断言保留、新增 7 组为 `"unverified"`。**schema 变更 → 指纹变 → 测试红 → 强制更新 manifest schemaHash**。
- **manifest 更新策略（整改约束）**：新增 7 组标 `verified:false` + backendCommit `"unverified"`（前端构造，未实际运行后端）；**既有 4 组 `verified:true`（backendCommit beeba577 曾实际运行生成）**；后端 SHA 冻结后统一更新 backendCommit + verified:true。**联调完成前禁止把 manifest 更新成未实际运行过的 SHA**（既有 4 组 backendCommit 保持 beeba577，不伪造已验证）。

#### 4.2.3 跨仓库脚本（F3，用户拍板：schemaHash + 本地脚本）

- **本地脚本 `apps/desktop/scripts/check-backend-contract.mjs`**：
  1. 若 `/home/yomu/elysia-agent/frontend_contract/ws_message.py` 存在：
     - 正则提取后端 frame type 字面量集合；**下限校验（I6）**：解析到的 type 数 < 3（后端已知 frame 数下界）→ 报错「解析异常，疑似模式失效」，避免静默「0/0」false pass；
     - 与前端 `RAW_FRAME_TYPES`（union 推导）比对：后端 type 前端不支持 → 报错（前端 parser 需覆盖）；前端 type 后端未定义 → warn（前端超前，联调确认）；
     - 输出「后端 frame type 覆盖检查：N/M」。
  2. 若后端路径不存在（CI/他人机器）：输出「后端仓库未挂载，跳过跨仓库检查」exit 0（CI 不硬依赖）。
  3. 不进入 CI 主流程；可加 `check:contract` npm script（可选）。
- **B-01 后增强（I1，整改建议 5 的最小落地设计 + 联调门禁）**：联调首日从真实后端抓取 N 条（≥3 条，覆盖 server_info / session / user_message.ack / generation 流）真实 raw frame 样例 → 过 `parseRawFrame` + mapper + `parseBackendEvent` 断言全过；该步骤写入 README「真实模式联调」小节，**列为 B-01 联调验收门禁**（§7 从「一句话推迟」升级为「有门禁的推迟」）。

#### 4.2.4 验收对应

- 新增 7 组场景全部通过 raw 层 + replay 消息交叉校验（§4.2.1）+ 领域层（非 replay 场景）；
- manifest 含 schemaHash/verified/scenario，schemaHash 与当前指纹一致；
- 修改 raw-schemas（如加 type）→ 指纹变 → wire-fixtures 红（门禁生效）；
- `RAW_FRAME_TYPES` 与 union 推导一致（防常量漂移）；
- `check-backend-contract.mjs` 无后端目录 exit 0；有后端目录输出 type 覆盖；解析 <3 type 报错；
- B-01 后「真实样例 → parser」列为联调门禁（README 记录）。

### 4.3 FE-P2-04：文档漂移同步

#### 4.3.1 CLAUDE.md（G2，用户拍板：由我更新）

- **"What this repository is" 节**（当前约第 4 行，**按内容定位非行号**，M6）：从「只有设计文档，没有代码/package.json/git repo」改为真实状态——代码已存在（`apps/desktop/` Electron + Vue3 + TS），阶段 0-2 + 真实联调整改批次 A/B 已落地，文档为工程契约、实现以 `apps/desktop/` 为准。
- **Commands 节**（约第 110 行）：从「None exist yet」改为实际脚本（dev/typecheck/lint/test/test:integration/build/package/verify:artifact），保留 doc 09 §5 规划脚本名。
- **"Current status" 节**：更新到批次 A/B 落地后状态，保留「已开发、未联调」与 B-01 待外部输入。
- **测试数字写下界（M6）**：写入「400+ 单测 / 22+ 集成」为本批已验证下界，避免制造本批正要修的漂移。
- 保留文档维护规则（改行为须改文档、doc 02 §19 对齐表唯一、中文）。

#### 4.3.2 README

- 状态行更新为「批次 A/B/C 已落地」+ 批次 C 摘要；数字同步（400+ 单测）；
- 确认「真实模式联调」小节（批次 A 已有）与 B-01 步骤一致；**追加 B-01 联调门禁项**（§4.2.3：真实样例 → parser）。

#### 4.3.3 docs/16

- 头部状态/阶段视图/变更记录表追加批次 C（FE-P2-02/03/04 + 决策 E1/E2/F1/F3/F4/G2 + 门禁数字 400+）。
- 已知限制追加（本批新增：跨仓库脚本依赖后端目录存在、replay 单条丢弃告警）。

#### 4.3.4 验收对应

- CLAUDE.md 无「只有设计文档/没有代码」等过时表述；命令节为真实脚本；
- README / docs/16 状态与数字一致（400+）；
- 全部保留「已开发、未联调」标记。

## 5. 测试计划

### 5.1 单元测试（`tests/unit/`）

| 文件 | 覆盖 |
|---|---|
| `ipc-response-schema.spec.ts`（新） | 各 schema 合法/非法样例；**含 assistant 消息（无 content、带 assistantSegments 的 text?/completed）通过校验（C1 防误丢）**；`PageSchema(ConversationSchema)` 泛型输出 |
| `ipc-executor.spec.ts`（扩） | **responseSchema 失败 → `SCHEMA_VALIDATION_FAILED` + 字段摘要 + 日志（C2）**；请求校验失败行为不回归 |
| `chat-handlers.spec.ts`（新，或扩展现有） | Main handler 成功响应校验：mock svc 返回畸形 data → `SCHEMA_VALIDATION_FAILED` |
| `desktop-api-chat.spec.ts`（扩） | `unwrap(res, schema)` 校验失败抛错；`isConnectionState` 字段级；`isReplayPayload` 纯守卫 + `filterReplayMessages` 逐条丢弃（非法丢 + 合法保留）→ 回调收到过滤结果（I3）；**畸形信封单测（M1）** |
| `wire-fixtures.spec.ts`（扩） | manifest `schemaHash === rawSchemasFingerprint()`；新增 7 组 raw 层 + replay 消息交叉校验（§4.2.1 I5）+ 非 replay 领域层；`RAW_FRAME_TYPES` 恒等于 union 推导集合（I6） |
| `raw-schemas.spec.ts`（扩） | `RAW_FRAME_TYPES` 白名单导出 + 恒等推导；`rawSchemasFingerprint` 同 schema 恒等 / 改 schema 变化（I4；**变更样本用「枚举增减成员」或「字段类型 string→number」，不用「加字段」**——N6 防假绿） |

### 5.2 跨仓库脚本（本地）

- `scripts/check-backend-contract.mjs`：无后端目录 exit 0；有后端目录输出 type 覆盖；解析 <3 type 报错（手动跑验证，不写单测）。

### 5.3 集成测试（`tests/integration/`）

| 文件 | 覆盖 |
|---|---|
| `ipc-security.spec.ts`（扩） | 无新增白名单键（本批不改 preload 面）；确认成功响应校验不破坏现有 22 键契约 |
| 既有套件 | 回归（Main responseSchema 替换 + executor 错误码后各命令正常路径仍通） |

### 5.4 验收门禁

- `pnpm typecheck` / `pnpm lint` / `pnpm test`（400+ 单测）/ `pnpm test:integration`（22+ 集成）/ `pnpm build` 全绿；
- 整改清单批次 C 三项验收测试逐条可回溯（§4 各节「验收对应」）。

## 6. 关键决策记录

批次 C 六项决策：**E2/F3/F1/G2 用户拍板**，E1/F4 推荐（记录进文档 + 最终报告提出）。另含 review 修复轮补充决策（C2/I2-I6/M1-M7 见正文标注）。

| # | 决策点 | 定案 | 来源 |
|---|---|---|---|
| E2 | replay 单条消息非法策略 | **逐条丢弃 + 告警**（不整批拒绝） | **用户拍板**。单条坏帧不毁整个回放；与批次 B guardDrop 一致（部分数据可用） |
| E1 | Schema 校验层级 | **Main handler 校验成功响应 + Preload 防御性解析**（双层） | 推荐。整改建议 1/2；Main 边界强校验，Preload 兜底 |
| F1 | 夹具场景范围 | **全部补齐**（rejected 空 messageId / QUEUE_FULL / STORAGE_UNAVAILABLE / 完整 server_info / 非空 replay / cancelled / 重连 replay / no-delta-public-reply） | **用户拍板**。整改建议 1-3 全覆盖，前端自造 jsonl 不依赖后端冻结 |
| F3 | 跨仓库门禁落地 | **manifest schemaHash + 本地脚本**（读 `/home/yomu/elysia-agent/frontend_contract` 交叉检查 frame type 覆盖；CI 不依赖后端路径） | **用户拍板**。CI 无后端仓库，本地脚本可行 |
| F4 | 新增场景 manifest SHA | 新增 7 组标 `verified:false` + backendCommit `"unverified"`；既有 4 组保持 beeba577 | 推荐。整改约束「联调前不更新成未运行过的 SHA」 |
| G2 | CLAUDE.md 更新 | **由我更新**（What this repository / Commands / Current status 同步到真实状态） | **用户拍板**。避免新会话被过时描述误导 |

**review 修复轮补充**（设计一致性/整改覆盖/事实核验 findings 整合）：
- C1 MessageSchema 严格镜像契约（content optional、assistantSegments text?/completed、tool 字段、ConversationSchema 无 unread）——**必须**，否则 replay 逐条清空 + getMessages 整页拒绝；
- C2 executor 响应校验失败 → `SCHEMA_VALIDATION_FAILED` + 字段摘要 + 日志（原 UNKNOWN/内部错误 无法暴露 wire 不兼容）；
- I2 泛型用 `z.ZodType`（zod v4 无 ZodTypeAny）；
- I3 preload replay 校验拆 `isReplayPayload`（纯守卫）+ `filterReplayMessages`（逐条丢弃），过滤结果达 handler；
- I4/I6 schemaHash 指纹从 discriminated union `_def` 推导（zod v4 无 toJSON），`RAW_FRAME_TYPES` 同理推导 + 恒等测试；
- I5 wire-fixtures 补 replay 消息交叉校验（FrameMapper 对 session 帧返回 null，两层校验不覆盖 MessageSchema）；
- I1 FE-P2-03 建议 5 的 B-01 后增强列为联调门禁（最小设计 + README 记录）；
- M1-M7 minor（畸形信封单测、replay 校验仅 Preload 分层决策、响应 schema 收敛 shared 废弃 channels 拷贝、unwrap 绑定 T/schema + preload 映射、usage 复用 TokenUsageSchema/MessagePageSchema 用泛型版、CLAUDE.md 行号按内容/数字写下界）。

## 7. 不在本次范围

- 真实联调（B-01 到位后）；后端 SHA 冻结前不更新 manifest 为未运行 SHA；
- 阶段 3+：附件、搜索、历史查看器、模型/语音、Live2D、工具执行；
- 后端真实 raw frames 样例过前端 parser 的**自动**检查——本批把 B-01 后落地设计为联调门禁（§4.2.3），非自动进 CI；
- `ConnectInput`/`BackendAdapter.connect` 接口层改造（批次 A 决策 8 推迟）。

## 8. 风险与预案

| 风险 | 预案 |
|---|---|
| `MessageSchema` 过严导致合法消息被拒 | 严格镜像契约（C1）后 schema 与真实数据兼容；replay 走逐条丢弃（不整批拒），单条过严只丢一条；「含 assistant 消息通过校验」有单测 |
| `rawSchemasFingerprint` 不稳定 | 从 union `_def` 推导（type 集合 + 字段名 + 字段类型判别 `_def.type` + 枚举/字面量成员 `_def.entries`/`_def.values`）+ node:crypto sha256；测试断言「同 schema 恒等、改 schema 变化（枚举增减/字段类型变更）」；对 zod minor 版本敏感可接受（CI 锁版本）。**边界**：指纹覆盖 schema 形状（字段名/类型/枚举），zod 版本内部细节变化不保证；字段级兼容仍由 wire-fixtures `parseRawFrame` 直跑兜底 |
| Main responseSchema 替换后既有集成用例失败 | 正常路径 data 形状与契约一致；若有偏差集成测试显式暴露并修复 handler 或契约（这正是本批要暴露的） |
| 跨仓库脚本依赖后端路径 | 路径缺失 exit 0（跳过）；本机有路径时真实检查；解析 type <3 报错防静默 false pass |
| manifest schemaHash 门禁误伤（改 schema 需同步改 manifest） | 这是**期望行为**（联调前禁止漂移）；改 schema 的任务须同步更新 manifest schemaHash |
| replay 校验仅 Preload 层（Main 不校验 push） | 明示为有意分层决策（整改建议 2 把 Main 校验限定在命令成功响应）；replay 丢弃以 `cyrene:replay:drop-invalid-message` 告警，非静默 |
