# 阶段 2 块 C：Store + IPC 事件推送 + 聊天 UI 纵向闭环 —— 实施计划

**日期：** 2026-08-11
**执行方式：** TDD，subagent 逐任务执行，每任务独立 commit。
**依据：** [spec](../specs/2026-08-11-phase2-store-ui-design.md)（已 code-review 干净，commit `19f2ba7`）、[2B plan](2026-08-11-phase2-real-backend.md)（RealBackend/BackendAdapter 已落地）、[2A](2026-08-10-phase2-contract-raw-wire.md)（StreamAccumulator/BackendEvent）

## Goal

打通「发送 → 流式 → 渲染」完整链路：Main 的 IPC 事件桥（`chat:event`/`chat:state`/`chat:replay` 推送 + chat 命令）、preload `desktopApi` 扩展、Renderer 的 Pinia 三 store（connection/conversation/message）+ 聊天/会话 UI 动态化。

## Architecture

`chat-service`（Main，持 BackendAdapter + webContents.send 桥）→ `chat:event`/`chat:state`/`chat:replay` 推送 + `ipcMain.handle` chat 命令 → preload `desktopApi`（信封 + schema 校验）→ Pinia stores（纯消费，messageStore 用 2A StreamAccumulator 应用领域事件）→ `CyChatView`/`CyConversationList`（双通道渲染 + 发送/停止）。

## Tech Stack

TypeScript + Pinia + Vue 3 + zod + vitest + `marked`（Markdown）。

## Global Constraints（subagent 必须遵守，逐条绑定）

1. **信任边界**：Renderer store 纯消费（无 Adapter 逻辑/凭据/文件/网络）；token 不经 Renderer（`chat:connect` 由 Main 读凭据存储）；`onChatEvent` payload 经 `parseBackendEvent` 校验（非法丢弃 + warn，不崩）。
2. **对 2B 加性修改**（spec §1.1）：`ConnectionState`/`ConnectionStatus` 迁 `shared/contracts/backend.ts`（RealBackend 从 shared 导入 + re-export）；`BackendAdapter` 加 `getConnectionState()`；`RealBackendOptions` 加 `onConnectionStateChange`；`MockBackend` 同步 `getConnectionState` + 状态回调。不改 RealBackend 其余逻辑。
3. **推送通道**：`chat:event`（领域 `BackendEvent`）/`chat:state`（`ConnectionState`）/`chat:replay`（`{conversationId, messages: Message[]}`）——独立 `PushChannels` 常量（不入 `IpcChannels` handle 集合，P3-2）；单向 `webContents.send`；chat 命令走 `ipcMain.handle` + `IpcResult` 信封。
4. **desktopApi**：chat 方法签名与 2B `BackendAdapter` 一致；`renameConversation` 单对象载荷 `{conversationId, title}`（registry arity 约束，P2-4）；统一 unwrap 信封辅助（P3-3）；`onChatEvent`/`onChatState`/`onChatReplay` 返回取消函数。
5. **messageStore**：`generationId` 守卫（跨代事件丢弃）；`accumulator.state.messageId` 关联父消息；finalizeAssistant 用 `acc.getState().status`（completed/completing 不硬编码）；**`MessageStatus` 加 `'completing'`**（对 2B 加性修改，Task 1 一并做，P1-5——acc 缺口时 `completing` 保留不完整标注）；乐观发送 `clientMessageId` key + 无 serverMessageId 也 acknowledged；cancel 乐观置 `interrupted`（CANCELLED 幂等）；断线且 in-flight → interrupted。
6. **activate**：`resetConversation(id)` + 拉第一页历史（`loadPage` 去重按 messageId）；`onSessionReplay` 经 `chat:replay` → `loadReplay`（方案 a，P1-3）。
7. **状态推送定死 push**：`chat:state`，不轮询。
8. **Markdown**：`marked` + sanitize（剥离 `<script>`/`on*`），CSP 安全（无 unsafe-eval）。
9. **连接控件**：MockBackend 免 token（`requireToken: false` 注入）；UI 提供 serverUrl 输入 + 连接按钮。
10. 既有 269 单测不回归；`pnpm typecheck`/`lint`/`build` 全过；本块标「已开发、未联调」。

---

### Task 1: 对 2B 加性修改（ConnectionState 迁移 + getConnectionState + 状态回调）

**Files:**
- Modify: `src/shared/contracts/backend.ts`（加 `ConnectionState`/`ConnectionStatus`）
- Modify: `src/shared/contracts/message.ts`（`MessageStatus` 加 `'completing'`，P1-5）
- Modify: `src/main/transport/backend-adapter.ts`（接口加 `getConnectionState`）
- Modify: `src/main/transport/real-backend.ts`（`ConnectionState` 从 shared 导入 + re-export；`RealBackendOptions` 加 `onConnectionStateChange`，状态变化触发；`getConnectionState` 实现已有）
- Modify: `src/main/transport/mock-backend.ts`（加 `getConnectionState` + `onConnectionStateChange` 回调）
- Modify: `tests/unit/real-backend.spec.ts`（不破坏；ConnectionState 类型迁移后仍编译）
- Create: `tests/unit/mock-backend-state.spec.ts`（状态回调测试）

**Interfaces:**
- Produces：`ConnectionState`/`ConnectionStatus` 在 `shared/contracts/backend`；`getConnectionState()` 接口方法；`onConnectionStateChange` 选项。

- [ ] **Step 1: 写失败测试** —— `tests/unit/mock-backend-state.spec.ts`

```typescript
import { describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'

describe('MockBackend 连接状态', () => {
  it('getConnectionState 初始 disconnected,connect 后 connected', async () => {
    const b = new MockBackend()
    expect(b.getConnectionState().status).toBe('disconnected')
    await b.connect({ serverUrl: 'mock://test' })
    expect(b.getConnectionState().status).toBe('connected')
    await b.disconnect()
    expect(b.getConnectionState().status).toBe('disconnected')
  })

  it('connect/disconnect 触发 onConnectionStateChange', async () => {
    const states: string[] = []
    const b = new MockBackend({ onConnectionStateChange: (s) => states.push(s.status) })
    await b.connect({ serverUrl: 'mock://test' })
    await b.disconnect()
    expect(states).toContain('connected')
    expect(states).toContain('disconnected')
  })
})
```
Run: `pnpm test -- tests/unit/mock-backend-state.spec.ts`
Expected: FAIL（无 getConnectionState）

- [ ] **Step 2: 实现**

a) `shared/contracts/backend.ts` 加：
```typescript
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
```
b) `backend-adapter.ts` 接口加 `getConnectionState(): ConnectionState`。
c) `real-backend.ts`：`import type { ConnectionState, ConnectionStatus } from '@shared/contracts/backend'` + `export type { ConnectionState, ConnectionStatus } from '@shared/contracts/backend'`（保持兼容）；`RealBackendOptions` 加 `onConnectionStateChange?: (s: ConnectionState) => void`；所有 `this.state = ...` 赋值点后调 `this.options.onConnectionStateChange?.(this.state)`（封装 `setState(next)` 辅助统一调用）。
d) `mock-backend.ts`：加 `getConnectionState()`（返回 `{status}` 本地状态）+ `onConnectionStateChange` 选项，connect/disconnect 时触发。

- [ ] **Step 3: 验证**

Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`
Expected: PASS（既有 269 不回归 + 新 2 用例）

- [ ] **Step 4: Commit**

```bash
git add src/shared/contracts/backend.ts src/shared/contracts/message.ts src/main/transport/backend-adapter.ts src/main/transport/real-backend.ts src/main/transport/mock-backend.ts tests/unit/mock-backend-state.spec.ts tests/unit/real-backend.spec.ts
git commit -m "feat(阶段2块C): ConnectionState 迁 shared + getConnectionState/状态回调 + MessageStatus.completing(2B 加性修改)"
```

---

### Task 2: IPC 事件通道 + chat-service（Main）

**Files:**
- Create: `src/main/chat/chat-service.ts`
- Create: `src/main/chat/chat-handlers.ts`
- Modify: `src/shared/contracts/ipc.ts`（`PushChannels` 常量 + chat 命令 channel 名）
- Modify: `src/main/ipc/channels.ts`（chat 命令 request schema，R5/P1-4）
- Modify: `src/main/ipc/handlers.ts`（注册 chat handlers）
- Modify: `src/main/index.ts`（装配 chat-service，BackendAdapter 注入）
- Create: `tests/unit/chat-service.spec.ts`

**Interfaces:**
- Consumes: `BackendAdapter`（含 `getConnectionState`）、`ConnectionState`、`parseBackendEvent`（2A）。
- Produces：`createChatService(deps)`、`chat:*` IPC channels、`PushChannels`。

- [ ] **Step 1: 写失败测试** —— `tests/unit/chat-service.spec.ts`

```typescript
import { describe, expect, it, vi } from 'vitest'
import { createChatService } from '../../src/main/chat/chat-service'
import { MockBackend } from '../../src/main/transport/mock-backend'

function makeDeps(overrides: Partial<Parameters<typeof createChatService>[0]> = {}) {
  const adapter = new MockBackend()
  const sent: { channel: string; payload: unknown }[] = []
  const deps = {
    adapter,
    send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
    getToken: () => 'sk-test',
    requireToken: false,   // mock 免 token 演示
    ...overrides
  }
  return { deps, sent }
}

describe('chat-service', () => {
  it('connect 转发 Adapter 并广播连接状态', async () => {
    const { deps, sent } = makeDeps()
    const svc = createChatService(deps)
    const session = await svc.connect({ serverUrl: 'mock://test' })
    expect(session.serverUrl).toBe('mock://test')
    // MockBackend connect 触发 onConnectionStateChange? —— 需 chat-service 在 connect 后主动推一次状态
    // 简化:chat-service 的 connect 调用后调 send('chat:state', adapter.getConnectionState())
    expect(sent.some((s) => s.channel === 'chat:state' && (s.payload as { status: string }).status === 'connected')).toBe(true)
    svc.dispose()
  })

  it('subscribe 的领域事件转发 chat:event', async () => {
    const { deps, sent } = makeDeps()
    const svc = createChatService(deps)
    await svc.connect({ serverUrl: 'mock://test' })
    const ref = await svc.send({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'c1' })
    expect(ref.clientRequestId).toBe('c1')
    await new Promise((r) => setTimeout(r, 35))   // P1-1:MockBackend 回放用 setTimeout 宏任务,须等待再断言
    expect(sent.some((s) => s.channel === 'chat:event')).toBe(true)
    svc.dispose()
  })

  it('connect 缺 token 且 requireToken=true → CREDENTIAL_UNAVAILABLE', async () => {
    const { deps } = makeDeps({ getToken: () => undefined, requireToken: true })
    const svc = createChatService(deps)
    await expect(svc.connect({ serverUrl: 'mock://test' })).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  })
})
```
Run: `pnpm test -- tests/unit/chat-service.spec.ts`
Expected: FAIL（chat-service 不存在）

- [ ] **Step 2: 实现 `chat-service.ts`**（核心）

```typescript
import type { BackendAdapter, BackendSession, Page, PageQuery, ConversationMessagesQuery, MessagePage, ActivateConversationResult, ConnectionState } from '@shared/contracts/backend'
import type { Conversation, CreateConversationInput } from '@shared/contracts/conversation'
import type { BackendEvent } from '@shared/contracts/events'
import type { ClientRequestRef, SendMessageInput } from '@shared/contracts/message'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { PushChannels } from '@shared/contracts/ipc'

export interface ChatServiceDeps {
  adapter: BackendAdapter
  send: (channel: string, payload: unknown) => void   // webContents.send 包装(PushChannels)
  getToken: () => string | undefined | Promise<string | undefined>   // 凭据读取(async;装配用 store.getCredential(key).then(t=>t??undefined),R1)
  requireToken?: boolean
}

export function createChatService(deps: ChatServiceDeps) {
  const { adapter } = deps
  let unsub: (() => void) | undefined
  // 领域事件 → chat:event;连接状态变化 → chat:state(adapter 的 onConnectionStateChange 由调用方传入?见下)
  unsub = adapter.subscribe((event: BackendEvent) => deps.send(PushChannels.event, event))

  const pushState = (s: ConnectionState) => deps.send(PushChannels.state, s)

  return {
    async connect(input: { serverUrl: string }): Promise<BackendSession> {
      let token: string | undefined
      if (deps.requireToken !== false) {
        token = await deps.getToken()
        if (!token) throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '后端 Token 未设置')
      }
      const session = await adapter.connect({ serverUrl: input.serverUrl, token })
      pushState(adapter.getConnectionState())
      return session
    },
    async disconnect(): Promise<void> { await adapter.disconnect(); pushState(adapter.getConnectionState()) },
    listConversations: (input: PageQuery) => adapter.listConversations(input),
    getMessages: (input: ConversationMessagesQuery) => adapter.getConversationMessages(input),
    send: (input: SendMessageInput) => adapter.sendMessage(input),
    cancel: (input: { generationId: string }) => adapter.cancelGeneration(input),
    activate: (id: string) => adapter.activateConversation(id),
    createConversation: (input: CreateConversationInput) => adapter.createConversation(input),
    renameConversation: (input: { conversationId: string; title: string }) => adapter.renameConversation(input.conversationId, input.title),
    deleteConversation: (id: string) => adapter.deleteConversation(id),
    getConnectionState: () => adapter.getConnectionState(),
    /** 连接状态变化主动推送(adapter.onConnectionStateChange 由装配方桥到此处) */
    pushState,
    dispose(): void { unsub?.() }
  }
}
```

**注**：`onConnectionStateChange` 的接线——`RealBackend`/`MockBackend` 构造时传 `onConnectionStateChange: (s) => svc.pushState(s)`。若 adapter 无该选项（如 MockBackend 未配），chat-service 在 connect/disconnect 后主动 `pushState`（已做）。

- [ ] **Step 3: 实现 `chat-handlers.ts` + `ipc.ts` + 装配**

`shared/contracts/ipc.ts` 加：
```typescript
export const PushChannels = { event: 'chat:event', state: 'chat:state', replay: 'chat:replay' } as const
// IpcChannels 加:chatConnect/chatDisconnect/chatListConversations/chatGetMessages/chatSend/chatCancel/chatActivate/chatCreate/chatRename/chatDelete/chatGetState
```
`chat-handlers.ts`：`registerChatHandlers({ svc, sanitize })`（getToken/requireToken 已在 `ChatServiceDeps` 内，不重复传参 P3；**`createIpcHandler` 必填 `options.sanitize`**——从 index.ts 的 `createSanitizePublicMessage` 传入，R4）注册 `ipcMain.handle` 各 chat 命令。

**schema 决策（P1-4）**：`createIpcHandler(requestSchema, responseSchema, fn, ...)` 双 schema 必填（`main/ipc/executor.ts`）。
- **request schema**：新建于 `main/ipc/channels.ts`（沿用 appInfoSchema 模式）——`chatConnectSchema`（`{serverUrl: string}`）、`chatSendSchema`（`SendMessageInput`）、`chatGetMessagesSchema`（`ConversationMessagesQuery`）、`chatRenameSchema`（`{conversationId, title}`）、`chatActivateSchema`（`{conversationId}`）、`chatListConversationsSchema`（`PageQuery`）、`chatCreateSchema`、`chatCancelSchema`、`chatDeleteSchema`、`chatGetStateSchema`（无 payload）等——用 zod 精确字段。
- **response schema**：**P0 用 `z.unknown()` 包装信封**（成功 `{ok:true, data}` 不校验 data 形状，响应校验留阶段 7 细化；失败 `{ok:false, error}` 恒校验）。**决策明确：不在 2C 新建大量领域响应 schema**（阶段 7 安全收敛统一做）。

`handlers.ts`/`index.ts` 装配：
```typescript
const adapter = /* MockBackend 默认(requireToken:false);RealBackend 可经配置切换 */
const svc = createChatService({
  adapter,
  send: (ch, payload) => { const w = getMainWindow(); w?.webContents.send(ch, payload) },   // P3:webContents 守卫(窗口未建不崩)
  getToken: () => store.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined),   // R1:CredentialStore 是 async getCredential
  requireToken: adapter instanceof MockBackend ? false : true
})
registerChatHandlers({ svc })
// onSessionReplay 接线(P2-2):adapter 若为 RealBackend,构造时传 onSessionReplay: (cid, messages) => svc 桥 send(PushChannels.replay, { conversationId: cid, messages })
//   —— 统一在 chat-service 内部:若 adapter 有 onSessionReplay 选项(RealBackend),构造时接;MockBackend 无回放则跳过
```
`onConnectionStateChange` 接线：adapter 构造时 `onConnectionStateChange: (s) => svc.pushState(s)`（Task 1 已加选项）。

- [ ] **Step 4: 验证**

Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/chat-service.ts src/main/chat/chat-handlers.ts src/shared/contracts/ipc.ts src/main/ipc/handlers.ts src/main/ipc/channels.ts src/main/index.ts tests/unit/chat-service.spec.ts
git commit -m "feat(阶段2块C): chat-service + IPC 事件通道(chat:event/state/replay) + chat 命令 + schema"
```

---

### Task 3: preload desktopApi 扩展 + 类型

**Files:**
- Modify: `src/preload/desktop-api.ts`（chat 方法 + onChatEvent/onChatState/onChatReplay + unwrap 辅助）
- Modify: `src/preload/index.d.ts`（`Window.desktopApi` 类型扩展）
- Create: `tests/unit/desktop-api-chat.spec.ts`（mock ipcRenderer）

**Interfaces:**
- Consumes: `PushChannels`、`IpcResult`、`ConnectionState`、`Message`、`BackendEvent`（shared）。
- Produces：`desktopApi` 完整 chat 面 + 订阅。

- [ ] **Step 1: 写失败测试** —— `tests/unit/desktop-api-chat.spec.ts`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest'
// 用 vi.mock('electron') 提供 mock ipcRenderer
// 注:desktop-api.ts import ipcRenderer from 'electron';测试 mock 该模块

describe('desktopApi chat 面', () => {
  it('onChatEvent 校验 payload,非法丢弃,返回取消函数', async () => {
    const { desktopApi, mockIpc } = await importDesktopApi()
    const received: unknown[] = []
    const unsub = desktopApi.onChatEvent((e) => received.push(e))
    // 模拟 ipcRenderer.on('chat:event') 收到合法 BackendEvent
    mockIpc.emit('chat:event', { event: 'generation.started', generationId: 'g', messageId: 'm', responseId: 'g', conversationId: 'c', eventId: 'e', sequence: 1 })
    mockIpc.emit('chat:event', { bogus: true })   // 非法 → 丢弃
    expect(received.length).toBe(1)
    unsub()   // 取消后不再收
    mockIpc.emit('chat:event', { event: 'generation.delta', ... })
    expect(received.length).toBe(1)
  })
  // + onChatState/onChatReplay 校验 + chat 方法信封(unwrap ok:false → throw)
})
```
（`importDesktopApi` 辅助 + mock electron ipcRenderer——详见实现。）

- [ ] **Step 2: 实现 desktop-api 扩展**

```typescript
// unwrap 通用辅助(ok:true → data;ok:false → throw [code] message;异常 → throw)
function unwrap<T>(res: IpcResult<T>): T { /* 同 getAppInfo 模式 */ }

// chat 方法
async function connect(serverUrl: string): Promise<BackendSession> { return unwrap(await invokeWithArgs(IpcChannels.chatConnect, { serverUrl })) }
async function disconnect(): Promise<void> { unwrap(await invoke(IpcChannels.chatDisconnect)) }
async function listConversations(input: PageQuery): Promise<Page<Conversation>> { return unwrap(await invokeWithArgs(IpcChannels.chatListConversations, input)) }
async function getMessages(input: ConversationMessagesQuery): Promise<MessagePage> { return unwrap(await invokeWithArgs(IpcChannels.chatGetMessages, input)) }
async function send(input: SendMessageInput): Promise<ClientRequestRef> { return unwrap(await invokeWithArgs(IpcChannels.chatSend, input)) }
async function cancel(input: CancelGenerationInput): Promise<void> { unwrap(await invokeWithArgs(IpcChannels.chatCancel, input)) }
async function activate(id: string): Promise<ActivateConversationResult> { return unwrap(await invokeWithArgs(IpcChannels.chatActivate, { conversationId: id })) }
async function createConversation(input: CreateConversationInput): Promise<Conversation> { return unwrap(await invokeWithArgs(IpcChannels.chatCreate, input)) }
async function renameConversation(input: { conversationId: string; title: string }): Promise<Conversation> { return unwrap(await invokeWithArgs(IpcChannels.chatRename, input)) }
async function deleteConversation(id: string): Promise<void> { unwrap(await invokeWithArgs(IpcChannels.chatDelete, { conversationId: id })) }
async function getConnectionState(): Promise<ConnectionState> { return unwrap(await invoke(IpcChannels.chatGetState)) }
// 订阅(schema 校验,返回取消)
onChatEvent / onChatState / onChatReplay(见 spec §5.1)
// desktopApi 对象合并 chat 面
```

- [ ] **Step 3: `index.d.ts` 扩展 `Window.desktopApi`**（chat 方法 + 订阅签名）。
- [ ] **Step 4: 验证**

Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/preload/desktop-api.ts src/preload/index.d.ts tests/unit/desktop-api-chat.spec.ts
git commit -m "feat(阶段2块C): desktopApi chat 面(方法 + 事件订阅 + 信封守卫)"
```

---

### Task 4: Pinia 三 store + store 单测

**Files:**
- Create: `src/renderer/src/stores/desktop-api.types.ts`（`DesktopApiLike`）
- Create: `src/renderer/src/stores/connection.store.ts` / `conversation.store.ts` / `message.store.ts`
- Modify: `src/renderer/src/main.ts`（注册 Pinia）
- Create: `tests/unit/connection.store.spec.ts` / `conversation.store.spec.ts` / `message.store.spec.ts`
- Modify: `apps/desktop/package.json`（pinia 已在 deps；仅确认/加 `@pinia/testing`——如测试用 `createTestingPinia`，否则不装，P3）

**Interfaces:**
- Consumes: `desktopApi`（Renderer 侧）、`StreamAccumulator`（2A）、`Message`/`BackendEvent`（shared）。
- Produces：三 store + `DesktopApiLike`。

- [ ] **Step 1: 安装 + 写失败测试** —— `tests/unit/message.store.spec.ts`（核心）

```typescript
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'

// mock desktopApi(store 依赖注入)——通过 stores/desktop-api.types.ts 的 DesktopApiLike
const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {})
}
// 注入机制定死(P1-3):新增 src/renderer/src/stores/desktop-api.ts:
//   export let api: DesktopApiLike; export function setDesktopApi(a: DesktopApiLike) { api = a }
//   store 内 import { api } from './desktop-api'(惰性读,动作内访问);main.ts 调 setDesktopApi(window.desktopApi)
//   测试:beforeEach 里 setDesktopApi(mockApi)(node env 无 window,不触全局)

function started(): BackendEvent { return { eventId: 'e', sequence: 1, event: 'generation.started', generationId: 'gen-1', messageId: 'msg-1', responseId: 'gen-1', conversationId: 'conv-1', model: 'm1' } }
function delta(seg: string, seq: number, text: string): BackendEvent { return { eventId: 'e', sequence: 2, event: 'generation.delta', generationId: 'gen-1', segmentId: seg, segmentIndex: 0, channel: 'public_reply', kind: 'markdown', deltaSequence: seq, text } }

describe('messageStore 流式应用', () => {
  beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi) })   // R2:注入 mock api(import { setDesktopApi } from stores/desktop-api)

  it('started→delta→completed 归并 assistant 消息(Token/model/emotion 落位)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent(delta('seg-1', 0, '你好'))
    store.applyEvent({ ...started(), event: 'generation.completed', usage: { input: 1, output: 2, total: 3, source: 'provider_reported' }, model: 'm1', emotion: 'happy' })
    expect(store.byId['msg-1']?.role).toBe('assistant')
    expect(store.byId['msg-1']?.assistantSegments?.[0]?.text).toBe('你好')
    expect(store.byId['msg-1']?.status).toBe('completed')
    expect(store.byId['msg-1']?.usage?.total).toBe(3)
    expect(store.byId['msg-1']?.emotion).toBe('happy')
  })

  it('generationId 守卫:跨代 delta 丢弃', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.applyEvent({ ...delta('seg-1', 0, 'ok'), generationId: 'gen-OTHER' })
    expect(store.byId['msg-1']?.assistantSegments).toHaveLength(0)
  })

  it('cancel 乐观置 interrupted', async () => {
    const store = useMessageStore()
    store.applyEvent(started())
    await store.cancel()   // P1-2:与实现顺序一致(await desktopApi.cancel 后置位)
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('断线且 in-flight → assistant 置 interrupted(P1-6)', () => {
    const store = useMessageStore()
    store.applyEvent(started())
    store.handleConnectionStateChange({ status: 'reconnecting' })   // 由 onChatState 回调接线调用(P2-1)
    expect(store.byId['msg-1']?.status).toBe('interrupted')
    expect(store.activeGenerationId).toBeUndefined()
  })

  it('loadReplay 按 messageId 去重插入(P2-2)', () => {
    const store = useMessageStore()
    const m1 = { messageId: 'msg-r1', conversationId: 'conv-1', role: 'user', content: 'hi', status: 'completed', createdAt: 't' } as Message
    store.loadReplay('conv-1', [m1, { ...m1 }])
    expect(Object.keys(store.byId)).toHaveLength(1)   // 去重
  })

  it('乐观发送:pending → acknowledged(failed 时 failed)', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1' })   // 无 serverMessageId
    const store = useMessageStore()
    await store.send('hi')
    const msgs = Object.values(store.byId)
    expect(msgs.some((m) => m.role === 'user' && m.status === 'acknowledged')).toBe(true)
  })
})
```
Run: `pnpm test -- tests/unit/message.store.spec.ts`
Expected: FAIL（stores 不存在）

**connection/conversation store 测试断言要点（P2-3）**：
- `connection.store.spec`：connect 成功（`api.connect` 被调；`state.status` 由 `onChatState` 推送更新）/ 失败（`api.connect` reject → `error` 置位）/ `setState` 更新 / `disconnect`（`api.disconnect` 被调）；
- `conversation.store.spec`：list（`api.listConversations` 被调 + `items`/`nextCursor` 记录）/ `activate(id)`（`api.activate` + `resetConversation` + `getMessages` → `loadPage` 被调）/ create / rename（单对象载荷 `{conversationId,title}`）/ remove / `getMore`（cursor 透传）。

- [ ] **Step 2: 实现三 store**（按 spec §5.2 精确逻辑；messageStore 用 `StreamAccumulator` + `stores/desktop-api.ts` 的 `api` 惰性引用）。**messageStore 额外实现**：`loadReplay(conversationId, messages)`（按 messageId 去重插入，重连回放核心路径，P2-2）、`handleConnectionStateChange(s)`（断线且 in-flight → assistant 置 interrupted + 清 activeGenerationId，P1-6）。
- [ ] **Step 3: `main.ts` 接线**（P2-1；**R3：接线放于 `app.use(createPinia())` 之后**——Pinia install 已 `setActivePinia`，`use*Store()` 才可用；mount 前后皆可）：
```typescript
setDesktopApi(window.desktopApi)   // 注入 api(P1-3)
const connectionStore = useConnectionStore()
const messageStore = useMessageStore()
window.desktopApi.onChatEvent((e) => messageStore.applyEvent(e))
window.desktopApi.onChatState((s) => { connectionStore.setState(s); messageStore.handleConnectionStateChange(s) })
window.desktopApi.onChatReplay(({ conversationId, messages }) => messageStore.loadReplay(conversationId, messages))
```
（Pinia 已注册——`app.use(createPinia())` 已在 main.ts，无需重复。）
- [ ] **Step 4: 验证**

Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`
Expected: PASS（既有 269 + 新增 store 用例）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/stores src/renderer/src/main.ts tests/unit/connection.store.spec.ts tests/unit/conversation.store.spec.ts tests/unit/message.store.spec.ts package.json pnpm-lock.yaml
git commit -m "feat(阶段2块C): Pinia 三 store(connection/conversation/message,流式 StreamAccumulator 应用)"
```

---

### Task 5: 聊天/会话 UI 动态化

**Files:**
- Create: `src/renderer/src/components/CyMarkdown.vue`、`CyMessageBubble.vue`、`CyChatInput.vue`
- Modify: `src/renderer/src/components/CyChatView.vue`、`CyConversationList.vue`
- Modify: `apps/desktop/package.json`（加 `marked` + `@types/marked`）
- Create: `tests/unit/markdown-sanitize.spec.ts`（XSS 转义）

**Interfaces:**
- Consumes: 三 store、`tokens.css`。
- Produces：动态聊天/会话 UI。

- [ ] **Step 1: 安装 + 写失败测试** —— `tests/unit/markdown-sanitize.spec.ts`

```typescript
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/renderer/src/utils/markdown'

describe('Markdown 渲染 + 消毒', () => {
  it('基础 markdown(标题/粗体/列表/代码块)', () => {
    expect(renderMarkdown('# 标题')).toContain('<h1')
    expect(renderMarkdown('**粗体**')).toContain('<strong')
    expect(renderMarkdown('- a\n- b')).toContain('<li')
  })
  it('XSS:script/on* 被剥离', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script')
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('onerror')
  })
})
```
Run: `pnpm test -- tests/unit/markdown-sanitize.spec.ts`
Expected: FAIL（utils/markdown 不存在）

- [ ] **Step 2: 实现 `utils/markdown.ts`**（marked + sanitize——剥离 script/on* 后 v-html）。
- [ ] **Step 3: 组件**

`CyMarkdown.vue`：`renderMarkdown(text)` → v-html（`v-html` + sanitize 后安全）。
`CyMessageBubble.vue`：props `{ message }`；user/assistant 区分；assistant 按 `assistantSegments`（segmentIndex 排序）渲染 inner_voice 折叠 + public_reply `CyMarkdown`；`usage/model/emotion` chips（completed 后）。
`CyChatInput.vue`：textarea（回车发送/Shift+Enter 换行）+ 发送 + 停止按钮（`activeGenerationId` 存在时）+ 断线横幅（`connectionStore.state.status`）。
`CyChatView.vue`：`messageStore.byId/order` 渲染（空态 + 流式占位「生成中…」）；`conversationStore` 激活/新建。
`CyConversationList.vue`：`conversationStore.items` 渲染（当前高亮）+ 新建/重命名/删除。
`CyChatView` 连接控件：serverUrl 输入 + 连接按钮（`connectionStore.connect`，Mock 免 token）。

- [ ] **Step 4: 验证**

Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`
Expected: PASS（组件逻辑由 store 单测兜底；UI 视觉留阶段 3 E2E）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components src/renderer/src/utils package.json pnpm-lock.yaml tests/unit/markdown-sanitize.spec.ts
git commit -m "feat(阶段2块C): 聊天/会话 UI 动态化(CyMarkdown 消毒/双通道气泡/输入+停止/列表)"
```

---

### Task 6: 收尾验证 + 文档同步

**Files:**
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（阶段 2 勾选剩余项）
- Modify: `docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md`（阶段 B/C 标注）
- Modify: `docs/06-Cyrene-前端状态管理与本地存储-v0.2.md`（store 命名同步）

**步骤：**
- [ ] **Step 1: 块级验证**：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build` 全绿。
- [ ] **Step 2: doc 16**：勾选阶段 2 剩余（Inner Voice/Public Reply 展示、Token/模型/心情落位、Markdown/停止、Store 契约测试），标「已开发、未联调」。
- [ ] **Step 3: docs/18**：标注阶段 B/C 已实施。
- [ ] **Step 4: doc 06**：store 命名同步（connection/conversation/message）。
- [ ] **Step 5: Commit**：
```bash
git add docs/16-Cyrene-前端实施任务清单与进度跟踪.md docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md docs/06-Cyrene-前端状态管理与本地存储-v0.2.md
git commit -m "docs(阶段2块C): doc16 阶段2 勾选完成 + docs18 标注 + doc06 store 命名同步"
```

---

## 完成定义（所有任务完成后验证）

Run: `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`
Expected: 全绿；既有 269 + 本块新增（Task1 ~2 + chat-service ~3 + desktop-api ~3 + stores ~10 + markdown ~2 ≈ 20+）。

对照 spec §8 验收：① desktopApi chat 面 + 订阅；② chat-service 装配 + chat:event 推送；③ 三 store + 单测全绿；④ messageStore 流式应用（双通道/Token 落位/completed 才结束/failed/乐观发送）；⑤ UI 动态化（双通道/markdown/停止/断线提示/会话列表）；⑥ 既有 269 不回归；⑦ 标「已开发、未联调」+ doc 16/06 同步。

## 风险提示（执行时注意）

- **store 测试注入**：stores 依赖 `desktopApi`——用 `DesktopApiLike` 接口 + 测试注入（`vi.stubGlobal` 或模块级可替换引用），不触 Electron。`message.store.spec` 需 stub `conversationStore.currentId`（P3-4）。
- **`onConnectionStateChange` 接线**：chat-service 装配时给 adapter 传 `onConnectionStateChange: (s) => svc.pushState(s)`（RealBackend/MockBackend 均支持）；connect/disconnect 后主动 push 兜底。
- **PushChannels vs IpcChannels**：推送通道不入 `IpcChannels`（P3-2）；chat 命令入 `IpcChannels`。
- **marked + CSP**：sanitize 剥离 `<script>`/`on*`；CSP 无 unsafe-eval，marked 不依赖。
- **契约漂移**：以 `/home/yomu/elysia-agent` 当前契约为准；真实联调待 B-01。
