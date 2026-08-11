# Cyrene 阶段2 真实联调整改·批次A 实施计划（连接凭据安全 / 真实模式装配 / rejected ACK）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复联调前置的三个前端问题——Token 与 Endpoint Origin 绑定（P0 安全）、Real/Mock 装配策略与最小连接设置、rejected ACK 即时结构化传递——使阶段 2 链路可安全进入真实联调。

**Architecture:** Main 新增 `connection-config`（注入 CredentialStore 端口）持有规范化 endpoint 与 token-origin 绑定，Renderer 不再传任意 URL（connect 无参）；装配策略改为打包恒 Real、未打包默认 Real + `CYRENE_BACKEND=mock` 显式 Mock；`RawUserAckSchema` 改 superRefine 按 status 校验，`handleAck` 保留 backendCode/retryable，IPC 错误信封结构化并经 contextBridge message 前缀传回 renderer 反解。

**Tech Stack:** Electron 43 / electron-vite 5 / Vue 3 / Pinia / zod 4.4.3 / vitest / playwright（集成）。

## Global Constraints

以下约束来自 spec，每个任务隐式包含；违反即返工：

- **URL 规范化**：远程只允许 `https:`；`http:` 仅回环 host（`localhost` / `127.0.0.0/8` / `[::1]`）；回环判定用 `net.isIP` + 位运算，**禁止** `hostname.startsWith('127.')` 前缀匹配；拒绝 `username`/`password`/`search`/`hash`；保留 pathname、去尾斜杠；`wsUrl` 由 URL 对象 protocol `http→ws`/`https→wss` 转换派生，不字符串拼接。
- **ACK schema**：`RawUserAckSchema` 保持单对象 + `superRefine`；**禁止**拆 `z.union([accepted, rejected])`（外层 `RawFrameSchema` 是 `z.discriminatedUnion('type', ...)`，子项再建 union 会首次 parse 抛 `Invalid discriminated union option`，zod 4.4.3 实测）。
- **跨 contextBridge 保真**：preload 抛 Error 只可靠保留 `message`；结构化字段并入 message 前缀 `[code] [backendCode=XX] [retryable=true] message`，renderer 用 `parsePublicError` 反解；**不**依赖 Error 附加 own property / instanceof。
- **Token 绑定**：新增 `BACKEND_TOKEN_ORIGIN_KEY`（进 `isKeyAllowed` 白名单）；`setBackendToken` 先校验 endpoint 已设；`setEndpoint` origin 变化自动清 token + 绑定；`connect` 校验绑定 origin 与 token 存在，不符 → `CREDENTIAL_UNAVAILABLE`。
- **装配策略**：`useMock = !app.isPackaged && process.env['CYRENE_BACKEND'] === 'mock'`；packaged 恒 Real；`requireToken = !useMock`。
- **决策 8**：wsUrl 接口层改造推迟——本批不改 `ConnectInput`/`BackendAdapter.connect` 接口，RealBackend 现有 `serverUrl.replace(/^http/,'ws') + '/ws'` 保留。
- **决策 9**：`setBackendToken/clearBackendToken` 由 `connection-config` 提供方法，`registerCredentialsHandlers` 对 `key === BACKEND_TOKEN_KEY` 特判委派，其余 key 通用路径零改动。
- **错误码**：`CyreneErrorCode` 新增 `BACKEND_REJECTED = 'BACKEND_REJECTED'`；rejected ACK 用它（缺 error 退化 `INVALID_INPUT`）。
- **门禁**：`pnpm typecheck` / `pnpm lint` / `pnpm test`（≥315 单测）/ `xvfb-run -a pnpm test:integration`（≥18 集成）/ `pnpm build` 全绿；测试命令在仓库根或 `apps/desktop` 下执行（单文件：`pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/<file>.spec.ts`）。
- **文档**：完成后仍标「已开发、未联调」；改动的行为对应更新 `docs/16` 变更记录。

---

### Task 1: 共享契约与错误码扩展

**Files:**
- Modify: `apps/desktop/src/shared/contracts/credentials.ts`（`BACKEND_TOKEN_ORIGIN_KEY` + 白名单）
- Modify: `apps/desktop/src/shared/errors/index.ts`（`BACKEND_REJECTED`）
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`（`IpcErrorBody` 结构化）
- Modify: `apps/desktop/src/shared/contracts/backend.ts`（`RuntimeInfo`）
- Test: `apps/desktop/tests/unit/credentials-contracts.spec.ts`（isKeyAllowed / 新 key）

**Interfaces:**
- Consumes: 现有 `BACKEND_TOKEN_KEY`、`isKeyAllowed`、`CyreneErrorCode`、`IpcErrorBody`
- Produces: `BACKEND_TOKEN_ORIGIN_KEY: string`、`CyreneErrorCode.BACKEND_REJECTED`、结构化 `IpcErrorBody`、`RuntimeInfo`

- [ ] **Step 1: 写失败测试**

`credentials-contracts.spec.ts` **修改既有断言**：现有 `expect(CREDENTIAL_KEY_ALLOWLIST).toEqual(['backend.token'])` 需同步为含 `BACKEND_TOKEN_ORIGIN_KEY`；并追加：
```ts
it('BACKEND_TOKEN_ORIGIN_KEY 在白名单且与 BACKEND_TOKEN_KEY 并列', () => {
  expect(isKeyAllowed(BACKEND_TOKEN_ORIGIN_KEY)).toBe(true)
  expect(BACKEND_TOKEN_ORIGIN_KEY).not.toBe(BACKEND_TOKEN_KEY)
})
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/credentials-contracts.spec.ts`
Expected: FAIL——`BACKEND_TOKEN_ORIGIN_KEY` undefined / `isKeyAllowed` false / allowlist 断言失配

- [ ] **Step 3: 实现**

`credentials.ts`：在 `BACKEND_TOKEN_KEY` 旁新增 `BACKEND_TOKEN_ORIGIN_KEY = 'backend_token_origin'`（类型用 `string`，**不**并入 `CredentialKey` 字面量联合以免 TS 报错），并入 `CREDENTIAL_KEY_ALLOWLIST`（照 `isKeyAllowed` 现有字面量/前缀匹配模式加）。
`errors/index.ts`：`CyreneErrorCode` 追加 `BACKEND_REJECTED = 'BACKEND_REJECTED'`（放在 `NOT_CONNECTED` 附近）。
`contracts/ipc.ts`：`IpcErrorBody` 扩展为：
```ts
export interface IpcErrorBody {
  code: string
  message: string
  backendCode?: string
  retryable?: boolean
  requestId?: string
}
```
`contracts/backend.ts`：新增 `export interface RuntimeInfo { mode: 'real' | 'mock'; packaged: boolean }`。（`ConnectInput.serverUrl` 保持必填不改——chat-service 恒传 serverUrl，无谓接口 churn 不要。）

- [ ] **Step 4: 运行验证通过**

Run: 同上
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/contracts/credentials.ts apps/desktop/src/shared/errors/index.ts apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/shared/contracts/backend.ts apps/desktop/tests/unit/credentials-contracts.spec.ts
git commit -m "feat(批次A): Task1 共享契约——BACKEND_TOKEN_ORIGIN_KEY/BACKEND_REJECTED/结构化IpcErrorBody/RuntimeInfo"
```

---

### Task 2: connection-config（endpoint 规范化 + token 绑定）

**Files:**
- Create: `apps/desktop/src/main/connection/connection-config.ts`
- Create: `apps/desktop/tests/unit/connection-config.spec.ts`

**Interfaces:**
- Consumes: `CyreneError`/`CyreneErrorCode`、`BACKEND_TOKEN_KEY`、`BACKEND_TOKEN_ORIGIN_KEY`、注入的存储端口
- Produces:
```ts
export interface NormalizedEndpoint { origin: string; baseUrl: string; wsUrl: string }
export interface ConnectionConfigStorePort {
  loadToken(): Promise<string | undefined>
  saveToken(v: string): Promise<void>
  clearToken(): Promise<void>
  loadBinding(): Promise<string | undefined>   // BACKEND_TOKEN_ORIGIN_KEY 值（origin 明文）
  saveBinding(origin: string): Promise<void>
  clearBinding(): Promise<void>
}
export class ConnectionConfig {
  constructor(port: ConnectionConfigStorePort, onEndpointChanged?: (e: NormalizedEndpoint) => void)   // onEndpointChanged 用于审计（Task 8 注入）
  normalizeEndpoint(rawUrl: string): NormalizedEndpoint          // 校验失败抛 CyreneError(INVALID_INPUT)
  async setEndpoint(rawUrl: string): Promise<NormalizedEndpoint> // origin 变化→clearToken+clearBinding
  getEndpoint(): NormalizedEndpoint | undefined                  // 内存持有，重启需重设（决策 3）
  async setBackendToken(token: string): Promise<void>            // 未设 endpoint→CREDENTIAL_UNAVAILABLE；saveToken+saveBinding(currentOrigin)
  async clearBackendToken(): Promise<void>                       // clearToken+clearBinding
  async getTokenBinding(): Promise<{ origin: string } | undefined>
}
```

- [ ] **Step 1: 写失败测试**（`connection-config.spec.ts`，fake port 内存实现）

```ts
import { describe, expect, it } from 'vitest'
import { ConnectionConfig, type ConnectionConfigStorePort } from '../../src/main/connection/connection-config'
import { CyreneErrorCode } from '../../src/shared/errors'

function makePort() {
  const mem = new Map<string, string>()
  const port: ConnectionConfigStorePort = {
    loadToken: () => Promise.resolve(mem.get('token')),
    saveToken: (v) => { mem.set('token', v); return Promise.resolve() },
    clearToken: () => { mem.delete('token'); return Promise.resolve() },
    loadBinding: () => Promise.resolve(mem.get('binding')),
    saveBinding: (o) => { mem.set('binding', o); return Promise.resolve() },
    clearBinding: () => { mem.delete('binding'); return Promise.resolve() }
  }
  return { port, mem }
}

describe('ConnectionConfig', () => {
  it('https 任意 host 规范化通过 → baseUrl/wsUrl 正确派生', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    const e = c.normalizeEndpoint('https://example.com/')
    expect(e.origin).toBe('https://example.com')
    expect(e.baseUrl).toBe('https://example.com')
    expect(e.wsUrl).toBe('wss://example.com/ws')
  })
  it('远程 http://example.com 被拒 INVALID_INPUT', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    try { c.normalizeEndpoint('http://example.com'); expect.unreachable() }
    catch (e: unknown) { expect((e as { code?: string }).code).toBe(CyneErrorCode.INVALID_INPUT) }
  })
  it('回环 http://127.0.0.1:8765 / localhost / [::1] 通过', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    for (const u of ['http://127.0.0.1:8765', 'http://localhost:8765', 'http://[::1]:8765']) {
      const e = c.normalizeEndpoint(u)
      expect(e.baseUrl).toBe(u.replace(/\/$/, ''))
      expect(e.wsUrl).toBe(u.replace(/^http/, 'ws') + '/ws')
    }
  })
  it('主机名以 127 开头但不是回环 → 拒（禁前缀匹配）', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    expect(() => c.normalizeEndpoint('http://127.1.2.3.attacker.com')).toThrow()
  })
  it('userinfo/query/fragment 拒绝', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    for (const u of ['https://user:pass@example.com', 'https://example.com/?a=1', 'https://example.com/#x']) {
      expect(() => c.normalizeEndpoint(u)).toThrow()
    }
  })
  it('path 前缀保留 + 尾斜杠去除 → ws 挂 /ws', () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    const e = c.normalizeEndpoint('https://example.com/pfx/')
    expect(e.baseUrl).toBe('https://example.com/pfx')
    expect(e.wsUrl).toBe('wss://example.com/pfx/ws')
  })
  it('setEndpoint origin 变化 → 自动清 token 与绑定', async () => {
    const { port, mem } = makePort(); const c = new ConnectionConfig(port)
    await c.setEndpoint('https://a.example')
    await c.setBackendToken('t1')
    expect(mem.get('token')).toBe('t1')
    await c.setEndpoint('https://b.example') // origin 变
    expect(mem.get('token')).toBeUndefined()
    expect(mem.get('binding')).toBeUndefined()
  })
  it('setBackendToken 未设 endpoint → CREDENTIAL_UNAVAILABLE', async () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    await expect(c.setBackendToken('t')).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
  })
  it('connect 绑定校验：绑定 origin ≠ 当前 → CREDENTIAL_UNAVAILABLE', async () => {
    const { port } = makePort(); const c = new ConnectionConfig(port)
    await c.setEndpoint('https://a.example'); await c.setBackendToken('t')
    await c.setEndpoint('https://b.example') // 自动清绑定
    expect(await c.getTokenBinding()).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/connection-config.spec.ts`
Expected: FAIL——模块不存在（Cannot find module）

- [ ] **Step 3: 实现**

`connection-config.ts` 核心：
```ts
import { net } from 'electron'  // 注意：net.isIP 在 main 进程可用；为纯逻辑可测，改用 node:net
```
（改用 `import { isIP } from 'node:net'`，`connection-config` 不依赖 Electron——spec 要求注入端口 + 纯函数可单测。）

```ts
import { isIP } from 'node:net'
import { CyreneError, CyreneErrorCode } from '../../shared/errors'

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (h === 'localhost') return true
  if (isIP(h) === 4) return Number(h.split('.')[0]) === 127   // 127.0.0.0/8
  if (isIP(h) === 6) return h === '::1'
  return false
}
```
完整类（`onEndpointChanged?` 为可选审计回调，Task 8 注入日志）：
```ts
export class ConnectionConfig {
  private endpoint?: NormalizedEndpoint
  constructor(
    private readonly port: ConnectionConfigStorePort,
    private readonly onEndpointChanged?: (e: NormalizedEndpoint) => void
  ) {}
  normalizeEndpoint(rawUrl: string): NormalizedEndpoint {
    let u: URL
    try { u = new URL(rawUrl) } catch { throw new CyreneError(CyneErrorCode.INVALID_INPUT, 'Endpoint 不是合法 URL') }
    if (u.username || u.password) throw new CyreneError(CyneErrorCode.INVALID_INPUT, 'Endpoint 不得包含 userinfo')
    if (u.search || u.hash) throw new CyreneError(CyneErrorCode.INVALID_INPUT, 'Endpoint 不得包含 query 或 fragment')
    const host = u.hostname
    if (u.protocol === 'https:') { /* 任意 host 通过 */ }
    else if (u.protocol === 'http:') { if (!isLoopbackHost(host)) throw new CyreneError(CyneErrorCode.INVALID_INPUT, 'http 仅允许回环地址') }
    else throw new CyreneError(CyneErrorCode.INVALID_INPUT, 'Endpoint 仅支持 https 或回环 http')
    const origin = `${u.protocol}//${u.host}`
    const baseUrl = origin + u.pathname.replace(/\/+$/, '')
    const ws = new URL(u.toString()); ws.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = ws.origin + ws.pathname.replace(/\/+$/, '') + '/ws'
    return { origin, baseUrl, wsUrl }
  }
  async setEndpoint(rawUrl: string): Promise<NormalizedEndpoint> {
    const e = this.normalizeEndpoint(rawUrl)
    const binding = await this.port.loadBinding()
    if (binding && binding !== e.origin) { await this.port.clearToken(); await this.port.clearBinding() }
    this.endpoint = e
    this.onEndpointChanged?.(e)
    return e
  }
  getEndpoint(): NormalizedEndpoint | undefined { return this.endpoint }
  async setBackendToken(token: string): Promise<void> {
    const e = this.endpoint
    if (!e) throw new CyreneError(CyneErrorCode.CREDENTIAL_UNAVAILABLE, '请先设置后端地址')
    await this.port.saveToken(token); await this.port.saveBinding(e.origin)
  }
  async clearBackendToken(): Promise<void> { await this.port.clearToken(); await this.port.clearBinding() }
  async getTokenBinding(): Promise<{ origin: string } | undefined> {
    const o = await this.port.loadBinding(); return o ? { origin: o } : undefined
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: 同上
Expected: PASS（若 `expect.unreachable()` 在该 vitest 版本不可用，改用 `expect(true).toBe(true)` + try/catch 断言 `e.code`）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/connection/connection-config.ts apps/desktop/tests/unit/connection-config.spec.ts
git commit -m "feat(批次A): Task2 connection-config——endpoint 规范化(token-origin 绑定) + URL 校验"
```

---

### Task 3: ACK superRefine + handleAck 结构化

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts:135-144`（`RawUserAckSchema`）
- Modify: `apps/desktop/src/main/transport/real-backend.ts:200-215`（`handleAck` rejected）
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（`connect` 用 `baseUrl`，去掉 `replace` 拼接？——不，决策 8 保留，`connect` 不改）
- Test: `apps/desktop/tests/unit/raw-schemas.spec.ts`、`apps/desktop/tests/unit/real-backend.spec.ts`

**Interfaces:**
- Consumes: `CyreneErrorCode.BACKEND_REJECTED`（Task 1）、`RawFrameSchema`
- Produces: `RawUserAckSchema` 单对象 superRefine；`handleAck` rejected → `CyreneError(BACKEND_REJECTED, msg, { backendCode, retryable })`

- [ ] **Step 1: 写失败测试**

`raw-schemas.spec.ts` 追加（先读该文件确认现有 `parseRawFrame` 断言风格）：
```ts
it('rejected + 空 messageId + QUEUE_FULL 通过 parseRawFrame', () => {
  const r = parseRawFrame({ type: 'user_message.ack', messageId: '', clientRequestId: 'c1', receivedAt: 't', status: 'rejected', error: { code: 'QUEUE_FULL', message: '队列已满', retryable: true } })
  expect(r.success).toBe(true)
  if (r.success) expect(r.data.status).toBe('rejected')
})
it('rejected 缺 error 通过（走退化分支）', () => {
  const r = parseRawFrame({ type: 'user_message.ack', messageId: '', clientRequestId: 'c1', receivedAt: 't', status: 'rejected' })
  expect(r.success).toBe(true)
})
it('accepted + 空 messageId 拒为非法帧', () => {
  const r = parseRawFrame({ type: 'user_message.ack', messageId: '', clientRequestId: 'c1', receivedAt: 't', status: 'accepted' })
  expect(r.success).toBe(false)
})
it('accepted 正常通过', () => {
  const r = parseRawFrame({ type: 'user_message.ack', messageId: 'm1', clientRequestId: 'c1', receivedAt: 't', status: 'accepted' })
  expect(r.success).toBe(true)
})
```

`real-backend.spec.ts` 追加。**构造指引**：先读该文件确认现有 fake `wss` 时序（`connect` 后回 `session→server_info` 握手；`sendMessage` 时 `on('message')` 收到 `type:'text'` 帧后按 `clientRequestId` 回 ack）。新增 rejected 分支（空 messageId）：在 `on('message')` 里对 text 帧回 `{ type:'user_message.ack', messageId:'', clientRequestId:<收到的> , status:'rejected', error:{ code:'QUEUE_FULL', message:'队列已满', retryable:true } }`。`handleAck` 是 private——经 `real.connect()` + fake `wss` 推送帧触发，`sendMessage` 用与现有 accepted 用例相同的 clientRequestId 关联。
```ts
it('rejected ACK（空 messageId + QUEUE_FULL）→ BACKEND_REJECTED + backendCode/retryable 保留（不超时）', async () => {
  // fake wss 回 rejected 帧（messageId:''）
  await expect(real.sendMessage({ conversationId: 'c1', text: 'x', clientRequestId: 'r1' }))
    .rejects.toMatchObject({ code: CyreneErrorCode.BACKEND_REJECTED })
  // 且 error.details.backendCode === 'QUEUE_FULL'、retryable === true（用 try/catch 捕获断言）
})
it('rejected ACK 缺 error → INVALID_INPUT 立即 reject（不等 ackTimeout）', async () => {
  // fake wss 回 rejected 无 error 帧（messageId:''）
  await expect(real.sendMessage({ conversationId: 'c1', text: 'x', clientRequestId: 'r2' }))
    .rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/raw-schemas.spec.ts tests/unit/real-backend.spec.ts`
Expected: FAIL——rejected 空 messageId 当前被拒；handleAck 仍 `INVALID_INPUT`

- [ ] **Step 3: 实现**

`raw-schemas.ts` 的 `RawUserAckSchema` 改为：
```ts
const RawUserAckSchema = z.object({
  type: z.literal('user_message.ack'),
  messageId: z.string(),   // 不设 min(1)：rejected 允许 ''
  clientRequestId: z.string().min(1),
  clientMessageId: z.string().optional(),
  conversationId: z.string().optional(),
  receivedAt: z.string().min(1),
  status: z.enum(['accepted', 'rejected']),
  error: z.object({ code: z.string().min(1), message: z.string(), retryable: z.boolean().optional() }).optional()
}).strict().superRefine((v, ctx) => {
  if (v.status === 'accepted' && v.messageId === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accepted ack 必须带非空 messageId', path: ['messageId'] })
  }
})
```

`real-backend.ts` `handleAck` rejected 分支改为：
```ts
} else {
  if (frame.error) {
    pending.reject(new CyreneError(CyneErrorCode.BACKEND_REJECTED, frame.error.message, { backendCode: frame.error.code, retryable: frame.error.retryable }))
  } else {
    pending.reject(new CyreneError(CyneErrorCode.INVALID_INPUT, '消息被后端拒绝'))
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: 同上
Expected: PASS（并确认既有 accepted 正常路径不回归）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/tests/unit/raw-schemas.spec.ts apps/desktop/tests/unit/real-backend.spec.ts
git commit -m "feat(批次A): Task3 ACK superRefine + handleAck 结构化(BACKEND_REJECTED/backendCode/retryable)"
```

---

### Task 4: IPC 基建（channels schema / executor 上提 / credentials 特判委派）

**Files:**
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`（`IpcChannels` 加三键；`IpcErrorBody` 已在 Task 1）
- Modify: `apps/desktop/src/main/ipc/channels.ts`（`chatConnectSchema` → `z.undefined()`；新增 set/get-endpoint、get-runtime-info schema）
- Modify: `apps/desktop/src/main/ipc/executor.ts`（`createIpcHandler` catch 上提 `backendCode/retryable/requestId`）
- Modify: `apps/desktop/src/main/credentials/index.ts`（`createCredentialsExecutors`/`registerCredentialsHandlers` 增 `connConfig` 参数，`BACKEND_TOKEN_KEY` 特判委派）
- Modify: `apps/desktop/src/main/ipc/handlers.ts`（`registerHandlers` deps 加 `connectionConfig`，透传）
- Test: `apps/desktop/tests/unit/ipc-executor.spec.ts`、`apps/desktop/tests/unit/credentials-ipc.spec.ts`、`apps/desktop/tests/unit/credentials-channels.spec.ts`

**Interfaces:**
- Consumes: `CyreneError.details`、`ConnectionConfig`（Task 2）、`BACKEND_TOKEN_KEY`
- Produces: `IpcChannels.chatSetEndpoint/chatGetEndpoint/chatGetRuntimeInfo`；`chatConnectSchema: z.ZodType<undefined>`；`createCredentialsExecutors(store, opts, connConfig?)`

- [ ] **Step 1: 写失败测试**

`ipc-executor.spec.ts` 追加（先读该文件现有断言风格；用一个抛 `CyreneError` 的 fn）：
```ts
it('CyreneError.details 的 backendCode/retryable/requestId 上提进 IpcErrorBody', async () => {
  const fn = () => { throw new CyreneError(CyneErrorCode.BACKEND_REJECTED, '队列已满', { backendCode: 'QUEUE_FULL', retryable: true }) }
  const handler = createIpcHandler(z.undefined(), z.unknown(), fn, { sanitize: (s: string) => s })
  const res = await handler(undefined)
  expect(res.ok).toBe(false)
  if (!res.ok) {
    expect(res.error.code).toBe('BACKEND_REJECTED')
    expect(res.error.backendCode).toBe('QUEUE_FULL')
    expect(res.error.retryable).toBe(true)
  }
})
it('兼容 details.code（error 帧路径）', async () => {
  const fn = () => { throw new CyreneError(CyneErrorCode.INVALID_INPUT, 'x', { code: 'BAD_FRAME' }) }
  const handler = createIpcHandler(z.undefined(), z.unknown(), fn, { sanitize: (s: string) => s })
  const res = await handler(undefined)
  if (!res.ok) expect(res.error.backendCode).toBe('BAD_FRAME')
})
```

`credentials-ipc.spec.ts` 追加（mock `ConnectionConfig`：setBackendToken/clearBackendToken 各打一个 spy；验证 BACKEND_TOKEN_KEY 走 connConfig、其他 key 走 store）：
```ts
it('BACKEND_TOKEN_KEY → 委派 connConfig.setBackendToken', async () => {
  const config = { setBackendToken: vi.fn(async () => {}), clearBackendToken: vi.fn(async () => {}) }
  // createCredentialsExecutors(store, opts, config as any).set({ key: BACKEND_TOKEN_KEY, value: 't' })
  // 断言 config.setBackendToken 被调、store.setCredential 未被调（对 BACKEND_TOKEN_KEY）
})
it('非 BACKEND_TOKEN_KEY → 通用 store 路径不变', async () => {
  // 断言 config 方法未被调、store.setCredential 被调
})
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/ipc-executor.spec.ts tests/unit/credentials-ipc.spec.ts`
Expected: FAIL——executor 未上提、credentials 无委派

- [ ] **Step 3: 实现**

`contracts/ipc.ts` 的 `IpcChannels`（找到定义处）加：
```ts
chatSetEndpoint: 'chat:set-endpoint',
chatGetEndpoint: 'chat:get-endpoint',
chatGetRuntimeInfo: 'chat:get-runtime-info'
```
`channels.ts`：
```ts
export const chatConnectSchema = z.undefined()
export const chatSetEndpointSchema = z.object({ serverUrl: z.string().min(1).max(4096) })
export const chatGetEndpointSchema = z.undefined()
export const chatGetRuntimeInfoSchema = z.undefined()
export const endpointResponseSchema = z.object({ endpoint: z.string().optional() })
export const runtimeInfoResponseSchema = z.object({ mode: z.enum(['real', 'mock']), packaged: z.boolean() })
```
`executor.ts` catch CyreneError 分支改为：
```ts
if (e instanceof CyreneError && typeof e.code === 'string' && typeof e.message === 'string') {
  const msg = e.message.length > 65536 ? '<message-too-long>' : truncateCodepoints(options.sanitize(e.message), 500)
  const details = (e.details ?? {}) as { backendCode?: string; code?: string; retryable?: boolean; requestId?: string }
  const backendCode = details.backendCode ?? details.code
  const error: { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string } = { code: e.code, message: msg }
  if (backendCode) error.backendCode = backendCode
  if (typeof details.retryable === 'boolean') error.retryable = details.retryable
  if (details.requestId) error.requestId = details.requestId
  return { ok: false, error }
}
```
`credentials/index.ts`：`createCredentialsExecutors(store, opts, connConfig?)`——set/clear 的 fn 里：
```ts
if (req.key === BACKEND_TOKEN_KEY && connConfig) { await connConfig.setBackendToken(req.value) }
else { await store.setCredential(req.key, req.value) }
```
（clear 同理 `connConfig.clearBackendToken()` vs `store.clearCredential`）。`registerCredentialsHandlers(store, opts, connConfig?)` 透传。
`handlers.ts`：`registerHandlers(deps: { credentials; logger; chat; connectionConfig })`，`registerCredentialsHandlers(deps.credentials, { logger, sanitize }, deps.connectionConfig)`。

- [ ] **Step 4: 运行验证通过**

Run: 同上
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/main/ipc/channels.ts apps/desktop/src/main/ipc/executor.ts apps/desktop/src/main/credentials/index.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/tests/unit/ipc-executor.spec.ts apps/desktop/tests/unit/credentials-ipc.spec.ts apps/desktop/tests/unit/credentials-channels.spec.ts
git commit -m "feat(批次A): Task4 IPC 基建——connect 无参 schema/错误上提/凭据特判委派"
```

---

### Task 5: chat-service（connect 无参 + 新方法 + chat-handlers 注册）

**Files:**
- Modify: `apps/desktop/src/main/chat/chat-service.ts`（`connect` 无参 + deps `connectionConfig/packaged` + `setEndpoint/getEndpoint/getRuntimeInfo`）
- Modify: `apps/desktop/src/main/chat/chat-handlers.ts`（connect 注册改 arity 0；新增三通道注册）
- Test: `apps/desktop/tests/unit/chat-service.spec.ts`

**Interfaces:**
- Consumes: `ConnectionConfig`（Task 2）、`chatSetEndpointSchema/chatGetEndpointSchema/chatGetRuntimeInfoSchema`（Task 4）、`IpcChannels` 新键
- Produces: `ChatServiceDeps` 增 `connectionConfig: ConnectionConfig`、`packaged: boolean`；`ChatService` 增 `setEndpoint(rawUrl) / getEndpoint() / getRuntimeInfo()`；connect 校验经 `deps.connectionConfig.getEndpoint()/getTokenBinding()`

- [ ] **Step 1: 写失败测试**

`chat-service.spec.ts` 更新/追加。**注意**：(a) `makeDeps` 补默认 `connectionConfig` mock（`getEndpoint: () => undefined`、`getTokenBinding: async () => undefined`、`setEndpoint: async (u) => ({ origin:u, baseUrl:u.replace(/\/$/,''), wsUrl:u.replace(/^http/,'ws')+'/ws' })`）；(b) `vi.spyOn(adapter, 'connect')`——现有 4 个用例也需过 typecheck（`connect()` 无条件先调 `connectionConfig.getEndpoint()`）；(c) `ChatServiceDeps` 只加 `connectionConfig`，**不**设独立 `getTokenBinding`（统一走 connectionConfig，见 Step 3）。
```ts
it('connect 无参且 Real 未设 endpoint → CREDENTIAL_UNAVAILABLE', async () => {
  // requireToken: true, connectionConfig.getEndpoint: () => undefined
  await expect(svc.connect()).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
})
it('connect 绑定 origin 不匹配 → CREDENTIAL_UNAVAILABLE', async () => {
  // connectionConfig: { getEndpoint: () => ({ origin:'https://a.example', baseUrl:'https://a.example', wsUrl:'wss://a.example/ws' }), getTokenBinding: async () => ({ origin: 'https://b.example' }) }
  await expect(svc.connect()).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
})
it('connect Mock（requireToken=false）用 mock://local 占位且跳过校验', async () => {
  // connectionConfig.getEndpoint: () => undefined, requireToken: false
  const session = await svc.connect()
  expect(adapter.connect).toHaveBeenCalledWith({ serverUrl: 'mock://local' })
  expect(session.serverUrl).toBe('mock://local')
})
it('setEndpoint → 返回规范化 baseUrl', async () => {
  // connectionConfig.setEndpoint: async (u) => ({ origin:'https://a.example', baseUrl:'https://a.example', wsUrl:'wss://a.example/ws' })
  const r = await svc.setEndpoint('https://a.example/')
  expect(r).toEqual({ endpoint: 'https://a.example' })
})
it('getRuntimeInfo 依 requireToken 返回 mode', async () => {
  // requireToken: true → { mode:'real', packaged:false }
  expect(await svc.getRuntimeInfo()).toEqual({ mode: 'real', packaged: false })
})
```
（设计：`ChatServiceDeps` 注入 `connectionConfig: ConnectionConfig`，chat-service 的 `setEndpoint/getEndpoint/getRuntimeInfo` 与 connect 校验都直接调它。）

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/chat-service.spec.ts`
Expected: FAIL——connect 签名/逻辑未变

- [ ] **Step 3: 实现**

`chat-service.ts`：
```ts
// ChatServiceDeps 增：
//   connectionConfig: ConnectionConfig
//   packaged?: boolean
async connect(): Promise<BackendSession> {
  const endpoint = deps.connectionConfig.getEndpoint()
  if (deps.requireToken !== false) {
    if (!endpoint) throw new CyreneError(CyneErrorCode.CREDENTIAL_UNAVAILABLE, '请先设置后端地址')
    const binding = await deps.connectionConfig.getTokenBinding()
    if (binding?.origin !== endpoint.origin) throw new CyreneError(CyneErrorCode.CREDENTIAL_UNAVAILABLE, '后端 Token 未设置或与当前地址不匹配')
    const token = await deps.getToken()
    if (!token) throw new CyreneError(CyneErrorCode.CREDENTIAL_UNAVAILABLE, '后端 Token 未设置')
    const session = await adapter.connect({ serverUrl: endpoint.baseUrl, token })
    pushState(adapter.getConnectionState()); return session
  }
  const session = await adapter.connect({ serverUrl: 'mock://local' })
  pushState(adapter.getConnectionState()); return session
}
async setEndpoint(rawUrl: string): Promise<{ endpoint: string }> {
  const e = await deps.connectionConfig.setEndpoint(rawUrl)
  return { endpoint: e.baseUrl }
}
getEndpoint(): { endpoint?: string } {
  const e = deps.connectionConfig.getEndpoint()
  return { endpoint: e?.baseUrl }
}
getRuntimeInfo(): { mode: 'real' | 'mock'; packaged: boolean } {
  return { mode: deps.requireToken !== false ? 'real' : 'mock', packaged: deps.packaged ?? false }
}
```
`chat-handlers.ts`：
```ts
registerHandler(IpcChannels.chatConnect, handle(chatConnectSchema, () => svc.connect()), 0)
registerHandler(IpcChannels.chatSetEndpoint, handle(chatSetEndpointSchema, (req) => svc.setEndpoint(req.serverUrl)), 1)
registerHandler(IpcChannels.chatGetEndpoint, handle(chatGetEndpointSchema, () => svc.getEndpoint()), 0)
registerHandler(IpcChannels.chatGetRuntimeInfo, handle(chatGetRuntimeInfoSchema, () => svc.getRuntimeInfo()), 0)
```
（响应 schema：set/get-endpoint 用 `endpointResponseSchema`、runtime 用 `runtimeInfoResponseSchema` 替换 `responseEnvelope`——保持其余命令 `responseEnvelope`。）

- [ ] **Step 4: 运行验证通过**

Run: 同上
Expected: PASS（现有 connect(serverUrl) 用例同步改为无参 + 前置 endpoint）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/chat/chat-service.ts apps/desktop/src/main/chat/chat-handlers.ts apps/desktop/tests/unit/chat-service.spec.ts
git commit -m "feat(批次A): Task5 chat-service connect 无参 + setEndpoint/getRuntimeInfo + Mock 占位"
```

---

### Task 6: desktop-api（preload 面）

**Files:**
- Modify: `apps/desktop/src/preload/desktop-api.ts`（`connect()` 无参；`setEndpoint/getEndpoint/getRuntimeInfo`；`unwrap`/`unwrapStatus` 结构化 message 前缀）
- Modify: `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`（`DesktopApiLike` 加 `setEndpoint/getEndpoint/getRuntimeInfo` + 凭据方法 `getCredentialStatus/setBackendToken/clearBackendToken`；`connect` 去参）
- Modify: `apps/desktop/src/preload/index.d.ts`（`Window.desktopApi` 类型同步）
- Test: `apps/desktop/tests/unit/desktop-api-chat.spec.ts`

**Interfaces:**
- Consumes: `IpcChannels` 新键（Task 4）、`IpcErrorBody` 结构化（Task 1）
- Produces: `desktopApi.setEndpoint/getEndpoint/getRuntimeInfo/connect(无参)`；错误 message 格式 `[code] [backendCode=XX] [retryable=true] message`

- [ ] **Step 1: 写失败测试**

`desktop-api-chat.spec.ts` 更新/追加（沿用现有 mockIpc 风格）：
```ts
it('connect 无参 invoke（arity 0）', async () => {
  // mockIpc invoke 记录 channel+payload；断言 invoke 被调 with ('chat:connect')（无第二参——无参 invoke 只传 channel）
})
it('setEndpoint invoke chat:set-endpoint 载荷 {serverUrl}', async () => {
  // await api.setEndpoint('https://a.example/')；断言 invoke('chat:set-endpoint', { serverUrl: 'https://a.example/' })
})
it('unwrap 错误 → message 含 [code] 与 [backendCode=..]', () => {
  // 构造 { ok:false, error:{ code:'BACKEND_REJECTED', message:'队列已满', backendCode:'QUEUE_FULL', retryable:true } }
  // 断言 throw 的 Error.message === '[BACKEND_REJECTED] [backendCode=QUEUE_FULL] [retryable=true] 队列已满'
})
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/desktop-api-chat.spec.ts`
Expected: FAIL——connect 仍传 serverUrl、unwrap 无前缀

- [ ] **Step 3: 实现**

`desktop-api.ts`：
```ts
function formatIpcError(error: { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string }): Error {
  const parts = [error.code]
  if (error.backendCode) parts.push(`backendCode=${error.backendCode}`)
  if (typeof error.retryable === 'boolean') parts.push(`retryable=${error.retryable}`)
  if (error.requestId) parts.push(`requestId=${error.requestId}`)
  return new Error(`[${parts.join('] [')}] ${error.message}`)
}
async function connect(): Promise<BackendSession> {
  return unwrap(await invoke<BackendSession>(IpcChannels.chatConnect))
}
async function setEndpoint(url: string): Promise<{ endpoint: string }> {
  return unwrap(await invokeWithArgs<{ endpoint: string }>(IpcChannels.chatSetEndpoint, { serverUrl: url }))
}
async function getEndpoint(): Promise<{ endpoint?: string }> {
  return unwrap(await invoke<{ endpoint?: string }>(IpcChannels.chatGetEndpoint))
}
async function getRuntimeInfo(): Promise<{ mode: 'real' | 'mock'; packaged: boolean }> {
  return unwrap(await invoke<{ mode: 'real' | 'mock'; packaged: boolean }>(IpcChannels.chatGetRuntimeInfo))
}
```
`unwrap`/`unwrapStatus` 的 `throw new Error(\`[${res.error.code}] ${res.error.message}\`)` 改为 `throw formatIpcError(res.error)`；`desktopApi` 对象加 `setEndpoint/getEndpoint/getRuntimeInfo`，`connect` 改为无参引用。类型同步：`renderer/src/stores/desktop-api.types.ts` 的 `DesktopApiLike` 加 `setEndpoint/getEndpoint/getRuntimeInfo` + 凭据方法 `getCredentialStatus/setBackendToken/clearBackendToken`（Task 7 面板要调）+ `connect` 去参；`preload/index.d.ts` 的 `Window.desktopApi` 同步。

- [ ] **Step 4: 运行验证通过**

Run: 同上
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/desktop-api.ts apps/desktop/src/renderer/src/stores/desktop-api.types.ts apps/desktop/src/preload/index.d.ts apps/desktop/tests/unit/desktop-api-chat.spec.ts
git commit -m "feat(批次A): Task6 desktop-api setEndpoint/getEndpoint/getRuntimeInfo + connect 无参 + 错误 message 前缀"
```

---

### Task 7: renderer（parsePublicError + stores + CyConnectionPanel）

**Files:**
- Create: `apps/desktop/src/renderer/src/utils/public-error.ts`（`parsePublicError`）
- Create: `apps/desktop/tests/unit/public-error.spec.ts`
- Create: `apps/desktop/src/renderer/src/components/CyConnectionPanel.vue`
- Modify: `apps/desktop/src/renderer/src/stores/connection.store.ts`（`connect()` 无参；`error` 结构化）
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`（`lastError` 结构化）
- Modify: `apps/desktop/src/renderer/src/components/CyChatView.vue`（连接控件区替换为 `CyConnectionPanel`）
- Modify: `apps/desktop/src/renderer/src/components/CyChatInput.vue`（`lastError` 展示改 `.message`，避免 `[object Object]`）
- Test: `apps/desktop/tests/unit/connection.store.spec.ts`、`apps/desktop/tests/unit/message.store.spec.ts`

**Interfaces:**
- Consumes: `desktopApi.setEndpoint/getEndpoint/getRuntimeInfo/connect(无参)`（Task 6）
- Produces: `PublicError`、`parsePublicError(message)`、`connectionStore.error: PublicError | undefined`、`messageStore.lastError: PublicError | undefined`、`CyConnectionPanel`

- [ ] **Step 1: 写失败测试**

`public-error.spec.ts`（新）：
```ts
import { describe, expect, it } from 'vitest'
import { parsePublicError } from '../../src/renderer/src/utils/public-error'

describe('parsePublicError', () => {
  it('解析 [code] message', () => {
    expect(parsePublicError('[CREDENTIAL_UNAVAILABLE] 后端 Token 未设置')).toEqual({ code: 'CREDENTIAL_UNAVAILABLE', message: '后端 Token 未设置' })
  })
  it('解析 [code] [backendCode=..] [retryable=..] message', () => {
    expect(parsePublicError('[BACKEND_REJECTED] [backendCode=QUEUE_FULL] [retryable=true] 队列已满')).toEqual({
      code: 'BACKEND_REJECTED', message: '队列已满', backendCode: 'QUEUE_FULL', retryable: true
    })
  })
  it('无前缀回退 UNKNOWN', () => {
    expect(parsePublicError('plain error')).toEqual({ code: 'UNKNOWN', message: 'plain error' })
  })
  it('message 本身含 [] 不受影响', () => {
    expect(parsePublicError('[AUTHENTICATION_FAILED] 401 [detail]')).toEqual({ code: 'AUTHENTICATION_FAILED', message: '401 [detail]' })
  })
})
```
`connection.store.spec.ts`：`connect()` 无参断言（mockApi.connect 无参）；错误路径 `error` 为结构化（`parsePublicError` 产出）。

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/public-error.spec.ts tests/unit/connection.store.spec.ts`
Expected: FAIL——模块不存在 / connect 仍带参数

- [ ] **Step 3: 实现**

`public-error.ts`：
```ts
export interface PublicError { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string }

/** 反解 desktop-api 跨桥错误 message 前缀（Electron contextBridge 只保真 message）：'[code] [k=v]... message' → { code, message, ... }（message 剥离 [k=v] 段） */
export function parsePublicError(message: string): PublicError {
  const text = message.startsWith('[') ? message : `[UNKNOWN] ${message}`
  const endBracket = text.indexOf(']')
  const code = endBracket > 0 ? text.slice(1, endBracket) : 'UNKNOWN'
  const rest = endBracket > 0 ? text.slice(endBracket + 1).trim() : text
  const out: PublicError = { code, message: rest }
  const kvRe = /\[([a-zA-Z]+)=([^\]]+)\]\s*/g
  let stripped = rest
  let m: RegExpExecArray | null
  while ((m = kvRe.exec(rest)) !== null) {
    stripped = stripped.replace(m[0], '')
    if (m[1] === 'backendCode') out.backendCode = m[2]
    else if (m[1] === 'retryable') out.retryable = m[2] === 'true'
    else if (m[1] === 'requestId') out.requestId = m[2]
  }
  out.message = stripped.trim() || rest   // 无 kv 段时 rest 原样（'401 [detail]' 的 [detail] 非 k=v 不剥离）
  return out
}
```
`connection.store.ts`：`error` 改 `ref<PublicError>()`；`connect()` 去参，**保留现有乐观置位**（`state.status='connecting'` + `connecting=true`，与现有 C-3「push 不轮询」设计一致），只把错误改结构化：
```ts
async function connect(): Promise<void> {
  error.value = undefined
  state.value = { status: 'connecting' }   // 乐观置位（保留既有行为）
  connecting.value = true
  try {
    await api.connect()
    // 连接结果由 chat:state push 更新（定死 push 不轮询），此处不主动拉
  } catch (e) {
    error.value = parsePublicError(e instanceof Error ? e.message : String(e))
    state.value = { status: 'disconnected' }
  } finally {
    connecting.value = false
  }
}
```
（`state`/`connecting` 为现有 store 的 ref 名——先读 `connection.store.ts` 确认字段名沿用；现有测试里 `connecting===true` 乐观态与失败后 `error` 字符串断言同步改为结构化。）
`message.store.ts`：`lastError` 改 `ref<PublicError>()`；`send` catch 里 `lastError.value = parsePublicError(messageOf(e))`；`failAssistant` 改 `lastError.value = { code: event.error.code, message: event.error.message, backendCode: event.error.code, retryable: event.error.retryable }`。

`CyConnectionPanel.vue`（核心结构；样式沿用 `--cy-*` token，参照现有组件）：
```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import type { CredentialStatus } from '@shared/contracts'
import { api } from '../stores/desktop-api'

const connection = useConnectionStore()
const mode = ref<'real' | 'mock'>('real')
const endpointInput = ref('')
const tokenInput = ref('')
const tokenStatus = ref<CredentialStatus>('empty')
const endpointErr = ref<string>()
const tokenErr = ref<string>()
const busy = ref(false)
const serverVersion = computed(() => connection.state.serverVersion)
const protocolVersion = computed(() => connection.state.protocolVersion)
const connected = computed(() => connection.state.status === 'connected')
const tokenLabel = computed(() => ({ available: 'Token 已设置', empty: 'Token 未设置', unavailable: '凭据存储不可用', locked: '凭据已锁定' }[tokenStatus.value] ?? ''))

onMounted(async () => {
  const r = await api.getRuntimeInfo()
  mode.value = r.mode
  const e = await api.getEndpoint()
  if (e.endpoint) endpointInput.value = e.endpoint
  tokenStatus.value = await api.getCredentialStatus()
})
async function applyEndpoint(): Promise<void> {
  endpointErr.value = undefined
  try { const r = await api.setEndpoint(endpointInput.value.trim()); endpointInput.value = r.endpoint }
  catch (e: unknown) { endpointErr.value = e instanceof Error ? e.message : String(e) }
}
async function applyToken(): Promise<void> {
  tokenErr.value = undefined
  const t = tokenInput.value.trim()
  if (!t) return
  try { tokenStatus.value = await api.setBackendToken(t) }
  catch (e: unknown) { tokenErr.value = e instanceof Error ? e.message : String(e) }
  finally { tokenInput.value = '' }   // 提交后立即清空明文（spec 3.2.2）
}
async function clearToken(): Promise<void> { tokenStatus.value = await api.clearBackendToken() }
async function toggleConnect(): Promise<void> {
  busy.value = true
  try { connected.value ? await connection.disconnect() : await connection.connect() } finally { busy.value = false }
}
</script>
<template>
  <div class="cy-connection-panel">
    <div class="cy-mode-row"><span class="cy-mode-badge">{{ mode === 'mock' ? 'MOCK 演示模式' : 'REAL' }}</span></div>
    <div v-if="mode !== 'mock'" class="cy-row">
      <input v-model="endpointInput" placeholder="https://… 或回环 http://127.0.0.1:8765" />
      <button :disabled="busy" @click="applyEndpoint">设置</button>
    </div>
    <div v-if="endpointErr" class="cy-err">{{ endpointErr }}</div>
    <div v-if="mode !== 'mock'" class="cy-row">
      <span>{{ tokenLabel }}</span>
      <input v-model="tokenInput" type="password" placeholder="Token" @keyup.enter="applyToken" />
      <button :disabled="busy" @click="applyToken">设置</button>
      <button v-if="tokenStatus === 'available'" :disabled="busy" @click="clearToken">清除</button>
    </div>
    <div v-if="tokenErr" class="cy-err">{{ tokenErr }}</div>
    <div class="cy-row">
      <button :disabled="busy" @click="toggleConnect">{{ connected ? '断开' : '连接' }}</button>
    </div>
    <div v-if="serverVersion || protocolVersion" class="cy-server-info">后端 {{ serverVersion }} · 协议 {{ protocolVersion }}</div>
    <div v-if="connection.error" class="cy-conn-error">{{ connection.error.message }}</div>
  </div>
</template>
```
`CyChatView.vue`：把现有「serverUrl 输入 + 连接按钮」控件区替换为 `<CyConnectionPanel />`；保留空态 / 流式占位 / 断线横幅。
`CyChatInput.vue`：现有 `<span>发送失败:{{ messageStore.lastError }}</span>`（约 62 行）——`lastError` 已改结构化，改 `v-if` 守卫 + `.message`：
```html
<span v-if="messageStore.lastError">发送失败:{{ messageStore.lastError.message }}</span>
```

- [ ] **Step 4: 运行验证通过**

Run: 同上
Expected: PASS（`connection.store.spec`/`message.store.spec` 现有断言随 error 结构化更新；`CyChatView` 相关 store 调用同步）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/utils/public-error.ts apps/desktop/tests/unit/public-error.spec.ts apps/desktop/src/renderer/src/components/CyConnectionPanel.vue apps/desktop/src/renderer/src/stores/connection.store.ts apps/desktop/src/renderer/src/stores/message.store.ts apps/desktop/src/renderer/src/components/CyChatView.vue apps/desktop/src/renderer/src/components/CyChatInput.vue apps/desktop/tests/unit/connection.store.spec.ts apps/desktop/tests/unit/message.store.spec.ts
git commit -m "feat(批次A): Task7 renderer parsePublicError/connection store 结构化/CyConnectionPanel"
```

---

### Task 8: main 装配（装配策略 + connection-config 注入）

**Files:**
- Modify: `apps/desktop/src/main/index.ts`（`useMock` 逻辑；构造 `ConnectionConfig` 注入 CredentialStore 端口；`chatSvc` deps 传 `connectionConfig/packaged`；`registerHandlers` 传 `connectionConfig`）
- Test: `apps/desktop/tests/unit/config-env.spec.ts` 或新增（装配策略纯逻辑——若 `index.ts` 难单测，把 `useMock` 判定提为纯函数放 `main/config/` 并单测）

**Interfaces:**
- Consumes: `ConnectionConfig`（Task 2）、`ChatServiceDeps` 扩展（Task 5）、`registerHandlers` deps 扩展（Task 4）
- Produces: `index.ts` 装配 `useMock = !app.isPackaged && process.env['CYRENE_BACKEND'] === 'mock'`；`ConnectionConfig` 注入端口

- [ ] **Step 1: 写失败测试**（若提纯函数）

在 `main/config/` 新增 `backend-mode.ts`：`export function resolveBackendMode(packaged: boolean, env: NodeJS.ProcessEnv): 'real' | 'mock'`——`return !packaged && env['CYRENE_BACKEND'] === 'mock' ? 'mock' : 'real'`。测试：
```ts
it('packaged → real（无视 env）', () => { expect(resolveBackendMode(true, { CYRENE_BACKEND: 'mock' })).toBe('real') })
it('未打包 + CYRENE_BACKEND=mock → mock', () => { expect(resolveBackendMode(false, { CYRENE_BACKEND: 'mock' })).toBe('mock') })
it('未打包默认 → real', () => { expect(resolveBackendMode(false, {})).toBe('real') })
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cyrene/desktop exec vitest run --config vitest.config.mts tests/unit/config-env.spec.ts`
Expected: FAIL——函数不存在

- [ ] **Step 3: 实现**

`main/config/backend-mode.ts` 按 Step 1 实现。`index.ts`：
```ts
import { ConnectionConfig } from './connection/connection-config'
import { resolveBackendMode } from './config/backend-mode'
...
const useMock = resolveBackendMode(app.isPackaged, process.env) === 'mock'
const adapter: BackendAdapter = useMock
  ? new MockBackend({ onConnectionStateChange: onState })
  : new RealBackend({ onConnectionStateChange: onState, onSessionReplay: onReplay })
const connConfig = new ConnectionConfig(
  {
    loadToken: () => store.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined),
    saveToken: (v) => store.setCredential(BACKEND_TOKEN_KEY, v),
    clearToken: () => store.clearCredential(BACKEND_TOKEN_KEY),
    loadBinding: () => store.getCredential(BACKEND_TOKEN_ORIGIN_KEY).then((t) => t ?? undefined),
    saveBinding: (o) => store.setCredential(BACKEND_TOKEN_ORIGIN_KEY, o),
    clearBinding: () => store.clearCredential(BACKEND_TOKEN_ORIGIN_KEY)
  },
  (e) => { void diagnostics.auditor.audit({ ts: new Date().toISOString(), type: 'endpoint:set', summary: e.origin }) }   // 审计记规范化 origin，不含 token/完整 URL 参数（spec 3.1.2）；AuditEvent 字段按 diagnostics/audit.ts 现有结构（ts/type/summary 等，无 data 字段）
)
const chatSvc = createChatService({
  adapter, send: (channel, payload) => { const w = getMainWindow(); w?.webContents.send(channel, payload) },
  getToken: () => store.getCredential(BACKEND_TOKEN_KEY).then((t) => t ?? undefined),
  requireToken: !useMock,
  connectionConfig: connConfig,
  packaged: app.isPackaged
})
chatBridge.svc = chatSvc
registerHandlers({ credentials: store, logger: diagnostics.logger, chat: chatSvc, connectionConfig: connConfig })
```
（注意 `BACKEND_TOKEN_ORIGIN_KEY` 从 `@shared/contracts` 导入；`CredentialStore.setCredential` 先确认签名，若抛错用现有错误传播。）

- [ ] **Step 4: 运行验证通过**

Run: `pnpm --filter @cyrene/desktop typecheck` + 单测
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/config/backend-mode.ts apps/desktop/tests/unit/config-env.spec.ts
git commit -m "feat(批次A): Task8 装配策略(打包恒Real/mock显式) + connection-config 注入"
```

---

### Task 9: 集成测试更新与新增

**Files:**
- Modify: `apps/desktop/tests/integration/ipc-security.spec.ts`（白名单 18→21 键；凭据往返先 `setEndpoint`；新增 attacker endpoint 用例）
- Modify: `apps/desktop/tests/integration/helpers/app.ts`（**必须**：`launchApp` env 设 `CYRENE_BACKEND=mock`——新装配策略未打包默认 Real，集成测试须固定 mock 装配，否则 boot 模式翻转）
- Modify: `apps/desktop/tests/integration/helpers/desktop-api.d.ts`（`Window.desktopApi` 补 `setEndpoint/getEndpoint/getRuntimeInfo` + `connect` 无参——tsconfig include `tests/**/*` 参与 typecheck，不加则终局 typecheck 红）

- [ ] **Step 1: 更新既有断言**

`ipc-security.spec.ts:25-29` 白名单键改为 21 个（排序）：
```ts
expect(surface.keys).toEqual([
  'activate', 'cancel', 'clearBackendToken', 'connect', 'createConversation', 'deleteConversation',
  'disconnect', 'getAppInfo', 'getConnectionState', 'getCredentialStatus', 'getEndpoint', 'getMessages',
  'getRuntimeInfo', 'listConversations', 'onChatEvent', 'onChatReplay', 'onChatState', 'renameConversation',
  'send', 'setBackendToken', 'setEndpoint'
])
```
`ipc-security.spec.ts:48-70` 凭据往返：在 `setBackendToken('sk-test-token')` 前先 `await window.desktopApi.setEndpoint('http://127.0.0.1:8765')`（否则新规则抛 `CREDENTIAL_UNAVAILABLE`）。

- [ ] **Step 2: 新增用例**

```ts
it('endpoint 变更后旧 token 不自动复用（绑定被清）', async () => {
  const res = await page.evaluate(async () => {
    const initial = await window.desktopApi.getCredentialStatus()
    if (initial === 'unavailable') return { skipped: true }   // safeStorage 不可用环境跳过（与凭据往返用例同款分支）
    await window.desktopApi.setEndpoint('http://127.0.0.1:8765')   // 先绑定本机
    await window.desktopApi.setBackendToken('sk-test')
    await window.desktopApi.setEndpoint('https://attacker.example') // origin 变 → 自动清 token 绑定
    return { status: await window.desktopApi.getCredentialStatus() }
  })
  if (res.skipped) return
  expect(res.status).toBe('empty')   // 集成套件跑 Mock（launchApp 设 CYRENE_BACKEND=mock），此断言模式无关；真正禁止外发 token 的 connect 守卫在 Real 路径，由 chat-service 单测覆盖
})
it('getRuntimeInfo 返回装配模式', async () => {
  const info = await page.evaluate(() => window.desktopApi.getRuntimeInfo())
  expect(['real', 'mock']).toContain(info.mode)
  expect(typeof info.packaged).toBe('boolean')
})
```
（attacker 用例的精确断言以实现为准：核心是「Endpoint 变化后旧 token 不自动复用」。若需要更严格，可在 Main 侧对 setEndpoint('https://attacker.example') 后调用 connect 断言 `CREDENTIAL_UNAVAILABLE` 而非发请求。）

- [ ] **Step 3: 运行**

Run: `xvfb-run -a pnpm --filter @cyrene/desktop test:integration`
Expected: 18+ 全绿（原 18 更新后 + 新增）

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/integration/ipc-security.spec.ts apps/desktop/tests/integration/helpers/app.ts apps/desktop/tests/integration/helpers/desktop-api.d.ts
git commit -m "test(批次A): Task9 集成测试——白名单21键/凭据先设endpoint/attacker不泄漏token/getRuntimeInfo"
```

---

### Task 10: 收尾（全量验证 + 文档同步）

**Files:**
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（变更记录追加批次 A）
- Modify: `README.md`（真实模式启动/Token/Endpoint 说明，对应 FE-P2-04 联调命令）
- Modify: `docs/superpowers/specs/2026-08-11-phase2-realconn-preparation-design.md`（如有实现偏差，同步）

- [ ] **Step 1: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm test && xvfb-run -a pnpm test:integration && pnpm build`
Expected: 全部通过（单测 ≥315，集成 ≥18）

- [ ] **Step 2: 文档同步**

- `docs/16` 变更记录追加一行：批次 A 三块（FE-P0-01/FE-P1-02/FE-P1-01）落地、门禁结果、仍标「已开发、未联调」；
- `README.md` 增加「真实模式联调」小节：`CYRENE_BACKEND=real`（默认）启动、连接面板设置 Endpoint/Token、`CYRENE_BACKEND=mock pnpm dev` 显式 Mock。

- [ ] **Step 3: 修复全部问题至绿**

若任一验证失败，修到全绿后继续。

- [ ] **Step 4: Commit**

```bash
git add docs/16-Cyrene-前端实施任务清单与进度跟踪.md README.md
git commit -m "docs(批次A): doc16/README——批次A落地记录与真实模式联调说明"
```

---

## 收尾说明

批次 A 三个 FE 问题（FE-P0-01 / FE-P1-02 / FE-P1-01）按 Task 1→10 顺序实施，每任务独立 TDD + commit。批次 B（FE-P1-03/04/05、FE-P2-01）与批次 C（FE-P2-02/03/04）另起 spec/plan，不在本 plan 范围。完成后仍标「已开发、未联调」。


