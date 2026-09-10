# Cyrene 阶段 2 真实联调整改·批次 A：连接与凭据安全 / 真实模式装配 / rejected ACK 设计

**日期：** 2026-08-11
**依据：** `docs/review/2026-08-11-阶段2真实联调前端整改清单.md` 批次 A（FE-P0-01 / FE-P1-02 / FE-P1-01）
**审查对象基线：** `main@3372ac9`
**范围：** Electron 阶段 2 文本聊天纵向链路的连接/凭据/装配/ACK 错误路径（Main / Preload / Renderer / RealBackend）
**目的：** 趁后端尚未冻结，先修复不依赖后端继续开发的前端问题；后端完成后直接进入真实联调。本批完成后仍标「已开发、未联调」。

---

## 1. 背景与目标

阶段 2 三块已全部落地并通过门禁（315 单测 + 18 集成 + typecheck/lint/build），但只能认定为「Mock 驱动链路已完成」。第三方 review 指出真实联调前有 1 个安全阻断项与若干功能/契约问题。本批处理批次 A 的三项：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-P0-01 | P0 | Renderer 控制 `serverUrl`，Main 向任意 Origin 携带已保存 Token | 任意 Renderer 输入都不能让 Main 把 Token 发往未绑定 Origin |
| FE-P1-02 | P1 | Real/Mock 模式和 Token/Endpoint 配置未形成产品路径 | 生产默认不落 Mock；用户可安全设置 Endpoint/Token；UI 明确 REAL/MOCK |
| FE-P1-01 | P1 | rejected ACK 空 `messageId` 被前端 Schema 丢弃 → 15s 超时 | rejected ACK 即时、结构化地传到 UI，保留 `backendCode/retryable` |

**完成标准**（对照 review 第 5 节，本批范围）：
- 任意 Renderer 输入都不能让 Main 把已有 Token 发往未绑定 Origin；
- rejected ACK 能即时、结构化地传到 UI（不等待 ACK timeout）；
- production 默认不落到 Mock，开发 Mock 有明确标识；
- 用户可安全设置 Endpoint/Token，Token 不可读回、不进日志；
- typecheck、lint、315+ 单测、18+ 集成测试、build 全绿；
- 文档仍标记「已开发、未联调」。

## 2. 范围（本批 vs 后续批次）

**本批做：** FE-P0-01（Endpoint/Token 绑定 + URL 规范化）、FE-P1-02（装配策略 + 最小连接设置 + 模式标识）、FE-P1-01（rejected ACK Schema + 结构化错误骨架）。

**本批不做**（分属 review 批次 B/C 或阶段 3+）：
- FE-P1-03 会话初始化时序、FE-P1-04 conversation/epoch 守卫、FE-P1-05 完整错误链、FE-P2-01 超时/取消/门控（批次 B）；
- FE-P2-02 IPC/replay 运行时 Schema 完整化、FE-P2-03 夹具跨仓库门禁、FE-P2-04 文档漂移（批次 C）；
- 阶段 3+：附件、搜索、历史查看器、模型/语音、Live2D、工具执行。

## 3. 设计

### 3.1 连接与凭据安全（FE-P0-01）

#### 3.1.1 Main 持有规范化 Endpoint，Renderer 不再传任意 URL

**新增** `apps/desktop/src/main/connection/connection-config.ts`：持有当前 endpoint 与 token 绑定状态。它依赖**注入的存储端口**（构造入参，如 `loadToken()/saveToken()/clearToken()/loadBinding()/saveBinding()/clearBinding()` 或 CredentialStore 接口），所有副作用（读/清 token、读写绑定 origin）都经该端口执行，自身不直接依赖 Electron；核心规范化/绑定逻辑为纯函数，注入 fake 端口即可单测。暴露：

```
interface NormalizedEndpoint { origin: string; baseUrl: string; wsUrl: string }
normalizeEndpoint(rawUrl: string): NormalizedEndpoint   // 校验 + 规范化，失败抛 CyreneError(INVALID_INPUT)
setEndpoint(rawUrl: string): NormalizedEndpoint          // 规范化 + 存储 + origin 变化时清 token 绑定
getEndpoint(): NormalizedEndpoint | undefined
getTokenBinding(): { origin: string } | undefined         // 读 BACKEND_TOKEN_ORIGIN_KEY
```
- 新增 `setEndpoint`/`getEndpoint`/`clearEndpoint` 方法由 chat-service 桥接（见 3.1.4）。

**URL 规范化规则**（`new URL`，对照 review FE-P0-01 必须修改 4）：
- 协议：远程只允许 `https:`；`http:` 仅允许回环 host（`localhost`、`127.0.0.0/8`、`[::1]`）；
- **回环判定实现约束**：必须按 IP 解析判定（`net.isIP` + `127.0.0.0/8` 位运算；`::1`），**禁止** `hostname.startsWith('127.')` 前缀匹配（会误放行 `http://127.1.2.3.attacker.com`）；IPv6 `[::1]` 的 `url.hostname` 带方括号，需同时覆盖去括号后的 `::1`；
- 拒绝 `username`/`password`、`search`、`hash`（`url.username !== ''` 等即拒）；
- 保留 pathname（允许反向代理前缀），去除尾斜杠；
- `origin` = `protocol://host[:port]`（规范化后）；
- `baseUrl` = origin + 去尾斜杠 pathname（REST 基址）；
- `wsUrl` = 由 URL 对象的 protocol `http→ws`/`https→wss` 转换派生，保留 host/path + `/ws`，不做字符串拼接；
- **wsUrl/baseUrl 层归属（本批决策：接口层改造推迟，见 §6 决策 8）**：connection-config 派生 `baseUrl`（喂给 RealBackend connect 的 serverUrl，REST 用）与 `wsUrl`（本批仅 connection-config 内部/测试使用）。RealBackend 现有 `serverUrl.replace(/^http/,'ws') + '/ws'`（real-backend.ts:253）保留——输入 baseUrl 恒 http(s) 开头且已去尾斜杠，派生结果与 wsUrl 等价；改 `ConnectInput`/`BackendAdapter.connect` 接口会牵动全部调用与测试，非本批正确性需要，推迟。

**IPC request schema 变化**（`apps/desktop/src/main/ipc/channels.ts`）：
- `chatConnectSchema` 从 `{ serverUrl: z.string().min(1) }` 改为 **`z.undefined()`**（与 `chatGetStateSchema` 一致），preload `connect()` 无参 `invoke`（arity 0）——避免 `z.object({}).safeParse(undefined)` 失败；
- 新增 `chatSetEndpointSchema = { serverUrl: z.string().min(1).max(4096) }`（arity 1）。

#### 3.1.2 Token 与规范化 Origin 绑定

- `shared/contracts` 新增 `BACKEND_TOKEN_ORIGIN_KEY = 'backend_token_origin'`（与 `BACKEND_TOKEN_KEY` 并列，进 `isKeyAllowed` 白名单）；存绑定 origin 明文（非敏感，不含 token）。
- `setBackendToken(token)`：先校验当前已设 endpoint（未设 → `CREDENTIAL_UNAVAILABLE`「请先设置后端地址」）；通过则存 token 到 `BACKEND_TOKEN_KEY` + 存当前 origin 到 `BACKEND_TOKEN_ORIGIN_KEY`。
- `clearBackendToken()`：清 token + 清绑定 origin。
- `setEndpoint()`（3.1.1）检测规范化后 origin 与绑定 origin 不同 → **自动清 token + 绑定**（旧 token 绝不发给新 origin；对照 review「Endpoint 变化不得自动复用旧 Token」）。
- `connect()`：读 token 与绑定 origin；无 token 或绑定 origin ≠ 当前 origin → `CREDENTIAL_UNAVAILABLE`（UI 提示重新设置 Token）；相符 → 用 `baseUrl` + token 连接 RealBackend。

**审计**：endpoint 变更、凭据 set/clear 进入现有审计日志（`diagnostics.audit`），**不记录 token 值**；endpoint 记录规范化后的 origin（不含 query/fragment，不记录敏感 URL 参数）。

#### 3.1.3 desktopApi 面变化（`apps/desktop/src/preload/desktop-api.ts`）

```
setEndpoint(url: string): Promise<{ endpoint: string }>   // 规范化后回显 baseUrl（非 secret）
getEndpoint(): Promise<{ endpoint?: string }>             // UI 回显
getRuntimeInfo(): Promise<{ mode: 'real' | 'mock'; packaged: boolean }>   // FE-P1-02 模式标识
setBackendToken(token) / clearBackendToken()              // 保持签名；Main 侧加 origin 绑定
connect(): Promise<BackendSession>                        // 无参：Main 用当前 endpoint
disconnect()                                              // 保持
```
- `desktopApi.connect` 现签名 `connect(serverUrl: string)` → 改无参 `connect()`；`BackendSession.serverUrl` 保留（由 adapter 回填实际连接地址，UI 展示用）。
- `index.d.ts` 与 `desktop-api.types.ts` 同步。
- 新增 IPC 通道需同步注册：`IpcChannels` 常量（`chat:set-endpoint`/`chat:get-endpoint`/`chat:get-runtime-info`）、`channels.ts` 对应 request/response schema、`main/ipc/handlers.ts` 注册与 arity、`preload/index.d.ts` 与 `desktop-api.types.ts` 类型同步。

#### 3.1.4 装配与桥接（`apps/desktop/src/main/index.ts` + `chat-service.ts`）

- `chat-service.ts`：`connect()` 不再收 `{ serverUrl }`；`ChatServiceDeps` 增 `getEndpoint()`（来自 connection-config）与 `getTokenBinding()`（绑定 origin）。connect 流程：
  1. Real 模式 `getEndpoint()` 为 undefined（未设 endpoint）→ `CREDENTIAL_UNAVAILABLE`（「请先设置后端地址」）；
  2. 校验 token 绑定：`getTokenBinding()?.origin !== endpoint.origin` → `CREDENTIAL_UNAVAILABLE`（重新设置 Token）；绑定匹配但取不到 token（如部分写入）→ `CREDENTIAL_UNAVAILABLE`（「后端 Token 未设置」）；
  3. `adapter.connect({ serverUrl: endpoint.baseUrl, token })`；
- **Mock 模式无 endpoint**：`getEndpoint()` 可能为 undefined（Mock 隐藏 Endpoint 行 + endpoint 内存持有）。chat-service 在 `requireToken=false`（Mock）分支用占位 `serverUrl: 'mock://local'` 且跳过 token 绑定校验；
- **setBackendToken/clearBackendToken 编排归属**：`connection-config` 增 `setBackendToken(token)`（先校验 endpoint 已设，未设 → `CREDENTIAL_UNAVAILABLE`；通过则经存储端口写 token + 绑定 origin）与 `clearBackendToken()`（清 token + 绑定）。`main/credentials` 的 `registerCredentialsHandlers` 对 `key === BACKEND_TOKEN_KEY` **特判委派**给 connection-config（其余 key 保持通用 credentialsSet/Clear，零耦合不破坏）；`index.ts` 装配时把 connection-config 注入 `registerCredentialsHandlers`。preload `setBackendToken/clearBackendToken` 签名不变；
- `index.ts`：构造 `connection-config`（注入 CredentialStore 端口：load/save/clear token + 绑定 origin），`setEndpoint`/`getEndpoint` 桥到 chat-service IPC handler、`getTokenBinding` 桥为 chat-service 内部 deps（connect 校验用）；`clearEndpoint` 为 connection-config **内部方法**（setEndpoint origin 变化时自动清 token，不暴露 IPC 面）；`getToken` 仍走 CredentialStore。
- `BackendSession.serverUrl`：RealBackend connect 返回规范化 `baseUrl`；Mock 无参 connect 返回 `MOCK_SESSION.serverUrl`（`mock://local`）。注意：现状 `MockBackend.connect` 用 `input.serverUrl` 覆盖 `MOCK_SESSION.serverUrl`（mock-backend.ts:94-98），改无参后不再覆盖，固定返回 `mock://local`。

### 3.2 真实模式装配与连接设置（FE-P1-02）

#### 3.2.1 装配策略（`apps/desktop/src/main/index.ts:107-109`）

```
const useMock = !app.isPackaged && process.env['CYRENE_BACKEND'] === 'mock'
adapter = useMock ? new MockBackend(...) : new RealBackend(...)
requireToken = !useMock
```
- **packaged → 恒 Real**（Mock 不可达）；
- **未打包 → 默认 Real**；`CYRENE_BACKEND=mock` 显式 Mock（演示/离线开发）；
- UI 模式标识通过 `getRuntimeInfo()` 获取（不依赖 env 猜测）。

#### 3.2.2 连接设置 UI

**新增** `apps/desktop/src/renderer/src/components/CyConnectionPanel.vue`，替换 `CyChatView.vue` 现有连接控件区（serverUrl 输入 + 连接按钮）。

**组成**（自上而下）：
- **模式标识**：`REAL` / `MOCK` badge（`getRuntimeInfo()`；Mock 模式额外注明「演示模式，无需 Token」）；
- **Endpoint 行**：输入框（初始值来自 `getEndpoint()` 回显）+「设置」按钮（`setEndpoint`，成功回显规范化 `baseUrl`，失败显示错误）；**Mock 模式隐藏**；
- **Token 行**：状态 chip（`getCredentialStatus()` 四态 `available/empty/unavailable/locked`）+「设置/清除」按钮（设置用密码框，**提交成功后立即清空明文响应式状态**，不提供读回，不进日志）；**Mock 模式隐藏**；
- **连接行**：「连接/断开」按钮（`connect()`/`disconnect()`，REAL 模式连失败显示结构化错误）；
- **连接信息行**：连接后显示后端 `serverVersion` / `protocolVersion`（来自 `ConnectionState`，联调证据可追溯）。

- `CyChatView.vue` 保留空态 / 流式占位 / 断线横幅；断线横幅保留现有文案。
- `connection.store.ts`：`connect()` 改无参（去掉 `serverUrl` 参数）；错误状态改为结构化（见 3.3.3）。

### 3.3 rejected ACK Schema 与结构化错误（FE-P1-01）

#### 3.3.1 ACK Schema 按 status 区分（`apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts:135-144`）

`RawUserAckSchema` **保持单对象 + `superRefine`** 按 status 校验 messageId/error。**不要**拆 `z.union([accepted, rejected])`：`RawUserAckSchema` 是外层 `RawFrameSchema = z.discriminatedUnion('type', [...])` 的成员，子项再建 union 会导致外层 discriminatedUnion 首次 parse 抛 `Invalid discriminated union option at index 0`（用项目实际 zod 4.4.3 实测会崩）：

```ts
messageId: z.string(),   // 不设 min(1)：rejected 允许 ''（空值是真实 wire——后端 ws_handler.py rejected 分支 messageId=""，语义是「消息尚未被正式接纳，无正式 ID」，不是漏填）
status: z.enum(['accepted', 'rejected']),
error: z.object({ code: z.string().min(1), message: z.string(), retryable: z.boolean().optional() }).optional(),
// superRefine：
//   status==='accepted' && messageId==='' → addIssue（非法帧 fail-closed）
//   status==='rejected' → 允许 messageId===''，error 可选（缺 error 不在此拒帧，交 3.3.2 退化分支立即 reject）
```
- 语义：rejected 表示「用户消息尚未被正式接纳，无正式 message ID」，空值是当前真实 wire（后端 `ws_handler.py`），不是漏填；
- `accepted + 空 messageId` 仍视为非法帧（fail-closed）；
- rejected 的 `error` **可选**：缺 error 的畸形 rejected 帧不在 schema 层拒掉（否则 pending 仍等 15s 超时），由 3.3.2 的退化分支立即 reject。

#### 3.3.2 handleAck 保留结构化信息（`apps/desktop/src/main/transport/real-backend.ts:200-215`）

- rejected 分支不再统一压 `CyreneError(INVALID_INPUT)`：
  - 新增 `CyreneErrorCode.BACKEND_REJECTED = 'BACKEND_REJECTED'`（shared/errors）；
  - 有 error：`new CyreneError(BACKEND_REJECTED, frame.error.message, { backendCode: frame.error.code, retryable: frame.error.retryable })`；
  - 缺 error（3.3.1 允许可选，此分支可达）：退化为 `new CyreneError(INVALID_INPUT, '消息被后端拒绝')` —— 立即 reject，不等待超时；
- 效果：`QUEUE_FULL` / `STORAGE_UNAVAILABLE` / `SESSION_NOT_FOUND` 等立即 reject，不等待 15s ACK timeout，`backendCode`/`retryable` 保留到 UI。

#### 3.3.3 结构化错误传递（骨架，完整链在批次 B FE-P1-05）

- `shared/contracts/ipc.ts`：`IpcErrorBody` 从 `{ code, message }` 扩展为
  ```
  interface IpcErrorBody { code: string; message: string; backendCode?: string; retryable?: boolean; requestId?: string }
  ```
- `main/ipc/executor.ts` 的 `createIpcHandler`（**共享 catch 点**，现把 `CyreneError` 压成 `{code, message}` 并丢弃 `details`；`main/chat/chat-handlers.ts` 自身无 try/catch）：catch 时把 `details` 中的 `backendCode/retryable/requestId` 上提进 `IpcErrorBody`（不泄漏堆栈/secret）。
- **跨 contextBridge 保真约束**：preload 抛 Error 跨桥到 renderer 时，Electron 只可靠保留 `message`，自定义 own property 与类原型（`instanceof`）会被剥掉（现有代码 `throw new Error('[code] message')` 正是为此）。因此结构化字段**并入 message 的可解析前缀**，由 renderer store 反解：
  - preload `unwrap`/`unwrapStatus` 抛 `Error('[code] [backendCode=QUEUE_FULL] [retryable=true] message')`（`code`/`backendCode`/`retryable` 有则带、无则省略；`requestId` 同理可加）；
  - renderer 新增纯函数 `parsePublicError(message): { code, message, backendCode?, retryable?, requestId? }`（单测覆盖，解析失败回退 `{ code: 'UNKNOWN', message }`）；
- `renderer store`：`connectionStore.error` / `messageStore.lastError` 从 `string` 改结构化 `{ code, message, backendCode?, retryable?, requestId? } | undefined`（由 `parsePublicError` 产出）；UI 据 `backendCode` 区分 `QUEUE_FULL`（限流可重试）、`STORAGE_UNAVAILABLE`（可重试）、`SESSION_NOT_FOUND` 等文案；
- **details 键统一**：本批 `handleAck` 用 `backendCode`；现有 `handleErrorFrame`（error 帧）用 `details.code`（error 帧完整链在批次 B FE-P1-05）。executor 上提时兼容读取 `backendCode` 与 `code` 两个键，避免批次 B 返工。
- 本批落地路径：连接错误（`connect`/`setEndpoint`）、rejected ACK（`send`）；其余路径（订阅推送、帧映射）保持现状，批次 B 补齐。

## 4. 错误处理汇总

| 场景 | 错误码 | 结构化字段 | UI 行为 |
|---|---|---|---|
| endpoint 非法（非 https/非回环/带 userinfo 等） | `INVALID_INPUT` | — | 输入框下显示校验错误 |
| endpoint 未设就设 Token | `CREDENTIAL_UNAVAILABLE` | — | 提示先设置后端地址 |
| origin 变化 | 自动清 token + `CREDENTIAL_UNAVAILABLE` | — | 提示重新设置 Token |
| 连接失败（网络/握手） | 现有 RealBackend 错误映射 | `backendCode?` | 连接面板显示结构化错误 |
| rejected ACK | `BACKEND_REJECTED` | `backendCode/retryable` | 发送气泡标 failed + 可重试提示 |
| 缺 Token | `CREDENTIAL_UNAVAILABLE` | — | Token 行引导设置 |

## 5. 测试与验收

### 5.1 单测（纯逻辑）
- `connection-config`：https 任意 host 通过；`http://example.com` 拒；`http://127.0.0.1:8765`/`localhost`/`[::1]` 通过；userinfo/query/fragment 拒；尾斜杠去除；`https://example.com/pfx/` → `baseUrl=https://example.com/pfx`、`wsUrl=wss://example.com/pfx/ws`；`http://127.0.0.1:8765` → `ws://127.0.0.1:8765/ws`；回环判定按 IP（`127.1.2.3.attacker.com` 拒，`127.0.0.0/8` 内通过）；
- token 绑定：`setEndpoint` origin 变化自动清 token+绑定；`setBackendToken` 未设 endpoint 拒；`connect` 绑定不符 → `CREDENTIAL_UNAVAILABLE`；
- `raw-schemas`：rejected + 空 `messageId` + QUEUE_FULL 通过；rejected 缺 error 通过（走退化分支）；accepted + 空 `messageId` 拒；accepted 正常通过；
- `real-backend handleAck`：rejected → `BACKEND_REJECTED` 且 `details.backendCode=QUEUE_FULL`、`retryable` 保留；rejected 缺 error → `INVALID_INPUT` 立即 reject；均不等待 timeout；
- `parsePublicError`：`'[CREDENTIAL_UNAVAILABLE] 后端 Token 未设置'` → `{code:'CREDENTIAL_UNAVAILABLE', message:'后端 Token 未设置'}`；`'[BACKEND_REJECTED] [backendCode=QUEUE_FULL] [retryable=true] 队列已满'` → 结构化三字段；无前缀 → 回退 `UNKNOWN`；
- **既有单测需随签名/语义更新（不全则红）**：`chat-service.spec.ts`（connect 无参 + 新 deps `getEndpoint/getTokenBinding` + Mock 占位）、`connection.store.spec.ts`（connect 无参、`error` 结构化、mockApi 补 `setEndpoint/getEndpoint/getRuntimeInfo`）、`desktop-api-chat.spec.ts`（connect invoke 载荷、unwrap 结构化 message 前缀断言、mockIpc 补新方法）、`credentials-ipc.spec.ts`（unwrapStatus 结构化）、`mock-backend-state.spec.ts`（serverUrl 不再被 input 覆盖）。

### 5.2 集成测试
- `setEndpoint('https://attacker.example')` 后 connect：断言 WS/fetch 未被调用、token 未离开 Main（对应 review FE-P0-01 验收 1）；
- `getRuntimeInfo`：Mock 模式 `mode='mock'`；
- rejected ACK 端到端：fake WS 发 rejected 空 messageId → 立即显示 failed + backendCode（不超时）；
- **现有集成测试必须更新（否则红灯）**：
  - `ipc-security.spec.ts:25-29` desktopApi 白名单 18 键断言 → 增 `setEndpoint/getEndpoint/getRuntimeInfo`（21 键，排序断言同步）；
  - `ipc-security.spec.ts:48-70` 凭据往返用例 → 先 `setEndpoint('http://127.0.0.1:8765')` 再 `setBackendToken`（新规则须先设 endpoint）。

### 5.3 验收对照（review FE-P0-01/FE-P1-02/FE-P1-01 验收测试）
- 已保存 backend-A token 后请求连接 attacker.example → WS/fetch 均未调用、token 未离开 Main；
- 远程 `http://example.com` 被拒绝；`http://127.0.0.1:8765` 本机可用；
- `https://example.com/` 规范化 → `wss://example.com/ws`；
- Endpoint A→B 后旧 token 不自动发往 B；
- packaged/production 装配不实例化 MockBackend；development/test 可显式 Mock；
- 未配置 Token 时显示明确 `CREDENTIAL_UNAVAILABLE` 引导；设置后可连接，Renderer 永远读不到 Token；
- rejected + `messageId:""` + `QUEUE_FULL`：立即 reject 不超时；accepted + 空 messageId：仍拒为非法帧。

## 6. 记录的中途决策（本批，最终报告需提及）

1. **FE-P0-01 方案（用户确认）**：Main 规范化 Endpoint + Token 绑定 Origin，不引入 `connectionProfileId` 模型（YAGNI；profile 是阶段 4 设置中心的事），但 `connection-config` 为未来 profile 留了扩展位。
2. **装配策略（用户确认）**：packaged 恒 Real；未打包默认 Real，`CYRENE_BACKEND=mock` 显式 Mock。
3. **Endpoint 内存持有不持久化**：重启需重设；endpoint 属敏感配置（可能内网），且设置中心（阶段 4）再做持久化 profile。
4. **Token 绑定用独立记录 key**（`BACKEND_TOKEN_ORIGIN_KEY`）而非按 origin 派生 token key：改动小、清晰，`clearBackendToken` 一次清两 key。
5. **允许 pathname（反向代理前缀）**：保留 path、去尾斜杠、`http→ws` 协议转换派生 WS；真实部署可能在前缀后挂 `/api` `/ws`。
6. **错误结构**：`IpcErrorBody` 扩展 `backendCode?/retryable?/requestId?`，`CyreneErrorCode` 新增 `BACKEND_REJECTED`；本批只落连接错误与 rejected ACK 路径，完整链在批次 B FE-P1-05。
7. **批次 A 三项合一个 spec**：FE-P0-01 与 FE-P1-02 共享 endpoint/token 管理架构，FE-P1-01 的错误结构与连接错误展示相关；拆两个 spec 会引入重叠。
8. **wsUrl 接口层改造推迟**：connection-config 派生 `wsUrl` 但本批不改 `ConnectInput`/`BackendAdapter.connect` 接口（baseUrl 规范化后 RealBackend 现有派生结果等价），避免牵动全部调用与测试；待批次 B 编排真实连接时统一。
9. **setBackendToken/clearBackendToken 编排**：`connection-config` 增方法 + `registerCredentialsHandlers` 对 `key === BACKEND_TOKEN_KEY` 特判委派（不新增专用 IPC 通道，保持 preload 签名不变；其余 key 零耦合）。

## 7. 已知限制（本批不做，记录待后续）
- 会话初始化时序（FE-P1-03）、conversation/epoch 守卫（FE-P1-04）、完整错误链（FE-P1-05）、超时/取消/门控（FE-P2-01）→ 批次 B；
- IPC/replay 运行时 Schema 完整化（FE-P2-02）、夹具跨仓库（FE-P2-03）、文档漂移（FE-P2-04）→ 批次 C；
- 连接设置 UI 只做最小面板，不做完整设置中心（阶段 4）。

## 8. 文档同步
- `docs/16` 变更记录追加本批；`docs/17` 环境/坑日志如有新增坑则补；
- 本批完成后仍标「已开发、未联调」。
