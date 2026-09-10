# 阶段 2 块 C：Store + IPC 事件推送 + 聊天 UI 纵向闭环 —— 设计

**日期：** 2026-08-11
**状态：** 已 code-review（第 1 轮干净;P1-1 ConnectionState 迁 shared/P1-2 状态 push 定死/P1-3 onSessionReplay 定方案 a(chatreplay 通道)/P1-4 乐观 interrupted + 全部 P2/P3 落地并复核通过）
**关联：** [2A spec](2026-08-10-phase2-contract-raw-wire-design.md)（StreamAccumulator/领域事件）、[2B spec](2026-08-11-phase2-real-backend-design.md)（RealBackend/BackendAdapter）、[doc 16 §5 阶段 2](../16-Cyrene-前端实施任务清单与进度跟踪.md#L228)、[doc 06 状态管理](../06-Cyrene-前端状态管理与本地存储-v0.2.md)、[doc 03 UI](../03-Cyrene-前端UI与交互设计-v0.2.md)

---

## 1. 背景与目标

2A 修好领域契约/StreamAccumulator（权威 content 规则），2B 实现 `RealBackend`（REST/WS Adapter，269 单测全绿），但 **Renderer 还是阶段 0 的静态壳**：无 Pinia store、无 IPC 事件推送、聊天区是静态示意。本块（2C）打通「发送 → 流式 → 渲染」的完整用户链路：

1. **IPC 事件通道**：Main 持有 BackendAdapter（真实 `RealBackend` 或 `MockBackend`），其领域事件经 `webContents.send` 推给 Renderer，preload 具名订阅；
2. **Pinia stores**：`connectionStore`（连接状态）、`conversationStore`（会话列表/当前会话/激活/历史）、`messageStore`（发送/流式应用/消息列表）；
3. **聊天 UI**：`CyChatView` 动态化——Inner Voice / Public Reply 双通道（全局排序 + 独立折叠）、Token/模型/心情落位、Markdown/代码块渲染、停止生成、发送框（乐观状态/确认）、断线提示；
4. **会话列表 UI**：`CyConversationList` 动态列表/选中/新建/重命名；
5. **契约测试**：Store 单测（MockBackend 注入）+ IPC 事件链路集成。

**本块不实现**：历史查看器/搜索/资源（阶段 3）、模型服务/语音（阶段 4）、Desktop 工具（阶段 6）。真实联调待 B-01，本块标「已开发、未联调」。

### 1.1 与 2A/2B 的边界
- 消费：2A 的 `BackendEvent`/`StreamAccumulator`、2B 的 `BackendAdapter`（含 `RealBackend`/`MockBackend`）与 `ConnectionState`。
- 本块新增：Main 的 IPC 桥（`chat:event` 推送 + chat 命令）、preload `desktopApi` 扩展、Renderer 的 Pinia stores 与 UI。
- **对 2A/2B 的加性修改**（P1-1/P1-2）：① `ConnectionState`/`ConnectionStatus` 从 2B `main/transport/real-backend.ts` **迁到 `shared/contracts/backend.ts`**（preload/renderer 需共享该类型，避免 renderer 编译依赖指向 main 模块图；RealBackend 从 shared 导入并 re-export 保持兼容）；② `BackendAdapter` 接口加 `getConnectionState(): ConnectionState`（`MockBackend` 同步实现）；③ `RealBackendOptions` 加 `onConnectionStateChange?: (s: ConnectionState) => void`（状态变化 push 触发，见 C-3）。其余领域层/RealBackend 逻辑不改。

## 2. 范围

| 项 | 内容 |
|---|---|
| IPC 事件通道 | Main `chat:event`（`webContents.send` 领域 `BackendEvent`）；preload `onChatEvent(handler): () => void`（contextBridge 具名，payload schema 校验，返回取消函数） |
| IPC chat 命令 | `chat:connect`/`chat:disconnect`/`chat:list-conversations`/`chat:get-messages`/`chat:send`/`chat:cancel`/`chat:activate`/`chat:create`/`chat:rename`/`chat:delete`/`chat:get-state`——Main 侧注册，经 `IpcResult` 信封 |
| Pinia stores | `connectionStore`（`ConnectionState` + 连接动作）、`conversationStore`（列表/当前会话/激活/历史 `MessagePage` 追加）、`messageStore`（发送/`StreamAccumulator` 流式应用/消息列表/停止） |
| Renderer 接线 | `desktopApi` 扩展（chat 方法 + `onChatEvent` 订阅）；`main.ts` 注册 Pinia；stores 注入 BackendAdapter 或经 IPC |
| 聊天 UI | `CyChatView`：双通道消息（inner_voice 折叠 / public_reply markdown）、Token/模型/心情 chips、Markdown 渲染、停止生成、发送框（乐观 + 确认）、断线提示、空态 |
| 会话 UI | `CyConversationList`：动态列表/选中高亮/新建/重命名；`CyChatView` 内会话标题 |
| 测试 | store 单测（MockBackend 注入，不依赖 IPC）、IPC 链路集成（Playwright 或 vitest + ipc mock）、既有 269 不回归 |
| 文档 | doc 16 阶段 2 勾选剩余项；doc 06 同步 store 命名 |

**非目标（后续阶段）：** 历史查看器/搜索/资源索引（阶段 3）、附件上传（阶段 3）、Markdown 编辑器/代码高亮主题（阶段 3 完善）、模型服务/语音（阶段 4）、Desktop 工具（阶段 6）。

## 3. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| C-1 | 事件通道 | Main 持有一个 `BackendAdapter` 实例（构造注入，默认 `MockBackend`，真实切换留 2C 连接配置）；其 `subscribe` 的领域事件 → `webContents.send('chat:event', event)`；preload `onChatEvent` 用 `ipcRenderer.on` + 取消函数 |
| C-2 | Renderer 侧数据流 | **不经 Main 中转领域事件到 store 的逻辑**——领域事件在 Main 由 Adapter 产出（2B 已保证领域形状），Renderer store 直接消费 `BackendEvent`（schema 校验后进 `StreamAccumulator`）。store 是纯消费层（无 Adapter 逻辑） |
| C-3 | 连接配置与状态推送 | `connectionStore.connect(serverUrl)` → `desktopApi.connect(serverUrl)` → Main 读凭据 token → Adapter.connect（token 不经 Renderer，C-4）。**连接状态 push 定死**：`RealBackendOptions.onConnectionStateChange`（P1-2，状态变化时触发）→ chat-service 桥 `webContents.send('chat:state', state)` → preload `onChatState` → `connectionStore.setState`；**不轮询**（P2-8）。MockBackend 亦在 connect/disconnect 时触发状态回调 |
| C-4 | token 读取 | `chat:connect` 由 Main 直接读凭据存储 `BACKEND_TOKEN_KEY`（safeStorage），Renderer 只传 `serverUrl`；token 缺失 → `CREDENTIAL_UNAVAILABLE` 错误。**MockBackend 免 token 路径**：chat-service 按注入 adapter 类型（`instanceof MockBackend` 或注入 `requireToken: boolean`）决定是否需 token——默认 mock 演示不阻塞（P2-5）。**最小连接控件**：`CyChatView`/`CyConversationList` 提供 serverUrl 输入 + 连接按钮（P2-5） |
| C-5 | store 注入 | stores 依赖 `BackendAdapter` 接口（`@shared/contracts/backend`）？**否**——Renderer 不直接依赖 Adapter（信任边界）。stores 依赖 `desktopApi`（IPC 面）。**但单测**：store 用注入的 `DesktopApiLike` 接口（renderer 侧定义，含 chat 方法 + onChatEvent），测试用 mock desktopApi，不触 Electron |
| C-6 | 事件 schema 校验 | preload `onChatEvent` 收 `ipcRenderer.on` payload → `parseBackendEvent`（2A schema）校验，非法丢弃 + `console.warn`（不崩）；Renderer store 收已校验事件 |
| C-7 | 消息流式应用 | `messageStore` 持 `StreamAccumulator` 实例（2A）：`generation.started` → 建消息；delta/segment.completed/completed/failed → `acc.apply` → `toAssistantSegments` 更新消息；`responseId` 关联消息（assistant 父消息） |
| C-8 | 双通道渲染 | 消息按 `assistantSegments` 渲染：`inner_voice` 段折叠（点击展开）；`public_reply` 段 markdown 渲染；全局顺序 = `segmentIndex` 排序；**流式占位为消息级**（`status==='streaming'` 且无可见段 → 显示「生成中…」；因 2A `toAssistantSegments` 过滤空段，零文本 in-flight 段不可见——P2-3） |
| C-9 | 停止生成 | `messageStore.cancel()`：`desktopApi.cancel(generationId)` → Main → Adapter.cancelGeneration（WS interrupt）+ **乐观**把当前 assistant 消息置 `interrupted`、清 `activeGenerationId`（P1-4）；迟到 `generation.failed{CANCELLED}` 幂等，code=CANCELLED 时保持 `interrupted` 不降级 `failed`；**断线**（`connectionStore.state.status` 为 `reconnecting/error/disconnected`）且 in-flight → 同样置 `interrupted` |
| C-10 | 乐观发送 | `messageStore.send(text)`：立即插 `pending` 用户消息（乐观，`byId`/`order` key 用 `clientMessageId`）→ `desktopApi.send`（`clientRequestId`）→ ack accepted → 置 `acknowledged`（**无 `serverMessageId` 也置 acknowledged**；有则迁移 key 到 `serverMessageId`，P2-1）；rejected → `failed` + 错误展示 |
| C-11 | 会话激活/历史 | `conversationStore.activate(id)`：`desktopApi.activate`（RealBackend: REST activate + WS 回放）+ **`messageStore.resetConversation(id)` + 拉第一页历史**（`desktopApi.getMessages({conversationId:id})` → `loadPage`，去重按 messageId，P1-3）；**`onSessionReplay` 接线（方案 a，P1-3）**：新增 `chat:replay` 推送通道——chat-service 构造 RealBackend 时把 `onSessionReplay(conversationId, messages)` 接到 `deps.send('chat:replay', {conversationId, messages})`；preload `onChatReplay` → `messageStore.loadReplay(conversationId, messages)`（重连回放核心数据路径）；`getMessages` 追加/前置 `MessagePage.items` |
| C-12 | 标记 | 真实联调未做（B-01 未到位）→「已开发、未联调」；store/UI 测试用 MockBackend + mock desktopApi |

**实施中新增决策：** 按目标指令追加到 §10 与最终报告。

## 4. 目标结构

```text
apps/desktop/src/
├── main/
│   ├── chat/
│   │   ├── chat-service.ts          # 新增:持 BackendAdapter + webContents.send 事件桥 + chat:event 定义
│   │   └── chat-handlers.ts         # 新增:chat:connect/send/cancel/... IPC handler(经 IpcResult 信封)
│   ├── ipc/handlers.ts              # 修改:注册 chat handlers + chat:event 推送源
│   └── index.ts                     # 修改:装配 chat-service(BackendAdapter 注入)
├── preload/desktop-api.ts           # 修改:chat 方法 + onChatEvent
├── renderer/src/
│   ├── main.ts                      # 修改:注册 Pinia
│   ├── stores/
│   │   ├── connection.store.ts      # 新增
│   │   ├── conversation.store.ts    # 新增
│   │   ├── message.store.ts         # 新增
│   │   └── desktop-api.types.ts     # 新增:Renderer 侧 DesktopApiLike(chat 面)
│   ├── components/
│   │   ├── CyChatView.vue           # 修改:动态化(双通道/发送/Markdown/停止)
│   │   ├── CyConversationList.vue   # 修改:动态列表
│   │   └── (子组件)CyMessageBubble.vue / CyMarkdown.vue / CyChatInput.vue / CyStreamingDots.vue  # 新增
├── tests/unit/
│   ├── connection.store.spec.ts     # 新增(mock desktopApi)
│   ├── conversation.store.spec.ts   # 新增
│   ├── message.store.spec.ts        # 新增(StreamAccumulator 应用)
│   └── (既有)
```

## 5. 关键实现

### 5.1 IPC 事件通道与 chat 命令

**Main（`chat-service.ts`）**：
```typescript
export interface ChatServiceDeps {
  adapter: BackendAdapter
  send: (channel: 'chat:event' | 'chat:state' | 'chat:replay', payload: unknown) => void   // 注入 webContents.send 包装(P3-2 PushChannels)
  getToken: () => string | undefined                            // 注入凭据读取(Main 直接 safeStorage)
  requireToken?: boolean                                        // false = MockBackend 免 token 演示(P2-5);默认 true(RealBackend)
}
export function createChatService(deps: ChatServiceDeps): {
  connect(input: { serverUrl: string }): Promise<BackendSession>   // token 从 deps.getToken()
  disconnect(): Promise<void>
  listConversations(input: PageQuery): Promise<Page<Conversation>>
  getMessages(input: ConversationMessagesQuery): Promise<MessagePage>
  send(input: SendMessageInput): Promise<ClientRequestRef>
  cancel(input: CancelGenerationInput): Promise<void>
  activate(id: string): Promise<ActivateConversationResult>
  createConversation(input: CreateConversationInput): Promise<Conversation>
  renameConversation(id: string, title: string): Promise<Conversation>
  deleteConversation(id: string): Promise<void>
  getConnectionState(): ConnectionState
  dispose(): void
}
```
- `createChatService` 内部 `adapter.subscribe((event) => deps.send('chat:event', event))`——领域事件推给所有窗口；
- `connect`：`deps.requireToken !== false` 时 `const token = deps.getToken()`，缺 token → 抛 `CREDENTIAL_UNAVAILABLE`（Renderer 提示设置）；`requireToken === false`（MockBackend 演示）跳过 token 校验；有 token → `adapter.connect({serverUrl, token})`；
- **事件推送通道**：`chat:event` 是**单向 Main→Renderer**（`webContents.send` + preload `ipcRenderer.on`），不经 `ipcMain.handle`；chat 命令走 `ipcMain.handle`（request/response 信封）。

**preload（`desktop-api.ts` 扩展）**：
```typescript
onChatEvent(handler: (event: BackendEvent) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => {
    const parsed = parseBackendEvent(payload)
    if (parsed.success) handler(parsed.data)
    else console.warn('[chat] 非法领域事件', payload)
  }
  ipcRenderer.on('chat:event', listener)
  return () => ipcRenderer.removeListener('chat:event', listener)
}
onChatState(handler: (state: ConnectionState) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => { if (isConnectionState(payload)) handler(payload) }
  ipcRenderer.on('chat:state', listener)
  return () => ipcRenderer.removeListener('chat:state', listener)
}
onChatReplay(handler: (payload: { conversationId: string; messages: Message[] }) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => { if (isReplayPayload(payload)) handler(payload) }
  ipcRenderer.on('chat:replay', listener)
  return () => ipcRenderer.removeListener('chat:replay', listener)
}
// + chat 方法(经 invoke 信封 + 守卫):
connect(serverUrl: string): Promise<BackendSession>        // Main 读 token
disconnect(): Promise<void>
listConversations(input: PageQuery): Promise<Page<Conversation>>
getMessages(input: ConversationMessagesQuery): Promise<MessagePage>
send(input: SendMessageInput): Promise<ClientRequestRef>
cancel(input: CancelGenerationInput): Promise<void>
activate(id: string): Promise<ActivateConversationResult>
createConversation(input: CreateConversationInput): Promise<Conversation>
renameConversation(input: { conversationId: string; title: string }): Promise<Conversation>   // IPC 载荷单对象(registry arity 约束,P2-4)
deleteConversation(id: string): Promise<void>
getConnectionState(): Promise<ConnectionState>
```

**IPC channels（`channels.ts` 扩展）**：`chatConnect`/`chatDisconnect`/`chatListConversations`/`chatGetMessages`/`chatSend`/`chatCancel`/`chatActivate`/`chatCreate`/`chatRename`/`chatDelete`/`chatGetState`（均 `ipcMain.handle` + `IpcResult` 信封）。

### 5.2 Pinia stores

**`connection.store.ts`**：
```typescript
export const useConnectionStore = defineStore('connection', () => {
  const state = ref<ConnectionState>({ status: 'disconnected' })
  const connecting = ref(false)
  const error = ref<string>()
  async function connect(serverUrl: string): Promise<void> {
    connecting.value = true; error.value = undefined
    try { await desktopApi.connect(serverUrl); state.value.status = 'connecting' }
    catch (e) { error.value = messageOf(e) }
    finally { connecting.value = false }
  }
  function setState(s: ConnectionState): void { state.value = s }   // 由 onChatState 推送(C-3 定死 push,不轮询)
  async function refreshState(): Promise<void> { state.value = await desktopApi.getConnectionState() }
  async function disconnect(): Promise<void> { await desktopApi.disconnect() }
  return { state, connecting, error, connect, disconnect, refreshState }
})
```
- 连接状态变化（断线/重连）：`ConnectionState` 不属 `BackendEvent`（2B 本地状态）。**C-3 定死 push**：Main 在状态变化时经 `webContents.send('chat:state', connectionState)`（`chat:state` 通道，preload `onChatState`），不轮询。

**`conversation.store.ts`**：
```typescript
export const useConversationStore = defineStore('conversation', () => {
  const items = ref<Conversation[]>([])
  const currentId = ref<string>()
  const hasMore = ref(false)
  const nextCursor = ref<string>()
  async function list(): Promise<void> { const p = await desktopApi.listConversations({}); items.value = p.items; hasMore.value = p.hasMore; nextCursor.value = p.nextCursor }
  async function activate(id: string): Promise<void> {
    await desktopApi.activate(id); currentId.value = id
    messageStore.resetConversation(id)                       // P1-3:切会话清空旧消息
    const p = await desktopApi.getMessages({ conversationId: id })   // 拉第一页历史
    messageStore.loadPage(p)
  }
  async function getMore(): Promise<void> { if (!nextCursor.value) return; const p = await desktopApi.listConversations({ cursor: nextCursor.value }); items.value.push(...p.items); ... }
  async function create(): Promise<void> { const c = await desktopApi.createConversation({}); await list(); currentId.value = c.id }
  async function rename(input: { conversationId: string; title: string }): Promise<void> { await desktopApi.renameConversation(input); await list() }   // P2-4:单对象载荷
  async function remove(id): Promise<void> { await desktopApi.deleteConversation(id); await list() }
  return { items, currentId, hasMore, nextCursor, list, activate, getMore, create, rename, remove }
})
```

**`message.store.ts`**（流式核心）：
```typescript
export const useMessageStore = defineStore('message', () => {
  const byId = ref<Record<string, Message>>({})
  const order = ref<string[]>([])
  const sending = ref(false)
  const activeGenerationId = ref<string>()
  const accumulator = ref<StreamAccumulator>()
  const lastError = ref<string>()

  function resetConversation(conversationId: string): void { byId.value = {}; order.value = []; activeGenerationId.value = undefined }

  function applyEvent(event: BackendEvent): void {
    switch (event.event) {
      case 'generation.started': {
        accumulator.value = new StreamAccumulator({ generationId: event.generationId, messageId: event.messageId, responseId: event.responseId, conversationId: event.conversationId })
        activeGenerationId.value = event.generationId
        // 创建/复用 assistant 父消息(空 segments,status streaming)
        upsertMessage({ messageId: event.messageId, conversationId: event.conversationId, role: 'assistant', status: 'streaming', assistantSegments: [], createdAt: nowIso(), ...(event.model ? { model: event.model } : {}) })
        break
      }
      case 'generation.delta': case 'generation.segment.started': case 'generation.segment.completed': {
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break   // P2-2:跨代/迟到事件丢弃
        acc.apply(event)
        patchAssistant(acc.getState().messageId, acc)   // 经 accumulator.state.messageId 关联父消息(C-G5)
        break
      }
      case 'generation.completed': {
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break
        acc.apply(event)
        finalizeAssistant(acc.getState().messageId, acc, event)   // status 用 acc.getState().status(completed/completing,不硬编码,P3-5)+ usage/model/emotion
        activeGenerationId.value = undefined
        break
      }
      case 'generation.failed': {
        const acc = accumulator.value
        if (!acc || acc.getState().generationId !== event.generationId) break
        acc.apply(event)
        failAssistant(acc.getState().messageId, event)   // status failed + error(CANCELLED → interrupted)
        activeGenerationId.value = undefined
        break
      }
    }
  }

  async function send(text: string): Promise<void> {
    const conversationId = conversationStore.currentId; if (!conversationId) return
    const clientRequestId = crypto.randomUUID()
    const key = `local-${clientRequestId}`
    const optimistic: Message = { messageId: key, conversationId, role: 'user', content: text, status: 'pending', clientMessageId: clientRequestId, createdAt: nowIso() }
    upsertMessage(key, optimistic); sending.value = true
    try {
      const ref = await desktopApi.send({ conversationId, text, clientRequestId })
      if (ref.serverMessageId) migrateKey(key, ref.serverMessageId, optimistic)   // P2-1:迁移 byId/order key 到 serverMessageId
      optimistic.status = 'acknowledged'   // P2-1:无 serverMessageId 也 acknowledged
    } catch (e) { optimistic.status = 'failed'; lastError.value = messageOf(e) }
    finally { sending.value = false }
  }

  async function cancel(): Promise<void> {
    const gid = activeGenerationId.value
    if (!gid) return
    await desktopApi.cancel({ generationId: gid }).catch(() => {})   // P1-4:乐观置位,不因后端结果阻塞
    const acc = accumulator.value
    if (acc) { const m = byId.value[acc.getState().messageId]; if (m) m.status = 'interrupted' }
    activeGenerationId.value = undefined
  }
  function loadPage(page: MessagePage): void { /* 按 messageId 去重插入 */ }
  return { byId, order, sending, activeGenerationId, lastError, resetConversation, applyEvent, send, cancel, loadPage }
})
```

**订阅接线（P3-6）**：`renderer/main.ts` 启动时 `desktopApi.onChatEvent((e) => messageStore.applyEvent(e))`、`desktopApi.onChatState((s) => connectionStore.setState(s))`（store 级订阅常驻，组件卸载无关）；`connectionStore` 的断线→in-flight 置 `interrupted` 由 `onChatState` 回调或 `watch(state.status)` 触发（P1-4）。
- **accumulator 关联**：`GenerationDeltaEvent` 无 `messageId`（只有 generationId/segmentId）——需经 accumulator 的 `responseId`（=generationId）关联父消息。`messageStore` 在 `generation.started` 时记 `generationId → messageId` 映射（`accumulator.state.messageId`），delta/completed 用该映射 patch。

### 5.3 UI 组件

**`CyChatView.vue`（动态化）**：
- 读 `messageStore.byId/order` + `conversationStore.currentId` + `connectionStore.state`；
- 消息列表：`order` 渲染（user/assistant 气泡），assistant 气泡内按 `assistantSegments`（segmentIndex 排序）渲染：
  - `inner_voice` 段：折叠行（默认收起，点击展开，前缀「内心独白」）；
  - `public_reply` 段：`CyMarkdown` 渲染（`kind==='markdown'`）；
- 回复级 chips：`usage`（token）、`model`、`emotion`（在 `generation.completed` 后显示）；
- 输入区（`CyChatInput`）：textarea + 发送（回车发送，Shift+Enter 换行）+ 停止按钮（`activeGenerationId` 存在时显示）；
- 断线提示：`connectionStore.state.status === 'reconnecting'/'error'` 时顶部横幅；
- 空态：无消息时「新会话，开始对话」。

**`CyConversationList.vue`（动态化）**：`conversationStore.items` 渲染（当前高亮）、新建按钮、重命名（双击/右键）、删除（确认）。

**`CyMarkdown.vue`**：最小 markdown 渲染。**决策 C-13（P2-6 定死）**：用 `marked`——手写 tokenizer 必须承担 XSS 责任（markdown 经 v-html 需 HTML 转义 + 剥离原始 HTML），`marked` 转义成熟、CSP 安全（`script-src 'self'` 无 unsafe-inline）、体积小；输出再经 sanitize（剥离 `<script>`/`on*` 属性）。若实施发现 marked 体积/许可问题，回退手写 + 明确转义/剥离规则 + 恶意输入单测（见 §10 记录）。

### 5.4 测试策略

| 文件 | 覆盖 |
|---|---|
| `connection.store.spec.ts` | mock desktopApi：connect 成功/失败、refreshState、disconnect（注入 `DesktopApiLike`） |
| `conversation.store.spec.ts` | list/activate/create/rename/remove、getMore cursor、currentId 切换 |
| `message.store.spec.ts` | **StreamAccumulator 应用链路**：构造领域事件序列（started→delta→completed）→ `applyEvent` → `byId/order` 正确（inner_voice + public_reply 段、Token/model/emotion 落位）；failed → status failed；乐观发送（pending→acknowledged/failed）；用 2A 领域事件构造，不依赖 IPC |
| `desktop-api.spec.ts`（扩展） | onChatEvent 订阅/取消 + payload schema 校验（非法丢弃）——mock `ipcRenderer` |
| 集成（块 C 或 2C 内） | IPC 事件链路：Main chat-service → webContents.send → preload → store（Playwright 或 vitest + ipc mock） |

**验证命令**：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。

## 6. 错误处理与安全

- **Token 不经 Renderer**：`chat:connect` 由 Main 读凭据存储（C-4），Renderer 只传 serverUrl；token 缺失 → `CREDENTIAL_UNAVAILABLE` 错误提示。
- **事件 schema 校验**：preload 收 `chat:event` 经 `parseBackendEvent`，非法丢弃 + warn，不崩 Renderer。
- **信封**：chat 命令一律 `IpcResult` 信封（成功 `{ok,data}` / 失败 `{ok:false,error}`），preload 守卫。
- **乐观状态安全**：`clientRequestId` 幂等（2B ack 语义）；rejected → 用户消息 `failed` + 错误展示。
- **store 纯消费**：Renderer store 无 Adapter 逻辑、无凭据、无文件/网络（信任边界保持）。

## 7. 测试策略总览

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单测（本块） | vitest node env | connection/conversation/message stores（mock desktopApi）、preload onChatEvent |
| 集成 | vitest/Playwright | IPC 事件链路（Main chat-service → preload → store）——2C 内做 vitest + ipc mock；Playwright E2E 留阶段 3 |
| 单测（既有） | vitest | 269 项不回归 |

## 8. 验收标准

1. `desktopApi` 扩展 chat 方法 + `onChatEvent`（具名订阅，返回取消函数，payload schema 校验）；
2. Main `chat-service` 装配 BackendAdapter（MockBackend 默认，RealBackend 可注入），领域事件经 `chat:event` 推送；
3. **Pinia 三 store** 落地（connection/conversation/message），store 单测全绿（mock desktopApi）；
4. **messageStore 流式应用**：领域事件序列（started→delta→segment.completed→completed）→ `byId/order` 正确（双通道段、Token/model/emotion 落位、completed 才结束）；failed → failed；乐观发送 pending→acknowledged/failed；
5. **UI 动态化**：`CyChatView` 双通道渲染（inner_voice 折叠 / public_reply markdown）、Token/模型/心情 chips、发送框 + 乐观 + 停止、断线提示；`CyConversationList` 动态列表/选中/新建/重命名；
6. 既有 269 单测不回归；typecheck/lint/build 过；
7. 本块标「已开发、未联调」；doc 16 阶段 2 勾选；doc 06 同步 store 命名。

## 9. 风险与预案

| 风险 | 预案 |
|---|---|
| Renderer 无 UI 测试基建（Playwright E2E 阶段 3） | 本块 UI 用组件逻辑抽 store 单测兜底；视觉验证留阶段 3 |
| `chat:event` 大流量（高频 delta） | 事件逐条推（2B 已保证领域事件粒度为 delta/segment）；store 应用是 O(n) 可接受；性能优化留阶段 7 |
| connection 状态非 BackendEvent（2B ConnectionState） | 2C `chat:state` 通道（C-3 定死 push：Main 状态变化时推，preload `onChatState`）；`chat:replay` 通道承载回放 |
| Markdown 渲染库选型 | 轻量手写（C-13）；若复杂，用 `marked`（CSP 安全，纯文本转 HTML 无 eval）——实施定 |
| 分类器/主模型间歇不可用（本环境） | 窗口内批量执行；doc 17 §15 已记录 |

## 10. 已知限制与接受项

| # | 限制 | 影响/处理 |
|---|---|---|
| C-G1 | Playwright E2E（真实 UI 流）留阶段 3 | 本块 store 单测 + IPC 链路集成兜底；UI 视觉验收阶段 3 |
| C-G2 | 真实后端联调未做（B-01 未到位） | 标「已开发、未联调」；MockBackend + mock desktopApi 驱动 |
| C-G3 | `chat:state`/`chat:replay` 推送通道 | **C-3/C-11 定死 push**：`chat:state`（ConnectionState 变化）、`chat:replay`（onSessionReplay 回放），preload `onChatState`/`onChatReplay`；不轮询 |
| C-G4 | Markdown 渲染范围 | P0 仅标题/粗体/列表/代码块/链接；图片/表格/高亮阶段 3 |
| C-G5 | messageStore 的 `generationId→messageId` 映射 | 2A accumulator 已存 `state.messageId`；store 用 `accumulator.state` 关联，无需重复映射 |
| C-G6 | **实施中新增决策** | ① P3-1：`preload/index.d.ts` 扩展 `Window.desktopApi` 类型（chat 方法 + `onChatEvent`/`onChatState` 签名）；② P3-2：推送通道 `chat:event`/`chat:state` 用独立 `PushChannels` 常量（不入 `IpcChannels` handle 集合）；③ P3-3：preload chat 方法统一 unwrap 信封辅助（`ok:false` → throw `[code] message`）；④ P3-4：`message.store.spec` 需 stub `conversationStore.currentId`（`createTestingPinia` 或直接设） |
