# 二次真实联调整改：Renderer 水合 + replay 身份防御 + 取消码统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**基线 HEAD：** `main@db6d127`（二次联调清单前端基线）。

**Goal:** 关闭二次真实联调三个前端问题：FE-INT2-P0-01（Renderer reload 不水合 Main 状态）、FE-INT2-P1-01（replay fallback 身份碰撞）、FE-INT2-P1-02（取消码不一致）。

**Architecture:** 新增 `renderer/src/bootstrap.ts`（`createRendererBootstrap(api, stores).register()`：统一 `applyChatState` 编排 + 启动 snapshot 水合 + 启动代次 epoch 守卫；给 `DesktopApiLike` 补 `onChatError`）；`RawSessionMessageItemSchema` 收紧 `message_id/timestamp` 必填（+ 同步收紧 `RawSessionMessageItem`/`MessageSource` TS 类型，移除 `rest-mapper` 共享 fallback，新增 tool replay fixture）；`message.store` 的 `failAssistant` 以 `isCancellationCode`（`GENERATION_CANCELLED`+legacy `CANCELLED`）统一取消终态，`chat-cancelled.jsonl` 更新为真实码。

**Tech Stack:** Electron main（Node）+ renderer（Vue/Pinia）+ TypeScript + zod v4 + vitest（node 环境）。

## Global Constraints

- D1（决策）：启动代次 epoch 守卫（前端侧，**不改 `ConnectionState` 契约**）。
- D2（决策）：replay 身份严格契约——`RawSessionMessageItem` 对持久化消息要求非空 `message_id/timestamp`（zod + TS 类型同步）；无身份项使 session 帧 parse 失败 → `RAW_FRAME_INVALID` 协议错误（replay 不进 store，REST 首屏恢复）；移除 `${convId}:replay` 共享 fallback；**不造随机 ID**。
- D3（决策）：`GENERATION_CANCELLED` 为正式取消码 + legacy `CANCELLED` helper；取消终态 interrupted + 不设 `lastError` + 保留 partial + 迟到事件不复活；不要求后端改码。
- `DesktopApiLike` 补 `onChatError(handler: (err: PublicError) => void): () => void`（窄接口，store 只消费窄面）。
- bootstrap 是依赖注入纯模块（可 node 单测，非孤立 `refreshState()`）。
- `chat-cancelled.jsonl` 只改 code 字符串 → `schemaHash` 不变（`generation.failed.code` 是任意 string）；`verified:false` + `backendCommit:"unverified"` 保持。
- 新增 fixture（tool replay）只含合法帧，入 `NEW_FIXTURES` + `replayFixtures`。
- 新增/修改测试只落 `tests/unit/`；文档语言中文；保留「已开发、未联调」。

---

### Task 1: FE-INT2-P0-01 Renderer bootstrap 水合编排（D1）

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`
- Create: `apps/desktop/src/renderer/src/bootstrap.ts`
- Modify: `apps/desktop/src/renderer/src/main.ts`
- Modify: `apps/desktop/tests/unit/connection.store.spec.ts`、`conversation.store.spec.ts`、`message.store.spec.ts`（mockApi 补 onChatError）
- Test: `apps/desktop/tests/unit/renderer-bootstrap.spec.ts`（新）

**Interfaces:**
- Produces（T2/T3 不消费，仅渲染端装配）: `createRendererBootstrap(api: DesktopApiLike, stores: BootstrapStores): { register(): void }`
- Consumes: `DesktopApiLike`（补 `onChatError`）、`ConnectionState`、`PublicError`。

- [ ] **Step 1: 写失败测试**——`tests/unit/renderer-bootstrap.spec.ts`（新）：

```ts
// tests/unit/renderer-bootstrap.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createRendererBootstrap } from '../../src/renderer/src/bootstrap'
import type { ConnectionState } from '@shared/contracts'

function makeFake() {
  const stateHandlers: Array<(s: ConnectionState) => void> = []
  let resolveSnapshot: ((s: ConnectionState) => void) | undefined
  let rejectSnapshot: ((e: Error) => void) | undefined
  const api = {
    onChatEvent: vi.fn(() => () => {}),
    onChatState: vi.fn((h: (s: ConnectionState) => void) => { stateHandlers.push(h); return () => {} }),
    onChatReplay: vi.fn(() => () => {}),
    onChatError: vi.fn(() => () => {}),
    getConnectionState: vi.fn(() => new Promise<ConnectionState>((res, rej) => { resolveSnapshot = res; rejectSnapshot = rej })),
    fireState: (s: ConnectionState) => stateHandlers.forEach((h) => h(s)),
    resolveSnapshot: (s: ConnectionState) => resolveSnapshot?.(s),
    rejectSnapshot: (e: Error) => rejectSnapshot?.(e)
  }
  return api
}
function makeStores() {
  return {
    connection: { setState: vi.fn(), setError: vi.fn() },
    message: { applyEvent: vi.fn(), handleConnectionStateChange: vi.fn(), loadReplay: vi.fn() },
    conversation: { onConnected: vi.fn(async () => {}), onActiveConversationAppeared: vi.fn(async () => {}) }
  }
}

describe('createRendererBootstrap（P0-01 水合编排）', () => {
  it('register 注册 4 订阅（onChatEvent/onChatState/onChatReplay/onChatError）', () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    expect(api.onChatEvent).toHaveBeenCalled()
    expect(api.onChatState).toHaveBeenCalled()
    expect(api.onChatReplay).toHaveBeenCalled()
    expect(api.onChatError).toHaveBeenCalled()
  })
  it('connected snapshot → applyChatState 完整编排（setState+handleConnectionStateChange+onConnected+onActiveConversationAppeared）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.resolveSnapshot({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    await Promise.resolve()
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'connected', connectionId: 'c1', activeConversationId: 'conv1' })
    expect(stores.message.handleConnectionStateChange).toHaveBeenCalled()
    expect(stores.conversation.onConnected).toHaveBeenCalledWith('c1')
    expect(stores.conversation.onActiveConversationAppeared).toHaveBeenCalledWith('conv1')
  })
  it('disconnected snapshot → 不触发 onConnected/onActiveConversationAppeared（不制造假 connected）', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.resolveSnapshot({ status: 'disconnected' })
    await Promise.resolve()
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'disconnected' })
    expect(stores.conversation.onConnected).not.toHaveBeenCalled()
    expect(stores.conversation.onActiveConversationAppeared).not.toHaveBeenCalled()
  })
  it('启动代次守卫：snapshot 等待期间收到 push → 迟到 snapshot 丢弃', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.fireState({ status: 'connected', connectionId: 'c2', activeConversationId: 'conv2' }) // push 先到
    api.resolveSnapshot({ status: 'disconnected' }) // 迟到旧 snapshot
    await Promise.resolve()
    // 只应用了 push 的 connected；迟到 snapshot 被丢弃
    expect(stores.connection.setState).toHaveBeenCalledTimes(1)
    expect(stores.connection.setState).toHaveBeenCalledWith({ status: 'connected', connectionId: 'c2', activeConversationId: 'conv2' })
  })
  it('snapshot 拒绝 → setError(UNKNOWN) 且不调用 disconnect', async () => {
    const api = makeFake(); const stores = makeStores()
    createRendererBootstrap(api as never, stores as never).register()
    api.rejectSnapshot(new Error('ipc failed'))
    await new Promise((r) => setTimeout(r, 0)) // .then().catch() 链需 2 个微任务冲刷（实测 1 次 flush 不够）
    expect(stores.connection.setError).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNKNOWN' }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/renderer-bootstrap.spec.ts`
Expected: 任务失败——`../../src/renderer/src/bootstrap` 不存在 → import 报错。

- [ ] **Step 3: 实现**

`desktop-api.types.ts`：`DesktopApiLike` 加 `onChatError`（补 `import type { PublicError } from '../utils/public-error'`）：
```ts
  onChatEvent(handler: (event: BackendEvent) => void): () => void
  onChatState(handler: (state: ConnectionState) => void): () => void
  onChatReplay(handler: (payload: { conversationId: string; messages: Message[] }) => void): () => void
  onChatError(handler: (err: PublicError) => void): () => void // P0-01:bootstrap 需消费 Main 错误推送
```

`src/renderer/src/bootstrap.ts`（依赖注入，与 spec §4.1 逐字一致）：
```ts
// src/renderer/src/bootstrap.ts
// P0-01:Renderer 启动水合编排——push 与启动 snapshot 用同一 applyChatState 消费;
// 启动代次守卫(epoch)防迟到 snapshot 覆盖已收到的新 push(D1,不改 ConnectionState 契约)。
import type { ConnectionState } from '@shared/contracts'
import type { PublicError } from './utils/public-error'
import type { DesktopApiLike } from './stores/desktop-api.types'

export interface BootstrapStores {
  connection: { setState(s: ConnectionState): void; setError(e: PublicError): void }
  message: { applyEvent(e: unknown): void; handleConnectionStateChange(s: ConnectionState): void; loadReplay(conversationId: string, messages: unknown[]): void }
  conversation: { onConnected(connectionId?: string): Promise<void>; onActiveConversationAppeared(activeId: string): Promise<void> }
}

export function createRendererBootstrap(api: DesktopApiLike, stores: BootstrapStores): { register(): void } {
  let stateEpoch = 0
  const applyChatState = (s: ConnectionState): void => {
    stores.connection.setState(s)
    stores.message.handleConnectionStateChange(s)
    if (s.status === 'connected') {
      void stores.conversation.onConnected(s.connectionId)
      if (s.activeConversationId) void stores.conversation.onActiveConversationAppeared(s.activeConversationId)
    }
  }
  const register = (): void => {
    api.onChatEvent((e) => stores.message.applyEvent(e))
    api.onChatState((s) => { stateEpoch++; applyChatState(s) })
    api.onChatReplay(({ conversationId, messages }) => stores.message.loadReplay(conversationId, messages))
    api.onChatError((err) => stores.connection.setError(err))
    // 启动 snapshot 水合：先注册订阅（epoch 从 0 起），再拉当前状态；epoch 变化即期间收到 push → 丢弃迟到 snapshot
    const captured = stateEpoch
    void api.getConnectionState().then((snapshot) => {
      if (stateEpoch === captured) applyChatState(snapshot)
    }).catch((e) => {
      stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
      // snapshot 失败进公开错误/诊断路径，不清凭据、不制造断开（清单 §4.3 #4）
    })
  }
  return { register }
}
```

`main.ts` 重构（`if (window.desktopApi)` 块内）：
```ts
if (window.desktopApi) {
  setDesktopApi(window.desktopApi)
  createRendererBootstrap(window.desktopApi, {
    connection: useConnectionStore(),
    message: useMessageStore(),
    conversation: useConversationStore()
  }).register()
}
```
（import `createRendererBootstrap`；原 4 条内联订阅代码删除。）

**既有 store spec 的 mockApi 补 onChatError**（`DesktopApiLike.onChatError` 为必填后，三处 `setDesktopApi(mockApi)` 缺该字段 → TS2345，须补）：
```ts
// connection.store.spec.ts / conversation.store.spec.ts / message.store.spec.ts 的 mockApi 各加一行：
    onChatError: vi.fn(() => () => {}),
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm -F @cyrene/desktop test tests/unit/renderer-bootstrap.spec.ts` + `pnpm -F @cyrene/desktop typecheck`
Expected: 全绿（5 用例）；typecheck node+web 绿（`window.desktopApi` 到 `DesktopApiLike` 结构化赋值、onChatError 兼容）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/desktop-api.types.ts apps/desktop/src/renderer/src/bootstrap.ts apps/desktop/src/renderer/src/main.ts apps/desktop/tests/unit/connection.store.spec.ts apps/desktop/tests/unit/conversation.store.spec.ts apps/desktop/tests/unit/message.store.spec.ts apps/desktop/tests/unit/renderer-bootstrap.spec.ts
git commit -m "fix(二次真实联调整改 T1): Renderer bootstrap 水合编排+启动代次守卫(P0-01)"
```

---

### Task 2: FE-INT2-P1-01 replay 身份契约防御（D2）

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-types.ts`
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`
- Create: `apps/desktop/src/main/fixtures/wire-v2/chat-replay-tool.jsonl` + `chat-replay-tool.manifest.json`
- Modify: `apps/desktop/tests/unit/wire-fixtures.spec.ts`
- Test: `apps/desktop/tests/unit/raw-schemas.spec.ts`、`apps/desktop/tests/unit/rest-mapper.spec.ts`、`apps/desktop/tests/unit/message.store.spec.ts`、`apps/desktop/tests/unit/wire-fixtures.spec.ts`

**Interfaces:**
- Produces: `RawSessionMessageItem` 的 `message_id`/`timestamp` 必填；`RawFrame` 不变（13 型）；`MessageSource.message_id: string`。
- Consumes: 无（独立）。

- [ ] **Step 1: 写失败测试**——`raw-schemas.spec.ts` 追加：
```ts
it('session item 缺 message_id/timestamp → 帧校验失败（D2 契约收紧）', () => {
  expect(parseRawFrame({ type: 'session', messages: [{ role: 'tool', message_id: 'm1', timestamp: 't' }] }).success).toBe(true)
  expect(parseRawFrame({ type: 'session', messages: [{ role: 'tool', timestamp: 't' }] }).success).toBe(false) // 缺 message_id
  expect(parseRawFrame({ type: 'session', messages: [{ role: 'tool', message_id: 'm1' }] }).success).toBe(false) // 缺 timestamp
})
```

`rest-mapper.spec.ts` 追加（`assemble` 是 private 单条方法——用公开 `toDomainMessageFromReplay(item, convId)` 逐条映射；输入 `RawSessionMessageItem` 带正式 ID）：
```ts
it('session tool item 不再产出共享 ${convId}:replay 主键（D2）', () => {
  const items = [
    { role: 'user', message_id: 'msg_u', timestamp: 't0', content: 'hi' },
    { role: 'tool', message_id: 'msg_t1', timestamp: 't1', tool_call_id: 'call_1', name: 'get_time', content: 'x', success: true },
    { role: 'tool', message_id: 'msg_t2', timestamp: 't2', tool_call_id: 'call_2', name: 'get_time', content: 'y', success: true }
  ]
  const out = items.map((m) => mapper.toDomainMessageFromReplay(m as never, 'conv-1'))
  expect(out).toHaveLength(3)
  expect(out.map((m) => m.messageId)).toEqual(['msg_u', 'msg_t1', 'msg_t2']) // 两个正式不同 msg_* ID
  expect(out.some((m) => m.messageId === 'conv-1:replay')).toBe(false)
})
```
（`mapper` 为 rest-mapper.spec 既有夹具实例；`toDomainMessageFromReplay` 输入按 `RawSessionMessageItem` 类型，`as never` 或字面量符合 TS。）

`message.store.spec.ts` 追加（replay/REST 同 ID 两种顺序去重 + 不同 tool_call_id 不碰撞，§4.2 验收）：
```ts
it('replay 与 REST 相同 messageId 两种到达顺序 → store 只有一条（byId 去重）', async () => {
  // 场景 A：先 loadReplay([{messageId:'msg_t1',...}]) 再经 REST 到达同 messageId → 仍一条
  // 场景 B：先 REST 后 loadReplay 同 messageId → 仍一条（实现者按 message.store.spec 现有 loadReplay/REST 注入模式构造）
})
it('两条不同 tool_call_id 不碰撞（各自独立 messageId）', async () => {
  // 两条 tool 消息 messageId 分别为 msg_t1/msg_t2 → byId 两条，不覆盖
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/raw-schemas.spec.ts tests/unit/rest-mapper.spec.ts tests/unit/message.store.spec.ts`
Expected: raw-schemas 新用例红（当前 optional 接受缺身份）；rest-mapper 新用例红（当前产出 `conv-1:replay`）；message.store 去重用例红（当前共享 fallback 碰撞/重复）。

- [ ] **Step 3: 实现**

`raw-schemas.ts` `RawSessionMessageItemSchema`（`:27-45`）收紧：
```ts
const RawSessionMessageItemSchema = z.object({
  role: z.string().min(1),
  message_id: z.string().min(1),  // D2:持久化消息要求非空身份(§5.4 #1)
  timestamp: z.string().min(1),
  parts: z.array(z.unknown()).optional(),
  ...
}).strict()
```

`raw-types.ts` `RawSessionMessageItem`（`:28-47`）同步：
```ts
export interface RawSessionMessageItem {
  role: string
  message_id: string // D2:持久化消息要求非空身份
  timestamp: string
  ...
}
```

`rest-mapper.ts`：`MessageSource`（`:12`）`message_id?: string` → `message_id: string`；`:49` 移除 fallback：
```ts
      messageId: src.message_id, // D2:正式 v2 路径不设 fallback——身份缺失已在 schema 层拒帧(§5.4 #3)
```

`src/main/fixtures/wire-v2/chat-replay-tool.jsonl`（真实后端 tool replay 形状，全部带正式 ID + timestamp；**必须单行 JSON**——`readLines` 按 `\n` 切行逐条 parse）：
```text
{"type":"session","conversationId":"conv-tool-replay","messages":[{"role":"user","message_id":"msg_u1","timestamp":"2026-08-13T13:15:30.000Z","content":"现在几点","content_type":{"text":[1]}},{"role":"assistant","message_id":"msg_a1","timestamp":"2026-08-13T13:15:31.000Z","content":"","tool_calls":[{"id":"call_1","name":"get_time","arguments":"{}"}]},{"role":"tool","message_id":"msg_t1","timestamp":"2026-08-13T13:15:31.500Z","tool_call_id":"call_1","name":"get_time","content":"2026-08-13 21:15:31 CST","success":true},{"role":"assistant","message_id":"msg_a2","timestamp":"2026-08-13T13:15:32.000Z","content":"当前时间 2026-08-13 21:15:31","content_type":{"text":[1]}}]}
```
`chat-replay-tool.manifest.json`：
```json
{ "backendCommit": "unverified", "protocol": "2", "serverProtocolVersion": "2.0", "schemaHash": "<既有指纹 96fc24c8...>", "verified": false, "scenario": "chat-replay-tool" }
```
（schemaHash = 当前 `rawSchemasFingerprint()`——D2 收紧不改变指纹，见 spec §6；实现者运行 `pnpm -F @cyrene/desktop test tests/unit/wire-fixtures.spec.ts` 确认门禁，若指纹与 96fc24c8 不符以实际为准。）

`wire-fixtures.spec.ts`：`NEW_FIXTURES` 加 `'chat-replay-tool.jsonl'`；`replayFixtures` 加 `'chat-replay-tool.jsonl'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/raw-schemas.spec.ts tests/unit/rest-mapper.spec.ts tests/unit/message.store.spec.ts tests/unit/wire-fixtures.spec.ts`
Expected: 全绿（含新 fixture 三层门禁 + replay 映射 + 去重）；`pnpm -F @cyrene/desktop check:contract` 13/13 不回归。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts apps/desktop/src/main/transport/protocol-v2/raw-types.ts apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts apps/desktop/src/main/fixtures/wire-v2/chat-replay-tool.jsonl apps/desktop/src/main/fixtures/wire-v2/chat-replay-tool.manifest.json apps/desktop/tests/unit/raw-schemas.spec.ts apps/desktop/tests/unit/rest-mapper.spec.ts apps/desktop/tests/unit/message.store.spec.ts apps/desktop/tests/unit/wire-fixtures.spec.ts
git commit -m "fix(二次真实联调整改 T2): replay 身份契约收紧+移除共享 fallback+tool replay fixture(P1-01)"
```

---

### Task 3: FE-INT2-P1-02 取消码统一（D3）

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`
- Modify: `apps/desktop/src/main/fixtures/wire-v2/chat-cancelled.jsonl`
- Test: `apps/desktop/tests/unit/message.store.spec.ts`

**Interfaces:**
- Produces: `export function isCancellationCode(code: string | undefined): boolean`
- Consumes: 无。

- [ ] **Step 1: 写失败测试**——`message.store.spec.ts` 追加（沿用现有 store 测试夹具 `setActivePinia`/`setDesktopApi(mockApi)`/mock event）：
```ts
it('generation.failed{code:GENERATION_CANCELLED} → interrupted + 无 lastError（D3 正式码）', async () => {
  // 构造 started + delta + failed(GENERATION_CANCELLED) 事件序列，断言消息 status interrupted、lastError 未设
})
it('failed 在 cancel IPC resolve 前到达（交错时序）→ 最终仍 interrupted + 无 lastError', async () => {
  // 不先走乐观 cancel；直接 failed(GENERATION_CANCELLED) → interrupted
})
it('本地乐观 cancel 先完成、failed 后到 → 状态不变 + 无错误横幅', async () => {
  // cancel() 乐观 interrupted → 迟到 failed(GENERATION_CANCELLED) 被 activeGenerationId 守卫丢弃
})
it('已收 partial segments 取消后保留', async () => {
  // started + delta(部分内容) → failed(GENERATION_CANCELLED) → assistantSegments 仍含已收段
})
it('迟到 completed 不把 interrupted 改回 completed', async () => {
  // failed(GENERATION_CANCELLED) → interrupted → 迟到 generation.completed 被守卫丢弃
})
it('legacy code CANCELLED 仍识别（helper 兼容）', async () => {
  // failed(CANCELLED) → interrupted
})
it('非取消错误 GENERATION_TIMEOUT → failed + lastError', async () => {
  // failed(GENERATION_TIMEOUT) → failed + lastError 设置
})
```
（实现者按 message.store.spec 既有事件构造模式写具体断言；参考 `failAssistant` 现有 `BACKEND_REJECTED → failed` 用例的构造。交错时序用例的 cancel promise `resolve` 声明 `(v?: unknown) => void` 且 `new Promise((res) => ...)` 不带泛型，避免 strictFunctionTypes TS2322。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/message.store.spec.ts`
Expected: GENERATION_CANCELLED 用例红（当前只认 CANCELLED → failed + lastError）。

- [ ] **Step 3: 实现**

`message.store.ts` 新增 helper（模块内或导出）：
```ts
/** 正式取消码 GENERATION_CANCELLED + legacy CANCELLED 兼容（D3，二次联调 §6.3） */
export function isCancellationCode(code: string | undefined): boolean {
  return code === 'GENERATION_CANCELLED' || code === 'CANCELLED'
}
```
`failAssistant` 重构（原 `:89-94`；**`byId` 是 `ref<Record<string, Message>>` 普通对象，用 `byId.value[messageId]` 非 `.get()`**）：
```ts
  function failAssistant(messageId: string, event: Extract<BackendEvent, { event: 'generation.failed' }>): void {
    const m = byId.value[messageId]
    if (!m || m.role !== 'assistant') return
    if (isCancellationCode(event.error.code)) {
      m.status = 'interrupted' // 取消终态：interrupted（不降级 failed）
      // 不设 lastError：用户主动取消不展示「发送失败」（§6.2 UX 不一致，D3）
    } else {
      m.status = 'failed'
      lastError.value = { code: event.error.code, message: event.error.message, backendCode: event.error.code, retryable: event.error.retryable }
    }
    activeGenerationId.value = undefined
  }
```
（`activeGenerationId` 清理在 failAssistant 内 guard 后；**`applyEvent` 的 failed 分支 :162 现有清理保留**作双保险——语义与现状一致，不删。）

`chat-cancelled.jsonl` 第 4 行：`"code":"CANCELLED"` → `"code":"GENERATION_CANCELLED"`（其余字段不变；manifest 不动——schemaHash 未变、verified:false 保持）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/message.store.spec.ts tests/unit/wire-fixtures.spec.ts`
Expected: 全绿（新增 4 用例 + 既有不回归；wire-fixtures 的 chat-cancelled accumulator 断言 `failed` 状态不区分取消码仍绿）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/message.store.ts apps/desktop/src/main/fixtures/wire-v2/chat-cancelled.jsonl apps/desktop/tests/unit/message.store.spec.ts
git commit -m "fix(二次真实联调整改 T3): 取消码统一 GENERATION_CANCELLED+取消终态不设 lastError+fixture 更新(P1-02)"
```

---

### Task 4: 全量门禁确认（无代码）

- [ ] **Step 1: 跑全部门禁**

Run: `pnpm -F @cyrene/desktop typecheck`、`pnpm -F @cyrene/desktop lint`、`pnpm -F @cyrene/desktop test`、`xvfb-run -a pnpm -F @cyrene/desktop test:integration`、`pnpm -F @cyrene/desktop build`、`pnpm -F @cyrene/desktop check:contract`、`pnpm -F @cyrene/desktop package`、`xvfb-run -a pnpm -F @cyrene/desktop verify:artifact -- --smoke`
Expected: 全部绿；单测 ≥ 515（本批新增约 5+，HEAD 基线 510）；集成 23 不回归；check:contract 13/13；package + smoke 通过（本批动 renderer bootstrap + main，须复跑打包路径）。

- [ ] **Step 2: 确认无代码变更 + 记录 B-01 复跑项**

Run: `git status --short`
Expected: 无本任务产生的改动；不 commit。**将 B-01 最小复跑全 10 项（清单 §8）记录进控制器最终报告**：①SHA 冻结 ②连接确认 ③纯文本 ④两次工具 ⑤reload 恢复 ⑥replay-REST 同 ID ⑦每 callId 一条 ⑧取消 GENERATION_CANCELLED ⑨旧 default ⑩诊断无错误。**另记录过渡期降级**：后端配套清单未落地时（session replay tool item 仍缺 ID），整帧拒绝使 `activeConversationId` 失去 WS 来源 → 过渡期**首次连接**的活动会话需用户点击激活（重连/已激活场景不受影响）；B-01 复跑 ⑤reload 恢复与 ⑥replay-REST 同 ID 依赖后端修复先落地。

---

## 自审（对照 spec）

- §4.1 bootstrap（DesktopApiLike+onChatError、createRendererBootstrap DI、applyChatState 统一编排、epoch 守卫、snapshot 失败进公开错误）→ T1。
- §4.2 replay 身份（schema 收紧 message_id/timestamp 必填、TS 类型同步 RawSessionMessageItem/MessageSource、rest-mapper 移除 fallback、REST 首屏恢复、tool replay fixture、两种到达顺序去重）→ T2。
- §4.3 取消码（isCancellationCode 正式+legacy、failAssistant 取消终态 interrupted+无 lastError+保留 partial、fixture 更新 GENERATION_CANCELLED、断言同步）→ T3。
- §5 门禁（typecheck/lint/515+ 单测/23+ 集成/build/contract 13/13/package/smoke + B-01 复跑 10 项）→ T4。
- 已知限制（B-01 复跑 headless、指纹不下探嵌套元素、replay 严格契约过渡期、工具卡片留阶段 3、fixture 非逐字捕获）→ T4 记录 + 控制器最终报告。

> **注**：文档状态同步（README/CLAUDE/docs16 二次联调整改批次 + 测试数字）由控制器在实施后执行；最终报告 + 验收按二次联调清单 §4.4/§5.5/§6.4/§8 逐项回报。
