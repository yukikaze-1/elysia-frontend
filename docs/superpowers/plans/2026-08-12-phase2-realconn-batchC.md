# 批次 C 边界与联调门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地批次 C 三项整改——FE-P2-02（IPC/response/replay 运行时 Schema + Main/Preload 双层校验）、FE-P2-03（夹具场景补全 + manifest schemaHash 门禁 + 跨仓库脚本）、FE-P2-04（文档漂移同步），使「双方各自单测都绿但 wire 不兼容」在联调前被显式暴露。

**Architecture:** 共享 zod schema（`shared/schemas/ipc-response.ts`）供 Main handler responseSchema 与 Preload 防御性解析共用；`createIpcHandler` 扩展 `{ sanitize, channel, logger? }` 使响应校验失败返回 `SCHEMA_VALIDATION_FAILED` + 字段摘要；replay 单条非法经 `filterReplayMessages` 逐条丢弃；schemaHash 指纹从 raw-schemas discriminated union `_def` 推导；本地脚本 `check-backend-contract.mjs` 读后端 `contract.schema.json` 交叉检查（限定当前 WS v2 帧子集）。

**Tech Stack:** Electron 43 + Vue 3 + TS + Zod 4.4.3 + Vitest。测试用 `pnpm`（**非 conda**）。

**v2 变更（plan review 两轮修复）：** ① T2 只改 executor + 更新既有 UNKNOWN 断言，logger 接线移入 T3（可执行性 1/3）；② T3 测试直接 `createIpcHandler`（无 getHandler，接口核验 F1/可执行性 5）+ Files 加 handlers.ts + chatSetEndpoint 必填显式（可执行性 7）；③ T5 抽 `rawSchemasFingerprintFor(schema)` 纯函数 + 测试断言改为「同恒等/改枚举或字段类型变化」（不 toContain hex，接口核验 F3/可执行性 4）+ fieldSig 加 `_def.value`（可执行性 6）；④ T7 后端提取改匹配 `Literal["…"]` + 比对限定 WS v2 帧子集 + phase3+ 白名单 warn（接口核验 F2/可执行性 2）+ check:contract 必加（可执行性 9）；⑤ T6 session 帧显式非空 conversationId（可执行性 8）；⑥ T9 明确不修改 chat-service（可执行性 10）。

---

## Global Constraints

- **zod v4 契约（已实测）**：`z.ZodTypeAny` 不存在（泛型用 `z.ZodType`）；无 `.toJSON()`；判别用 `_def.type`（小写）+ `_def.entries`/`_def.values`/`_def.value`（**`_def.typeName` 恒 undefined，禁用**）。
- **MessageSchema 严格镜像 `shared/contracts/message.ts`**：`content` 可选、`assistantSegments` 项为 `{segmentId, segmentIndex, channel, kind, text?, completed}`（**无 content/folded**）、`tool` 字段、`Conversation` 无 `unread`。
- **executor 响应校验失败 → `SCHEMA_VALIDATION_FAILED`** + 字段摘要（`issues.slice(0,3)` 的 `path.join('.')+':'+message`）+ `logger?.error('ipc:response-invalid', { channel, summary })`（脱敏，不记 data 全文）。**既有 `ipc-executor.spec.ts` 的 UNKNOWN 断言须同步更新**。
- **replay 单条非法逐条丢弃 + `cyrene:replay:drop-invalid-message` 告警**（E2 用户拍板），不整批拒绝；`isReplayPayload` 保持纯守卫，过滤逻辑在 `filterReplayMessages`。
- **preload `setEndpoint` 返回类型保持 `{ endpoint: string }`**（chatSetEndpoint 用必填 schema `z.object({ endpoint: z.string() })`，N7 省事方案）。
- **schemaHash 指纹**从 `RawFrameSchema._def.options` 推导（type 集合 + 字段名 + `_def.type` + 枚举 `_def.entries`/字面量 `_def.values`+`_def.value`）；抽 `rawSchemasFingerprintFor(schema)` 纯函数便于敏感性测试；`RAW_FRAME_TYPES` 同理推导。
- **manifest 门禁**：`schemaHash === rawSchemasFingerprint()`；新增 7 组 `verified:false` + backendCommit `"unverified"`；既有 4 组 `verified:true`（beeba577）。**联调前不把 manifest 更新成未运行过的 SHA**。
- **跨仓库脚本**：后端提取匹配 `Literal["…"]`（pydantic）；比对**限定当前 WS v2 帧子集**（与 `RAW_FRAME_TYPES` 对齐），phase 3+ 帧（voice_session/dictation/tool.request 等）走 warn 白名单；后端路径缺失 exit 0；解析 type <3 报错。
- **文档**：CLAUDE.md 按内容定位；测试数字写下界「400+/22+」；保留「已开发、未联调」。
- 规范：`pnpm -F @cyrene/desktop typecheck` / `lint` / `test` / `test:integration`（xvfb-run -a）/ `build` 全绿后提交。

---

### Task 1: 共享领域响应 Schema（`shared/schemas/ipc-response.ts`）

**Files:**
- Create: `apps/desktop/src/shared/schemas/ipc-response.ts`
- Modify: `apps/desktop/src/shared/schemas/index.ts`
- Modify: `apps/desktop/src/main/ipc/channels.ts`（M3：删除 `runtimeInfoResponseSchema`/`endpointResponseSchema` 拷贝，改从 shared 导入别名）
- Test: `apps/desktop/tests/unit/ipc-response-schema.spec.ts`（新）

**Interfaces:**
- Consumes: `z`（v4）、`TokenUsageSchema`（`./events`）、`Message`/`Conversation`/`Page`/`ClientRequestRef`/`BackendSession`/`ConnectionState`/`RuntimeInfo`/`ActivateConversationResult` 类型（`@shared/contracts`）。
- Produces: `ConnectionStateSchema`/`BackendSessionSchema`/`ClientRequestRefSchema`/`ActivateConversationResultSchema`/`RuntimeInfoSchema`/`EndpointResponseSchema`/`AssistantSegmentSchema`/`MessageSchema`/`ConversationSchema`/`PageSchema<T>`/`MessagePageSchema`/`ReplayPayloadSchema`。

- [ ] **Step 1: 写失败测试**

`tests/unit/ipc-response-schema.spec.ts`（含 C1 防误丢；schema 与断言同 spec v3 §5.1）：

```ts
import { MessageSchema, PageSchema, ConversationSchema, ConnectionStateSchema, ReplayPayloadSchema } from '@shared/schemas'
const assistantMsg = { messageId: 'm1', conversationId: 'c1', role: 'assistant', status: 'completed', createdAt: 't', assistantSegments: [{ segmentId: 's1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: 'hi', completed: true }] }
it('assistant 消息(无 content + assistantSegments text?/completed)通过 MessageSchema', () => { expect(MessageSchema.safeParse(assistantMsg).success).toBe(true) })
it('user 消息带 content 通过', () => { expect(MessageSchema.safeParse({ messageId: 'm2', conversationId: 'c1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' }).success).toBe(true) })
it('非法:缺 messageId / 缺 completed → 失败', () => { /* 两个负例 */ })
it('ConversationSchema:合法项通过(无 unread 依赖)', () => { expect(ConversationSchema.safeParse({ id: 'c', title: 't', updatedAt: 'd' }).success).toBe(true) })
it('PageSchema(ConversationSchema) 泛型:合法通过 / items 错形状失败', () => {})
it('ConnectionStateSchema:缺 status 失败、带全部 optional 通过', () => {})
it('ReplayPayloadSchema:messages 单条非法 → 整 payload 校验失败(逐条丢弃在 preload 层处理)', () => {})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test ipc-response-schema`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `ipc-response.ts`（严格镜像契约，spec §4.1.1）**

```ts
import { z } from 'zod'
import { TokenUsageSchema } from './events'
export const ConnectionStateSchema = z.object({ status: z.enum(['disconnected','connecting','connected','reconnecting','error']), serverUrl: z.string().optional(), protocolVersion: z.string().optional(), serverVersion: z.string().optional(), connectionId: z.string().optional(), activeConversationId: z.string().optional(), lastError: z.string().optional() })
export const BackendSessionSchema = z.object({ sessionId: z.string().min(1), protocolVersion: z.string().min(1), serverUrl: z.string().min(1) })
export const ClientRequestRefSchema = z.object({ clientRequestId: z.string().min(1), serverMessageId: z.string().optional() })
export const ActivateConversationResultSchema = z.object({ conversationId: z.string().min(1) })
export const RuntimeInfoSchema = z.object({ mode: z.enum(['real','mock']), packaged: z.boolean() })
export const EndpointResponseSchema = z.object({ endpoint: z.string().optional() })
export const AssistantSegmentSchema = z.object({ segmentId: z.string().min(1), segmentIndex: z.number().int().nonnegative(), channel: z.enum(['inner_voice','public_reply']), kind: z.enum(['text','markdown','image','video','audio','file','sticker','link']), text: z.string().optional(), completed: z.boolean() })
export const MessageSchema = z.object({ messageId: z.string().min(1), conversationId: z.string().min(1), role: z.enum(['user','assistant','system','tool']), content: z.string().optional(), status: z.enum(['pending','acknowledged','streaming','completing','completed','failed','interrupted']), createdAt: z.string(), clientMessageId: z.string().optional(), assistantSegments: z.array(AssistantSegmentSchema).optional(), tool: z.unknown().optional(), usage: TokenUsageSchema.optional(), model: z.string().optional(), emotion: z.string().optional() })
export const ConversationSchema = z.object({ id: z.string().min(1), title: z.string(), updatedAt: z.string(), preview: z.string().optional() })
export const PageSchema = <T extends z.ZodType>(itemSchema: T) => z.object({ items: z.array(itemSchema), hasMore: z.boolean(), nextCursor: z.string().optional() })
export const MessagePageSchema = PageSchema(MessageSchema)
export const ReplayPayloadSchema = z.object({ conversationId: z.string().min(1), messages: z.array(MessageSchema) })
```

`shared/schemas/index.ts` 加 `export * from './ipc-response'`。`main/ipc/channels.ts` 删除两份拷贝，改 `import { RuntimeInfoSchema, EndpointResponseSchema } from '@shared/schemas'` + 别名 `export const runtimeInfoResponseSchema = RuntimeInfoSchema` 等（保持 chat-handlers 引用兼容）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test ipc-response-schema && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/shared/schemas/index.ts apps/desktop/src/main/ipc/channels.ts apps/desktop/tests/unit/ipc-response-schema.spec.ts
git commit -m "feat(批次C T1): 共享领域响应 Schema(镜像契约)+ 废弃 channels 拷贝"
```

---

### Task 2: executor 响应校验失败 → SCHEMA_VALIDATION_FAILED（只改 executor + 更新既有断言）

**Files:**
- Modify: `apps/desktop/src/main/ipc/executor.ts`
- Modify: `apps/desktop/tests/unit/ipc-executor.spec.ts`（**更新既有 UNKNOWN 断言**，可执行性 3）
- Test: `apps/desktop/tests/unit/ipc-executor.spec.ts`

**Interfaces:**
- Consumes: `createIpcHandler(requestSchema, responseSchema, fn, options)` 现 options `{ sanitize }`。
- Produces: options 扩展 `{ sanitize, channel?: string, logger?: Logger }`；responseSchema 失败 → `{ code:'SCHEMA_VALIDATION_FAILED', message:'响应校验失败: <摘要>' }` + `logger?.error('ipc:response-invalid', { channel, summary })`。**logger/channel 为可选，T2 内调用方可暂不传（T3 补齐接线）**。

- [ ] **Step 1: 写失败测试 + 更新既有断言**

`tests/unit/ipc-executor.spec.ts`：
- **更新既有**「响应过 responseSchema 失败 → UNKNOWN」（约 :36-39）为 → `SCHEMA_VALIDATION_FAILED` + 摘要 + 日志。
- **追加**：

```ts
it('responseSchema 校验失败 → SCHEMA_VALIDATION_FAILED + 字段摘要 + 日志(channel/logger 注入)', async () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }
  const handler = createIpcHandler(z.undefined(), z.object({ ok: z.boolean() }), () => ({ bad: 1 }), { sanitize: (m) => m, channel: 'chat:get-state', logger: logger as never })
  const res = await handler(undefined)
  expect(res.ok).toBe(false)
  if (!res.ok) { expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED'); expect(res.error.message).toContain('响应校验失败'); expect(res.error.message).toContain('ok') }
  expect(logger.error).toHaveBeenCalledWith('ipc:response-invalid', expect.objectContaining({ channel: 'chat:get-state' }))
})
it('不传 logger/channel 也正常(向后兼容)', async () => { /* createIpcHandler(..., { sanitize }) 失败分支不崩 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test ipc-executor`
Expected: FAIL（既有 UNKNOWN 断言红 + 新用例红）

- [ ] **Step 3: 实现 executor.ts**

`IpcHandlerOptions` 扩展 + 响应失败分支：

```ts
export interface IpcHandlerOptions { sanitize: MessageSanitizer; channel?: string; logger?: Logger }
// 响应校验失败分支(替换原 UNKNOWN/内部错误):
if (!out.success) {
  const summary = out.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}:${i.message}`).join('; ')
  options.logger?.error('ipc:response-invalid', { channel: options.channel, summary })
  return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: `响应校验失败: ${summary}` } }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test ipc-executor && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/executor.ts apps/desktop/tests/unit/ipc-executor.spec.ts
git commit -m "feat(批次C T2): executor 响应校验失败 SCHEMA_VALIDATION_FAILED+摘要+日志"
```

---

### Task 3: chat-handlers 各命令传 responseSchema + registerChatHandlers 签名 + handlers.ts logger 接线

**Files:**
- Modify: `apps/desktop/src/main/chat/chat-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/handlers.ts`（chat 注册传 logger）
- Test: `apps/desktop/tests/unit/chat-handlers.spec.ts`（新）

**Interfaces:**
- Consumes: `createIpcHandler`（T2 后支持 channel/logger）、`registerChatHandlers(opts: { svc, sanitize, logger })`、shared schemas（T1）。
- Produces: `responseEnvelope = z.unknown()` 弃用；各命令传 responseSchema + `channel: IpcChannels.chatXxx`；`registerChatHandlers` 签名补 `logger`；`handlers.ts` 调 `registerChatHandlers({ svc, sanitize, logger })` 注 `diagnostics.logger`。

- [ ] **Step 1: 写失败测试（直接 createIpcHandler，无 registry getter；接口核验 F1）**

`chat-handlers.spec.ts`（新）：**不依赖 `getHandler`/`ipcMain`**（registry 无 getter、vitest node 环境无 electron），改为直接调用注册的 handler 无法经 registerHandler 拿到 executor——因此**直接测「各命令的 responseSchema 与 handler 组合」**：

```ts
import { createIpcHandler } from '../../src/main/ipc/executor'
import { ConnectionStateSchema, MessagePageSchema, PageSchema, ConversationSchema } from '@shared/schemas'
import { IpcChannels } from '@shared/contracts'

it('chatGetState 的 responseSchema 拒绝畸形 ConnectionState(SCHEMA_VALIDATION_FAILED)', async () => {
  const h = createIpcHandler(z.undefined(), ConnectionStateSchema, () => ({ status: 'bogus' }), { sanitize: (m) => m, channel: IpcChannels.chatGetState })
  const res = await h(undefined)
  expect(res.ok).toBe(false); if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
})
it('chatListConversations 的 PageSchema(ConversationSchema) 拒绝畸形 page', () => {})
it('chatGetMessages 的 MessagePageSchema 拒绝缺 items', () => {})
it('chatDisconnect 的 z.undefined() 接受成功 undefined', async () => {
  const h = createIpcHandler(z.undefined(), z.undefined(), () => undefined, { sanitize: (m) => m, channel: IpcChannels.chatDisconnect })
  expect((await h(undefined)).ok).toBe(true)
})
it('chatSetEndpoint 用必填 schema z.object({endpoint:z.string()})——拒绝缺 endpoint(可执行性 7/N7)', async () => {
  const h = createIpcHandler(chatSetEndpointSchema, z.object({ endpoint: z.string() }), () => ({}), { sanitize: (m) => m, channel: IpcChannels.chatSetEndpoint })
  const res = await h({ serverUrl: 'http://127.0.0.1:1' })
  expect(res.ok).toBe(false); if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
})
```

> 该测试验证「T3 实现后各命令实际使用的 responseSchema 组合」——若实现与测试不一致，可对齐（实现为源、测试为镜像）。若想连 registerChatHandlers 也覆盖，可 `vi.mock('electron')` 捕获 `ipcMain.handle`（可选增强，非必需）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test chat-handlers`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 chat-handlers + handlers.ts**

`chat-handlers.ts`：
- `handle` 包装函数加 `channel: IpcChannelName` 参数，透传 createIpcHandler；
- 各命令传 responseSchema（spec §4.1.2 表格）：
  - chatGetState → `ConnectionStateSchema`；chatConnect → `BackendSessionSchema`；chatSend → `ClientRequestRefSchema`；chatActivate → `ActivateConversationResultSchema`；chatCreate/chatRename → `ConversationSchema`；chatListConversations → `PageSchema(ConversationSchema)`；chatGetMessages → `MessagePageSchema`；chatGetEndpoint → `EndpointResponseSchema`；**chatSetEndpoint → `z.object({ endpoint: z.string() })`（必填，非共享 optional）**；chatGetRuntimeInfo → `RuntimeInfoSchema`；chatDisconnect/chatCancel/chatDelete → `z.undefined()`；
- `registerChatHandlers(opts)` 签名补 `logger: Logger`，透传 createIpcHandler。

`handlers.ts`：`registerChatHandlers({ svc, sanitize, logger: diagnostics.logger })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test chat-handlers && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/chat/chat-handlers.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/tests/unit/chat-handlers.spec.ts
git commit -m "feat(批次C T3): chat-handlers 传 responseSchema + registerChatHandlers 注 logger"
```

---

### Task 4: preload unwrap schema 校验 + isConnectionState 升级 + replay 过滤

**Files:**
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Test: `apps/desktop/tests/unit/desktop-api-chat.spec.ts`

**Interfaces:**
- Consumes: shared schemas（T1）、`unwrap`/`invoke`/`invokeWithArgs`/`isConnectionState`/`isReplayPayload`。
- Produces: `unwrap<T>(res, schema: z.ZodType<T>)`；`isConnectionState` 升级 ConnectionStateSchema 纯守卫；新增 `filterReplayMessages(payload): ReplayPayload`；`onChatReplay` 回调 `handler(filterReplayMessages(payload))`。

- [ ] **Step 1: 写失败测试**（同 spec v3 §5.1，含 M1 畸形信封）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test desktop-api-chat`
Expected: FAIL

- [ ] **Step 3: 实现**

- `unwrap<T>(res, schema)`：ok:true 时 `schema.safeParse(res.data)` 失败抛 `[SCHEMA_VALIDATION_FAILED] IPC 响应校验失败`；畸形信封（缺 data/缺 error）抛 `[IPC_ERROR] IPC 返回格式异常`。
- 各 chat 方法传 schema（按 spec §4.1.2 镜像；void 命令 `z.undefined()`；**chatSetEndpoint 传必填 `z.object({ endpoint: z.string() })`**——N7，返回类型保持 `{ endpoint: string }`）。
- `isConnectionState` 改用 `ConnectionStateSchema.safeParse(v).success`（纯守卫）。
- `isReplayPayload` 保持纯结构守卫；新增 `filterReplayMessages`（逐条 `MessageSchema.safeParse`，非法 `console.warn('cyrene:replay:drop-invalid-message', { conversationId, index })` 丢弃）；`onChatReplay` 内 `if (isReplayPayload(payload)) handler(filterReplayMessages(payload))`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test desktop-api-chat && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/desktop-api.ts apps/desktop/tests/unit/desktop-api-chat.spec.ts
git commit -m "feat(批次C T4): preload unwrap+schema 校验 + isConnectionState 升级 + replay 逐条过滤"
```

---

### Task 5: raw-schemas RAW_FRAME_TYPES + rawSchemasFingerprintFor（union _def 推导）

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`
- Test: `apps/desktop/tests/unit/raw-schemas.spec.ts`

**Interfaces:**
- Consumes: `RawFrameSchema`（discriminatedUnion `_def.options`）、`node:crypto`。
- Produces: `RAW_FRAME_TYPES`（union 推导）；`rawSchemasFingerprintFor(schema): string`（纯函数）；`rawSchemasFingerprint(): string` = `rawSchemasFingerprintFor(RawFrameSchema)`。

- [ ] **Step 1: 写失败测试（接口核验 F3：不对 hex 摘要做子串断言）**

`raw-schemas.spec.ts` 追加：

```ts
import { RAW_FRAME_TYPES, rawSchemasFingerprint, rawSchemasFingerprintFor } from '../../src/main/transport/protocol-v2/raw-schemas'
import { z } from 'zod'

it('RAW_FRAME_TYPES 与 union 推导集合一致(I6)', () => {
  const derived = RawFrameSchema._def.options.map((o) => o.shape.type.value).sort()
  expect([...RAW_FRAME_TYPES].sort()).toEqual(derived)
})
it('rawSchemasFingerprint 同 schema 恒等', () => { expect(rawSchemasFingerprint()).toBe(rawSchemasFingerprint()) })
it('枚举增减成员 → 指纹变化(敏感性,N6 样本)', () => {
  const a = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), e: z.enum(['p','q']) })]))
  const b = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), e: z.enum(['p','q','r']) })]))
  expect(a).not.toBe(b)
})
it('字段类型 string→number → 指纹变化(敏感性)', () => {
  const a = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), n: z.string() })]))
  const b = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), n: z.number() })]))
  expect(a).not.toBe(b)
})
it('非判别字面量值变更 → 指纹变化(_def.value,可执行性 6)', () => {
  const a = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), c: z.literal('a') })]))
  const b = rawSchemasFingerprintFor(z.discriminatedUnion('t', [z.object({ t: z.literal('x'), c: z.literal('b') })]))
  expect(a).not.toBe(b)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test raw-schemas`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现（spec §4.2.2，N6 判别 API + literal value）**

```ts
import { createHash } from 'crypto'
export const RAW_FRAME_TYPES: readonly string[] = RawFrameSchema._def.options.map((o) => o.shape.type.value)
const fieldSig = ([k, s]: [string, unknown]) => {
  const d = s as { _def?: { type?: string; entries?: Record<string, unknown>; values?: unknown[]; value?: unknown } }
  const vals = d._def?.entries ? Object.keys(d._def.entries).sort().join(',') : (d._def?.values ?? []).join(',')
  const lit = d._def?.value !== undefined ? String(d._def.value) : ''
  return `${k}:${d._def?.type}:${vals}:${lit}`
}
export function rawSchemasFingerprintFor(schema: z.ZodDiscriminatedUnion<string, any>): string {
  const fields = schema._def.options.map((o) => ({ type: o.shape.type.value, fields: Object.entries(o.shape).map(fieldSig).sort() }))
  return createHash('sha256').update(JSON.stringify({ types: schema._def.options.map((o) => o.shape.type.value).sort(), fields })).digest('hex')
}
export function rawSchemasFingerprint(): string { return rawSchemasFingerprintFor(RawFrameSchema) }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test raw-schemas && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts apps/desktop/tests/unit/raw-schemas.spec.ts
git commit -m "feat(批次C T5): RAW_FRAME_TYPES + rawSchemasFingerprintFor(union _def 推导)"
```

---

### Task 6: 补夹具场景 + manifest 扩展 + wire-fixtures 门禁

**Files:**
- Create: `apps/desktop/src/main/fixtures/wire-v2/rejected-ack-empty-messageid.jsonl` + `.manifest.json`、`rejected-ack-storage-unavailable.*`、`server-info-full.*`、`chat-replay-nonempty.*`、`chat-cancelled.*`、`chat-reconnect-replay.*`、`chat-no-delta-public-reply.*`（14 文件）
- Modify: `apps/desktop/src/main/fixtures/wire-v2/*.manifest.json`（既有 4 组加 schemaHash/verified/scenario）
- Modify: `apps/desktop/tests/unit/wire-fixtures.spec.ts`
- Test: `apps/desktop/tests/unit/wire-fixtures.spec.ts`（扩）

**Interfaces:**
- Consumes: `rawSchemasFingerprint`（T5）、`parseRawFrame`、`FrameMapper`、`parseBackendEvent`、`restMapper.toDomainMessageFromReplay`、`MessageSchema`（T1）。
- Produces: 7 组新 fixture；manifest 全组含 schemaHash/verified/scenario；wire-fixtures 断言 schemaHash 门禁 + replay 交叉校验。

- [ ] **Step 1: 写失败测试（manifest 门禁 + 新场景 + 交叉校验）**

`wire-fixtures.spec.ts` 扩（断言同 spec v3 §5.1；**replay 交叉校验 session 帧显式非空 conversationId**，可执行性 8）：

```ts
it('manifest schemaHash 与当前 rawSchemasFingerprint 一致 + verified 为 boolean(门禁)', () => {
  for (const f of fixtures) { const m = readManifest(f.replace(/\.jsonl$/, '.manifest.json')); expect(m.schemaHash).toBe(rawSchemasFingerprint()); expect(typeof m.verified).toBe('boolean') }
})
it('新增场景 verified:false + backendCommit unverified;既有 4 组 verified:true + beeba577', () => {})
it('replay 场景交叉校验:session 帧 messages 经 toDomainMessageFromReplay → MessageSchema.safeParse 通过(I5/C1)', () => {
  for (const f of ['chat-replay-nonempty.jsonl', 'chat-reconnect-replay.jsonl']) {
    for (const [i, line] of readLines(f).entries()) {
      const raw = parseRawFrame(line); if (!raw.success || raw.data.type !== 'session') continue
      expect(raw.data.conversationId).toBeTruthy()   // 显式非空(可执行性 8)
      for (const m of raw.data.messages) { const dom = restMapper.toDomainMessageFromReplay(m, raw.data.conversationId); expect(MessageSchema.safeParse(dom).success, `${f} 第 ${i} 行`).toBe(true) }
    }
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test wire-fixtures`
Expected: FAIL（manifest 无 schemaHash、新场景文件不存在）

- [ ] **Step 3: 实现夹具 + manifest**

按 spec §4.2.1/§4.2.2 建 7 组 jsonl（raw frame 形状须过 `parseRawFrame`；**session 帧显式带非空 `conversationId`**；`chat-replay-*` 的 messages 为 assistant 带 `assistantSegments`/无 content，镜像 rest-mapper 输出）+ manifest（`schemaHash` 用 T5 实现现算、`verified:false`、`backendCommit:"unverified"`、`scenario`）。既有 4 组 manifest 追加 `schemaHash` + `verified:true`。

- [ ] **Step 4: 更新 wire-fixtures.spec.ts**

fixtures 数组追加 7 组；保留两层校验通用逻辑 + 门禁/交叉校验断言。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test wire-fixtures && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/fixtures/wire-v2/ apps/desktop/tests/unit/wire-fixtures.spec.ts
git commit -m "feat(批次C T6): 补 7 夹具场景 + manifest schemaHash/verified 门禁 + replay 交叉校验"
```

---

### Task 7: 跨仓库脚本 check-backend-contract.mjs

**Files:**
- Create: `apps/desktop/scripts/check-backend-contract.mjs`
- Modify: `apps/desktop/package.json`（**必加** `check:contract` script，可执行性 9）

**Interfaces:**
- Consumes: 后端 `contract.schema.json`（判别联合，非 Python 源码——接口核验 F2）、前端 `RAW_FRAME_TYPES`。
- Produces: 本地脚本；输出 WS v2 帧子集覆盖结论。

- [ ] **Step 1: 写脚本（spec §4.2.3，接口核验 F2 修正）**

```js
// apps/desktop/scripts/check-backend-contract.mjs
import { readFileSync, existsSync } from 'fs'
const BACKEND_DIR = '/home/yomu/elysia-agent/frontend_contract'
const SCHEMA_JSON = `${BACKEND_DIR}/contract.schema.json`   // 判别联合(如不存在退 ws_message.py Literal 提取)
const RAW_SCHEMAS = new URL('../src/main/transport/protocol-v2/raw-schemas.ts', import.meta.url)
const WS_V2_FRAME_TYPES = ['server_info', 'session', 'expression', 'user_message.ack', 'error',
  'generation.started', 'generation.segment.started', 'generation.delta', 'generation.segment.completed', 'generation.completed', 'generation.failed']
// phase 3+ 帧:前端有意滞后,只 warn 不报错(F2 白名单)
if (!existsSync(BACKEND_DIR)) { console.log('[check-contract] 后端仓库未挂载,跳过'); process.exit(0) }
let backendTypes = []
if (existsSync(SCHEMA_JSON)) {
  const json = JSON.parse(readFileSync(SCHEMA_JSON, 'utf8'))
  backendTypes = extractFromJsonSchema(json)   // 从判别联合取 type 字面量
} else {
  const src = readFileSync(`${BACKEND_DIR}/ws_message.py`, 'utf8')
  backendTypes = [...src.matchAll(/Literal\[["']([^"']+)["']\]/g)].map(m => m[1])   // pydantic Literal["…"]
}
if (backendTypes.length < 3) { console.error(`[check-contract] 后端 type 数 ${backendTypes.length} < 3,疑似模式失效`); process.exit(1) }
// 前端 RAW_FRAME_TYPES:从 raw-schemas.ts 精确提取数组字面量(实现时校准,不含枚举/字段字面量)
const frontSrc = readFileSync(RAW_SCHEMAS, 'utf8')
const frontTypes = extractRawFrameTypes(frontSrc)   // 提取 export const RAW_FRAME_TYPES = [...] 内 'xxx'
const wsV2 = backendTypes.filter(t => WS_V2_FRAME_TYPES.includes(t))
const missing = wsV2.filter(t => !frontTypes.includes(t))
const deferred = backendTypes.filter(t => !WS_V2_FRAME_TYPES.includes(t))
if (missing.length) { console.error(`[check-contract] 前端缺 WS v2 帧 type: ${missing.join(', ')}`); process.exit(1) }
console.log(`[check-contract] WS v2 帧覆盖: ${wsV2.length - missing.length}/${wsV2.length} 通过;phase3+ 帧 ${deferred.length} 个有意滞后(warn)`)
```

> `extractFromJsonSchema`/`extractRawFrameTypes` 为脚本内辅助函数，实现时按 `contract.schema.json` 实际结构 + raw-schemas.ts `RAW_FRAME_TYPES` 定义校准（正则精确性在实现时验证，**子集/白名单语义已定**）。

- [ ] **Step 2: 手动跑验证**

Run: `node apps/desktop/scripts/check-backend-contract.mjs`
Expected: 输出 WS v2 帧覆盖结论（本机有后端；若 backendTypes 提取异常 <3 会报错提示修提取）。无后端路径（模拟 `mv`）exit 0。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/scripts/check-backend-contract.mjs apps/desktop/package.json
git commit -m "feat(批次C T7): 跨仓库脚本 check-backend-contract.mjs(WS v2 帧覆盖)"
```

---

### Task 8: 文档漂移同步（CLAUDE.md / README / docs/16）

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`

**Interfaces:**
- Consumes: 本批实际门禁数字（400+ 单测 / 22+ 集成）、T7 的 `check:contract`。
- Produces: 文档同步到批次 C 落地后状态。

- [ ] **Step 1: 更新 CLAUDE.md（G2，按内容定位）**

- "What this repository is" 节：代码已存在（`apps/desktop/` Electron+Vue3+TS），阶段 0-2 + 批次 A/B/C 落地；文档为工程契约。
- "Commands" 节：实际脚本（dev/typecheck/lint/test/test:integration/build/package/verify:artifact/**check:contract**）。
- "Current status" 节：批次 A/B/C；保留「已开发、未联调」+ B-01 待输入。
- 测试数字写下界「400+ / 22+」。

- [ ] **Step 2: 更新 README**

- 状态行「批次 A/B/C 已落地」+ 批次 C 摘要；数字 400+。
- 「真实模式联调」小节追加 **B-01 联调门禁**（真实样例 → parseRawFrame + mapper 断言全过，spec §4.2.3）。

- [ ] **Step 3: 更新 docs/16**

- 头部状态/阶段视图/变更记录表追加批次 C（FE-P2-02/03/04 + 决策 + 门禁数字）；已知限制追加（跨仓库脚本依赖后端目录、replay 逐条丢弃告警）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md
git commit -m "docs(批次C T8): CLAUDE.md/README/docs16 同步(状态/命令/门禁/已开发未联调保留)"
```

---

### Task 9: 全量门禁（不修改 chat-service 层）

**Files:**
- Modify: `apps/desktop/tests/integration/ipc-security.spec.ts`（如需：确认 22 键契约不破坏）
- 全量门禁

**Interfaces:**
- Consumes: T1-T8 全部改动。
- Produces: 全量门禁绿。

- [ ] **Step 1: 明确范围（可执行性 10）**

本批**不修改** `chat-service.ts` 及其 spec（chat-service 层无响应 schema 变更，T3 只在 handler 层传 responseSchema；若集成回归发现 chat-service 相关用例红，属 T3 影响,在该步修复）。

- [ ] **Step 2: 跑全量单测 + 集成**

Run: `pnpm -F @cyrene/desktop test` → 400+ 全绿
Run: `xvfb-run -a pnpm -F @cyrene/desktop test:integration` → 22+ 全绿（ipc-security 22 键契约不破坏）

- [ ] **Step 3: 全量门禁**

Run: `pnpm -F @cyrene/desktop typecheck && lint && test && test:integration && build`
Expected: 全绿

- [ ] **Step 4: Commit（若有测试修复）**

```bash
git add apps/desktop/tests/  # 若有
git commit -m "fix(批次C T9): 集成回归修复"
```

---

## Self-Review

- **Spec 覆盖**：T1(§4.1.1)/T2(§4.1.2 executor)/T3(§4.1.2 表格)/T4(§4.1.3)/T5(§4.2.2 指纹)/T6(§4.2.1/2)/T7(§4.2.3)/T8(§4.3)——三项 FE 全覆盖；T9 门禁。
- **依赖顺序**：T1(schema)→ T2(executor)→ T3(chat-handlers+logger 接线)→ T4(preload)→ T5(raw-schemas)→ T6(fixtures)→ T7(脚本)→ T8(文档)→ T9(门禁)。T2/T3/T4 依赖 T1；T6 依赖 T5 指纹；T7 依赖 T5 RAW_FRAME_TYPES。
- **Placeholder 扫描**：无 TBD/TODO；T7 的正则辅助函数标注「实现时校准」是提取方式细节（子集/白名单语义已定），非占位。
- **类型一致性**：`MessageSchema`/`AssistantSegmentSchema`/`PageSchema<T>`/`RAW_FRAME_TYPES`/`rawSchemasFingerprintFor`/`filterReplayMessages`/`unwrap<T>(res, schema)`/`createIpcHandler` options 在定义与消费处一致。
- **review findings 覆盖**：可执行性 11 项 + 接口核验 F1-F3 全部整合（T2 范围/既有断言、T3 无 getHandler + 必填 schema、T5 敏感性断言 + literal value、T7 Literal 提取 + 子集白名单 + check:contract 必加、T6 conversationId、T9 明确范围）。
