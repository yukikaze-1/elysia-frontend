# Cyrene 阶段 2 真实联调整改·批次 B：真实连接编排（初始化时序 / 会话守卫 / 错误链 / 超时门控）设计

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段2真实联调前端整改清单.md` 批次 B（FE-P1-03 / FE-P1-04 / FE-P1-05 / FE-P2-01）
**审查对象基线：** `main@54c27df`（批次 A 落地后 HEAD）
**范围：** Electron 阶段 2 文本聊天纵向链路的真实连接编排（Main / Preload / Renderer / RealBackend）
**目的：** 真实联调前把「连接 → 会话 → 发送 → ACK → 流式 → 完成/失败 → 重连回放」做成安全闭环：连接后会话自动就绪、快速切会话不串台、错误可见可追踪、超时/取消/门控完整。本批完成后仍标「已开发、未联调」。
**文档状态：** v3 定稿（经 code-review 三轮闭环：整改覆盖 7 findings + 设计一致性 12 findings + 复查 3 新问题 N1/N2/N3 + 4 minor N-a/b/c/d，全部整合进本版；新增决策 D13–D24 见 §6）

---

## 1. 背景与目标

阶段 2 主体 + 批次 A（连接凭据安全 / 真实模式装配 / rejected ACK）已落地并通过门禁（361 单测 + 20 集成 + typecheck/lint/build 全绿），但仍是「Mock 驱动链路」。批次 A 主要解决连接入口与 ACK 错误路径；批次 B 处理连接成功后的编排与运行时健壮性。第三方 review 指出四类问题：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-P1-03 | P1 | 会话列表/活动会话初始化时序错误 | 连接成功后列表、活动会话、第一页历史自动就绪；空后端明确空态；挂载不产生 unhandled Promise |
| FE-P1-04 | P1 | 回放、流式事件和快速切会话缺少 conversation/epoch 守卫 | 快速 A→B 不串台；迟到 replay/事件不污染当前会话；历史/回放按 messageId 去重 |
| FE-P1-05 | P1 | 错误被吞、压扁或不展示，协议告警未接日志 | 连接/协议/后端错误可见可追踪；非法帧只进脱敏诊断 |
| FE-P2-01 | P2 | 连接/REST 无明确超时取消，未连接操作缺少门控 | 握手/REST 有超时；断线/切端/退出取消 in-flight；未连接或未就绪动作禁用 |

**完成标准**（对照 review 第 5 节，本批范围）：
- 真实连接后会话列表、活动会话和历史自动完成初始化；
- 快速切会话、迟到 replay 和迟到 generation 不污染当前会话；
- 认证、限流、队列满、存储不可用、协议不匹配均有可见错误；
- typecheck、lint、361+ 单测、20+ 集成测试、build 全绿；
- 文档仍标记「已开发、未联调」。

## 2. 范围（本批 vs 后续批次）

**本批做：** FE-P1-03（连接后初始化编排）、FE-P1-04（conversation/epoch 守卫）、FE-P1-05（可见错误 + 协议告警脱敏日志）、FE-P2-01（超时/取消/门控）。

**本批不做**（分属 review 批次 C 或阶段 3+）：
- FE-P2-02 IPC/replay 运行时 Schema 完整化、FE-P2-03 夹具跨仓库门禁、FE-P2-04 文档漂移（批次 C）；
- 按 conversation 分桶缓存多会话消息、虚拟列表、历史查看器（阶段 3 起）；
- 阶段 3+：附件、搜索、模型/语音、Live2D、工具执行。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `renderer/src/components/CyConversationList.vue:50-52` | `onMounted(() => { void conversationStore.list() })` 无条件拉列表 | RealBackend 未连接时 REST 抛 `NOT_CONNECTED`；Mock 掩盖该问题 |
| `renderer/src/main.ts:20-24` | `onChatState` 只 `setState` + `handleConnectionStateChange`；`onChatReplay` 无条件 `loadReplay` | connected 后不触发会话初始化；replay 到达时 `currentId` 常为空 |
| `renderer/src/stores/conversation.store.ts:22-30` | `activate()` 无 epoch；先设 `currentId` 再拉历史，慢响应可覆盖快切换；无错误处理 | 快速 A→B 时 A 的迟到响应可把 UI 切回 A 或残留 loading |
| `renderer/src/stores/message.store.ts:80-133` | `applyEvent` 仅靠 `activeGenerationId` 守卫；`generation.started` 无条件替换全局 accumulator | A 的 `generation.started` 迟到到 B 会覆盖 B 的 accumulator；`loadReplay` 不校验 conversationId |
| `renderer/src/stores/message.store.ts:135-162,38-45` | `send()` 乐观插入 + `migrateKey`；切会话后迟到 ack 会把 A 的乐观消息重新插入 B 的 byId | send ack 竞态串台（见 4.2.5） |
| `renderer/src/stores/connection.store.ts:25-31` | `connect()` 失败改回 `disconnected` | 违反整改「连接失败保持可见 error 状态」；错误无 UI 展示 |
| `main/index.ts:110-112` | 构造 RealBackend 未传 `onProtocolWarning` / `onError` | 所有协议告警与后端错误静默丢弃 |
| `main/transport/real-backend.ts:238-252` | `connect()` 若 TCP 建连但无 `server_info` 可永久悬挂；`restFetch`（396-412）无 AbortController/超时 | 握手/ REST 无超时，UI 可长时间挂起 |
| `renderer/src/components/CyChatInput.vue:18-20` | `canSend` 只查草稿/sending/currentId，不查连接状态 | 断线时按钮看似可发送 |
| `renderer/src/components/CyConversationList.vue` / `CyChatView.vue` | 新建/重命名/删除/激活按钮未连接仍可点 | 未连接 REST 调用产生错误/挂起 |

### 3.2 技术约束（重要）

**generation 事件 conversationId 缺失。** `shared/contracts/events.ts` 中**只有 `generation.started` 带 `conversationId`**；`generation.delta`、`generation.segment.started`、`generation.segment.completed`、`generation.completed`、`generation.failed` 均不带。因此中间事件的会话归属必须经 **generationId → conversationId 映射**关联，不能直接读 `event.conversationId`。本批在 message store 建立该映射（见 4.2.1）。

**IPC 请求无法真正取消。** REST/activate 已在 Main 侧执行，renderer 无法收回已发出的 invoke。epoch 是 renderer 侧的防呆（只允许最新请求提交状态），不是取消。

**contextBridge 只保真 `message`。** 结构化错误跨进程经 message 前缀编码 + `parsePublicError` 反解（批次 A 已落地），本批沿用，不新增错误传输机制。

**Main 不拥有 Vue UI 状态。** 会话初始化编排必须落在 renderer 侧（Pinia store + 装配层接线），Main 只负责能力与方法。

**真实 WS 时序（关键）。** `server_info` 帧（→ connected push，此时 `activeConversationId` 仍 undefined）**恒先于** session 回放帧（`handleSession` 才 setState activeConversationId）。因此「connected push 到达时 activityConversationId 可能还没出现」，初始化编排必须容忍 `activeConversationId` 晚到（见 4.1.3）。

## 4. 设计

### 4.1 FE-P1-03：连接后会话初始化时序

**编排方：renderer 装配层（`renderer/src/main.ts`）。** 在 `onChatState` 收到 `connected` 时触发 `conversationStore.onConnected(s.connectionId)`；收到非 connected 时不触发。Main 侧不感知会话初始化。

#### 4.1.1 `conversationStore.onConnected(connectionId?: string)`

新增方法，幂等 + 区分首次/重连 + 就绪门控：

```ts
const initializedFor = ref<string>()   // 本次连接(connectionId)的初始化标记
const ready = ref(false)               // 初始化完成(D13):连接后列表/活动会话/首屏就绪才 true
const error = ref<PublicError>()       // 会话操作错误(供 UI 展示,见 4.2.4)
const busy = ref(false)                // 会话操作进行中(D22,供按钮 loading/防重复)

async function onConnected(connectionId?: string): Promise<void> {
  if (connectionId && initializedFor.value === connectionId) return   // 同一连接幂等
  if (connectionId === undefined && initializedFor.value !== undefined) return  // Mock 无 connectionId:只初始化一次(m3)
  initializedFor.value = connectionId ?? ''
  try {
    if (currentId.value) {
      // 重连/已有活动会话:只刷新列表 + reconcile 活动会话,不动已有历史(replay 按 messageId 去重合并)
      await safeList()
      const activeId = useConnectionStore().state.activeConversationId
      if (activeId && activeId !== currentId.value) await activate(activeId)   // I4:后端活动会话变了 → 切过去
      ready.value = true
      return
    }
    // 首次:完整初始化
    await safeList()
    ready.value = true            // 就绪门控(D13):列表刷新完成即就绪(N1:不依赖 activate,避免 C1 时序 ready 恒 false)
    if (currentId.value) return   // m6:safeList 期间用户已手动切会话,不再覆盖
    const activeId = useConnectionStore().state.activeConversationId
    if (activeId) await activate(activeId)   // 同步出现的 active:activate(applyPendingReplay + getMessages 首屏)
    // active 晚到(session 帧晚于 safeList):由 onActiveConversationAppeared 补激活(4.1.3),此处不设 currentId
  } catch (e) {
    error.value = parsePublicError(messageOf(e))
  }
}
```

- **幂等键**：`connectionId`（server_info 的 connectionId，重连时变化 → 重跑）；Mock 无 connectionId → 只初始化一次（m3 修正）。
- **空后端**：`activeId` 为 undefined 且 `currentId` 留空 → UI 显示空态，用户可新建。不静默伪造 currentId。
- **就绪门控（D13，整改 F1）**：`ready` 在初始化全流程完成后置 true。`canSend` 与会话管理按钮 = `status === 'connected' && ready`（4.4.3）。初始 `ready=false`；`connected` 时若 `ready` 仍 false，UI 禁操作（防首屏未加载就发送/建会话）。

#### 4.1.2 移除 `onMounted` 无条件 list

`CyConversationList.vue` 的 `onMounted(() => { void conversationStore.list() })` 移除。会话列表只在 `onConnected` 路径刷新（连接成功后）。组件内新建/删除/重命名完成后仍各自调 `list()`（现有逻辑保留，它们发生在已连接态）。

#### 4.1.3 replay/list 两种时序结果一致（pendingReplay 纯缓冲 + 活动会话晚到补激活）

`messageStore` 新增 `pendingReplay = ref<{ conversationId: string; messages: Message[] }>()`：

```ts
function loadReplay(conversationId: string, messages: Message[]): void {
  const cur = useConversationStore().currentId
  if (cur === conversationId) { for (const m of messages) upsertMessage({ ...m, conversationId }); return }
  if (cur === undefined) { pendingReplay.value = { conversationId, messages }; return }  // 未激活前一律缓冲(N1 修正:活动会话也缓冲,不设 currentId)
  guardDropReplay(conversationId)   // 非当前会话 replay,选项 A 不缓存,丢弃 + 记录
}
function applyPendingReplay(id: string): void {
  if (pendingReplay.value?.conversationId === id) {
    for (const m of pendingReplay.value.messages) upsertMessage({ ...m, conversationId: id })
  }
  pendingReplay.value = undefined   // 无论是否匹配都清空,防残留(m5)
}
```

`activate()` 内 `resetConversation` 之后调用 `applyPendingReplay(id)`（4.2.3）。三种时序结果一致：
- **list 先于 replay**：currentId 已设且匹配 → 直接合并去重。
- **replay 先于 list（活动会话晚到）**：`server_info` 先 connected（`activeConversationId` 未出现）→ `onConnected` 首次 list 时 activeId 为空、currentId 留空、replay 缓冲；session 帧到达 → connected push 携带 `activeConversationId` → `onActiveConversationAppeared(activeId)` 补 `activate`（applyPendingReplay 应用缓冲 + getMessages 拉首屏历史）。历史完整（N2）。
- **replay 先于 list（非活动会话）**：缓冲 → 后续 `activate` 应用并清空。

**活动会话晚到补激活（N1/N2 修正，替代 v2 的 C1 自足）：**

```ts
// conversationStore 方法:
async function onActiveConversationAppeared(activeId: string): Promise<void> {
  if (currentId.value) return          // 已激活/用户已手动切,不动
  if (busy.value) return               // 初始化/操作进行中,由激活流程覆盖
  await activate(activeId)             // applyPendingReplay(缓冲 replay) + getMessages 首屏
}
```

由 `renderer/src/main.ts` 在 `onChatState` 收到 connected 且携带 `activeConversationId` 时触发（见 4.5）。`ready` 由 `safeList` 完成后置位（4.1.1），不依赖该补激活，故 N1 的「C1 时序下 ready 恒 false」被消除。

#### 4.1.4 断线重连的本地乐观消息清理（I5）

断线时 in-flight 的 `send` 乐观消息以 `local-<uuid>` 为 key 留在 `byId`（Main disconnect 会 reject 该 ack → `send()` catch 置 failed）。重连后后端若已处理该消息，replay/历史带回 `serverMessageId`，与 `local-*` 不同 key → 同一条消息渲染两次（failed 幽灵 + 正式消息）。**去重只在 messageId 一致时生效，对 `local-*` 不成立。**

修复：`messageStore.handleConnectionStateChange`（reconnecting/error/disconnected 分支，现已有断线→in-flight 置 interrupted）追加清理 `byId` 中 `status === 'pending'` 且 key 以 `local-` 开头的用户消息（未确认，后端若已处理会经 replay 带回正式版本）：

```ts
function handleConnectionStateChange(s: ConnectionState): void {
  if (s.status !== 'reconnecting' && s.status !== 'error' && s.status !== 'disconnected') return
  for (const id of order.value) {
    const m = byId.value[id]
    if (m && m.role === 'user' && m.status === 'pending' && id.startsWith('local-')) {
      delete byId.value[id]; order.value.splice(order.value.indexOf(id), 1)
    }
  }
  // ... 现有 in-flight → interrupted 逻辑
}
```

#### 4.1.5 验收对应

- RealBackend guard 开启时应用挂载不产生 unhandled Promise（onMounted 不再裸调 list；store 方法内部 catch）；
- 连接已有活动会话的后端 → 列表、当前会话、第一页历史自动就绪（含 `activeConversationId` 晚到时由 onActiveConversationAppeared 补激活，N1/N2）；
- 空后端连接 → 空态 + 可新建；
- replay 先于 list / list 先于 replay / activeConversationId 晚于初始化决策 三种时序结果一致，且历史完整（4.1.3 onActiveConversationAppeared 补激活）；
- 断开后重连 → 只刷新列表 + reconcile 活动会话，不重复消息、不清空正确历史；断线 in-flight 乐观消息被清理（I5）。

### 4.2 FE-P1-04：conversation/epoch 守卫

#### 4.2.1 generation 事件归属守卫（message store）

新增 `generationByConversation = ref<Record<string, string>>({})`（generationId → conversationId，解决 3.2 的中间事件无 conversationId 问题）：

- **`generation.started`**：先校验 `event.conversationId === useConversationStore().currentId`；不符 → `guardDropEvent('generation.started', event.conversationId, event.generationId)` 并 `break`（**关键：防 A 的 started 迟到到 B 时覆盖 B 的 accumulator**）。相符 → 记录 `generationByConversation.value[event.generationId] = event.conversationId`，再走现有创建 accumulator 逻辑。
- **`generation.delta` / `generation.segment.started` / `generation.segment.completed` / `generation.completed` / `generation.failed`**：先查 `const conv = generationByConversation.value[event.generationId]`；`conv` 为 undefined 或 `!== useConversationStore().currentId` → `guardDropEvent(...)` 并 `break`（completed/failed 同样按 generationId 查表——它们是唯一可靠的归属手段，设计一致性确认正确）；相符 → 继续现有守卫（acc.generationId 匹配 + activeGenerationId 匹配，P2-5）与处理逻辑。
- **`resetConversation`**：追加清空 `generationByConversation.value = {}`。

`guardDropEvent(type, conversationId?, generationId?)`：`console.warn('cyrene:guard:drop', { type, conversationId, generationId })` + 计数 `droppedEvents.value++`。只记类型与 ID，**不记消息正文**。**取舍说明（D21，整改 F5）**：renderer 丢弃事件是**领域守卫**（非协议层），记录 `console.warn` + 计数器供调试/测试断言，UI 不展示、不进 Main 脱敏日志；协议层告警（非法帧等）由 Main `onProtocolWarning` 进脱敏日志（4.3.1）。两层职责不同：领域守卫不产生协议告警，不重复上报。

#### 4.2.2 replay 归属守卫（4.1.3 已覆盖）

`loadReplay` 校验 `currentId`：匹配 → 合并；未设 → 纯缓冲（活动会话晚到由 onActiveConversationAppeared 补激活，见 4.1.3）；不匹配 → 丢弃 + `guardDropReplay`。

#### 4.2.3 `conversationStore.activate(id)` 加 epoch + busy

新增模块级 `let epoch = 0`（store 闭包内）：

```ts
async function activate(id: string): Promise<void> {
  const myEpoch = ++epoch
  busy.value = true
  currentId.value = id               // 立即切走:保护 send/canSend 与事件守卫(即使后续失败也留在目标会话)
  const messageStore = useMessageStore()
  messageStore.resetConversation(id) // 选项 A:清空旧消息 + activeGenerationId + generationByConversation
  messageStore.applyPendingReplay(id)
  try {
    await api.activate(id)
    if (myEpoch !== epoch) return    // 已被更新的切换取代,不提交
    const p = await api.getMessages({ conversationId: id })
    if (myEpoch !== epoch) return
    messageStore.loadPage(p)
  } catch (e) {
    if (myEpoch !== epoch) return    // 被取代的请求失败不打扰
    error.value = parsePublicError(messageOf(e))
  } finally {
    if (myEpoch === epoch) busy.value = false
  }
}
```

- `loadPage`/`upsertMessage` 已按 messageId 去重（`order` 只对新 key 追加），维持稳定顺序（现有逻辑，不改）。
- `create()`（现 `await api.createConversation({})` + list + currentId）与 `remove()` 也按 4.2.4 加错误处理 + busy。

#### 4.2.4 会话操作错误处理 + busy（含 FE-P2-01 门控的 store 层）

`list` / `getMore` / `create` / `rename` / `remove` 均改为 try/catch 包住 api 调用，失败写 `error`（`parsePublicError`），**不向外抛**——组件调用方不再产生 unhandled rejection；操作期间置 `busy`，结束复位：

```ts
async function safeList(): Promise<void> {
  busy.value = true
  try { await list() } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { busy.value = false }
}
```

`activate` 已含 try/catch + busy（4.2.3）。`create`/`rename`/`remove` 同理（其内部本已 `await list()`，改为 `await safeList()`）。

**conversationStore.error 的 UI 消费（I2）**：`CyConversationList` 顶部渲染短横幅展示 `conversationStore.error`（会话操作失败可见，如激活/新建/删除失败；不清空已展示的连接错误）。

#### 4.2.5 send ack 竞态守卫（I1）

用户 A 发送（乐观 `local-xxx` 入 byId）→ 切到 B（`resetConversation` 清空）→ 迟到的 `send` resolve 带 `serverMessageId` → `migrateKey` 会把 A 的消息重新插回 B。修复 `migrateKey` 开头：

```ts
function migrateKey(oldKey: string, newKey: string, msg: Message): void {
  if (byId.value[oldKey] === undefined) return   // I1:乐观消息已被 resetConversation 清掉(切会话)则不重插
  if (oldKey === newKey) return
  const idx = order.value.indexOf(oldKey)
  if (idx >= 0) order.value[idx] = newKey
  delete byId.value[oldKey]
  msg.messageId = newKey
  byId.value[newKey] = msg
}
```

#### 4.2.6 验收对应

- 快速 A→B，A 的迟到 REST 响应不能把 UI 切回 A（epoch）；
- 切到 B 后收到 A replay，B 页面不出现 A 消息（4.2.2 丢弃）；
- 切到 B 后收到 A 的 `generation.started/delta/completed`，B 页面不被污染（4.2.1：started 校验 conversationId；中间事件查 generationByConversation）；
- 切到 B 后 A 的迟到 send ack 不把 A 消息插回 B（4.2.5）；
- 当前 B 的正常流式回复不受影响（匹配路径不变）；
- 重连 replay 与已有历史合并不重复（upsertMessage 去重 + I5 local-* 清理）。

### 4.3 FE-P1-05：错误链、协议告警与脱敏日志

#### 4.3.1 Main 侧接线（`main/index.ts`）

构造 adapter 时补传两个回调（用 const 桥容器 `chatBridge` 模式，现有 `onState`/`onReplay` 同理；`onProtocolWarning`/`onError` 闭包引用 `adapter`/`diagnostics`，回调只在 connect/运行时触发，构造时无需 adapter 已赋值）：

```ts
const extractPublic = (d: unknown): { backendCode?: string; retryable?: boolean; requestId?: string } => {
  const o = (d ?? {}) as Record<string, unknown>
  return {
    backendCode: typeof o.backendCode === 'string' ? o.backendCode : typeof o.code === 'string' ? o.code : undefined,
    retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
    requestId: typeof o.requestId === 'string' ? o.requestId : undefined
  }
}
const onProtocolWarning = (w: ProtocolWarning) => {
  const st = adapter.getConnectionState()
  diagnostics.logger.warn('protocol:warning', {
    code: w.code,
    message: sanitize(w.message),      // 脱敏兜底:不记录聊天正文/Token/原始整帧
    mode: useMock ? 'mock' : 'real',
    ...(st.serverVersion ? { serverVersion: st.serverVersion } : {}),
    ...(st.protocolVersion ? { protocolVersion: st.protocolVersion } : {})
  })
}
const onError = (err: CyreneError) => {
  const pub = extractPublic(err.details)
  diagnostics.logger.error('backend:error', { code: err.code, message: sanitize(err.message), ...pub })
  getMainWindow()?.webContents.send(PushChannels.error, { code: err.code, message: err.message, ...pub })   // 公开错误通道(新 push)
}
const adapter: BackendAdapter = useMock
  ? new MockBackend({ onConnectionStateChange: onState })
  : new RealBackend({ onConnectionStateChange: onState, onSessionReplay: onReplay, onProtocolWarning, onError })
```

- **`onProtocolWarning`**：接 `diagnostics.logger`（**warn 级**）。固定 `code` + 帧信息（message 已含帧类型短描述）+ 装配 mode + 后端 build（serverVersion/protocolVersion，若已知）。经 `sanitize` 脱敏兜底。**不记录**聊天正文、Token、原始整帧。
- **`onError`**：接 `diagnostics.logger`（error 级）+ **新公开错误通道** `PushChannels.error`。结构化字段 `{ code, message, backendCode?, retryable?, requestId? }` 推送 renderer。`extractPublic` 从 `CyreneError.details` 提取后端字段（兼容 `{ backendCode }` 与 `{ code }` 两种现有写法，见 real-backend `handleAck`/`handleErrorFrame`）。

#### 4.3.2 新 PushChannel 与 preload 订阅

- `shared/contracts/ipc.ts`：`PushChannels` 增加 `error: 'chat:error'`。
- `preload/desktop-api.ts`：新增 `onChatError(handler: (err: PublicErrorShape) => void)`（与 `onChatReplay` 同模式），`PublicErrorShape = { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string }`，加入返回对象。**白名单键 21 → 22**（m1，含排序：`onChatError` 插在 `onChatEvent` 与 `onChatReplay` 之间）。

#### 4.3.3 Renderer 消费与展示

- `connection.store.ts` 改造：
  - `connect()` 开始：`error.value = undefined`（现有）。
  - `connect()` 失败 catch：**不再改回 `disconnected`**，改为 `error.value = parsePublicError(...)`；`state.value = { status: 'error', lastError: error.value.message }`——保持可见 error 状态（整改必须修改 5）。
  - `setState`：收到 `connected`/`reconnecting` 时 `error.value = undefined`（成功后清理旧错误）。
  - 新增 `setError(err: PublicError): void`（`onChatError` 消费入口）：`error.value = err`。
- `renderer/src/main.ts`：接 `window.desktopApi.onChatError((err) => connectionStore.setError(err))`。
- **UI 展示**（整改验收「错误 UI 不依赖 DevTools 就能看见」）：
  - `CyConnectionPanel` 展示 `connectionStore.error`（连接/运行时错误，复用已有面板空间）。
  - `CyChatInput` 断线横幅：`reconnecting` → 现有「正在重连…」；`error` → 显示 `connectionStore.error?.message`（**不再用 `state.lastError`**，避免与面板重复）。
  - `messageStore.lastError` 继续管发送失败（批次 A 已有，QUEUE_FULL/STORAGE_UNAVAILABLE 等经它展示不同文案与 retryable）。

#### 4.3.4 限流口径（D20，整改 F4）

HTTP/WS 升级 **429/RATE_LIMITED** 走现有**重连退避**路径（real-backend 已实现：瞬态状态码视为本次连接失败、关闭 socket 后指数退避，UI 显示「重连中…」提示），**不新增** `RATE_LIMITED` 领域码（避免错误码扩散）。rejected ACK 的 `QUEUE_FULL` 等后端码经 `BACKEND_REJECTED` + `backendCode` 展示不同文案与 retryable（批次 A 已有）。§5 验收「限流可见」口径 = 重连中提示 + QUEUE_FULL 文案，spec 明示避免实现/验收口径差。

#### 4.3.5 验收对应

- 缺 Token、401、403、协议版本不匹配均有明确 UI（连接失败 → `state.error` + `connectionStore.error` 展示）；
- `QUEUE_FULL`、`STORAGE_UNAVAILABLE` 显示不同文案与 retryable（发送失败 → `messageStore.lastError`，批次 A 已结构化）；
- 429 限流 → 重连退避 + 「重连中」提示（D20）；
- 非法 raw frame 只进脱敏诊断（`RAW_FRAME_INVALID` → `onProtocolWarning` → logger，不泄漏原帧正文）；
- 新连接成功后旧错误消失（connect 开始清 error + connected 再清）；
- 错误 UI 不依赖 DevTools。

### 4.4 FE-P2-01：超时、取消与门控

#### 4.4.1 握手超时（RealBackend）

- 新增选项 `handshakeTimeoutMs`（默认 **10000**，测试可注入小值）。
- `connect()`：开头 `clearTimeout(reconnectTimer)` + `clearHandshakeTimer()`（**m4**：自动重连挂起期间手动 connect 会产生双 socket/双握手 timer，connect 前必须清旧 timer）；建立 connect promise 后启动握手 timer；`handleServerInfo` / `disconnect` / `onUnexpectedResponse` / `onSocketClosed` 均清除 timer。
- timer 超时回调，按是否在用户 connect 流程分派：

```ts
private clearHandshakeTimer(): void {
  if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined }
}
// connect() 开头:
this.clearHandshakeTimer(); if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
// establishWs() 每次建 socket:
this.handshakeTimer = setTimeout(() => {
  this.handshakeTimer = undefined
  this.ws?.close(); this.ws = undefined
  if (this.connectReject) {
    const err = new CyreneError(CyreneErrorCode.TIMEOUT, `等待 server_info 超时(${this.handshakeTimeoutMs}ms)`)
    this.connectReject(err); this.connectResolve = undefined; this.connectReject = undefined
    this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl })
    this.options.onError?.(err)
  } else {
    this.onSocketClosed()   // 自动重连无 connect promise:关闭后走指数退避
  }
}, this.handshakeTimeoutMs)
```

- `handleServerInfo`（收到 server_info）清除 timer（`this.clearHandshakeTimer()`）。**用户 connect() 不再永久悬挂**：TCP 建连但无 server_info 时 10s 内 fail-fast error；自动重连场景超时则继续退避。
- **重连握手超时最坏情况（m2）**：自动重连路径每次 `establishWs` 等满 `handshakeTimeoutMs`（10s）才退避，6 次尝试最坏约 **60s** 才到 error 态。spec 明确接受（整改只要求「connect 不永久悬挂」，用户主动 connect 恒 fail-fast 10s；自动重连的 60s 窗口有「重连中」提示），不额外优化缩短。

#### 4.4.2 REST 超时 + AbortController（RealBackend.restFetch）

- 新增选项 `restTimeoutMs`（默认 **10000**，测试可注入）。
- `restFetch` 增加 `AbortController` + 超时 timer；请求完成/失败时 `clearTimeout` + 从活跃集移除。**disconnect 触发的 abort 与真实超时区分（I3）**：

```ts
private readonly activeControllers = new Set<AbortController>()
private async restFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!this.serverUrl) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'REST 方法需先 connect')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), this.restTimeoutMs)
  this.activeControllers.add(controller)
  const url = `${this.serverUrl.replace(/\/$/, '')}${path}`
  try {
    const res = await (this.options.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal, headers: { ...(init?.headers as Record<string,string> | undefined), authorization: `Bearer ${this.token}`, 'content-type': 'application/json' } })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const code = (body as { code?: string }).code ?? 'HTTP_ERROR'
      throw new CyreneError(mapHttpError(res.status, code), (body as { message?: string }).message ?? `HTTP ${res.status}`, body)
    }
    return res
  } catch (e) {
    if (controller.signal.aborted) {
      // I3:disconnect 主动 abort(连接已断开) → NOT_CONNECTED;超时 timer abort → TIMEOUT
      if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开,请求已取消')
      throw new CyreneError(CyreneErrorCode.TIMEOUT, `REST 请求超时(${this.restTimeoutMs}ms): ${path}`)
    }
    throw e
  } finally {
    clearTimeout(timer)
    this.activeControllers.delete(controller)
  }
}
```

- `disconnect()`：遍历 `activeControllers` 全部 `abort()` 后清空（在现有 disconnect 逻辑中，与 ack/reconnect 清理并列）。`this.disconnected` 字段已存在（real-backend.ts:107），复用。

#### 4.4.3 操作门控

- **发送**（`CyChatInput.canSend`）：追加 `connectionStore.state.status === 'connected' && conversationStore.ready`。
- **会话管理**：`CyConversationList` 新建/重命名/删除/激活按钮、`CyChatView` 新建按钮在 `status !== 'connected' || !conversationStore.ready || conversationStore.busy` 时 `disabled`。用 computed `canAct`。
- **store 层 guard**：不额外强制（避免破坏 Mock/测试）；门控由组件 + store 内部错误处理共同覆盖。
- **无离线队列**（D12，§6）：断线时发送按钮禁用，不实现队列。UI 已由断线横幅提示。

#### 4.4.4 取消 in-flight

- **disconnect**：`RealBackend.disconnect` 已 `clearTimeout(reconnectTimer)`（现有）+ 新增 `clearHandshakeTimer()` + abort 所有 `activeControllers`（4.4.2）。
- **切换 Endpoint（D14，整改 F3）**：`chat-service.setEndpoint` 在 endpoint（origin 或 baseUrl）变化时先 `adapter.disconnect()` 再应用新配置——旧 WS 关闭、in-flight REST 被 abort、旧握手/重连 timer 清除，面板显示的新地址才与真实连接一致：

```ts
async setEndpoint(rawUrl: string): Promise<{ endpoint: string }> {
  const before = deps.connectionConfig.getEndpoint()
  const e = await deps.connectionConfig.setEndpoint(rawUrl)
  if (before && (e.origin !== before.origin || e.baseUrl !== before.baseUrl)) {
    await deps.adapter.disconnect()
  }
  return { endpoint: e.baseUrl }
}
```

- **应用退出**（D24，整改 F7）：`before-quit` → `createShutdownHandler`（现有）关闭诊断；adapter 断开由渲染进程随窗口关闭自然结束，**本批不做进程级强制**（进程退出即回收，风险低）。该条在最终报告/验收中显式列为「已决策推迟」。

#### 4.4.5 验收对应

- 握手无 `server_info` → 10s 内 `TIMEOUT` fail-fast（不永久悬挂）；
- REST 请求超时 → `TIMEOUT` 结构化错误；disconnect 主动取消 → `NOT_CONNECTED`（不误报超时）；
- 断线/切 Endpoint 后 in-flight REST 被 abort、旧 WS 关闭、timer 清理；
- 未连接或初始化未完成（`!ready`）时会话管理与发送动作禁用；操作中 `busy` 防重复；
- 所有用户动作进入 store 的 loading/error 状态，组件不产生 unhandled rejection。

### 4.5 跨项共享改动清单

| 文件 | 改动 |
|---|---|
| `shared/contracts/ipc.ts` | `PushChannels` 增 `error: 'chat:error'` |
| `preload/desktop-api.ts` | 新增 `onChatError`（含 `PublicErrorShape` 类型）+ 返回对象（白名单 21→22） |
| `main/transport/real-backend.ts` | `handshakeTimeoutMs`/`restTimeoutMs` 选项；握手 timer + `clearHandshakeTimer`；`connect()` 开头清 reconnect/handshake timer（m4）；`restFetch` AbortController+超时 + disconnect→`NOT_CONNECTED`（I3）；`activeControllers` + disconnect abort；`handleServerInfo`/`disconnect`/`onUnexpectedResponse`/`onSocketClosed` 接入 timer 清理 |
| `main/chat/chat-service.ts` | `setEndpoint` 在 endpoint 变化时 `adapter.disconnect()`（D14） |
| `main/index.ts` | 构造 RealBackend 传 `onProtocolWarning`/`onError`；`extractPublic` 辅助；`PushChannels.error` 推送 |
| `renderer/src/stores/connection.store.ts` | 失败保持 `error` 状态（不再改回 disconnected）；`setError`；connected/reconnecting 清 error |
| `renderer/src/stores/conversation.store.ts` | `onConnected`/`onActiveConversationAppeared`/`initializedFor`/`ready`/`error`/`busy`；`activate` 加 epoch+busy+applyPendingReplay；`safeList`；list/getMore/create/rename/remove 错误处理+busy；`onConnected` 幂等修正（m3）/safeList 后重查（m6）/重连 reconcile（I4） |
| `renderer/src/stores/message.store.ts` | `generationByConversation` 归属表；started 校验 conversationId；中间事件查表；`pendingReplay`/`applyPendingReplay`（纯缓冲，活动会话晚到由 conversationStore.onActiveConversationAppeared 补激活）；`migrateKey` 守卫（I1）；`handleConnectionStateChange` 清理 local-* 乐观消息（I5）；`guardDropEvent`/`guardDropReplay`/`droppedEvents`；resetConversation 清表 |
| `renderer/src/main.ts` | `onChatState` connected 触发 `onConnected` + 携带 `activeConversationId` 时触发 `onActiveConversationAppeared`；`onChatError` → `connectionStore.setError` |
| `renderer/src/components/CyConversationList.vue` | 移除 onMounted list；未连接/未就绪禁用会话管理按钮；顶部渲染 `conversationStore.error` 短横幅（I2） |
| `renderer/src/components/CyChatInput.vue` | `canSend` 加 connected+ready；error 横幅改用 `connectionStore.error` |
| `renderer/src/components/CyChatView.vue` | 新建按钮未连接/未就绪禁用 |
| `renderer/src/components/CyConnectionPanel.vue` | 展示 `connectionStore.error` |

## 5. 测试计划

**原则：** 单元测试覆盖纯逻辑/守卫/超时（不依赖真实 Electron）；集成测试覆盖 IPC 边界与装配；Mock 驱动的 renderer store 测试沿用现有 `*.store.spec.ts` 模式（mock desktop-api + pinia）。

### 5.1 单元测试（`tests/unit/`）

| 文件 | 覆盖 |
|---|---|
| `real-backend.spec.ts`（增） | 握手超时：fake-ws 建连但不发 server_info → `connect()` reject `TIMEOUT` + state error（注入 `handshakeTimeoutMs` 小值）；正常 server_info 清除 timer；disconnect 清除 timer；手动 connect 清旧 reconnect timer（m4，重连挂起时 connect 无双 socket）；REST 超时：`fetchImpl` 挂起 + 注入 `restTimeoutMs` → `TIMEOUT`；disconnect 主动 abort → `NOT_CONNECTED` 非 `TIMEOUT`（I3） |
| `chat-service.spec.ts`（增） | `setEndpoint` endpoint 变化 → `adapter.disconnect` 被调（D14）；同 endpoint 不调 |
| `conversation.store.spec.ts`（增） | `activate` epoch：快速 A→B→A 迟到 A 响应不覆盖；`onConnected` 幂等（同 connectionId 只跑一次）、首次（无 currentId）完整初始化、重连（有 currentId）只刷新列表 + reconcile（I4）、safeList 期间用户切会话不覆盖（m6）；空 activeId 留空 currentId；`safeList` 失败写 error 不抛；`ready` 初始 false、safeList 后 true（N1）；`onActiveConversationAppeared`：currentId 空 → activate、已设 → 不动、busy → 跳过（N1/N2） |
| `message.store.spec.ts`（增） | `generation.started` 非当前会话 → 丢弃 + `droppedEvents` 计数；当前会话正常；中间事件查 generationByConversation（非当前 → 丢弃；查无 → 丢弃）；`resetConversation` 清表；`loadReplay` 匹配/未设 currentId（纯缓冲）/不匹配（丢弃）；`applyPendingReplay` 应用并清空（不匹配也清空 m5）；`migrateKey` 旧 key 已清 → 不重插（I1）；`handleConnectionStateChange` 清理 local-* pending 消息（I5） |
| `connection.store.spec.ts`（增） | `connect` 失败 → state `error` + lastError（**不再回 disconnected**）；`setState` connected 清 error；`setError` 设置 |
| `desktop-api-chat.spec.ts`（增） | `PushChannels.error` 常量、`onChatError` 订阅接线、`PublicErrorShape` 透传 |

### 5.2 集成测试（`tests/integration/`）

| 文件 | 覆盖 |
|---|---|
| `ipc-security.spec.ts`（增） | **白名单键 22**（`onChatError` 加入，`onChatEvent` 与 `onChatReplay` 之间）+ 排序列表断言更新（m1）；`chat:error` 推送通道受信任（不在 Invoke 白名单，仅 push）；mock 装配下 `onChatError` 可从 Main 收到 |
| `trust-boundary.spec.ts`（增） | Main 构造 RealBackend（mock 分支跳过）时 `onProtocolWarning`/`onError` 已接线。**注意：** launchApp 恒 mock，无法直测 RealBackend 回调 → 用「helper 注入 RealBackend 构造选项 + fake-ws」在单元层覆盖；集成层只验证 push 通道与渲染消费接线（`onChatError` 注册后 renderer 收到结构化错误并写入 connectionStore） |

### 5.3 验收门禁

- `pnpm typecheck` / `pnpm lint` / `pnpm test`（361+ 单测）/ `pnpm test:integration`（20+ 集成）/ `pnpm build` 全绿；
- 整改清单批次 B 四项验收测试逐条可回溯（§4 各节「验收对应」）。

## 6. 关键决策记录

本批决策分三类：**用户拍板**（D1）、**设计定案**（D2–D12）、**review 修复轮新增**（D13–D24，本次 code-review 的 19 项 findings 整合后新增）。全部记录进文档并在最终报告提出。

| # | 决策点 | 定案 | 来源/理由 |
|---|---|---|---|
| D1 | 消息内存策略 | **选项 A：单会话全局 byId/order，切换清空重建**（切回 A 重新拉历史） | **用户拍板**。阶段 2 目标是「安全进入真实联调」非会话缓存体验；整改清单自述「按 conversation 分桶是可选完整方案，阶段 2 最小安全方案即可」 |
| D2 | 会话初始化编排方 | renderer 装配层（`main.ts` onChatState connected → `conversationStore.onConnected`） | 推荐。遵守「Main 不拥有 Vue UI 状态」；状态编排属 renderer 职责 |
| D3 | onMounted 策略 | 移除无条件 `list()`；会话列表统一由连接成功后的 `onConnected` 刷新 | 推荐。RealBackend 未连接 REST 必抛 `NOT_CONNECTED`，挂载拉取无意义 |
| D4 | replay/list 时序 | `messageStore.pendingReplay` 纯缓冲 + `conversationStore.onActiveConversationAppeared` 补激活；`activate` 内 `applyPendingReplay` | 推荐。IPC 通道顺序无保证，缓冲使时序一致 |
| D5 | 非当前会话事件处理 | 丢弃 + renderer 协议告警（`console.warn` + `droppedEvents` 计数，不记正文） | 推荐（与 D1 绑定）。选项 A 无按会话缓存，非当前事件无法归属展示 |
| D6 | epoch 机制 | conversationStore 模块级递增数字，最新请求才提交 currentId/历史/error | 推荐。IPC 无法真正取消，数字 epoch 是 renderer 侧防呆（3.2） |
| D7 | generation 中间事件归属 | `generationByConversation`（generationId→conversationId）映射表，started 记录、中间事件查表 | 推荐。events.ts 只有 started 带 conversationId（3.2 技术约束），查表是唯一可靠归属手段 |
| D8 | onProtocolWarning | Main 接 `diagnostics.logger` **warn 级**：固定 code + 帧信息 + mode + build，经 sanitize | 推荐。整改「必须修改 1」；日志是唯一消费者，不进 UI/审计 |
| D9 | onError 路由 | Main `logger.error` + 新 `PushChannels.error` → renderer `connectionStore.error` 展示 | 推荐。整改「必须修改 2」（公开错误通道）；连接失败由 `state.error` 覆盖，运行时错误帧走此通道 |
| D10 | 超时常量 | 握手 `server_info` 10s、REST 10s（均可注入）；ACK 15s（已有） | 推荐。整改「建议修改 1」；10s 平衡「不悬挂」与「慢网络容忍」 |
| D11 | 门控范围 | `canSend` 加 connected；会话管理按钮未连接禁用；store 层操作内部 catch 进 error 状态 | 推荐。整改「建议修改 3/4」；组件禁用（UX）+ store 吞错（防 unhandled）双保险 |
| D12 | 离线队列 | **不实现队列**，断线发送按钮禁用（`canSend` 查 connected） | 推荐。整改「建议修改 5」二选一；队列属阶段 3 离线增强，非联调阻断 |
| D13 | 初始化就绪门控 | `conversationStore.ready`：初始化全流程完成才 true；`canSend`/会话管理 = `connected && ready` | review 修复（整改 F1）。防「connected 已推送但首屏历史未加载」窗口内误操作 |
| D14 | setEndpoint 联动取消 | endpoint（origin/baseUrl）变化时先 `adapter.disconnect()` | review 修复（整改 F3）。否则面板显示新地址但旧 WS/REST 存活 |
| D15 | 活动会话晚到补激活 | `loadReplay` 一律纯缓冲；新增 `conversationStore.onActiveConversationAppeared(activeId)`：connected push 首次携带 `activeConversationId` 时补 `activate`（应用缓冲 replay + 拉首屏历史） | review 修复（设计 C1 critical + N1/N2）。解决「session 帧晚于 safeList → pendingReplay 孤儿」，且不引入 ready 死锁（N1）、保证历史完整（N2） |
| D16 | send ack 竞态守卫 | `migrateKey` 开头：旧 key 已清（切会话）则不重插 | review 修复（设计 I1）。A 的迟到 ack 不再污染 B |
| D17 | disconnect abort 语义 | restFetch catch：`aborted && disconnected` → `NOT_CONNECTED`，否则 `TIMEOUT` | review 修复（设计 I3）。用户主动断线不误报「超时」 |
| D18 | 重连 reconcile | `onConnected` 重连分支 safeList 后比较 currentId 与 activeConversationId，不一致 → activate | review 修复（设计 I4）。断线期间后端活动会话变化时本端跟随 |
| D19 | 断线清理 local-* 乐观消息 | `handleConnectionStateChange` 断线分支清理 `pending` 的 `local-*` 用户消息 | review 修复（设计 I5）。防重连后同一消息渲染两次（failed 幽灵 + 正式） |
| D20 | 限流口径 | 429/RATE_LIMITED 走重连退避 + 「重连中」提示；不新增 `RATE_LIMITED` 领域码 | review 修复（整改 F4）。避免错误码扩散；QUEUE_FULL 经 BACKEND_REJECTED 展示 |
| D21 | renderer 丢弃事件取舍 | `console.warn` + `droppedEvents` 计数，不进 Main 脱敏日志 | review 修复（整改 F5）。领域守卫非协议层，两层职责不同，不重复上报 |
| D22 | 会话操作 busy | `conversationStore.busy`：list/activate/create/rename/remove 期间置 true，按钮禁用防重复 | review 修复（整改 F6）。满足「进入 loading/error 状态」 |
| D23 | 重连握手超时 | 自动重连路径 10s/次，最坏 ~60s 到 error；用户 connect 恒 fail-fast 10s | review 修复（设计 m2）。整改只要求「不永久悬挂」，60s 窗口有「重连中」提示 |
| D24 | 应用退出取消 in-flight | 本批不做进程级强制，依赖窗口关闭自然回收 | review 修复（整改 F7）。进程退出即回收，风险低；验收时显式列为已决策推迟 |

## 7. 不在本次范围

- FE-P2-02/03/04（批次 C）；
- 按 conversation 分桶缓存多会话、虚拟列表、历史查看器（阶段 3）；
- 附件、搜索、模型/语音、dictation、Live2D、工具执行（阶段 3+）；
- 进程级 in-flight 强制取消（应用退出时依赖窗口自然结束，D24）；
- 离线发送队列（D12）；
- 429 独立领域码与专属 UI（D20，走重连退避）；
- ConnectionState 接口结构不变（保持 `lastError: string`，renderer 侧用 `connectionStore.error` 结构化展示）。

## 8. 风险与预案

| 风险 | 预案 |
|---|---|
| `generationByConversation` 表与现有 `activeGenerationId` 守卫重叠导致行为变化 | 表只作归属判定，不清除任何现有守卫；中间事件需同时过表 + 现有守卫才处理 |
| pendingReplay 缓冲在多会话交替时残留 | `applyPendingReplay` 无论匹配与否都清空（m5）；活动会话晚到由 onActiveConversationAppeared 补激活，不走缓冲 |
| ready 早于历史加载（首屏未加载即可发送/建会话）窗口（N-a） | 可接受：currentId 已设、消息落盘、后续操作错误可见；若需 D13 语义「就绪=首屏可用」保真，可把 ready 移到补激活完成后（现不阻塞设计） |
| `onActiveConversationAppeared` busy 跳过且无重触发（N-b） | 极窄窗口（safeList 完成到 session 帧到达间恰发起的操作吞掉补激活，ms 级），接受；用户可手动点会话兜底 |
| 首连 `safeList()` 抛错 → `ready` 恒 false，需断线重连恢复（N-c） | 接受：初始化失败 error 可见，同连接幂等不重跑，重连（connectionId 变化）重试 |
| 握手超时与重连退避交互（超时后 state error → 后续 close/error 早退） | 超时回调先 close 再分派；state error 后 `onSocketClosed` 早退（现有守卫），不 double-handle |
| `onError` 在连接失败路径与 `connect()` catch 重复推送 | renderer 统一 `connectionStore.error` 单字段，覆盖无害；`state.lastError` 不再在 UI 单独展示（用 error.message） |
| 未连接/未就绪禁用会破坏现有 Mock 演示交互 | Mock 装配下仍需先连接（connect 后 connected + ready），与真实模式行为一致；测试改用「连接后」断言 |
| `onActiveConversationAppeared` 与用户手动切会话并发 | currentId 已设/busy 时跳过（方法内守卫）；补激活只发生在 currentId 空且非 busy |
| 首连 `activate(activeId)` 吞错后 `ready` 仍 true（N3） | 可接受取舍：激活失败写 error（UI 可见），currentId 已切到用户选择会话，后续操作错误可见；不额外让 ready 依赖 activate 结果（否则回退 N1） |
| setEndpoint 断开会清掉当前连接（用户可能只改 path 不想断） | 仅 endpoint（origin/baseUrl）变化时断开；同 endpoint 重设不打断（幂等） |
