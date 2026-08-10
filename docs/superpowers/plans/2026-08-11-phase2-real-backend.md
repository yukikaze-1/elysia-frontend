# 阶段 2 块 B：RealBackend —— REST/WS v2 Adapter —— 实施计划

**日期：** 2026-08-11
**执行方式：** TDD，subagent 逐任务执行，每任务独立 commit。
**依据：** [spec](specs/2026-08-11-phase2-real-backend-design.md)（已 code-review 干净，commit `1d148d4`）、[2A plan](2026-08-10-phase2-contract-raw-wire.md)（raw 层/FrameMapper/Accumulator 已落地）、[docs/18 §16 阶段 B](18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md)、后端契约 `beeba577`

## Goal

在 Main 进程实现 `RealBackend`（真实 REST + WebSocket v2 Adapter），消费 2A 的 raw schema/FrameMapper，把后端 wire 转成领域 `BackendEvent`/领域模型，供 2C Store 消费。覆盖连接/握手/会话/历史/发送/停止/心跳重连。

## Architecture

`real-backend.ts`（WS 生命周期 + REST 调用 + 事件推送）复用 2A `protocol-v2/raw-schemas`（扩展 ack/error）+ `frame-mapper` + 新增 `rest-types/rest-schemas/rest-mapper`。`BackendAdapter` 接口扩展（`getConversationMessages`/`activateConversation`/`renameConversation`），`MockBackend` 同步。领域 `Message.tool?` 承载 tool 元数据。

## Tech Stack

TypeScript + zod + vitest + `ws`（新增依赖，Main 进程 WS 客户端）。

## Global Constraints（subagent 必须遵守，逐条绑定）

1. **两层版本取值**：请求头 `X-Protocol-Version: "2"`（精确，`resolve_protocol_version` 只认 `"2"`）；`server_info.protocol_version` 是展示层 `"2.0"`——**检查目标是 `"2.0"`**，非 `"2.0"` → `PROTOCOL_MISMATCH`（spec §5.3 step 4 / §6 / §8 验收 #2）。
2. **fail-closed**：握手版本不符、`delta` 无 segment meta、conversationId 无法补齐 → 抛 `CyreneError(PROTOCOL_MISMATCH)`；绝不默认/降级 v1。
3. **REST 混合命名**：`RestMessage` 保留 `message_id`/`session_id`/`_id`/`tool_call_id`/`duration_ms`/`error_type`（snake）+ camel 字段；`rest-schemas` 用 `.strict()`；`_id` 恒保留为 cursor。
4. **分页**：`before`/`after` 认 `_id` 游标；before 页倒序 → `(_id, timestamp)` 正序归一化；after 页不反转；`nextCursor` 用响应 `cursor`，缺省且 `has_more` 时用 raw 最末 `_id`；畸形游标 400 → `CyreneError`。
5. **Bearer**：所有 REST 请求与 WS 握手统一注入 `Authorization: Bearer <token>`（与 WS 同 token）。
6. **ack/error 帧**：raw 层扩展 `user_message.ack`/`error` 两帧（2A union 无）；二者由 RealBackend 处理（mapper 返回 null）；ack 按 `clientRequestId` 关联 pending（accepted resolve / rejected 抛错 / **15s 超时**）。
7. **重连**：网络层 close/error → 指数退避（1s ×2 上限 30s，6 次 → error）；**`unexpected-response`(400/401/403) → fail-fast 不重连**。
8. **回放**：`session` 帧 `conversationId` 存在即用；缺省时缓冲至 REST `active:true` 条目；投递经 `onSessionReplay(conversationId, messages)`；connectionId 不当 conversationId。
9. **tool 元数据**：tool 消息保留到领域 `Message.tool?`（docs/18 §14），不得按普通文本丢弃。
10. **assistant 段优先级**：`content` 纯文本优先，`parts` 仅当 content 非纯文本/缺失（防重复段）。
11. `interrupt` 非定向（后端无 generationId）；`cancelGeneration` 的 generationId 仅日志关联。
12. 既有 231 单测不回归；`pnpm typecheck`/`lint`/`build` 全过；本块标「已开发、未联调」。

---

### Task 1: REST wire 层 + ws 依赖

**Files:**
- Create: `src/main/transport/protocol-v2/rest-types.ts`
- Create: `src/main/transport/protocol-v2/rest-schemas.ts`
- Create: `tests/unit/rest-schemas.spec.ts`
- Modify: `apps/desktop/package.json`（加 `ws` + `@types/ws`）

**Interfaces:**
- Produces：`RestSessionSummary`/`RestSessionListResult`/`RestSessionDetail`/`RestMessage`/`RestMessagesPageResponse`/`RestSessionActivateResult`/`RestPendingQueryResponse`；`parseRestMessage`/`parseRestSessions`/`parseRestMessagesPage` 等解析函数。

- [ ] **Step 1: 安装依赖**

Run: `pnpm add ws && pnpm add -D @types/ws`（在 `apps/desktop/`）
Expected: package.json 含 `ws`（dependencies）+ `@types/ws`（devDependencies）

- [ ] **Step 2: 写失败测试** —— `tests/unit/rest-schemas.spec.ts`（完整内容）

```typescript
import { describe, expect, it } from 'vitest'
import { parseRestSessions, parseRestMessagesPage, parseRestMessage, parseRestSessionDetail, parseRestActivateResult } from '../../src/main/transport/protocol-v2/rest-schemas'

const validSummary = { conversationId: 'conv-1', title: '测试', messageCount: 3, updatedAt: '2026-08-11T00:00:00.000Z', active: true }

const validMessage = {
  role: 'assistant', parts: [{ content: '你好' }], content: '你好',
  message_id: 'msg-1', timestamp: '2026-08-11T00:00:00.000Z',
  session_id: 'conv-1', _id: '507f1f77bcf86cd799439011',
  inner_voice: '内心独白', tool_call_id: 'tc-1', tool_name: 'desktop.file.read',
  success: true, error: '', error_type: '', duration_ms: 10, truncated: false
}

describe('REST wire schema', () => {
  it('SessionSummary 合法通过,缺 title 通过', () => {
    expect(parseRestSessions({ sessions: [validSummary], has_more: false }).success).toBe(true)
    const noTitle = { ...validSummary }; delete (noTitle as Record<string, unknown>).title
    expect(parseRestSessions({ sessions: [noTitle], has_more: true, cursor: 'c1' }).success).toBe(true)
  })

  it('Message 全字段(混合命名 message_id/_id/tool_call_id)通过', () => {
    expect(parseRestMessage(validMessage).success).toBe(true)
  })

  it('Message 缺 message_id/timestamp 拒绝(必填)', () => {
    const bad = { ...validMessage }; delete (bad as Record<string, unknown>).message_id
    expect(parseRestMessage(bad).success).toBe(false)
    const bad2 = { ...validMessage }; delete (bad2 as Record<string, unknown>).timestamp
    expect(parseRestMessage(bad2).success).toBe(false)
  })

  it('Message 缺 _id 通过(可选,Mongo 归档 id)', () => {
    const noId = { ...validMessage }; delete (noId as Record<string, unknown>)._id
    expect(parseRestMessage(noId).success).toBe(true)
  })

  it('strict:未知键拒绝', () => {
    expect(parseRestMessage({ ...validMessage, bogus: 1 }).success).toBe(false)
  })

  it('MessagesPageResponse 全字段通过,has_more=false 时 cursor 缺省', () => {
    expect(parseRestMessagesPage({ messages: [validMessage], has_more: false, total: 1 }).success).toBe(true)
    expect(parseRestMessagesPage({ messages: [validMessage], has_more: true, total: 2, cursor: '507f' }).success).toBe(true)
  })

  it('SessionDetail 通过,activate 结果通过', () => {
    expect(parseRestSessionDetail({ session: validSummary, messages: [validMessage], active: true }).success).toBe(true)
    expect(parseRestActivateResult({ activeConversationId: 'conv-2' }).success).toBe(true)
  })

  it('未知 role 拒绝(仅 user/assistant/tool)', () => {
    expect(parseRestMessage({ ...validMessage, role: 'system' }).success).toBe(false)
  })
})
```

Run: `pnpm test -- tests/unit/rest-schemas.spec.ts`
Expected: FAIL（rest-schemas 不存在）

- [ ] **Step 3: 实现 `rest-types.ts`**（完整内容，见 spec §5.1）

```typescript
/** REST wire 类型(保留后端混合命名:message_id/_id/tool_call_id snake + camel) */

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
  role: 'user' | 'assistant' | 'tool'
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
  _id?: string
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
export interface RestPendingQueryResponse {
  pendingMessages: { messageId: string; snippet: string; createdAt: string }[]
  pendingApprovals: unknown[]
}
```

- [ ] **Step 4: 实现 `rest-schemas.ts`**（完整内容；zod 4.4.3 双参 record）

```typescript
import { z } from 'zod'
import type { RestMessage, RestMessagesPageResponse, RestSessionDetail, RestSessionListResult, RestSessionActivateResult } from './rest-types'

export const RestSessionSummarySchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  active: z.boolean()
}).strict()

export const RestSessionListResultSchema = z.object({
  sessions: z.array(RestSessionSummarySchema),
  has_more: z.boolean(),
  cursor: z.string().optional()
}).strict()

export const RestMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  parts: z.array(z.object({ content: z.string() })).optional(),
  content: z.unknown().optional(),
  content_type: z.record(z.string(), z.array(z.number().int().nonnegative())).optional(),
  inner_voice: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  token_usage: z.unknown().optional(),
  message_id: z.string().min(1),
  timestamp: z.string().min(1),
  session_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  _id: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  error_type: z.string().optional(),
  duration_ms: z.number().optional(),
  truncated: z.boolean().optional()
}).strict()

export const RestMessagesPageResponseSchema = z.object({
  messages: z.array(RestMessageSchema),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
  cursor: z.string().optional()
}).strict()

export const RestSessionDetailSchema = z.object({
  session: RestSessionSummarySchema,
  messages: z.array(RestMessageSchema),
  active: z.boolean()
}).strict()

export const RestSessionActivateResultSchema = z.object({
  activeConversationId: z.string().min(1)
}).strict()

export const RestPendingQueryResponseSchema = z.object({
  pendingMessages: z.array(z.object({
    messageId: z.string().min(1), snippet: z.string(), createdAt: z.string().min(1)
  })),
  pendingApprovals: z.array(z.unknown())
}).strict()

// parse 助手(返回判别结果,调用方处理失败)
export function parseRestMessage(input: unknown): { success: true; data: RestMessage } | { success: false; error: z.ZodError } {
  return RestMessageSchema.safeParse(input)
}
export function parseRestSessions(input: unknown): { success: true; data: RestSessionListResult } | { success: false; error: z.ZodError } {
  return RestSessionListResultSchema.safeParse(input)
}
export function parseRestMessagesPage(input: unknown): { success: true; data: RestMessagesPageResponse } | { success: false; error: z.ZodError } {
  return RestMessagesPageResponseSchema.safeParse(input)
}
export function parseRestSessionDetail(input: unknown): { success: true; data: RestSessionDetail } | { success: false; error: z.ZodError } {
  return RestSessionDetailSchema.safeParse(input)
}
export function parseRestActivateResult(input: unknown): { success: true; data: RestSessionActivateResult } | { success: false; error: z.ZodError } {
  return RestSessionActivateResultSchema.safeParse(input)
}
export function parseRestPendingQuery(input: unknown): { success: true; data: RestPendingQueryResponse } | { success: false; error: z.ZodError } {
  return RestPendingQueryResponseSchema.safeParse(input)
}
```

- [ ] **Step 5: 验证**

Run: `pnpm test -- tests/unit/rest-schemas.spec.ts`、`pnpm typecheck`、`pnpm lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/transport/protocol-v2/rest-types.ts src/main/transport/protocol-v2/rest-schemas.ts tests/unit/rest-schemas.spec.ts package.json pnpm-lock.yaml
git commit -m "feat(阶段2块B): REST wire 层——rest-types/rest-schemas(混合命名 + strict)"
```

---

### Task 2: rest-mapper + Message.tool?

**Files:**
- Create: `src/main/transport/protocol-v2/rest-mapper.ts`
- Create: `tests/unit/rest-mapper.spec.ts`
- Modify: `src/shared/contracts/message.ts`（`Message.tool?`）

**Interfaces:**
- Consumes: `RestMessage`/`RestSessionSummary`/`RestMessagesPageResponse`（Task 1）、`RawSessionMessageItem`（2A raw-types）、领域 `Message`/`Conversation`/`MessagePage`。
- Produces：`RestMapper`（`toDomainMessage`/`toDomainMessageFromReplay`/`toConversation`/`toMessagePage`）。

- [ ] **Step 1: 写失败测试** —— `tests/unit/rest-mapper.spec.ts`（完整内容）

```typescript
import { describe, expect, it } from 'vitest'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import type { RestMessage, RestMessagesPageResponse, RestSessionSummary } from '../../src/main/transport/protocol-v2/rest-types'
import type { RawSessionMessageItem } from '../../src/main/transport/protocol-v2/raw-types'

const mapper = new RestMapper({ onProtocolWarning: () => {} })

const userMsg: RestMessage = {
  role: 'user', content: '你好', parts: [{ content: '你好' }],
  message_id: 'msg-1', timestamp: '2026-08-11T00:00:00.000Z', session_id: 'conv-1', _id: '507f1f77bcf86cd799439011'
}
const assistantMsg: RestMessage = {
  role: 'assistant', content: '好的', parts: [{ content: '好的' }],
  inner_voice: '让我想想',
  message_id: 'msg-2', timestamp: '2026-08-11T00:00:01.000Z', session_id: 'conv-1', _id: '507f1f77bcf86cd799439012'
}
const toolMsg: RestMessage = {
  role: 'tool', content: '文件内容', message_id: 'msg-3', timestamp: '2026-08-11T00:00:02.000Z',
  session_id: 'conv-1', _id: '507f1f77bcf86cd799439013',
  tool_call_id: 'tc-1', tool_name: 'desktop.file.read', success: true, duration_ms: 12
}

describe('RestMapper', () => {
  it('user 消息 → content 文本,status completed', () => {
    const m = mapper.toDomainMessage(userMsg)
    expect(m.messageId).toBe('msg-1')
    expect(m.role).toBe('user')
    expect(m.content).toBe('你好')
    expect(m.conversationId).toBe('conv-1')
    expect(m.status).toBe('completed')
  })

  it('assistant 消息 → inner_voice 段 + public_reply 段,content 不重复写入', () => {
    const m = mapper.toDomainMessage(assistantMsg)
    expect(m.role).toBe('assistant')
    const segs = m.assistantSegments ?? []
    expect(segs.some((s) => s.channel === 'inner_voice' && s.text === '让我想想')).toBe(true)
    expect(segs.some((s) => s.channel === 'public_reply' && s.text === '好的')).toBe(true)
    expect(m.content).toBeUndefined() // assistant 正文单一来源 assistantSegments
  })

  it('tool 消息 → content + tool 元数据保留', () => {
    const m = mapper.toDomainMessage(toolMsg)
    expect(m.content).toBe('文件内容')
    expect(m.tool).toEqual({ callId: 'tc-1', name: 'desktop.file.read', success: true, durationMs: 12 })
  })

  it('toDomainMessageFromReplay:回放项 name/mood 处理', () => {
    const replay: RawSessionMessageItem = {
      role: 'tool', message_id: 'msg-4', timestamp: '2026-08-11T00:00:03.000Z',
      content: '结果', name: 'desktop.file.write', success: false, error: 'denied'
    }
    const m = mapper.toDomainMessageFromReplay(replay, 'conv-9')
    expect(m.conversationId).toBe('conv-9')
    expect(m.tool?.name).toBe('desktop.file.write')
    expect(m.tool?.success).toBe(false)
    expect(m.tool?.error).toBe('denied')
  })

  it('toConversation 映射', () => {
    const s: RestSessionSummary = { conversationId: 'conv-1', title: '测试', messageCount: 3, updatedAt: '2026-08-11T00:00:00.000Z', active: true }
    expect(mapper.toConversation(s)).toEqual({ id: 'conv-1', title: '测试', updatedAt: '2026-08-11T00:00:00.000Z' })
  })

  it('toMessagePage before 页倒序归一化 + nextCursor', () => {
    const page: RestMessagesPageResponse = {
      messages: [
        { ...userMsg, message_id: 'msg-5', timestamp: '2026-08-11T00:00:05.000Z', _id: '5' },
        { ...assistantMsg, message_id: 'msg-6', timestamp: '2026-08-11T00:00:04.000Z', _id: '4' }
      ],
      has_more: true, total: 10, cursor: '4'
    }
    const result = mapper.toMessagePage(page, { direction: 'before' })
    expect(result.items.map((i) => i.messageId)).toEqual(['msg-6', 'msg-5']) // 正序
    expect(result.nextCursor).toBe('4')
    expect(result.hasMore).toBe(true)
  })

  it('toMessagePage after 页不反转', () => {
    const page: RestMessagesPageResponse = {
      messages: [
        { ...userMsg, message_id: 'msg-7', timestamp: '2026-08-11T00:00:06.000Z', _id: '6' },
        { ...assistantMsg, message_id: 'msg-8', timestamp: '2026-08-11T00:00:07.000Z', _id: '7' }
      ],
      has_more: false, total: 8
    }
    const result = mapper.toMessagePage(page, { direction: 'after' })
    expect(result.items.map((i) => i.messageId)).toEqual(['msg-7', 'msg-8']) // 不反转
    expect(result.nextCursor).toBeUndefined() // has_more=false 无 cursor
  })
})
```

Run: `pnpm test -- tests/unit/rest-mapper.spec.ts`
Expected: FAIL（rest-mapper 不存在 / Message.tool 类型缺）

- [ ] **Step 2: 实现 `Message.tool?`**（`shared/contracts/message.ts` 追加）

```typescript
/** tool 消息元数据(docs/18 §14:不得按普通文本丢弃) */
export interface MessageToolInfo {
  callId?: string
  name?: string
  success?: boolean
  error?: string
  errorType?: string
  durationMs?: number
  truncated?: boolean
}
```
并在 `Message` 接口加 `tool?: MessageToolInfo`。

- [ ] **Step 3: 实现 `rest-mapper.ts`**（完整内容）

```typescript
import type { Conversation } from '@shared/contracts/conversation'
import type { Message, MessageRole, MessageToolInfo } from '@shared/contracts/message'
import type { MessagePage } from '@shared/contracts/backend'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import type { RawSessionMessageItem } from './raw-types'
import type { RestMessage, RestMessagesPageResponse, RestSessionSummary } from './rest-types'

export interface RestMapperOptions { onProtocolWarning?: (warning: ProtocolWarning) => void }

interface MessageSource {
  role: string
  message_id?: string
  timestamp?: string
  session_id?: string
  parts?: { content: string }[]
  content?: unknown
  inner_voice?: string
  mood?: string
  tool_call_id?: string
  name?: string
  success?: boolean
  error?: string
  error_type?: string
  duration_ms?: number
  truncated?: boolean
}

export class RestMapper {
  private readonly onProtocolWarning: (warning: ProtocolWarning) => void
  constructor(options: RestMapperOptions = {}) { this.onProtocolWarning = options.onProtocolWarning ?? (() => {}) }

  toDomainMessage(raw: RestMessage, conversationId?: string): Message { return this.assemble({ ...raw }, conversationId) }
  toDomainMessageFromReplay(raw: RawSessionMessageItem, conversationId: string): Message { return this.assemble({ ...raw, session_id: conversationId }, conversationId) }
  toConversation(raw: RestSessionSummary): Conversation { return { id: raw.conversationId, title: raw.title, updatedAt: raw.updatedAt } }
  toMessagePage(raw: RestMessagesPageResponse, opts: { direction: 'before' | 'after'; conversationId?: string }): MessagePage {
    const items = raw.messages.map((m) => this.toDomainMessage(m, opts.conversationId))
    if (opts.direction === 'before') items.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1) // (timestamp, messageId) 稳定排序
    let nextCursor: string | undefined
    if (raw.has_more) nextCursor = raw.cursor ?? raw.messages.at(-1)?._id
    return { items, hasMore: raw.has_more, nextCursor }
  }

  private assemble(src: MessageSource, conversationId?: string): Message {
    const role = src.role as MessageRole
    const convId = conversationId ?? src.session_id ?? ''
    const base: Message = {
      messageId: src.message_id ?? `${convId}:${src.timestamp ?? 'replay'}`, // 缺省可复现本地 id
      conversationId: convId,
      role,
      createdAt: src.timestamp ?? '',
      status: 'completed'
    }
    if (role === 'user' || role === 'tool') {
      base.content = extractText(src.content, src.parts)
    } else if (role === 'assistant') {
      const segments: NonNullable<Message['assistantSegments']> = []
      if (src.inner_voice) segments.push({ segmentId: `iv-${base.messageId}`, segmentIndex: 0, channel: 'inner_voice', kind: 'text', text: src.inner_voice, completed: true })
      const mainText = extractText(src.content, src.parts)
      if (mainText) segments.push({ segmentId: `pr-${base.messageId}`, segmentIndex: segments.length, channel: 'public_reply', kind: 'markdown', text: mainText, completed: true })
      if (segments.length) base.assistantSegments = segments
    }
    if (role === 'tool' || src.tool_call_id || src.name || src.success !== undefined) {
      const tool: MessageToolInfo = {}
      if (src.tool_call_id) tool.callId = src.tool_call_id
      if (src.name) tool.name = src.name
      if (src.success !== undefined) tool.success = src.success
      if (src.error !== undefined) tool.error = src.error
      if (src.error_type !== undefined) tool.errorType = src.error_type
      if (src.duration_ms !== undefined) tool.durationMs = src.duration_ms
      if (src.truncated !== undefined) tool.truncated = src.truncated
      if (Object.keys(tool).length) base.tool = tool
    }
    return base
  }
}

/** 提取纯文本:content 为 string 优先;否则 parts 拼接(assistant content/parts 同文本时不重复) */
function extractText(content: unknown, parts?: { content: string }[]): string | undefined {
  if (typeof content === 'string' && content.length > 0) return content
  if (typeof content === 'string' && content.length === 0) return undefined
  const joined = (parts ?? []).map((p) => p.content).join('')
  return joined.length > 0 ? joined : undefined
}
```

- [ ] **Step 4: 验证**

Run: `pnpm test -- tests/unit/rest-mapper.spec.ts`、`pnpm typecheck`、`pnpm lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/transport/protocol-v2/rest-mapper.ts tests/unit/rest-mapper.spec.ts src/shared/contracts/message.ts
git commit -m "feat(阶段2块B): rest-mapper REST→领域映射 + Message.tool 元数据"
```

---

### Task 3: raw 层扩展(ack/error) + BackendAdapter 接口扩展 + MockBackend 同步

**Files:**
- Modify: `src/main/transport/protocol-v2/raw-types.ts`、`raw-schemas.ts`（加 `user_message.ack`/`error`）
- Modify: `tests/unit/raw-schemas.spec.ts`（补 ack/error 用例）
- Modify: `src/shared/contracts/backend.ts`（`ConversationMessagesQuery`/`ActivateConversationResult`）
- Modify: `src/main/transport/backend-adapter.ts`（接口新方法）
- Modify: `src/main/transport/mock-backend.ts`（同步实现）

**Interfaces:**
- Consumes: 无新依赖。
- Produces：`RawUserAck`/`RawErrorMessage` 进 `RawFrame` union；`BackendAdapter` 新方法。

- [ ] **Step 1: 写失败测试** —— 扩展 `tests/unit/raw-schemas.spec.ts`（追加 describe）

```typescript
describe('raw schema ack/error 扩展(2B)', () => {
  it('user_message.ack accepted 通过', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'msg-1', clientRequestId: 'c1', receivedAt: '2026-08-11T00:00:00.000Z', status: 'accepted' })
    expect(r.success).toBe(true)
  })
  it('user_message.ack rejected 带 error 通过', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'msg-1', clientRequestId: 'c1', receivedAt: '2026-08-11T00:00:00.000Z', status: 'rejected', error: { code: 'CONTRACT_VALIDATION', message: 'bad', retryable: false } })
    expect(r.success).toBe(true)
  })
  it('error 帧通过', () => {
    const r = parseRawFrame({ type: 'error', message: '会话不存在', code: 'SESSION_NOT_FOUND', requestId: 'req-1', retryable: false })
    expect(r.success).toBe(true)
  })
  it('ack status 非法拒绝', () => {
    const r = parseRawFrame({ type: 'user_message.ack', messageId: 'm', clientRequestId: 'c', receivedAt: 't', status: 'pending' })
    expect(r.success).toBe(false)
  })
})
```

Run: `pnpm test -- tests/unit/raw-schemas.spec.ts`
Expected: FAIL（ack/error 不在 union）

- [ ] **Step 2: 扩展 `raw-types.ts`**（追加）

```typescript
export interface RawUserAck {
  type: 'user_message.ack'
  messageId: string
  clientRequestId: string
  clientMessageId?: string
  conversationId?: string
  receivedAt: string
  status: 'accepted' | 'rejected'
  error?: { code: string; message: string; retryable?: boolean }
}
export interface RawErrorMessage {
  type: 'error'
  message: string
  code?: string
  requestId?: string
  retryable?: boolean
  details?: Record<string, unknown>
}
export type RawFrame =
  | RawSessionMessage | RawServerInfo | RawExpression
  | RawGenerationStarted | RawGenerationSegmentStarted | RawGenerationDelta
  | RawGenerationSegmentCompleted | RawGenerationCompleted | RawGenerationFailed
  | RawUserAck | RawErrorMessage
```

- [ ] **Step 3: 扩展 `raw-schemas.ts`**（追加两个 schema + 并入 `RawFrameSchema` 判别 union）

```typescript
const RawUserAckSchema = z.object({
  type: z.literal('user_message.ack'),
  messageId: z.string().min(1),
  clientRequestId: z.string().min(1),
  clientMessageId: z.string().optional(),
  conversationId: z.string().optional(),
  receivedAt: z.string().min(1),
  status: z.enum(['accepted', 'rejected']),
  error: z.object({ code: z.string().min(1), message: z.string(), retryable: z.boolean().optional() }).optional()
}).strict()

const RawErrorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string().min(1),
  code: z.string().optional(),
  requestId: z.string().optional(),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional()
}).strict()

export const RawFrameSchema = z.discriminatedUnion('type', [/* …既有… */, RawUserAckSchema, RawErrorMessageSchema])
```

**注**：`FrameMapper` 的 `mapFrame` 默认分支已返回 null（非 generation 帧），无需改——ack/error 由 RealBackend 直接处理（spec B-12）。

- [ ] **Step 4: 接口扩展** —— `shared/contracts/backend.ts` + `backend-adapter.ts`

```typescript
// backend.ts 追加
export interface ConversationMessagesQuery {
  conversationId: string
  before?: string   // _id opaque cursor(倒序)
  after?: string    // _id opaque cursor(正序增量)
  limit?: number
}
export interface ActivateConversationResult { conversationId: string }
```
`backend-adapter.ts` 接口加：
```typescript
getConversationMessages(input: ConversationMessagesQuery): Promise<MessagePage>
activateConversation(conversationId: string): Promise<ActivateConversationResult>
renameConversation(id: string, title: string): Promise<Conversation>
```

- [ ] **Step 5: `MockBackend` 同步实现**

```typescript
async getConversationMessages(_input: ConversationMessagesQuery): Promise<MessagePage> { return { items: [], hasMore: false } }
async activateConversation(conversationId: string): Promise<ActivateConversationResult> { return { conversationId } }
async renameConversation(id: string, title: string): Promise<Conversation> {
  const conv = MOCK_CONVERSATIONS.find((c) => c.id === id)
  if (!conv) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `会话不存在: ${id}`)
  conv.title = title
  return { ...conv }
}
```

- [ ] **Step 6: 验证**

Run: `pnpm test`（全量，含既有 231 不回归）、`pnpm typecheck`、`pnpm lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/transport/protocol-v2/raw-types.ts src/main/transport/protocol-v2/raw-schemas.ts tests/unit/raw-schemas.spec.ts src/shared/contracts/backend.ts src/main/transport/backend-adapter.ts src/main/transport/mock-backend.ts
git commit -m "feat(阶段2块B): raw 层扩展 ack/error 帧 + BackendAdapter 接口扩展(会话分页/激活/重命名)"
```

---

### Task 4: RealBackend WS 连接生命周期

**Files:**
- Create: `src/main/transport/real-backend.ts`（WS 部分：connect/握手/帧分派/session 回放/心跳/重连/ack 关联/error 路由）
- Create: `tests/unit/real-backend.spec.ts`（WS 部分：本地 Mock WS 服务）
- Modify: `apps/desktop/package.json` 已含 ws（Task 1）

**Interfaces:**
- Consumes: `BackendAdapter`（含新方法）、`parseRawFrame`/`FrameMapper`（2A + Task 3）、`RestMapper`（Task 2）。
- Produces：`RealBackend` 类 + `ConnectionState`。

**约束：** 握手两层取值、帧四路分派、session 缓冲归属、重连退避 + unexpected-response fail-fast、ack 15s 超时、`onSessionReplay`/`onError` 回调。

- [ ] **Step 1: 写失败测试** —— `tests/unit/real-backend.spec.ts`（WS 部分；用 `ws` 库起真实本地伪后端）

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { WebSocketServer } from 'ws'
import { AddressInfo } from 'net'
import { RealBackend } from '../../src/main/transport/real-backend'
import type { BackendEvent } from '@shared/contracts'
import { CyreneErrorCode } from '@shared/errors'

let server: Server
let wss: WebSocketServer
let authServer: Server
let port: number
let authPort: number
let receivedHeaders: Record<string, string> = {}
let receivedClientFrames: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(404); res.end()
  })
  wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (ws, req) => {
    receivedHeaders = {}
    receivedClientFrames = []
    for (const k of Object.keys(req.headers)) receivedHeaders[k.toLowerCase()] = String(req.headers[k] ?? '')
    ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
    ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
    ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
    ws.send(JSON.stringify({ type: 'generation.started', generationId: 'gen-1', messageId: 'msg-g', conversationId: 'conv-1', model: 'm1' }))
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data))
      receivedClientFrames.push(frame.type)
      if (frame.type === 'text') {
        if (frame.clientRequestId === 'c-timeout') return // 不发 ack → 触发超时
        const ok = frame.clientRequestId === 'c-reject'
          ? { status: 'rejected', error: { code: 'CONTRACT_VALIDATION', message: 'bad', retryable: false } }
          : frame.clientRequestId === 'c-error'
            ? (ws.send(JSON.stringify({ type: 'error', message: '限流', code: 'RATE_LIMITED', requestId: 'req-1', retryable: true })), { status: 'accepted' })
            : { status: 'accepted' }
        ws.send(JSON.stringify({ type: 'user_message.ack', messageId: 'msg-ack', clientRequestId: frame.clientRequestId, receivedAt: '2026-08-11T00:00:00.000Z', ...ok }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  authServer = createServer((_req, res) => { res.writeHead(401); res.end() })
  await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve))
  authPort = (authServer.address() as AddressInfo).port
})

afterAll(async () => { wss.close(); server.close(); authServer.close() })

function makeBackend(): RealBackend { return new RealBackend({ now: () => Date.now() }) }

describe('RealBackend WS 连接', () => {
  it('握手头精确注入 X-Protocol-Version:"2"/X-Client-Platform/Authorization', async () => {
    const b = makeBackend()
    const session = await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    expect(session.protocolVersion).toBe('2.0')
    expect(session.sessionId).toBe('conn-1')
    expect(receivedHeaders['x-protocol-version']).toBe('2')
    expect(receivedHeaders['x-client-platform']).toBe('electron')
    expect(receivedHeaders['authorization']).toBe('Bearer sk-test')
    await b.disconnect()
  })

  it('连接状态 connected + activeConversationId 解析', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    expect(b.getConnectionState().status).toBe('connected')
    expect(b.getConnectionState().activeConversationId).toBe('conv-1')
    await b.disconnect()
  })

  it('sendMessage → ack accepted → ClientRequestRef', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    const ref = await b.sendMessage({ conversationId: 'conv-1', text: 'hi', clientRequestId: 'c1' })
    expect(ref.clientRequestId).toBe('c1')
    expect(ref.serverMessageId).toBe('msg-ack')
    await b.disconnect()
  })

  it('sendMessage → ack rejected → CyreneError', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await expect(b.sendMessage({ conversationId: 'conv-1', text: 'hi', clientRequestId: 'c-reject' })).rejects.toBeDefined()
    await b.disconnect()
  })

  it('sendMessage ack 超时 → CyreneError(TIMEOUT)', async () => {
    const b = new RealBackend({ now: () => Date.now(), ackTimeoutMs: 30 })
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await expect(b.sendMessage({ conversationId: 'conv-1', text: 'x', clientRequestId: 'c-timeout' })).rejects.toMatchObject({ code: CyreneErrorCode.TIMEOUT })
    await b.disconnect()
  })

  it('subscribe 收到 generation 事件(经 FrameMapper)', async () => {
    const b = makeBackend()
    const received: BackendEvent[] = []
    b.subscribe((e) => received.push(e))
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await new Promise((r) => setTimeout(r, 50))
    expect(received.some((e) => e.event === 'generation.started' && e.responseId === 'gen-1')).toBe(true)
    await b.disconnect()
  })

  it('cancelGeneration → interrupt 帧发出', async () => {
    const b = makeBackend()
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await b.cancelGeneration({ generationId: 'gen-1' })
    await new Promise((r) => setTimeout(r, 50)) // ws.send fire-and-forget,等伪后端收帧
    expect(receivedClientFrames).toContain('interrupt')
    await b.disconnect()
  })

  it('WS error 帧 → onError 回调', async () => {
    const errs: unknown[] = []
    const b = new RealBackend({ now: () => Date.now(), onError: (e) => errs.push(e) })
    await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
    await b.sendMessage({ conversationId: 'conv-1', text: 'x', clientRequestId: 'c-error' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    expect(errs.length).toBeGreaterThan(0)
    await b.disconnect()
  })

  it('server_info 版本非 2.0 → connect reject PROTOCOL_MISMATCH,状态 error', async () => {
    const fakeWs = {
      send: () => {}, close: () => {}, readyState: 1,
      on: (ev: string, cb: (arg?: unknown) => void) => {
        if (ev === 'open') cb()
        if (ev === 'message') {
          cb(Buffer.from(JSON.stringify({ type: 'session', conversationId: 'c', messages: [], token_stats: { total: 0, byModel: {} } })))
          setTimeout(() => cb(Buffer.from(JSON.stringify({ type: 'server_info', protocol_version: '1.0', server_version: 'v', features: {}, services: {} }))), 0)
        }
      }
    }
    const b = new RealBackend({ now: () => Date.now(), wsFactory: () => fakeWs as never })
    await expect(b.connect({ serverUrl: 'http://x', token: 't' })).rejects.toMatchObject({ code: CyreneErrorCode.PROTOCOL_MISMATCH })
    expect(b.getConnectionState().status).toBe('error')
  })

  it('unexpected-response(401) → fail-fast error 状态不重连', async () => {
    const b = makeBackend()
    await expect(b.connect({ serverUrl: `http://127.0.0.1:${authPort}`, token: 'bad' })).rejects.toBeDefined()
    expect(b.getConnectionState().status).toBe('error') // 不是 reconnecting
  })
})
```

**实现备注（subagent 阅读）：**
- **connect promise**：在 `server_info` 到达后 resolve；版本非 `"2.0"` → **reject connect promise**（置 state=error），不是仅抛异常（回调里抛异常会逃逸、promise 永不 settle → 测试超时）。
- **`unexpected-response`**：ws 库 `WebSocket.on('unexpected-response', (req, res))`；收到（authServer 端口 401 拒绝升级触发）→ reject connect + state=error，**不重连**；且**置 error 后后续 `close`/`error` 事件必须跳过重连**（401 拒绝后 ws 库可能再发 close/error，避免把 state 翻回 `reconnecting`）。
- `generation.started` 已在 beforeAll 伪后端注入（server_info 后）；FrameMapper 在 `handleSession` 解析后 `setActiveConversationId('conv-1')`。
- **`ackTimeoutMs`** 是 `RealBackendOptions` 选项（默认 15000），测试用 30ms；实现需支持该注入。
- WS `error` 帧用例：伪后端对 `c-error` text 先发 error 帧再发 ack；onError 回调收到 error 帧，sendMessage 仍正常 resolve（两者独立路径）。
- **Task 4 前置**：`shared/errors/index.ts` 枚举追加 `TIMEOUT`/`NOT_FOUND`/`AUTHENTICATION_FAILED`（spec §10 B-G6），本 Step 先加。activateConversation 的 REST 版属 Task 5（本 Step 不测）。

- [ ] **Step 2: 实现 `real-backend.ts`**（WS 连接核心；REST 方法 Task 5）

```typescript
import { WebSocket } from 'ws'
import type { BackendEvent } from '@shared/contracts'
import type { BackendSession, ConnectInput, ConversationMessagesQuery, ActivateConversationResult, MessagePage, PageQuery, Page } from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput } from '@shared/contracts/conversation'
import type { ClientRequestRef, Message, SendMessageInput } from '@shared/contracts/message'
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { parseRawFrame, type RawFrame } from './protocol-v2/raw-schemas'
import type { RawSessionMessageItem } from './protocol-v2/raw-types'
import { FrameMapper } from './protocol-v2/frame-mapper'
import { RestMapper } from './protocol-v2/rest-mapper'
import { parseRestSessions, parseRestMessagesPage, parseRestSessionDetail, parseRestActivateResult } from './protocol-v2/rest-schemas'
import type { BackendAdapter, BackendEventHandler } from './backend-adapter'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
export interface ConnectionState {
  status: ConnectionStatus
  serverUrl?: string
  protocolVersion?: string
  serverVersion?: string
  connectionId?: string
  activeConversationId?: string
  lastError?: string
}
export interface WebSocketLike {
  on(ev: 'open' | 'message' | 'close' | 'error' | 'unexpected-response', cb: (arg?: unknown, arg2?: unknown) => void): void
  send(data: string): void
  close(): void
  readyState: number
}
export interface RealBackendOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocketLike
  onProtocolWarning?: (warning: ProtocolWarning) => void
  onSessionReplay?: (conversationId: string, messages: Message[]) => void
  onError?: (error: CyreneError) => void
  ackTimeoutMs?: number   // 默认 15000;测试注入小值
}

export class RealBackend implements BackendAdapter {
  private ws?: WebSocketLike
  private readonly options: RealBackendOptions
  private readonly handler = new Set<BackendEventHandler>()
  private readonly pendingAcks = new Map<string, { resolve: (r: ClientRequestRef) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  private state: ConnectionState = { status: 'disconnected' }
  private mapper?: FrameMapper
  private readonly restMapper = new RestMapper()
  private sessionBuffer: RawSessionMessageItem[] = []
  private reconnectAttempts = 0
  private serverUrl = ''
  private token = ''
  private connectResolve?: (s: BackendSession) => void
  private connectReject?: (e: unknown) => void

  constructor(options: RealBackendOptions = {}) { this.options = options }

  getConnectionState(): ConnectionState { return this.state }
  subscribe(handler: BackendEventHandler): () => void { this.handler.add(handler); return () => this.handler.delete(handler) }
  async setToken(token: string): Promise<void> { this.token = token }

  // —— 帧分派 ——
  private handleFrame(rawText: string): void {
    let parsed
    try { parsed = parseRawFrame(JSON.parse(rawText)) } catch { this.warn('RAW_FRAME_INVALID', 'JSON 解析失败'); return }
    if (!parsed.success) { this.warn('RAW_FRAME_INVALID', '帧校验失败'); return }
    const frame = parsed.data
    switch (frame.type) {
      case 'session': this.handleSession(frame); return
      case 'server_info': this.handleServerInfo(frame); return
      case 'expression': return
      case 'user_message.ack': this.handleAck(frame); return
      case 'error': this.handleErrorFrame(frame); return
      default: { const ev = this.mapper?.mapFrame(frame); if (ev) this.emit(ev) }
    }
  }
  // handleSession:conversationId 存在 → setActiveConversationId + onSessionReplay(restMapper.toDomainMessageFromReplay 归一化 messages);缺省 → sessionBuffer 缓冲(B-6,经 REST active:true 解析后投递)
  // handleServerInfo:protocol_version !== '2.0' → connectReject(PROTOCOL_MISMATCH) + state=error;否则记录元数据 + connectResolve(BackendSession{sessionId: connectionId ?? 'local', protocolVersion: '2.0', serverUrl})
  // handleAck:按 clientRequestId resolve(accepted,带 serverMessageId)/reject(rejected,ack.error 映射 INVALID_INPUT)/清 timer
  // handleErrorFrame:onError(CyreneError) + warn
  private warn(code: string, message: string): void { this.options.onProtocolWarning?.({ code, message }) }
  private emit(event: BackendEvent): void { for (const h of this.handler) h(event) }

  // connect 核心:校验 token → wsBase=serverUrl.replace(/^http/, 'ws')+'/ws' → wsFactory(headers: X-Protocol-Version:"2"/X-Client-Platform:"electron"/Authorization:"Bearer <token>")
  //   → ws.on('message') → handleFrame;'close'/'error' → scheduleReconnect;'unexpected-response' → connectReject + state=error(不重连)
  //   → connect 的 Promise 由 handleServerInfo resolve/reject(见备注:版本不符必须 reject 而非抛)
  // scheduleReconnect:now() 注入退避(1s ×2 上限 30s);>6 次 → state=error

  // —— 其余 BackendAdapter 接口 ——
  // Task 4 实现:connect/disconnect/sendMessage(WS text+pending ack)/cancelGeneration(WS interrupt)/subscribe
  // Task 5 实现:listConversations/getConversation/getConversationMessages/createConversation/renameConversation/deleteConversation/activateConversation(REST)
  // 非目标 stub(抛 NOT_IMPLEMENTED):getMessageContext/listModelProfiles/testModelProfile/activateModelProfile/queryChatHistory/startVoiceInput/stopVoiceInput/startDictation/stopDictation/submitToolResult
}
```

**Task 4 前置（错误码扩展）**：`src/shared/errors/index.ts` 枚举追加 `TIMEOUT`/`NOT_FOUND`/`AUTHENTICATION_FAILED`（spec §10 B-G6），与 Task 4 同 commit。

**注**：`RealBackend` 完整实现需覆盖 spec §5.3（WS 部分）；`implements BackendAdapter` 要求所有接口方法存在——Task 4 先实现 WS 相关（connect/disconnect/sendMessage/cancelGeneration/subscribe），其余抛 `NOT_IMPLEMENTED` 占位，Task 5 实现 REST 会话/历史方法。

- [ ] **Step 3: 验证**

Run: `pnpm test -- tests/unit/real-backend.spec.ts`、`pnpm typecheck`、`pnpm lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/transport/real-backend.ts tests/unit/real-backend.spec.ts src/shared/errors/index.ts
git commit -m "feat(阶段2块B): RealBackend WS 连接生命周期(握手/帧分派/回放/重连/ack) + 错误码扩展"
```

---

### Task 5: RealBackend REST 方法 + 收尾验证

**Files:**
- Modify: `src/main/transport/real-backend.ts`（REST 方法：list/get/messages/create/rename/delete/activate + Bearer）
- Modify: `tests/unit/real-backend.spec.ts`（REST 部分：`fetchImpl` mock）

**Interfaces:**
- Consumes: `RestMapper`（Task 2）、`RestParser`（Task 1）。
- Produces：`RealBackend` 完整 `BackendAdapter`（除阶段 3+ 的 NOT_IMPLEMENTED）。

- [ ] **Step 1: 写失败测试** —— 扩展 `tests/unit/real-backend.spec.ts`（REST 部分）

```typescript
const fakeWs = () => ({ on: () => {}, send: () => {}, close: () => {}, readyState: 0 })

describe('RealBackend REST 方法', () => {
  function mockFetch(responses: Record<string, unknown>): { fetchImpl: typeof fetch; calls: { url: string; opts: RequestInit }[] } {
    const calls: { url: string; opts: RequestInit }[] = []
    const fetchImpl = async (url: string | URL | Request, opts?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, opts: opts ?? {} })
      const key = Object.keys(responses).find((k) => u.includes(k))
      if (!key) throw new Error(`no mock for ${u}`)
      return new Response(JSON.stringify(responses[key]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return { fetchImpl, calls }
  }

  it('listConversations 透传 limit/cursor + Bearer + 映射', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/sessions': { sessions: [{ conversationId: 'conv-1', title: 't', messageCount: 1, updatedAt: '2026-08-11T00:00:00.000Z', active: true }], has_more: false }
    })
    const b = new RealBackend({ fetchImpl, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.setToken('sk-token')
    const page = await b.listConversations({ limit: 20 })
    expect(page.items[0]?.id).toBe('conv-1')
    expect(calls[0]?.url).toContain('/api/sessions')
    expect(calls[0]?.url).toContain('limit=20')
    expect((calls[0]?.opts.headers as Record<string, string>).authorization).toBe('Bearer sk-token')
  })

  it('getConversationMessages 透传 before + 400 CONTRACT_VALIDATION → CyreneError', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/sessions/conv-1/messages': { messages: [], has_more: false, total: 0 }
    })
    const b = new RealBackend({ fetchImpl, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.setToken('sk-token')
    const page = await b.getConversationMessages({ conversationId: 'conv-1', before: '507f1f77bcf86cd799439011' })
    expect(calls[0]?.url).toContain('before=507f1f77bcf86cd799439011')
    expect(page.hasMore).toBe(false)

    const badFetch = async () => new Response(JSON.stringify({ code: 'CONTRACT_VALIDATION', message: '非法游标' }), { status: 400 })
    const b2 = new RealBackend({ fetchImpl: badFetch as never, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b2.setToken('t')
    await expect(b2.getConversationMessages({ conversationId: 'c', before: 'bad' })).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
  })

  it('getConversationMessages 透传 after/limit', async () => {
    const { fetchImpl, calls } = mockFetch({ '/api/sessions/conv-1/messages': { messages: [], has_more: false, total: 0 } })
    const b = new RealBackend({ fetchImpl, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.setToken('t')
    await b.getConversationMessages({ conversationId: 'conv-1', after: '507f1f77bcf86cd799439011', limit: 50 })
    expect(calls[0]?.url).toContain('after=507f1f77bcf86cd799439011')
    expect(calls[0]?.url).toContain('limit=50')
  })

  it('activateConversation → REST activate + WS activate_session', async () => {
    const { fetchImpl, calls } = mockFetch({ '/activate': { activeConversationId: 'conv-2' } })
    const b = new RealBackend({ fetchImpl, now: () => Date.now(), wsFactory: () => fakeWs() })
    await b.setToken('sk-token')
    const r = await b.activateConversation('conv-2')
    expect(r.conversationId).toBe('conv-2')
    expect(calls[0]?.url).toContain('/api/sessions/conv-2/activate')
  })
})
```

**注**：`fakeWs()` 已在测试顶部定义（无操作 ws mock，REST 用例不需真实连接）；`setToken` 为 RealBackend 辅助方法（Task 4 已有）。REST 方法经 `fetchImpl`，url 用 `{serverUrl}/api/...`（serverUrl 尾斜杠剥除），headers 注入 `Authorization: Bearer <token>`（spec P2-1）。activateConversation 在**未连接**时只做 REST activate（WS activate_session 仅在 connected 时发送，见实现）。

- [ ] **Step 2: 实现 REST 方法**（`real-backend.ts` 追加）

```typescript
private token = ''
async setToken(token: string): Promise<void> { this.token = token }

private async restFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${(this.serverUrl ?? '').replace(/\/$/, '')}${path}`
  const res = await (this.options.fetchImpl ?? fetch)(url, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const code = (body as { code?: string }).code ?? 'HTTP_ERROR'
    throw new CyreneError(mapHttpError(res.status, code), (body as { message?: string }).message ?? `HTTP ${res.status}`, body)
  }
  return res
}

async listConversations(input: PageQuery): Promise<Page<Conversation>> {
  const q = new URLSearchParams()
  if (input.cursor) q.set('cursor', input.cursor)
  if (input.limit) q.set('limit', String(input.limit))
  const res = await this.restFetch(`/api/sessions${q.size ? `?${q}` : ''}`)
  const parsed = parseRestSessions(await res.json())
  if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '会话列表响应校验失败')
  return { items: parsed.data.sessions.map((s) => this.restMapper.toConversation(s)), hasMore: parsed.data.has_more, nextCursor: parsed.data.cursor }
}
// getConversation / getConversationMessages / createConversation / renameConversation / deleteConversation / activateConversation
//   均按 spec §5.3 REST 方法表实现;getConversationMessages 用 ConversationMessagesQuery 拼 before/after/limit;
//   activateConversation:REST POST /activate → {conversationId: activeConversationId} + 发起 WS activate_session
// 错误映射 mapHttpError:400 CONTRACT_VALIDATION → INVALID_INPUT;401/403 → AUTHENTICATION_FAILED;404 → NOT_FOUND;其余 → UNKNOWN(枚举已 Task 4 扩展)
```

**注**：`RestMapper` 在 `RealBackend` 内实例化（`restMapper` 字段）；REST 方法与 WS 方法共用 serverUrl/token。

- [ ] **Step 3: 块收尾验证**

Run: `pnpm test`（全量）、`pnpm typecheck`、`pnpm lint`、`pnpm build`
Expected: 全绿；既有 231 + 本块新增（rest-schemas ~7 + rest-mapper ~8 + raw ack/error ~4 + real-backend ~8 ≈ 27+）

- [ ] **Step 4: Commit**

```bash
git add src/main/transport/real-backend.ts tests/unit/real-backend.spec.ts
git commit -m "feat(阶段2块B): RealBackend REST 方法(会话/历史/激活 + Bearer + 错误映射)"
```

---

## 完成定义（所有任务完成后验证）

Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`
Expected: 全绿。

对照 spec §8 验收：
1. `real-backend.ts` 实现 `BackendAdapter`（含新方法）；`ws` 依赖落地；
2. 握手 header 精确 + `server_info.protocol_version !== "2.0"` → `PROTOCOL_MISMATCH`；
3. `session` 缓冲/归属、`server_info` 元数据、`expression` 忽略；connectionId 不当 conversationId；
4. 事件推送经 `parseRawFrame → FrameMapper → subscribe`；坏帧不 kill 连接；
5. REST 会话/历史 + `_id` cursor 分页 + 畸形游标 400 → `CyreneError`；
6. `text`+ack（accepted/rejected/超时）、`interrupt`；`error` 帧 → onError；
7. 断线重连退避 + unexpected-response fail-fast；
8. rest-schemas/rest-mapper/real-backend 三套单测全绿；既有 231 不回归；
9. 标「已开发、未联调」；doc 16 勾选；docs/18 阶段 B 标注。

## 风险提示（执行时注意）

- **测试注入接口**：`real-backend.spec` 用真实 `ws` 伪后端（beforeAll 起本地 `WebSocketServer`）；`unexpected-response`/旧版本用例可走独立端口或 `wsFactory` mock——选择可实现且断言明确的方式，不要留「无法实现」的用例。
- **`restFetch` 的 `serverUrl`**：connect 前 REST 方法可能被调用（2C 先 listConversations 再 connect?）——本块按「先 connect 后 REST」约定，`serverUrl` 存自 connect；若 2C 需先 list，可在 `RealBackend` 构造时接受 serverUrl（见 §10 记录）。
- **FrameMapper 连接上下文**：每个 `connect` 新建 `FrameMapper`（`connectionId` 注入），`handleSession` 解析后 `setActiveConversationId`（供缺 conversationId 的 generation 帧补齐）。
- **契约漂移**：以 `/home/yomu/elysia-agent` 当前契约为准；manifest/断言与 spec §1.1 一致。
