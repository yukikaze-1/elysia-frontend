# 批次 B 真实连接编排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地批次 B 四项整改——连接后会话初始化时序（FE-P1-03）、conversation/epoch 守卫（FE-P1-04）、可见错误链与脱敏日志（FE-P1-05）、超时/取消/门控（FE-P2-01），使阶段 2「连接→会话→发送→ACK→流式→重连回放」可安全进入真实联调。

**Architecture:** 初始化编排在 renderer（`conversationStore.onConnected` + `onActiveConversationAppeared` 补激活 + `pendingReplay` 纯缓冲）；事件归属守卫在 renderer store（`generationByConversation` 表 + epoch）；错误链跨 Main/Preload/Renderer（Main `onProtocolWarning`/`onError` 接线 + 新 `PushChannels.error`）；超时/取消在 Main RealBackend（握手/REST 超时 + disconnect abort）。

**Tech Stack:** Electron 43 + Vue 3 + TypeScript + Pinia + Zod + Vitest（单元）+ Electron 集成测试。测试用 `pnpm`（**非 conda**——前端测试不用 conda 环境）。

**v3 变更（plan review 两轮闭环）：** v2 已重排任务（原 Task 7/8 对调，message.store 守卫先行解决 `applyPendingReplay` 前置引用 C1）+ 整合可执行性审查全部 findings（C2 abort-aware mock、I1 index.d.ts、I2 模块化 TDD、I3/I4 正向测试、I5 断言、I6 trust-boundary、M1–M5）；v3 再整合接口核验 8 findings（F1 Task4 mock 补 subscribe、F2 现有 message.store.spec 用例须更新、F3 现有 connection.store.spec 断言须更新、F4 白名单插入位置改 listConversations 与 onChatEvent 之间、F6 makeOpts 依赖 fakeWs、F8 conversation.store 自定 messageOf、F10 CyConnectionPanel 已有 error 展示、F11 local-* 清理插早退前）。

---

## Global Constraints

- **选项 A 消息内存策略**：单会话全局 `byId/order`，切换会话清空重建（spec D1，用户拍板）。
- **generation 中间事件无 `conversationId`**：`delta/segment.*/completed/failed` 只能经 `generationByConversation`（generationId→conversationId）表判归属；表只在 `generation.started`（唯一带 conversationId 的事件）记录。
- **IPC 无法真正取消**：epoch 是 renderer 侧防呆（递增数字，最新请求才提交），不是取消。
- **contextBridge 只保真 `message`**：结构化错误跨进程经 message 前缀编码 + `parsePublicError` 反解（批次 A 已有），本批不新增错误传输机制。
- **Main 不拥有 Vue UI 状态**：初始化编排在 renderer 装配层（`renderer/src/main.ts` onChatState 接线）。
- **不新增 `RATE_LIMITED` 领域码**：429/RATE_LIMITED 走重连退避 + 「重连中」提示（spec D20）。
- **`ConnectionState` 接口结构不变**：保持 `lastError: string`；renderer 侧用 `connectionStore.error`（PublicError）结构化展示。
- **门控 = `status === 'connected' && conversationStore.ready`**（spec D13）；操作中 `busy` 防重复。
- **preload 白名单 21 → 22**：`onChatError` 插在 **`listConversations` 与 `onChatEvent` 之间**（F4：断言是 `Object.keys().sort()`，`'onChatError' < 'onChatEvent'` 因第 8 字符 r<v；返回对象声明序非字母序，与排序断言解耦）。
- **握手超时 10s、REST 超时 10s**（均可注入）；ACK 15s 已有。
- **`disconnect` 主动 abort → `NOT_CONNECTED`，超时 timer abort → `TIMEOUT`**（spec I3/D17）。
- **真实测试夹具**：`tests/unit/real-backend.spec.ts` 无 `baseOpts` 变量，选项为内联 `{ now: () => Date.now(), wsFactory: () => fakeWs() }`（`fakeWs` 在 242 行）；新测试复用该模式，可定义本地 `makeOpts(overrides)`。
- 规范：`pnpm -F @cyrene/desktop typecheck` / `lint` / `test` / `test:integration` / `build` 全绿后提交。

---

### Task 1: 共享 PushChannel + preload onChatError + Window 类型

**Files:**
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`（I1：`Window.desktopApi` 字面量加 `onChatError`，否则 Task 9 的 `window.desktopApi.onChatError` 在 web tsconfig 下 typecheck 失败）
- Test: `apps/desktop/tests/unit/desktop-api-chat.spec.ts`

**Interfaces:**
- Consumes: `PushChannels`（现有 `{ event, state, replay }`）、`ipcRenderer.on/removeListener`。
- Produces: `PushChannels.error = 'chat:error'`；`desktopApi.onChatError(handler: (err: PublicErrorShape) => void): () => void`；`PublicErrorShape = { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string }`（导出自 `desktop-api.ts`）。

- [ ] **Step 1: 写失败测试（含 I4 完整断言）**

`tests/unit/desktop-api-chat.spec.ts` 追加（沿用该文件现有 mockIpc emit 基建）：

```ts
it('PushChannels.error = chat:error', () => {
  expect(PushChannels.error).toBe('chat:error')
})
it('onChatError 合法载荷送达 + PublicErrorShape 字段透传', () => {
  const handler = vi.fn()
  const unsub = desktopApi.onChatError(handler)
  mockIpc.emit(PushChannels.error, { code: 'BACKEND_REJECTED', message: '队列满', backendCode: 'QUEUE_FULL', retryable: true, requestId: 'r1' })
  expect(handler).toHaveBeenCalledWith({ code: 'BACKEND_REJECTED', message: '队列满', backendCode: 'QUEUE_FULL', retryable: true, requestId: 'r1' })
  unsub()
})
it('onChatError 非法载荷(缺 code/message)丢弃 + unsub 后不再收', () => {
  const handler = vi.fn()
  const unsub = desktopApi.onChatError(handler)
  mockIpc.emit(PushChannels.error, { foo: 1 })
  unsub()
  mockIpc.emit(PushChannels.error, { code: 'X', message: 'x' })
  expect(handler).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test desktop-api-chat`
Expected: FAIL（`PushChannels.error` 不存在 / `onChatError` 不存在）

- [ ] **Step 3: 实现 `PushChannels.error` + `onChatError` + Window 类型**

`shared/contracts/ipc.ts`：

```ts
export const PushChannels = { event: 'chat:event', state: 'chat:state', replay: 'chat:replay', error: 'chat:error' } as const
```

`preload/desktop-api.ts`（参照 `onChatReplay` 模式）：

```ts
export interface PublicErrorShape {
  code: string
  message: string
  backendCode?: string
  retryable?: boolean
  requestId?: string
}
function isPublicErrorShape(v: unknown): v is PublicErrorShape {
  return !!v && typeof v === 'object' && typeof (v as PublicErrorShape).code === 'string' && typeof (v as PublicErrorShape).message === 'string'
}
function onChatError(handler: (err: PublicErrorShape) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => { if (isPublicErrorShape(payload)) handler(payload) }
  ipcRenderer.on(PushChannels.error, listener)
  return () => { ipcRenderer.removeListener(PushChannels.error, listener) }
}
```

返回对象加 `onChatError`（声明序不限，白名单断言独立 sort()）。`preload/index.d.ts` 的 `Window.desktopApi` 字面量中 `onChatReplay` 后加 `onChatError(handler: (err: import('./desktop-api').PublicErrorShape) => void): () => void`（或与 `onChatReplay` 同风格声明）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test desktop-api-chat && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/index.d.ts apps/desktop/tests/unit/desktop-api-chat.spec.ts
git commit -m "feat(批次B T1): PushChannels.error + preload onChatError + Window 类型(白名单基座)"
```

---

### Task 2: RealBackend 握手超时 + connect 清旧 timer

**Files:**
- Modify: `apps/desktop/src/main/transport/real-backend.ts`
- Test: `apps/desktop/tests/unit/real-backend.spec.ts`

**Interfaces:**
- Consumes: `RealBackendOptions`（现有 `fetchImpl/now/wsFactory/onProtocolWarning/onSessionReplay/onError/onConnectionStateChange/ackTimeoutMs/reconnectBaseDelayMs`）、`this.reconnectTimer`、`this.disconnected`、`this.connectResolve/connectReject`、`this.ws`；测试夹具 `{ now, wsFactory: () => fakeWs() }`（**无 `baseOpts`**，用本地 `makeOpts`）。
- Produces: 选项 `handshakeTimeoutMs`（默认 10000）；`private handshakeTimer`；`private clearHandshakeTimer()`。

- [ ] **Step 1: 写失败测试（握手超时，I3 正向测试同批写）**

`tests/unit/real-backend.spec.ts` 追加：

```ts
const makeOpts = (o: Partial<RealBackendOptions> = {}) => ({ now: () => Date.now(), wsFactory: () => fakeWs(), ...o })

it('握手超时:建连但不发 server_info → connect reject TIMEOUT + state error', async () => {
  const b = new RealBackend(makeOpts({ handshakeTimeoutMs: 20 }))   // wsFactory 只触发 open,不推帧
  const p = b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })
  await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
  expect(b.getConnectionState().status).toBe('error')
})
it('正常 server_info 到达 → 握手 timer 清除,不超时(I3 正向)', async () => {
  const b = new RealBackend(makeOpts({ handshakeTimeoutMs: 50 }))
  await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })   // fakeWs 推 server_info → resolve
  expect(b.getConnectionState().status).toBe('connected')
})
it('disconnect 清除握手 timer,不再触发超时回调', async () => {
  const b = new RealBackend(makeOpts({ handshakeTimeoutMs: 200 }))
  const p = b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })
  await b.disconnect()
  await expect(p).rejects.toMatchObject({ code: 'NOT_CONNECTED' })   // 由 disconnect 取消,非 TIMEOUT
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test real-backend`
Expected: FAIL（connect 无超时，永久 pending / disconnect 不 reject）

- [ ] **Step 3: 实现握手 timer**

`real-backend.ts` 加字段与方法：

```ts
private handshakeTimer?: ReturnType<typeof setTimeout>
private clearHandshakeTimer(): void {
  if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined }
}
```

`connect()` 开头清旧 timer（m4：重连挂起时手动 connect 防双 socket）：

```ts
this.clearHandshakeTimer()
if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
```

`establishWs()` 建 socket 后启动 timer；`handleServerInfo()` / `onSocketClosed()` / `onUnexpectedResponse()` / `disconnect()` 均 `this.clearHandshakeTimer()`。超时回调按是否在用户 connect 流程分派：

```ts
this.handshakeTimer = setTimeout(() => {
  this.handshakeTimer = undefined
  this.ws?.close(); this.ws = undefined
  if (this.connectReject) {
    const err = new CyreneError(CyreneErrorCode.TIMEOUT, `等待 server_info 超时(${this.handshakeTimeoutMs}ms)`)
    this.connectReject(err); this.connectResolve = undefined; this.connectReject = undefined
    this.setState({ status: 'error', lastError: err.message, serverUrl: this.serverUrl })
    this.options.onError?.(err)
  } else {
    this.onSocketClosed()   // 自动重连:关闭后走指数退避
  }
}, this.handshakeTimeoutMs)
```

- [ ] **Step 4: 补 m4 测试（重连挂起时 connect 无双 socket）**

```ts
it('重连挂起时手动 connect 清旧 reconnect/handshake timer(无双 socket)', async () => {
  // 构造:首次 connect 后断开触发 scheduleReconnect(reconnectTimer 已排),此时再 connect()
  // 断言 establishWs 只调用一次(旧 timer 被清,不会二次建立 socket)
  let wsCreateCount = 0
  const b = new RealBackend(makeOpts({ wsFactory: (_u, _h) => { wsCreateCount++; return fakeWs() }, reconnectBaseDelayMs: 100000, handshakeTimeoutMs: 100 }))
  await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })   // 成功(server_info)
  await b.disconnect()                                               // 触发? disconnect 直接 disconnected,不走重连
  // 改为:构造 reconnecting 态再手动 connect,见下方实现后校准
})
```

> 若该时序难以直接构造，用 `now()` 注入 + 缩短 `reconnectBaseDelayMs` 让重连先排 timer，再 `connect()` 断言 `wsCreateCount === 1`。实现后校准。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test real-backend && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/transport/real-backend.ts apps/desktop/tests/unit/real-backend.spec.ts
git commit -m "feat(批次B T2): RealBackend 握手超时 10s + connect 清旧 timer"
```

---

### Task 3: RealBackend REST 超时 + AbortController + disconnect abort

**Files:**
- Modify: `apps/desktop/src/main/transport/real-backend.ts`
- Test: `apps/desktop/tests/unit/real-backend.spec.ts`

**Interfaces:**
- Consumes: `restFetch`（现有）、`disconnect()`、`this.disconnected`；`makeOpts`（Task 2 定义）。
- Produces: 选项 `restTimeoutMs`（默认 10000）；`private readonly activeControllers = new Set<AbortController>()`。

> **F6 注**：`makeOpts` 的默认 `wsFactory: () => fakeWs()`（fakeWs 推 session + server_info → connect 可 resolve，不悬挂）；若缺 wsFactory，`await b.connect(...)` 会对 127.0.0.1:1 建连失败走退避悬挂。

- [ ] **Step 1: 写失败测试（C2：mock 必须 abort-aware）**

```ts
// abort-aware fetch:挂起直到 signal abort(真实实现靠它触发 TIMEOUT/取消)
const abortAwareFetch = (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
})

it('REST 超时:fetchImpl 挂起且 abort-aware → TIMEOUT', async () => {
  const b = new RealBackend(makeOpts({ fetchImpl: abortAwareFetch as never, restTimeoutMs: 20 }))
  await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })
  await expect(b.listConversations({})).rejects.toMatchObject({ code: 'TIMEOUT' })
})
it('disconnect 主动 abort → NOT_CONNECTED 而非 TIMEOUT', async () => {
  const b = new RealBackend(makeOpts({ fetchImpl: abortAwareFetch as never, restTimeoutMs: 10000 }))
  await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })
  const p = b.listConversations({})   // 挂起
  await b.disconnect()                // abort 全部 activeControllers
  await expect(p).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test real-backend`
Expected: FAIL（restFetch 无超时/无 abort，永久 pending）

- [ ] **Step 3: 实现 restFetch 超时 + abort 语义（spec §4.4.2）**

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
      if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开,请求已取消')   // I3/D17
      throw new CyreneError(CyreneErrorCode.TIMEOUT, `REST 请求超时(${this.restTimeoutMs}ms): ${path}`)
    }
    throw e
  } finally {
    clearTimeout(timer)
    this.activeControllers.delete(controller)
  }
}
```

`disconnect()` 现有逻辑追加：

```ts
for (const c of this.activeControllers) c.abort()
this.activeControllers.clear()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test real-backend && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/real-backend.ts apps/desktop/tests/unit/real-backend.spec.ts
git commit -m "feat(批次B T3): RealBackend REST 超时+AbortController, disconnect abort→NOT_CONNECTED"
```

---

### Task 4: chat-service.setEndpoint 联动断开

**Files:**
- Modify: `apps/desktop/src/main/chat/chat-service.ts`
- Test: `apps/desktop/tests/unit/chat-service.spec.ts`

**Interfaces:**
- Consumes: `deps.connectionConfig.getEndpoint()/setEndpoint(rawUrl)`（返回 `NormalizedEndpoint` 含 `origin`/`baseUrl`）、`deps.adapter.disconnect()`。
- Produces: `setEndpoint(rawUrl)`：endpoint（origin 或 baseUrl）变化时 `adapter.disconnect()`（spec D14；顺序为「先 setEndpoint 应用 → 再 disconnect」——需先规范化才知是否变化，M1 已在 spec 正文措辞修正）。

- [ ] **Step 1: 写失败测试**

```ts
it('setEndpoint endpoint 变化 → adapter.disconnect 被调', async () => {
  const adapter = { subscribe: () => () => {}, disconnect: vi.fn(async () => {}) }
  const connConfig = {
    getEndpoint: () => ({ origin: 'http://a', baseUrl: 'http://a' }),
    setEndpoint: vi.fn(async () => ({ origin: 'http://b', baseUrl: 'http://b' }))
  }
  const svc = createChatService({ adapter: adapter as never, send: () => {}, getToken: () => undefined, connectionConfig: connConfig as never })
  await svc.setEndpoint('http://b')
  expect(connConfig.setEndpoint).toHaveBeenCalledWith('http://b')
  expect(adapter.disconnect).toHaveBeenCalled()
})
it('setEndpoint 同 endpoint → 不 disconnect(幂等)', async () => {
  const adapter = { subscribe: () => () => {}, disconnect: vi.fn(async () => {}) }
  const connConfig = { getEndpoint: () => ({ origin: 'http://a', baseUrl: 'http://a' }), setEndpoint: async () => ({ origin: 'http://a', baseUrl: 'http://a' }) }
  const svc = createChatService({ adapter: adapter as never, send: () => {}, getToken: () => undefined, connectionConfig: connConfig as never })
  await svc.setEndpoint('http://a')
  expect(adapter.disconnect).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test chat-service`
Expected: FAIL（当前 setEndpoint 不调 disconnect）

- [ ] **Step 3: 实现**

```ts
async setEndpoint(rawUrl: string): Promise<{ endpoint: string }> {
  const before = deps.connectionConfig.getEndpoint()
  const e = await deps.connectionConfig.setEndpoint(rawUrl)
  if (before && (e.origin !== before.origin || e.baseUrl !== before.baseUrl)) {
    await deps.adapter.disconnect()   // D14:旧 WS/REST 取消,面板新地址与真实连接一致
  }
  return { endpoint: e.baseUrl }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test chat-service && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/chat/chat-service.ts apps/desktop/tests/unit/chat-service.spec.ts
git commit -m "feat(批次B T4): setEndpoint endpoint 变化联动 adapter.disconnect"
```

---

### Task 5: backend-error-handlers 模块（onProtocolWarning/onError）+ main 接线

**Files:**
- Create: `apps/desktop/src/main/chat/backend-error-handlers.ts`（I2：抽成可单测纯模块）
- Modify: `apps/desktop/src/main/index.ts`
- Test: Create `apps/desktop/tests/unit/backend-error-handlers.spec.ts`

**Interfaces:**
- Consumes: `Logger`、`MessageSanitizer`、`getMainWindow`（注入）、`PushChannels.error`、`ProtocolWarning`、`CyreneError`。
- Produces: `buildBackendErrorHandlers(deps)` 返回 `{ onProtocolWarning(w: ProtocolWarning): void; onError(err: CyreneError): void }`；`main/index.ts` 用它构造 RealBackend 回调。

- [ ] **Step 1: 写失败测试（先测试后实现，I2 TDD）**

`tests/unit/backend-error-handlers.spec.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { buildBackendErrorHandlers } from '../../src/main/chat/backend-error-handlers'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'

const noopSanitize = (m: string): string => m

describe('buildBackendErrorHandlers', () => {
  it('onError → logger.error(backend:error, {code,message,+pub})', () => {
    const logger = { error: vi.fn(), warn: vi.fn() } as never
    const send = vi.fn()
    const h = buildBackendErrorHandlers({ logger, sanitize: noopSanitize, send, mode: 'real', getBuild: () => ({}) })
    h.onError(new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '队列满', { backendCode: 'QUEUE_FULL', retryable: true }))
    expect(logger.error).toHaveBeenCalledWith('backend:error', { code: 'BACKEND_REJECTED', message: '队列满', backendCode: 'QUEUE_FULL', retryable: true })
    expect(send).toHaveBeenCalledWith('chat:error', { code: 'BACKEND_REJECTED', message: '队列满', backendCode: 'QUEUE_FULL', retryable: true })
  })
  it('onError message 经 sanitize;details 兼容 {code} 写法', () => {
    const sanitize = (m: string) => m.replace(/sk-\w+/g, '[REDACTED]')
    const logger = { error: vi.fn(), warn: vi.fn() } as never
    const h = buildBackendErrorHandlers({ logger, sanitize, send: vi.fn(), mode: 'real', getBuild: () => ({}) })
    h.onError(new CyreneError(CyreneErrorCode.UNKNOWN, 'bad sk-abc123', { code: 'WS_ERROR' }))
    expect(logger.error).toHaveBeenCalledWith('backend:error', { code: 'UNKNOWN', message: 'bad [REDACTED]', backendCode: 'WS_ERROR' })
  })
  it('onProtocolWarning → logger.warn(protocol:warning, {code,message,mode,+build})', () => {
    const logger = { error: vi.fn(), warn: vi.fn() } as never
    const h = buildBackendErrorHandlers({ logger, sanitize: noopSanitize, send: vi.fn(), mode: 'real', getBuild: () => ({ serverVersion: 'v1', protocolVersion: '2.0' }) })
    h.onProtocolWarning({ code: 'RAW_FRAME_INVALID', message: '帧校验失败' })
    expect(logger.warn).toHaveBeenCalledWith('protocol:warning', { code: 'RAW_FRAME_INVALID', message: '帧校验失败', mode: 'real', serverVersion: 'v1', protocolVersion: '2.0' })
  })
  it('onProtocolWarning message 经 sanitize', () => { /* 同上 sanitize 断言 */ })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test backend-error-handlers`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现模块**

`apps/desktop/src/main/chat/backend-error-handlers.ts`：

```ts
import type { ProtocolWarning } from '@shared/contracts/protocol'
import { PushChannels } from '@shared/contracts/ipc'
import type { CyreneError } from '@shared/errors'
import type { Logger } from '../diagnostics/logger'
import type { MessageSanitizer } from '../diagnostics/sanitize'

const extractPublic = (d: unknown): { backendCode?: string; retryable?: boolean; requestId?: string } => {
  const o = (d ?? {}) as Record<string, unknown>
  return {
    backendCode: typeof o.backendCode === 'string' ? o.backendCode : typeof o.code === 'string' ? o.code : undefined,
    retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
    requestId: typeof o.requestId === 'string' ? o.requestId : undefined
  }
}

export interface BackendErrorHandlerDeps {
  logger: Logger
  sanitize: MessageSanitizer
  send: (channel: string, payload: unknown) => void   // webContents.send 包装
  mode: 'real' | 'mock'
  getBuild: () => { serverVersion?: string; protocolVersion?: string }
}

export function buildBackendErrorHandlers(deps: BackendErrorHandlerDeps): {
  onProtocolWarning(w: ProtocolWarning): void
  onError(err: CyreneError): void
} {
  return {
    onProtocolWarning(w) {
      const b = deps.getBuild()
      deps.logger.warn('protocol:warning', {
        code: w.code,
        message: deps.sanitize(w.message),
        mode: deps.mode,
        ...(b.serverVersion ? { serverVersion: b.serverVersion } : {}),
        ...(b.protocolVersion ? { protocolVersion: b.protocolVersion } : {})
      })
    },
    onError(err) {
      const pub = extractPublic(err.details)
      deps.logger.error('backend:error', { code: err.code, message: deps.sanitize(err.message), ...pub })
      deps.send(PushChannels.error, { code: err.code, message: err.message, ...pub })
    }
  }
}
```

- [ ] **Step 4: `main/index.ts` 接线**

RealBackend 分支：

```ts
const errorHandlers = buildBackendErrorHandlers({
  logger: diagnostics.logger,
  sanitize,
  send: (channel, payload) => { const w = getMainWindow(); w?.webContents.send(channel, payload) },
  mode: useMock ? 'mock' : 'real',
  getBuild: () => ({ serverVersion: adapter.getConnectionState().serverVersion, protocolVersion: adapter.getConnectionState().protocolVersion })
})
: new RealBackend({
    onConnectionStateChange: onState,
    onSessionReplay: onReplay,
    onProtocolWarning: errorHandlers.onProtocolWarning,
    onError: errorHandlers.onError
  })
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test backend-error-handlers && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/chat/backend-error-handlers.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/backend-error-handlers.spec.ts
git commit -m "feat(批次B T5): backend-error-handlers 模块(onProtocolWarning→脱敏日志+onError→logger+chat:error)"
```

---

### Task 6: connection.store 失败保持 error 状态 + setError

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/connection.store.ts`
- Test: `apps/desktop/tests/unit/connection.store.spec.ts`

**Interfaces:**
- Consumes: `api.connect()`、`parsePublicError`、`PublicError`、`ConnectionState`。
- Produces: `error`（PublicError）；`setError(err)`；`connect()` 失败置 `state = { status: 'error', lastError }`（**不再改回 disconnected**）；`setState` 收到 `connected`/`reconnecting` 清 `error`。

> **F3 注（必须更新现有断言）**：现有 `connection.store.spec.ts` 两处既有用例（约 :44-51、:53-59）断言失败后 `status === 'disconnected'`——语义改动后必挂，**必须同步更新**为 `error`。

- [ ] **Step 1: 写失败测试**

```ts
it('connect 失败 → state error(不回 disconnected) + lastError', async () => {
  api.connect.mockRejectedValue(new Error('[AUTHENTICATION_FAILED] 401'))
  await store.connect()
  expect(store.state.status).toBe('error')
  expect(store.error?.code).toBe('AUTHENTICATION_FAILED')
  expect(store.state.lastError).toBeDefined()
})
it('setState connected → 清 error', () => {
  store.error = { code: 'X', message: 'x' }
  store.setState({ status: 'connected' })
  expect(store.error).toBeUndefined()
})
it('setError 设置公开错误', () => {
  store.setError({ code: 'BACKEND_REJECTED', message: 'm', retryable: true })
  expect(store.error?.retryable).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test connection.store`
Expected: FAIL（当前失败改回 disconnected、无 setError）

- [ ] **Step 3: 实现**

```ts
async function connect(): Promise<void> {
  error.value = undefined
  state.value = { status: 'connecting' }
  connecting.value = true
  try {
    await api.connect()
  } catch (e) {
    error.value = parsePublicError(e instanceof Error ? e.message : String(e))
    state.value = { status: 'error', lastError: error.value.message }   // 保持可见 error(D9/整改必须修改5)
  } finally {
    connecting.value = false
  }
}
function setState(s: ConnectionState): void {
  state.value = s
  if (s.status === 'connected' || s.status === 'reconnecting') error.value = undefined   // 成功/重连清旧错误
}
function setError(err: PublicError): void { error.value = err }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test connection.store && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/connection.store.ts apps/desktop/tests/unit/connection.store.spec.ts
git commit -m "feat(批次B T6): connection.store 失败保持 error + setError + connected 清错误"
```

---

### Task 7: message.store 事件守卫 + 纯缓冲 + 竞态修复

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`
- Test: `apps/desktop/tests/unit/message.store.spec.ts`

**Interfaces:**
- Consumes: `applyEvent`、`loadReplay`、`resetConversation`、`upsertMessage`、`migrateKey`、`handleConnectionStateChange`、`useConversationStore().currentId`。
- Produces: `generationByConversation`、`pendingReplay`、`droppedEvents`；`guardDropEvent/guardDropReplay`；`applyPendingReplay(id)`（**Task 8 依赖**）；`migrateKey` 守卫；`handleConnectionStateChange` 清理 local-*。

> **顺序说明（C1）**：本任务（原 v1 Task 8）前移到 conversation.store（Task 8）之前，确保 Task 8 的 `activate` 调用 `messageStore.applyPendingReplay` 时已存在。

> **F2 注（必须更新现有用例）**：现有 `message.store.spec.ts` 用例全部直接 `store.applyEvent(started())` / `loadReplay('conv-1', ...)`，**不设 `currentId`**。新守卫会让 `generation.started` 被丢弃、`loadReplay` 走纯缓冲 → 至少 7 条既有断言挂。本任务**必须同步更新**这些用例：`applyEvent`/`loadReplay` 前设 `useConversationStore().$patch({ currentId: 'conv-1' })`（或等价的 currentId 注入）。

> **F11 注（local-* 清理位置）**：`handleConnectionStateChange` 断线分支开头有 `const gid = activeGenerationId.value; if (!gid) return` 早退。local-* 清理循环必须**插在该早退之前**（先清理 pending 乐观消息，再处理 in-flight → interrupted），否则无 active generation 时清理永不执行。

- [ ] **Step 1: 写失败测试（含 M2 正向路径）**

```ts
it('generation.started 非当前会话 → 丢弃 + droppedEvents 计数', () => {})
it('generation.started 当前会话 → 记录 generationByConversation 并正常处理(正向,M2)', () => {})
it('中间事件查 generationByConversation:非当前/查无 → 丢弃', () => {})
it('当前会话中间事件正常通过(正向,M2)', () => {})
it('resetConversation 清 generationByConversation', () => {})
it('loadReplay 匹配 → 合并;未设 currentId → 纯缓冲;不匹配 → 丢弃', () => {})
it('applyPendingReplay 应用并清空;不匹配也清空(m5)', () => {})
it('migrateKey 旧 key 已清(切会话)→ 不重插(I1)', () => {})
it('handleConnectionStateChange 断线清理 local-* pending 消息(I5)', () => {})
```

> 断言要点：`droppedEvents` 计数递增；`generationByConversation` 内容正确；缓冲不污染当前 byId；`applyPendingReplay` 后 byId 含缓冲消息且 `pendingReplay` 清空；`migrateKey` 对已删 key 不重插；断线清理后 byId 无 local-* pending。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test message.store`
Expected: FAIL（当前无守卫/缓冲/清理）

- [ ] **Step 3: 实现（spec §4.1.3 / §4.1.4 / §4.2.1 / §4.2.5）**

```ts
const generationByConversation = ref<Record<string, string>>({})
const pendingReplay = ref<{ conversationId: string; messages: Message[] }>()
const droppedEvents = ref(0)
function guardDropEvent(type: string, conversationId?: string, generationId?: string): void {
  console.warn('cyrene:guard:drop', { type, conversationId, generationId })
  droppedEvents.value++
}
function guardDropReplay(conversationId: string): void {
  console.warn('cyrene:guard:drop', { type: 'replay', conversationId })
  droppedEvents.value++
}
function loadReplay(conversationId: string, messages: Message[]): void {
  const cur = useConversationStore().currentId
  if (cur === conversationId) { for (const m of messages) upsertMessage({ ...m, conversationId }); return }
  if (cur === undefined) { pendingReplay.value = { conversationId, messages }; return }
  guardDropReplay(conversationId)
}
function applyPendingReplay(id: string): void {
  if (pendingReplay.value?.conversationId === id) {
    for (const m of pendingReplay.value.messages) upsertMessage({ ...m, conversationId: id })
  }
  pendingReplay.value = undefined
}
```

`applyEvent` 的 `generation.started` 分支开头：

```ts
if (event.conversationId !== useConversationStore().currentId) { guardDropEvent('generation.started', event.conversationId, event.generationId); break }
generationByConversation.value[event.generationId] = event.conversationId
```

`delta/segment.started/segment.completed/completed/failed` 分支开头（现有 acc/activeGenerationId 守卫之前）：

```ts
const conv = generationByConversation.value[event.generationId]
if (conv === undefined || conv !== useConversationStore().currentId) { guardDropEvent(event.event, conv, event.generationId); break }
```

`resetConversation` 追加 `generationByConversation.value = {}`。`migrateKey` 开头加 `if (byId.value[oldKey] === undefined) return`。`handleConnectionStateChange` 断线分支追加：

```ts
for (const id of [...order.value]) {
  const m = byId.value[id]
  if (m && m.role === 'user' && m.status === 'pending' && id.startsWith('local-')) {
    delete byId.value[id]
    const i = order.value.indexOf(id); if (i >= 0) order.value.splice(i, 1)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test message.store && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/message.store.ts apps/desktop/tests/unit/message.store.spec.ts
git commit -m "feat(批次B T7): message.store 归属守卫+纯缓冲+migrateKey竞态+local-*清理"
```

---

### Task 8: conversation.store 初始化编排 + epoch + ready/busy/error

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/conversation.store.ts`
- Test: `apps/desktop/tests/unit/conversation.store.spec.ts`

**Interfaces:**
- Consumes: `api.listConversations/activate/getMessages/createConversation/renameConversation/deleteConversation`、`useConnectionStore().state`、`useMessageStore()`（含 Task 7 的 `resetConversation`/`applyPendingReplay`/`loadPage`）、`parsePublicError`。
- Produces: `initializedFor`、`ready`、`error`、`busy`（ref）；`onConnected(connectionId?)`、`onActiveConversationAppeared(activeId)`、`safeList()`；`activate` 加 epoch + busy + applyPendingReplay。

- [ ] **Step 1: 写失败测试**

```ts
it('activate epoch:快速 A→B→A 迟到 A 响应不覆盖', () => {})
it('onConnected 幂等:同 connectionId 只跑一次', () => {})
it('onConnected 首次:list 后 activeId 存在 → activate', () => {})
it('onConnected 首次无 activeId → currentId 留空 + ready true(空态)', () => {})
it('onConnected 重连(有 currentId):只 safeList + reconcile(activeId!==currentId → activate)', () => {})
it('safeList 失败写 error 不抛', () => {})
it('ready 初始 false,safeList 后 true(N1)', () => {})
it('onActiveConversationAppeared:currentId 空 → activate;已设 → 不动;busy → 跳过', () => {})
it('safeList 期间用户切会话不覆盖(m6)', () => {})
it('activate 失败写 error + busy 复位', () => {})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test conversation.store`
Expected: FAIL（当前无 onConnected/ready/busy/epoch）

- [ ] **Step 3: 实现（spec §4.1.1 / §4.1.3 / §4.2.3 / §4.2.4）**

```ts
const initializedFor = ref<string>()
const ready = ref(false)
const error = ref<PublicError>()
const busy = ref(false)
let epoch = 0

async function onConnected(connectionId?: string): Promise<void> {
  if (connectionId && initializedFor.value === connectionId) return
  if (connectionId === undefined && initializedFor.value !== undefined) return   // Mock 只初始化一次(m3)
  initializedFor.value = connectionId ?? ''
  try {
    if (currentId.value) {
      await safeList()
      const activeId = useConnectionStore().state.activeConversationId
      if (activeId && activeId !== currentId.value) await activate(activeId)   // I4 reconcile
      ready.value = true
      return
    }
    await safeList()
    ready.value = true            // N1:safeList 后即就绪,不依赖 activate
    if (currentId.value) return   // m6
    const activeId = useConnectionStore().state.activeConversationId
    if (activeId) await activate(activeId)
  } catch (e) {
    error.value = parsePublicError(messageOf(e))
  }
}

async function onActiveConversationAppeared(activeId: string): Promise<void> {
  if (currentId.value) return
  if (busy.value) return
  await activate(activeId)
}

async function safeList(): Promise<void> {
  busy.value = true
  try { await list() } catch (e) { error.value = parsePublicError(messageOf(e)) } finally { busy.value = false }
}

async function activate(id: string): Promise<void> {
  const myEpoch = ++epoch
  busy.value = true
  currentId.value = id
  const messageStore = useMessageStore()
  messageStore.resetConversation(id)
  messageStore.applyPendingReplay(id)
  try {
    await api.activate(id)
    if (myEpoch !== epoch) return
    const p = await api.getMessages({ conversationId: id })
    if (myEpoch !== epoch) return
    messageStore.loadPage(p)
  } catch (e) {
    if (myEpoch !== epoch) return
    error.value = parsePublicError(messageOf(e))
  } finally {
    if (myEpoch === epoch) busy.value = false
  }
}
```

`list/getMore/create/rename/remove` 均包 try/catch（写 error）+ busy（`create/rename/remove` 内部 `list` 改 `safeList`）。**F8：`messageOf` 只在 message.store.ts 内定义（非导出），conversation.store.ts 需自定模块内 helper**（`e instanceof Error ? e.message : String(e)`），或从 message.store 导出复用。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test conversation.store && pnpm -F @cyrene/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/conversation.store.ts apps/desktop/tests/unit/conversation.store.spec.ts
git commit -m "feat(批次B T8): conversation.store 初始化编排+epoch+ready/busy/error+补激活"
```

---

### Task 9: renderer 装配接线 + 组件门控/错误展示

**Files:**
- Modify: `apps/desktop/src/renderer/src/main.ts`
- Modify: `apps/desktop/src/renderer/src/components/CyConversationList.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyChatInput.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyChatView.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyConnectionPanel.vue`

**Interfaces:**
- Consumes: `conversationStore.onConnected/onActiveConversationAppeared/ready/busy/error`、`connectionStore.error/setError`、`messageStore.lastError`。

- [ ] **Step 1: `renderer/src/main.ts` 接线**

```ts
if (window.desktopApi) {
  setDesktopApi(window.desktopApi)
  const connectionStore = useConnectionStore()
  const messageStore = useMessageStore()
  const conversationStore = useConversationStore()
  window.desktopApi.onChatEvent((e) => messageStore.applyEvent(e))
  window.desktopApi.onChatState((s) => {
    connectionStore.setState(s)
    messageStore.handleConnectionStateChange(s)
    if (s.status === 'connected') {
      void conversationStore.onConnected(s.connectionId)
      if (s.activeConversationId) void conversationStore.onActiveConversationAppeared(s.activeConversationId)
    }
  })
  window.desktopApi.onChatReplay(({ conversationId, messages }) => messageStore.loadReplay(conversationId, messages))
  window.desktopApi.onChatError((err) => connectionStore.setError(err))
}
```

- [ ] **Step 2: `CyConversationList.vue`**

- 删除 `onMounted(() => { void conversationStore.list() })`（import 中移除 onMounted）。
- 顶部渲染 `conversationStore.error` 短横幅：

```vue
<div v-if="conversationStore.error" class="cy-conversation-error" role="alert">{{ conversationStore.error.message }}</div>
```

- 新建/重命名/删除/激活按钮 `:disabled="!canAct"`，其中：

```ts
const canAct = computed(() => connectionStore.state.status === 'connected' && conversationStore.ready && !conversationStore.busy)
```

- [ ] **Step 3: `CyChatInput.vue`**

```ts
const canSend = computed(() =>
  draft.value.trim().length > 0 && !messageStore.sending && !!conversationStore.currentId &&
  connectionStore.state.status === 'connected' && conversationStore.ready
)
```

error 横幅（`messageStore.lastError`）保留；断线 banner 的 error 分支文案改用 `connectionStore.error?.message`（不再用 `state.lastError`）。

- [ ] **Step 4: `CyChatView.vue` / `CyConnectionPanel.vue`**

- `CyChatView` 新建按钮 `:disabled="!canAct"`（同 Step 2 computed）。
- `CyConnectionPanel` 确认/对齐 `connectionStore.error` 展示：现有第 ~98 行已有 `v-if="connection.error"` 渲染（**F10：避免重复实现**）——确认已有展示即可；如需用 `connectionStore.error` 结构化字段则对齐类型。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint`
Expected: PASS

- [ ] **Step 6: 记录门控验收项（M5）**

在 `docs/16` 批次 B 变更记录或最终验收清单加一行：门控 computed（`canSend`/`canAct` 的 `connected && ready && !busy`）为组件逻辑，无单测；最终验收以人工/集成断言兜底。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/main.ts apps/desktop/src/renderer/src/components/CyConversationList.vue apps/desktop/src/renderer/src/components/CyChatInput.vue apps/desktop/src/renderer/src/components/CyChatView.vue apps/desktop/src/renderer/src/components/CyConnectionPanel.vue
git commit -m "feat(批次B T9): renderer 装配接线+组件门控(connected&&ready)+错误展示"
```

---

### Task 10: 集成测试（白名单 22 + trust-boundary + chat:error 纯 push）

**Files:**
- Modify: `apps/desktop/tests/integration/ipc-security.spec.ts`
- Modify: `apps/desktop/tests/integration/helpers/desktop-api.d.ts`
- Modify: `apps/desktop/tests/integration/trust-boundary.spec.ts`（I6：renderer 收到 chat:error 并写入 connectionStore）

**Interfaces:**
- Consumes: `launchApp`（helper）、`desktopApi` 类型（helpers/desktop-api.d.ts）、白名单断言、`window.desktopApi` 推送订阅。

- [ ] **Step 1: 更新 `desktop-api.d.ts`**

加 `onChatError(handler: (err: { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string }) => void): () => void`（按 `src/preload/index.d.ts` 的 onChatReplay 声明风格；注意 `helpers/desktop-api.d.ts` 是窄声明、现无 onChatReplay，以 src 侧为准）。

- [ ] **Step 2: 更新白名单断言（21 → 22）**

`ipc-security.spec.ts`：白名单数组在 **`listConversations` 与 `onChatEvent` 之间**插入 `onChatError`（F4：`Object.keys().sort()` 排序位置），总数断言 21→22。加一条「`chat:error` 不在 Invoke 白名单，仅 push」断言（M4：若现有文件有 invoke 通道枚举，确认不含 `chat:error`；`ipcRenderer.on` 白名单含之）。

- [ ] **Step 3: `trust-boundary.spec.ts` 加 chat:error 消费用例（I6）**

launchApp（mock 装配）后：

```ts
it('onChatError 注册后,Main 推送 chat:error → renderer connectionStore.error 可见', async () => {
  // 约束:launchApp 恒 mock,MockBackend 无 onError 选项,无法经真实后端触发
  // 替代验证:通过 Main 侧直接 send(PushChannels.error, {...}) 注入一条错误,
  // 断言 renderer 端已注册的 onChatError 收到并写入 connectionStore(经 window.evaluate 读状态)
  // 实现:helper 暴露 test hook(如 process.env.CYRENE_TEST_HARNESS 下注册 pushMainError(channel,payload)),
  // 或对 window.desktopApi.onChatError 做「注册后无异常 + 白名单含键」的弱断言并记录偏离
})
```

> **偏离记录（I6）**：mock 装配下无法经 MockBackend 触发 `onError` 真实路径；`onProtocolWarning/onError` 回调接线在 Task 5 单元层覆盖。集成层仅验证 `onChatError` 订阅通道可用 + 白名单含 `chat:error` 纯 push 通道；若 helper 提供注入能力则做真实推送断言，否则记录该偏离（文档 + 最终报告提出）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test:integration`
Expected: PASS（全量集成，含既有用例）

- [ ] **Step 5: 全量门禁**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop test && pnpm -F @cyrene/desktop test:integration && pnpm -F @cyrene/desktop build`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/tests/integration/ipc-security.spec.ts apps/desktop/tests/integration/helpers/desktop-api.d.ts apps/desktop/tests/integration/trust-boundary.spec.ts
git commit -m "feat(批次B T10): 集成测试——白名单22键+chat:error 纯push+onChatError 消费"
```

---

## Self-Review

- **Spec 覆盖**：T1(§4.3.2)/T2(§4.4.1+m4+I3)/T3(§4.4.2+I3)/T4(§4.4.4 D14)/T5(§4.3.1)/T6(§4.3.3)/T7(§4.1.3/4+§4.2.1/5)/T8(§4.1+§4.2.3/4)/T9(§4.4.3+组件)/T10(§5.2)——四项 FE 全覆盖；spec §4.5 改动清单每文件都落在某任务。
- **依赖顺序**：T1(preload 基座)→ T2-T5(Main)→ T6-T8(renderer store,其中 T7 message 先于 T8 conversation 解决 `applyPendingReplay` 前置引用 C1)→ T9(组件)→ T10(集成)。T5 依赖 T1 的 `PushChannels.error` 已建好。
- **Placeholder 扫描**：无 TBD/TODO；三处注释占位已写全断言(I5)；Task 2 m4 测试有实现后校准说明(非占位,是测试构造提示)。
- **类型一致性**：`onChatError`/`PublicErrorShape`/`handshakeTimeoutMs`/`restTimeoutMs`/`activeControllers`/`generationByConversation`/`pendingReplay`/`applyPendingReplay`/`onConnected`/`onActiveConversationAppeared`/`safeList`/`ready`/`busy`/`droppedEvents`/`buildBackendErrorHandlers` 在定义与消费处一致。
- **接口事实**：`real-backend.spec.ts` 无 `baseOpts`(已用 `makeOpts`);`preload/index.d.ts` 已含于 T1(I1);Task 5 模块化 + TDD(I2)。
